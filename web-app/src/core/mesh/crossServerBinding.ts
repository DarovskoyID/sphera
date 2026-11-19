/** Separate device possession from owner approval. No owner seed is ever needed
 * on the device being bound to a different selected application server.
 */
import { accountBytes, accountDigest, meshUserId, signIdentityStatement } from './account';
import { applicationKeys, ownerController, type ApplicationKeys } from './applicationAuth';
import { meshDeviceId } from './devices';
import { entryProbeNonce, validateTrustedEntryPoints, verifyEntryProbe, type TrustedEntryPoint } from './entryPoint';
import { unlockVault } from './vault';
type Challenge = { domain: 'sfera-mesh-application-bind-v1'; network: string; genesis: string; entry: string;
  application_user: string; login_jti: string; owner: string; device: string; device_public: string;
  history_version: number; history_hash: string; challenge: string; issued_at: number; expires_at: number };
type SignedRequest = { body: { domain: 'sfera-mesh-binding-request-v1'; challenge: Challenge; controller_public: string }; signature: string };
export type BindingRequest = { entry: SignedRequest; device_signature: string };
export type PendingBinding = { domain: 'sfera-mesh-pending-binding-v1'; request: BindingRequest; credentials: ApplicationKeys };
export type BindingApproval = { domain: 'sfera-mesh-binding-approval-v1'; request_digest: string; owner_signature: string };
const hash = (v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = (bytes:Uint8Array)=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const copy = <T>(v:T):T=>JSON.parse(JSON.stringify(v));
async function verify(publicHex:string,signature:string,body:unknown){
  if(!hash(publicHex)||typeof signature!=='string'||!/^[0-9a-f]{128}$/.test(signature))throw new Error('binding_invalid_signature');
  const raw=Uint8Array.from(publicHex.match(/../g)!,x=>parseInt(x,16)),sig=Uint8Array.from(signature.match(/../g)!,x=>parseInt(x,16));
  const key=await crypto.subtle.importKey('raw',raw.buffer,'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,sig.buffer,new Uint8Array(accountBytes(body)).buffer))throw new Error('binding_invalid_signature');
}
async function verifySigned(value:SignedRequest,pin:TrustedEntryPoint,now:number){
  const message=copy(value),b=message?.body,c=b?.challenge;
  const {network,nodeId,publicKey,url,label}=pin;await validateTrustedEntryPoints([{network,nodeId,publicKey,url,label}]);
  if(!message||Object.keys(message).sort().join(',')!=='body,signature'||!b||Object.keys(b).sort().join(',')!=='challenge,controller_public,domain'||b.domain!=='sfera-mesh-binding-request-v1'||!hash(b.controller_public)||
    !c||Object.keys(c).sort().join(',')!=='application_user,challenge,device,device_public,domain,entry,expires_at,genesis,history_hash,history_version,issued_at,login_jti,network,owner'||
    c.domain!=='sfera-mesh-application-bind-v1'||c.network!==pin.network||c.entry!==pin.nodeId||![c.genesis,c.owner,c.device,c.device_public,c.history_hash,c.challenge].every(hash)||
    !uuid.test(c.application_user)||typeof c.login_jti!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(c.login_jti)||
    !Number.isSafeInteger(c.history_version)||c.history_version<1||c.history_version>256||!Number.isSafeInteger(c.issued_at)||!Number.isSafeInteger(c.expires_at)||
    c.issued_at>now+5||c.issued_at<now-60||c.expires_at<=now||c.expires_at>c.issued_at+60||accountBytes(message).length>8192||await meshDeviceId(c.device_public)!==c.device)throw new Error('binding_request_context');
  await verify(pin.publicKey,message.signature,b);return message;
}
export async function verifyBindingRequest(value:BindingRequest,pin:TrustedEntryPoint,now=Math.floor(Date.now()/1000)){
  const request=copy(value);
  if(!request||Object.keys(request).sort().join(',')!=='device_signature,entry')throw new Error('invalid_binding_request');
  const entry=await verifySigned(request.entry,pin,now);
  await verify(entry.body.challenge.device_public,request.device_signature,entry.body.challenge);return {entry,device_signature:request.device_signature};
}
export async function approveServerBinding(value:BindingRequest,pin:TrustedEntryPoint,valueKeys:ApplicationKeys,password:string,now=Math.floor(Date.now()/1000)){
  const request=await verifyBindingRequest(value,pin,now),keys=applicationKeys(valueKeys,valueKeys.server),c=request.entry.body.challenge;
  if(!keys.ownerVault||keys.network!==c.network||keys.genesis!==c.genesis||await meshUserId(keys.ownerPublic)!==c.owner||await ownerController(keys)!==request.entry.body.controller_public)throw new Error('binding_owner_context');
  const root=await unlockVault(keys.ownerVault,c.owner,password);
  try{
    const owner_signature=hex(await signIdentityStatement(root,accountBytes(c)));await verify(request.entry.body.controller_public,owner_signature,c);
    return {domain:'sfera-mesh-binding-approval-v1' as const,request_digest:await accountDigest(accountBytes(request)),owner_signature};
  }finally{root.fill(0);}
}
/** Local credential extraction grants no binding or session. Historical entry
 * signatures remain useful after a request expires or its HTTP reply is lost. */
export async function recoverBindingCredentials(value:PendingBinding,pin:TrustedEntryPoint,password:string){
  const pending=copy(value);
  if(!pending||Object.keys(pending).sort().join(',')!=='credentials,domain,request'||pending.domain!=='sfera-mesh-pending-binding-v1'||accountBytes(pending).length>98304)throw new Error('invalid_pending_binding');
  const request=await verifyBindingRequest(pending.request,pin,pending.request.entry.body.challenge.issued_at),c=request.entry.body.challenge,keys=applicationKeys(pending.credentials,pin.url);
  if(keys.ownerVault!==null||keys.ownerControl||keys.entry!==pin.nodeId||keys.applicationUser!==c.application_user||keys.network!==c.network||keys.genesis!==c.genesis||keys.devicePublic!==c.device_public||await meshUserId(keys.ownerPublic)!==c.owner)throw new Error('binding_pending_context');
  const root=await unlockVault(keys.deviceVault,await meshUserId(keys.devicePublic),password);
  try{if(hex(await signIdentityStatement(root,accountBytes(c)))!==request.device_signature)throw new Error('binding_device_vault_mismatch');return keys;}finally{root.fill(0);}
}
type Options={pin:TrustedEntryPoint;token:()=>string;guard:()=>boolean;transport?:typeof fetch};
export class CrossServerBindingClient{
  private options:Options;
  constructor(options:Options){this.options={...options,pin:{...options.pin}};}
  private assert(){if(!this.options.guard())throw new Error('binding_cancelled');}
  private actor(){
    const token=this.options.token();if(typeof token!=='string'||token.length>32768)throw new Error('binding_login_required');
    try{const b=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(!uuid.test(b.user_id)||typeof b.jti!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(b.jti)||!Number.isSafeInteger(b.exp)||b.exp<=Date.now()/1000)throw new Error();return {user:b.user_id as string,jti:b.jti as string,token};}catch{throw new Error('binding_login_required');}
  }
  private async http(path:string,body:unknown,token?:string){
    this.assert();const o=this.options,response=await(o.transport??fetch)(o.pin.url+'/api/auth/mesh/'+path,{method:'POST',credentials:token?'include':'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Ionik-Client':'1',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    this.assert();if(response.status!==200||response.redirected||(response.url&&new URL(response.url).origin!==o.pin.url)){await response.body?.cancel();throw new Error('binding_http_'+response.status);}
    const reader=response.body?.getReader();if(!reader)throw new Error('binding_invalid_response');const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();this.assert();if(next.done)break;size+=next.value.length;if(size>131072){await reader.cancel();throw new Error('binding_response_too_large');}chunks.push(next.value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  private async probe(){const nonce=entryProbeNonce();return verifyEntryProbe(await this.http('entry/',{nonce}),this.options.pin,nonce);}
  async prepare(value:ApplicationKeys,password:string):Promise<PendingBinding>{
    const keys=applicationKeys(value,value.server),o=this.options,genesis=await this.probe(),actor=this.actor();
    if(keys.network!==o.pin.network||keys.genesis!==genesis)throw new Error('binding_network_mismatch');
    const entry=await verifySigned(await this.http('challenge/',{owner:await meshUserId(keys.ownerPublic),device:await meshDeviceId(keys.devicePublic),signed:true},actor.token),o.pin,Math.floor(Date.now()/1000)),c=entry.body.challenge;
    if(c.application_user!==actor.user||c.login_jti!==actor.jti||c.owner!==await meshUserId(keys.ownerPublic)||c.device_public!==keys.devicePublic||c.genesis!==keys.genesis)throw new Error('binding_challenge_mismatch');
    const root=await unlockVault(keys.deviceVault,await meshUserId(keys.devicePublic),password);
    try{
      const request={entry,device_signature:hex(await signIdentityStatement(root,accountBytes(c)))};await verifyBindingRequest(request,o.pin);
      const credentials:ApplicationKeys={...keys,entry:o.pin.nodeId,server:o.pin.url+'/',applicationUser:actor.user,ownerVault:null};delete credentials.ownerControl;
      this.assert();if(this.actor().token!==actor.token)throw new Error('binding_actor_changed');
      return {domain:'sfera-mesh-pending-binding-v1',request,credentials};
    }finally{root.fill(0);}
  }
  async complete(value:PendingBinding,valueApproval:BindingApproval,password:string,beforeSubmit?:(credentials:ApplicationKeys)=>void){
    const pending=copy(value),approval=copy(valueApproval),o=this.options,genesis=await this.probe(),actor=this.actor();
    if(!pending||Object.keys(pending).sort().join(',')!=='credentials,domain,request'||pending.domain!=='sfera-mesh-pending-binding-v1'||accountBytes(pending).length>98304)throw new Error('invalid_pending_binding');
    const request=await verifyBindingRequest(pending.request,o.pin),c=request.entry.body.challenge,keys=applicationKeys(pending.credentials,o.pin.url);
    if(keys.ownerVault!==null||keys.ownerControl||keys.entry!==o.pin.nodeId||keys.applicationUser!==actor.user||keys.network!==o.pin.network||keys.genesis!==genesis||c.genesis!==genesis||
      c.application_user!==actor.user||c.login_jti!==actor.jti||c.device_public!==keys.devicePublic||c.owner!==await meshUserId(keys.ownerPublic))throw new Error('binding_pending_context');
    if(!approval||Object.keys(approval).sort().join(',')!=='domain,owner_signature,request_digest'||approval.domain!=='sfera-mesh-binding-approval-v1'||approval.request_digest!==await accountDigest(accountBytes(request)))throw new Error('binding_approval_mismatch');
    await verify(request.entry.body.controller_public,approval.owner_signature,c);
    const root=await unlockVault(keys.deviceVault,await meshUserId(keys.devicePublic),password);
    try{if(hex(await signIdentityStatement(root,accountBytes(c)))!==request.device_signature)throw new Error('binding_device_vault_mismatch');}finally{root.fill(0);}
    this.assert();if(this.actor().token!==actor.token)throw new Error('binding_actor_changed');
    beforeSubmit?.(copy(keys));this.assert();
    const result=await this.http('bind/',{challenge:c.challenge,owner_signature:approval.owner_signature,device_signature:request.device_signature},actor.token);
    const s=result?.mesh_session;
    if(typeof result?.access!=='string'||result.access.length>32768||!s||Object.keys(s).sort().join(',')!=='device,entry,genesis,id,owner'||!hash(s.id)||s.owner!==c.owner||s.device!==c.device||s.genesis!==genesis||s.entry!==o.pin.nodeId)throw new Error('binding_session_mismatch');
    try{const jwt=JSON.parse(atob(result.access.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(jwt.user_id!==c.application_user||!Number.isSafeInteger(jwt.exp)||jwt.exp<=Date.now()/1000||await accountDigest(accountBytes(jwt.mesh_session))!==await accountDigest(accountBytes(s)))throw new Error();}catch{throw new Error('binding_session_mismatch');}
    this.assert();return {access:result.access as string,credentials:keys};
  }
}
