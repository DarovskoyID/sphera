/** Owner-approved new devices keep the stable account identity. Imported proof
 * establishes signatures only; callers must obtain a fresh signed network head.
 */
import { accountBytes, meshUserId, signIdentityStatement, type AccountRecord } from './account';
import { verifyControlledAccount, type AccountControlHead, type RootCheckpoint } from './accountControls';
import { applicationKeys, ownerController, type ApplicationKeys } from './applicationAuth';
import { meshDeviceId, verifyDeviceEvent, type DeviceEvent } from './devices';
import { unlockVault, wrapArchiveRoot } from './vault';
const ZERO='0'.repeat(64),hex=(v:Uint8Array)=>Array.from(v,x=>x.toString(16).padStart(2,'0')).join('');
export type DeviceHead = { record: AccountRecord; history: AccountControlHead[]; checkpoint: RootCheckpoint; events: DeviceEvent[] };
export type EnrollmentCandidate = { domain: 'sfera-mesh-device-enrollment-v1'; event: DeviceEvent; credentials: ApplicationKeys };
export async function verifyControlledDeviceHistory(value: DeviceHead, network: string, genesis: string, owner: string) {
  const head=JSON.parse(JSON.stringify(value)) as DeviceHead;
  const account=await verifyControlledAccount(head.record,head.history,network,genesis,owner),checkpoint=head.checkpoint;
  if(!checkpoint || checkpoint.accountVersion!==account.record.body.version || checkpoint.accountDigest!==account.digest || checkpoint.controlDigest!==account.controlDigest ||
    !Array.isArray(head.events) || head.events.length>256 || head.events.length!==checkpoint.devicesVersion)throw new Error('device_head_checkpoint_mismatch');
  let digest=ZERO; const digests=[ZERO],devices: {[id:string]:{publicKey:string;active:boolean}}={};
  const controllerKeys=new Set([account.record.body.public_key,...account.history.map(item=>item.record.body.new_public)]);
  for(let index=0;index<head.events.length;index++){
    const event=head.events[index];let signer=account.record.body.public_key;
    for(const item of account.history){if(index+1<=item.record.body.devices_version)break;signer=item.record.body.new_public;}
    const checked=await verifyDeviceEvent(event,network,signer,owner),body=checked.event.body,old=devices[body.device_id];
    if(body.version!==index+1 || body.previous!==digest || controllerKeys.has(body.device_public))throw new Error('device_history_gap_or_fork');
    if(body.operation==='enroll'){
      if(old || Object.keys(devices).length>=64)throw new Error('device_already_seen_or_limit');
      devices[body.device_id]={publicKey:body.device_public,active:true};
    }else{if(!old?.active || old.publicKey!==body.device_public)throw new Error('device_not_active');old.active=false;}
    digest=checked.digest;digests.push(digest);
  }
  if(digest!==checkpoint.devicesDigest || account.history.some(item=>digests[item.record.body.devices_version]!==item.record.body.devices_digest))throw new Error('device_history_checkpoint_conflict');
  return {...head,devices,controllerPublic:account.controllerPublic};
}
export async function prepareDeviceEnrollment(value: ApplicationKeys, password: string, newPassword: string, headValue: DeviceHead) {
  const keys=applicationKeys(value,value.server),owner=await meshUserId(keys.ownerPublic);
  const head=await verifyControlledDeviceHistory(headValue,keys.network,keys.genesis,owner);
  if(!keys.ownerVault || await ownerController(keys)!==head.controllerPublic || head.checkpoint.devicesVersion>=256 || Object.keys(head.devices).length>=64)throw new Error('device_enrollment_owner_required');
  const ownerRoot=await unlockVault(keys.ownerVault,owner,password);let root:Uint8Array|undefined;
  try{
    const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
    const encoded=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
    try{if(encoded.length!==48 || hex(encoded.subarray(0,16))!=='302e020100300506032b657004220420')throw new Error('unsupported_device_encoding');root=encoded.slice(16);}finally{encoded.fill(0);}
    const publicKey=hex(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
    const body:DeviceEvent['body']={domain:'sfera-mesh-device-event-lab-v1',network:keys.network,user_id:owner,version:head.checkpoint.devicesVersion+1,previous:head.checkpoint.devicesDigest,operation:'enroll',device_id:await meshDeviceId(publicKey),device_public:publicKey};
    const event:DeviceEvent={body,owner_signature:hex(await signIdentityStatement(ownerRoot,accountBytes(body))),device_signature:hex(await signIdentityStatement(root,accountBytes(body)))};
    await verifyDeviceEvent(event,keys.network,head.controllerPublic,owner);
    const credentials:ApplicationKeys={...keys,ownerVault:null,devicePublic:publicKey,deviceVault:await wrapArchiveRoot(root,await meshUserId(publicKey),newPassword)};
    delete credentials.ownerControl;
    return {domain:'sfera-mesh-device-enrollment-v1' as const,event,credentials};
  }finally{ownerRoot.fill(0);root?.fill(0);}
}
export async function verifyEnrollmentFile(value: EnrollmentCandidate, password: string, source: ApplicationKeys) {
  const candidate=JSON.parse(JSON.stringify(value)) as EnrollmentCandidate,keys=applicationKeys(candidate.credentials,source.server);
  if(Object.keys(candidate).sort().join(',')!=='credentials,domain,event' || candidate.domain!=='sfera-mesh-device-enrollment-v1' || keys.ownerVault!==null || keys.ownerControl ||
    keys.ownerPublic!==source.ownerPublic || keys.network!==source.network || keys.genesis!==source.genesis || keys.entry!==source.entry || keys.applicationUser!==source.applicationUser ||
    candidate.event.body.operation!=='enroll' || candidate.event.body.device_public!==keys.devicePublic || candidate.event.body.device_id!==await meshDeviceId(keys.devicePublic))throw new Error('invalid_enrollment_file');
  const root=await unlockVault(keys.deviceVault,await meshUserId(keys.devicePublic),password);
  try{if(hex(await signIdentityStatement(root,accountBytes(candidate.event.body)))!==candidate.event.device_signature)throw new Error('enrollment_device_mismatch');}
  finally{root.fill(0);}
  return candidate;
}
export async function prepareDeviceRevocation(value:ApplicationKeys,password:string,headValue:DeviceHead,target:string,actorDevice?:string){
  const keys=applicationKeys(value,value.server),owner=await meshUserId(keys.ownerPublic),head=await verifyControlledDeviceHistory(headValue,keys.network,keys.genesis,owner);
  if(!keys.ownerVault || await ownerController(keys)!==head.controllerPublic || !head.devices[target]?.active || target===(actorDevice??await meshDeviceId(keys.devicePublic)))throw new Error('revoke_from_other_device_required');
  const root=await unlockVault(keys.ownerVault,owner,password);
  try{
    const body:DeviceEvent['body']={domain:'sfera-mesh-device-event-lab-v1',network:keys.network,user_id:owner,version:head.checkpoint.devicesVersion+1,previous:head.checkpoint.devicesDigest,operation:'revoke',device_id:target,device_public:head.devices[target].publicKey};
    const event={body,owner_signature:hex(await signIdentityStatement(root,accountBytes(body))),device_signature:''};
    await verifyDeviceEvent(event,keys.network,head.controllerPublic,owner);return event;
  }finally{root.fill(0);}
}
