/** A checked global checkpoint covers every byte of the SDK stores and heads.
 * Mutations reserve the next revision first. An interrupted reservation fails
 * closed; it is never resolved by accepting an older local backup.
 */
import { accountBytes, accountDigest } from './account';
import { entryProbeNonce, type TrustedEntryPoint } from './entryPoint';
import type { CipherIdentity } from './pairwiseCipher';
type Body = { domain: 'sfera-mesh-cipher-profile-v1'; network: string; genesis: string; owner: string; device: string; version: number; previous: string; profile_digest: string };
type Record = { body: Body; signature: string };
type Head = { record: Record; digest: string };
const ZERO = '0'.repeat(64), hash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const hex = (x: Uint8Array) => Array.from(x, b => b.toString(16).padStart(2, '0')).join('');
const raw = (x: string) => Uint8Array.from(x.match(/../g)!, b => parseInt(b, 16));
async function verify(publicKey: string, signature: string, body: unknown) {
  if (!hash(publicKey) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) throw new Error('cipher_profile_invalid_signature');
  const key = await crypto.subtle.importKey('raw', raw(publicKey).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, raw(signature).buffer, new Uint8Array(accountBytes(body)).buffer)) throw new Error('cipher_profile_invalid_signature');
}
function serial(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return ['number',value];
  if (value instanceof ArrayBuffer) return ['bytes',hex(new Uint8Array(value))];
  if (ArrayBuffer.isView(value)) return ['view',value.constructor.name,hex(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))];
  if (value instanceof Date) return ['date',value.toISOString()];
  if (Array.isArray(value)) return ['array',value.map(serial)];
  if (value && Object.getPrototypeOf(value) === Object.prototype) return ['object',Object.keys(value).sort().map(key => [key,serial((value as {[k:string]:unknown})[key])])];
  throw new Error('cipher_profile_unsupported_store_value');
}
export async function cipherProfileDigest(store: string) {
  const expected = [store+'::matrix-sdk-crypto',store+'::matrix-sdk-crypto-meta','sphere-e2ee-heads-v1:'+store];
  if (!indexedDB.databases) throw new Error('cipher_profile_inventory_unavailable');
  const inventory = await indexedDB.databases(), result: unknown[] = []; let total = 0, count = 0;
  if (inventory.some(db => db.name?.startsWith(store) && !expected.includes(db.name))) throw new Error('cipher_profile_unknown_sdk_store');
  for (const name of expected) {
    if (!inventory.some(db => db.name === name)) { result.push([name,null]); continue; }
    const db = await new Promise<IDBDatabase>((resolve,reject) => { const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('cipher_profile_read_failed'));r.onupgradeneeded=()=>r.transaction?.abort(); });
    try {
      const names=Array.from(db.objectStoreNames).sort(), rows: unknown[]=[];
      if (names.length) await new Promise<void>((resolve,reject)=>{
        const tx=db.transaction(names,'readonly');
        for (const table of names) {
          const values: unknown[]=[], objectStore=tx.objectStore(table);
          const indexes=Array.from(objectStore.indexNames).sort().map(name=>{const index=objectStore.index(name);return [name,index.keyPath,index.unique,index.multiEntry];});
          rows.push([table,objectStore.keyPath,objectStore.autoIncrement,indexes,values]); const r=objectStore.openCursor();
          r.onsuccess=()=>{try{const cursor=r.result;if(!cursor)return;const row=[serial(cursor.key),serial(cursor.value)];total+=accountBytes(row).length;if(++count>100000 || total>32*1048576)throw new Error();values.push(row);cursor.continue();}catch{tx.abort();}};
        }
        tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(new Error('cipher_profile_snapshot_failed'));
      });
      result.push([name,db.version,rows]);
    } finally { db.close(); }
  }
  return accountDigest(accountBytes(result));
}
export class CipherProfileGuard {
  private head: Head | null = null;
  private poisoned = false;
  private active = false;
  private own: CipherIdentity; private devicePublic: string; private pin: TrustedEntryPoint;
  private signer: CryptoKey; private post: (body: unknown)=>Promise<unknown>; private store: string;
  constructor(own: CipherIdentity, devicePublic: string, pin: TrustedEntryPoint,
    signer: CryptoKey, post: (body: unknown)=>Promise<unknown>, store: string) {
    this.own={...own};this.devicePublic=devicePublic;this.pin={...pin};this.signer=signer;this.post=post;this.store=store;
  }
  private async read(): Promise<Head|null> {
    const nonce=entryProbeNonce(),value=await this.post({nonce}) as {body: {[k:string]:any};signature:string},b=value?.body,now=Math.floor(Date.now()/1000);
    if (!value || Object.keys(value).sort().join(',')!=='body,signature' || !b || Object.keys(b).sort().join(',')!=='device,domain,entry,expires_at,finality,genesis,head,issued_at,network,nonce,owner' ||
      b.domain!=='sfera-mesh-cipher-profile-head-v1' || b.network!==this.own.network || b.genesis!==this.own.genesis || b.owner!==this.own.owner || b.device!==this.own.device || b.entry!==this.pin.nodeId || b.nonce!==nonce ||
      !Number.isSafeInteger(b.issued_at) || !Number.isSafeInteger(b.expires_at) || b.issued_at>now+5 || b.issued_at<now-15 || b.expires_at<=now || b.expires_at>b.issued_at+15) throw new Error('cipher_profile_head_context');
    const a=b.finality;
    if (!a || Object.keys(a).sort().join(',')!=='expires_at,header_hash,height,network,validators_hash' || a.network!==this.own.network || !Number.isSafeInteger(a.height) || a.height<1 || !hash(a.header_hash) || !hash(a.validators_hash) || a.expires_at<=now || b.expires_at>a.expires_at) throw new Error('cipher_profile_head_anchor');
    await verify(this.pin.publicKey,value.signature,b);
    if (b.head===null) return null;
    const head=b.head as Head,r=head?.record,body=r?.body;
    if (!head || Object.keys(head).sort().join(',')!=='digest,record' || !r || Object.keys(r).sort().join(',')!=='body,signature' || !body || Object.keys(body).sort().join(',')!=='device,domain,genesis,network,owner,previous,profile_digest,version' ||
      body.domain!=='sfera-mesh-cipher-profile-v1' || body.network!==this.own.network || body.genesis!==this.own.genesis || body.owner!==this.own.owner || body.device!==this.own.device || !Number.isSafeInteger(body.version) || body.version<1 ||
      !hash(body.previous) || !hash(body.profile_digest) || body.profile_digest===ZERO || body.version===1 && body.previous!==ZERO || await accountDigest(accountBytes(r))!==head.digest) throw new Error('cipher_profile_record_context');
    await verify(this.devicePublic,r.signature,body);return head;
  }
  private async advance(profile_digest: string) {
    const body: Body={domain:'sfera-mesh-cipher-profile-v1',...this.own,version:(this.head?.record.body.version??0)+1,previous:this.head?.digest??ZERO,profile_digest};
    const record={body,signature:hex(new Uint8Array(await crypto.subtle.sign('Ed25519',this.signer,new Uint8Array(accountBytes(body)).buffer)))},digest=await accountDigest(accountBytes(record));
    try { await this.post({record}); } catch { /* A lost response is checked below, never treated as success. */ }
    for(let attempt=0;attempt<40;attempt++) {
      try {
        const fresh = await this.read();
        if (fresh?.digest === digest) { this.head = fresh; return; }
        if (fresh?.digest !== this.head?.digest) throw new Error('cipher_profile_checkpoint_conflict');
      } catch (error) {
        // The write may already be committed. Keep polling its signed receipt
        // on transient failures without starting a second write.
        const retryable = error instanceof TypeError || error instanceof Error &&
          (error.name === 'AbortError' || /^dm_cipher_(http_50[234]|request_timed_out)$/.test(error.message));
        if (!retryable) throw error;
      }
      if(attempt<39)await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('cipher_profile_confirmation_pending');
  }
  async beforeInitialize() {
    this.head=await this.read();
    if (this.head) { this.active = true; await this.reserve(this.head); }
  }
  async afterInitialize() { if(this.active)await this.finish(); }
  async activate() {
    if(this.active)return;
    try {await this.advance(await cipherProfileDigest(this.store));this.active=true;}catch(error){this.poisoned=true;throw error;}
  }
  async begin() {
    if(!this.active || this.poisoned)throw new Error('cipher_profile_unavailable');
    try {
      const fresh=await this.read();
      if (!fresh || fresh.digest !== this.head?.digest) throw new Error('cipher_profile_checkpoint_conflict');
      await this.reserve(fresh);
    }catch(error){this.poisoned=true;throw error;}
  }
  private async reserve(head: Head) {
    if (head.record.body.version % 2 !== 1) throw new Error('cipher_profile_interrupted');
    if (head.record.body.profile_digest !== await cipherProfileDigest(this.store)) throw new Error('cipher_profile_local_mismatch');
    this.head = head;
    await this.advance(head.record.body.profile_digest);
  }
  async finish() {
    if(this.poisoned)throw new Error('cipher_profile_unavailable');
    try{await this.advance(await cipherProfileDigest(this.store));}catch(error){this.poisoned=true;throw error;}
  }
  fail(){this.poisoned=true;}
}
