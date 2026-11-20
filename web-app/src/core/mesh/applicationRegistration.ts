import { createMeshAccount } from './account';
import { initialApplicationProfile, applicationUserId } from './applicationProfiles';
import { meshDeviceId, signDeviceEvent } from './devices';
import { answerApplicationChallenge, applicationKeys, type ApplicationKeys } from './applicationAuth';
import { entryProbeNonce, verifyEntryProbe, validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';
import { acquireCipherStoreLock } from './cipherStoreLock';

export async function prepareApplicationRegistration(pin: TrustedEntryPoint, genesis: string,
  handle: string, nickname: string, password: string) {
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(handle) || !/^[0-9a-f]{64}$/.test(genesis)
      || password.length<12 || password.length>1024) throw new Error('application_registration_fields');
  const {network,nodeId,publicKey,url,label}=pin;
  [pin]=await validateTrustedEntryPoints([{network,nodeId,publicKey,url,label}]);
  const account=await createMeshAccount(password,pin.network,'0'.repeat(64));
  let device: Awaited<ReturnType<typeof createMeshAccount>> | undefined;
  try {
    device=await createMeshAccount(password,pin.network,'0'.repeat(64));
    const profile=await initialApplicationProfile(account.root,account.publicKey,pin.network,genesis,handle,nickname);
    const event=await signDeviceEvent(account.root,account.publicKey,{domain:'sfera-mesh-device-event-lab-v1',network:pin.network,
      user_id:account.userId,version:1,previous:'0'.repeat(64),operation:'enroll',
      device_id:await meshDeviceId(device.publicKey),device_public:device.publicKey},device.root);
    const keys: ApplicationKeys={version:1,network:pin.network,genesis,entry:pin.nodeId,server:new URL(pin.url).origin+'/',
      applicationUser:await applicationUserId(pin.network,account.userId),ownerPublic:account.publicKey,devicePublic:device.publicKey,
      ownerVault:account.vault,deviceVault:device.vault};
    // Persist this encrypted credential and the exact public bundle before the
    // first request. Retries must never create a second identity after timeout.
    return {keys,bundle:{account:account.record,profile,device:event}};
  } finally { account.root.fill(0);device?.root.fill(0); }
}

export type PreparedApplicationRegistration=Awaited<ReturnType<typeof prepareApplicationRegistration>>;

export async function publishApplicationRegistration(prepared: PreparedApplicationRegistration,
  post: (bundle: PreparedApplicationRegistration['bundle'])=>Promise<unknown>) {
  const bundle=JSON.parse(JSON.stringify(prepared.bundle));
  const value=await post(bundle) as Record<string,unknown>;
  if (!value || value.owner!==bundle.account.body.user_id) throw new Error('application_registration_response');
  if (value.state==='pending' && ['account','profile','device'].includes(value.stage as string)) return {state:'pending' as const};
  if (value.state!=='confirmed' || value.device!==bundle.device.body.device_id
      || value.application_user!==prepared.keys.applicationUser) throw new Error('application_registration_response');
  return {state:'confirmed' as const};
}

/** Original sign-up form adapter. Persist encrypted credentials before publish;
 * retries resume exactly the same identity. Passwords never enter HTTP bodies. */
export async function accessDistributedApplication(options: {
  pin: TrustedEntryPoint; password: string; handle: string; nickname: string; register: boolean;
  storage: Pick<Storage,'getItem'|'setItem'>; post: (path:string,body:unknown)=>Promise<unknown>;
  guard: ()=>void; wait?: ()=>Promise<void>;
  onAuthenticated?: (keys:ApplicationKeys,token:string)=>Promise<void>;
}) {
  const {pin,post,storage,guard}=options;guard();
  const nonce=entryProbeNonce();
  const genesis=await verifyEntryProbe(await post('/api/auth/mesh/entry/',{nonce}),pin,nonce);guard();
  const key=`sfera_distributed_credentials_v1:${pin.network}:${genesis}:${options.handle}`;
  const release=await acquireCipherStoreLock('registration:'+key);
  try {
  const saved=storage.getItem(key);
  let prepared:PreparedApplicationRegistration;
  if (saved!==null) {
    if (saved.length>32768) throw new Error('invalid_application_keys');
    prepared=JSON.parse(saved);
    // Explicit selected-entry change: the new entry has independently proved
    // the same network/genesis. Owner/device records remain byte-for-byte fixed.
    if (prepared.keys.network!==pin.network || prepared.keys.genesis!==genesis
        || prepared.bundle.profile.body.handle!==options.handle) throw new Error('application_registration_identity_mismatch');
    prepared.keys=applicationKeys({...prepared.keys,entry:pin.nodeId,server:new URL(pin.url).origin+'/'},pin.url);
    storage.setItem(key,JSON.stringify(prepared));
  } else {
    if (!options.register) throw new Error('application_local_keys_missing');
    prepared=await prepareApplicationRegistration(pin,genesis,options.handle,options.nickname,options.password);guard();
    storage.setItem(key,JSON.stringify(prepared));
  }
  if (options.register) {
    let confirmed=false;
    for (let attempt=0;attempt<30;attempt++) {
      guard();
      const result=await publishApplicationRegistration(prepared,bundle=>post('/api/distribution/registration/',bundle));guard();
      if (result.state==='confirmed') {confirmed=true;break;}
      await (options.wait?options.wait():new Promise<void>(resolve=>setTimeout(resolve,1000)));
    }
    if (!confirmed) throw new Error('application_registration_pending_retry');
  }
  const challenge=await post('/api/auth/mesh/login/challenge/',{owner:prepared.bundle.account.body.user_id,device:prepared.bundle.device.body.device_id}) as Record<string,unknown>;guard();
  const proof=await answerApplicationChallenge(prepared.keys,options.password,challenge,'login');guard();
  const result=await post('/api/auth/mesh/login/',proof) as {access?:unknown;mesh_session?:unknown};guard();
  if (typeof result.access!=='string' || !result.mesh_session) throw new Error('application_registration_login_rejected');
  await options.onAuthenticated?.(prepared.keys,result.access);guard();
  return result.access;
  } finally { await release(); }
}
