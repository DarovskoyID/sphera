import {applicationKeys,ownerController,type ApplicationKeys} from './applicationAuth';
import {accountBytes,accountDigest,meshUserId} from './account';
import {loadEntryPointPin,entryProbeNonce,verifyEntryProbe} from './entryPoint';
import {signApplicationProfile,type ApplicationProfileRecord} from './applicationProfiles';
import {unlockVault} from './vault';

export async function updateDistributedNickname(server:string,token:string,user:string,nickname:string,password:string,
  storage:Storage=localStorage,transport:typeof fetch=fetch,guard:()=>void=()=>{}){
  const pin=await loadEntryPointPin(storage);guard();
  if(!pin || pin.url!==new URL(server).origin)throw new Error('application_trusted_entry_required');
  const send=async(path:string,body?:unknown)=>{
    guard();const response=await transport(pin.url+path,{method:body===undefined?'GET':'POST',credentials:'include',redirect:'error',
      headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('application_profile_request_rejected');
    const value=await response.json();guard();return value;
  };
  const nonce=entryProbeNonce(),genesis=await verifyEntryProbe(await send('/api/auth/mesh/entry/',{nonce}),pin,nonce);guard();
  let keys:ApplicationKeys|undefined;
  for(let i=0;i<storage.length;i++){
    const name=storage.key(i);if(!name?.startsWith('sfera_distributed_credentials_v1:'))continue;
    const text=storage.getItem(name);if(!text || text.length>32768)continue;
    try{const value=JSON.parse(text).keys;if(value?.applicationUser===user && value.network===pin.network && value.genesis===genesis){keys=applicationKeys({...value,entry:pin.nodeId,server:pin.url+'/'},server);break;}}catch{/* unrelated entry */}
  }
  if(!keys?.ownerVault)throw new Error('application_owner_keys_missing');
  const owner=await meshUserId(keys.ownerPublic),controller=await ownerController(keys);
  const catalog=await send('/api/distribution/catalog/');
  if(catalog.network!==pin.network || catalog.genesis!==genesis || !Array.isArray(catalog.profiles))throw new Error('application_catalog_context');
  const profile=catalog.profiles.find((p:{id:string;owner:string})=>p.id===user && p.owner===owner);
  const head=profile?.record as ApplicationProfileRecord|undefined;
  if(!head || head.body.owner!==owner || head.body.network!==pin.network || head.body.genesis!==genesis
      || head.body.control_epoch!==(keys.ownerControl?.history.length??0) || await accountDigest(accountBytes(head))!==profile.digest)throw new Error('application_profile_head_mismatch');
  const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(controller.match(/../g)!,v=>parseInt(v,16)).buffer,'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(head.signature.match(/../g)??[],v=>parseInt(v,16)).buffer,new Uint8Array(accountBytes(head.body)).buffer))throw new Error('application_profile_signature');
  const encoded=Array.from(new TextEncoder().encode(nickname),v=>v.toString(16).padStart(2,'0')).join('');
  if(head.body.nickname_utf8===encoded)return;
  const root=await unlockVault(keys.ownerVault,owner,password);
  let record:ApplicationProfileRecord;
  try{record=await signApplicationProfile(root,controller,{...head.body,version:head.body.version+1,previous:profile.digest,nickname_utf8:encoded});}
  finally{root.fill(0);}
  for(let i=0;i<30;i++){
    const result=await send('/api/distribution/profiles/',{record});
    if(result.owner!==owner || result.digest!==await accountDigest(accountBytes(record)))throw new Error('application_profile_response');
    if(result.state==='confirmed')return;
    if(result.state!=='pending')throw new Error('application_profile_response');
    await new Promise(resolve=>setTimeout(resolve,1000));guard();
  }
  throw new Error('application_profile_confirmation_pending');
}
