/** Short-lived device signing capability. Seeds/passwords are never retained. */
import { applicationKeys,type ApplicationKeys } from './applicationAuth';
import { meshUserId } from './account';
import { unlockVault } from './vault';
import { meshDeviceId } from './devices';
import { applicationUserId } from './applicationProfiles';
import { applicationDialogId,applicationConversationId,signDeviceApplicationDialog } from './applicationDialogs';
import { signApplicationSignal,type ApplicationSignalIdentity } from './applicationSignals';

type Context={user:string;entry:string;server:string;identity:ApplicationSignalIdentity;key:CryptoKey;expires:number};
let active:Context|undefined;
const claims=(token:string)=>{
  if(token.length>32768 || token.split('.').length!==3)throw new Error('application_action_login_required');
  return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
};
export function lockApplicationActions(){active=undefined;}
function context(server:string,token:string){
  const value=active,jwt=claims(token),claim=jwt.mesh_session;
  if(!value || value.expires<=Date.now()/1000 || jwt.exp<=Date.now()/1000
      || value.server!==new URL(server).origin || jwt.user_id!==value.user
      || !claim || claim.owner!==value.identity.owner || claim.device!==value.identity.device
      || claim.genesis!==value.identity.genesis || claim.entry!==value.entry)throw new Error('application_action_unlock_required');
  return value;
}
export async function unlockApplicationActions(value:ApplicationKeys,password:string,token:string){
  const keys=applicationKeys(value,value.server),jwt=claims(token),claim=jwt.mesh_session;
  const identity={network:keys.network,genesis:keys.genesis,owner:await meshUserId(keys.ownerPublic),
    device:await meshDeviceId(keys.devicePublic),devicePublic:keys.devicePublic};
  if(jwt.user_id!==keys.applicationUser || !claim || claim.owner!==identity.owner || claim.device!==identity.device
      || claim.entry!==keys.entry || claim.genesis!==keys.genesis || !Number.isSafeInteger(jwt.exp)
      || jwt.exp<=Date.now()/1000)throw new Error('application_action_context_mismatch');
  const root=await unlockVault(keys.deviceVault,await meshUserId(keys.devicePublic),password);
  const encoded=new Uint8Array(48);encoded.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);encoded.set(root,16);
  try{
    const key=await crypto.subtle.importKey('pkcs8',encoded.buffer,'Ed25519',false,['sign']);
    active={user:keys.applicationUser,entry:keys.entry,server:new URL(keys.server).origin,identity,key,expires:Math.min(jwt.exp,Date.now()/1000+900)};
  }finally{root.fill(0);encoded.fill(0);}
}
type Profile={id:string;owner:string;control_epoch:number;devices_version:number};
type Catalog={network:string;genesis:string;profiles:Profile[];dialogs:{identity:string;id:string;members:string[]}[]};
async function catalog(server:string,token:string,transport:typeof fetch):Promise<Catalog>{
  const response=await transport(`${server}/api/distribution/catalog/`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('application_catalog_unavailable');
  const result=await response.json();
  if(!result || !Array.isArray(result.profiles) || result.profiles.length>256 || !Array.isArray(result.dialogs))throw new Error('application_catalog_invalid');
  return result;
}
export async function openDistributedDialog(server:string,token:string,peer:string,guard:()=>void,
  transport:typeof fetch=fetch,wait:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,1000))){
  const jwt=claims(token),claim=jwt.mesh_session;guard();
  const listing=await catalog(server,token,transport);guard();
  if(!claim || listing.genesis!==claim.genesis || typeof listing.network!=='string')throw new Error('application_catalog_context');
  const own=listing.profiles.find(p=>p.owner===claim.owner && p.id===jwt.user_id),other=listing.profiles.find(p=>p.id===peer);
  if(!own || !other || own.owner===other.owner || await applicationUserId(listing.network,other.owner)!==peer)throw new Error('application_dialog_peer');
  const members=[own.owner,other.owner].sort(),identity=await applicationDialogId(listing.network,members);
  const existing=listing.dialogs.find(d=>d.identity===identity);
  if(existing){if(existing.id!==applicationConversationId(identity) || JSON.stringify(existing.members)!==JSON.stringify(members))throw new Error('application_dialog_identity');return existing.id;}
  const actor=context(server,token);
  if(actor.identity.network!==listing.network)throw new Error('application_catalog_context');
  const record=await signDeviceApplicationDialog(actor.identity,actor.key,other.owner,own.control_epoch,own.devices_version);guard();
  for(let attempt=0;attempt<30;attempt++){
    context(server,token);guard();
    const response=await transport(`${server}/api/distribution/dialogs/`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({record}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('application_dialog_rejected');
    const result=await response.json();guard();
    if(result.identity!==identity)throw new Error('application_dialog_identity');
    if(result.state==='confirmed')return applicationConversationId(identity);
    if(result.state!=='pending')throw new Error('application_dialog_response');
    await wait();
  }
  throw new Error('application_dialog_pending');
}
export async function signedApplicationSignal(server:string,token:string,signal:Record<string,unknown>,transport:typeof fetch=fetch){
  signal=JSON.parse(JSON.stringify(signal));
  const actor=context(server,token),listing=await catalog(server,token,transport);
  const other=listing.profiles.find(p=>p.id===signal.to);
  if(listing.network!==actor.identity.network || listing.genesis!==actor.identity.genesis || !other
      || await applicationUserId(listing.network,other.owner)!==signal.to)throw new Error('application_signal_peer');
  context(server,token);
  const packet=await signApplicationSignal(actor.identity,actor.key,other.owner,signal);
  context(server,token);return packet;
}
