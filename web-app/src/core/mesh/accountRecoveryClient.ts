import { accountBytes, accountDigest, verifyAccount, type AccountRecord } from './account';
import { entryProbeNonce, verifyEntryProbe, type TrustedEntryPoint } from './entryPoint';
import type { Vault } from './vault';
import { verifyControlledAccount, type AccountControlHead, type RootCheckpoint, type prepareRootControl } from './accountControls';
import { verifyControlledDeviceHistory, type DeviceHead } from './deviceEnrollment';
import { verifyDeviceEvent, type DeviceEvent } from './devices';

type Head = { record: AccountRecord; digest: string; expiresAt: number; history?: AccountControlHead[]; checkpoint?: RootCheckpoint };
type Options = { pin: TrustedEntryPoint; genesis: string; owner: string; device: string;
  token: () => string; guard: () => boolean; transport?: typeof fetch };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export async function verifyAccountHead(value: unknown, pin: TrustedEntryPoint, genesis: string,
  owner: string, device: string, nonce: string, now = Math.floor(Date.now() / 1000)): Promise<Head> {
  const message = JSON.parse(JSON.stringify(value));
  if (!message || Object.keys(message).sort().join(',') !== 'body,signature' || typeof message.signature !== 'string' || !/^[0-9a-f]{128}$/.test(message.signature)) throw new Error('invalid_account_head');
  const b = message.body;
  const controlled = b?.domain === 'sfera-mesh-application-account-head-v2';
  const fields = ['authority','device','digest','domain','entry','expires_at','finality','genesis','issued_at','network','nonce','owner','record'];
  if (controlled) fields.push('control_history', 'devices_version', 'devices_digest');
  if (!b || Object.keys(b).sort().join(',') !== fields.sort().join(',') ||
    (!controlled && b.domain !== 'sfera-mesh-application-account-head-v1') || b.authority !== 'selected_entry_verified_directory' ||
    b.network !== pin.network || b.genesis !== genesis || b.entry !== pin.nodeId || b.owner !== owner || b.device !== device ||
    !hash(nonce) || b.nonce !== nonce || !hash(b.digest) || !Number.isSafeInteger(b.issued_at) || !Number.isSafeInteger(b.expires_at) ||
    b.issued_at > now + 5 || b.issued_at < now - 15 || b.expires_at <= now || b.expires_at > b.issued_at + 15) throw new Error('account_head_context_mismatch');
  const a = b.finality;
  if (!a || Object.keys(a).sort().join(',') !== 'expires_at,header_hash,height,network,validators_hash' ||
    a.network !== pin.network || !Number.isSafeInteger(a.height) || a.height < 1 || !hash(a.header_hash) || !hash(a.validators_hash) ||
    !Number.isFinite(a.expires_at) || a.expires_at <= now || b.expires_at > a.expires_at) throw new Error('invalid_account_head_anchor');
  const raw = Uint8Array.from(pin.publicKey.match(/../g)!, x => parseInt(x, 16));
  const key = await crypto.subtle.importKey('raw', raw.buffer, 'Ed25519', false, ['verify']);
  const signature: string = message.signature;
  const sig = Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16));
  if (!await crypto.subtle.verify('Ed25519', key, sig.buffer, new Uint8Array(accountBytes(b)).buffer)) throw new Error('invalid_account_head_signature');
  if (controlled) {
    const checked = await verifyControlledAccount(b.record, b.control_history, pin.network, genesis, owner);
    if (checked.digest !== b.digest) throw new Error('account_head_digest_mismatch');
    if (!Number.isSafeInteger(b.devices_version) || b.devices_version < 0 || b.devices_version > 256 || !hash(b.devices_digest) ||
      (b.devices_version === 0 && b.devices_digest !== '0'.repeat(64)) ||
      checked.history.some(head => head.record.body.devices_version > b.devices_version ||
        (head.record.body.devices_version === b.devices_version && head.record.body.devices_digest !== b.devices_digest))) throw new Error('invalid_account_device_checkpoint');
    return { record: checked.record, digest: checked.digest, expiresAt: b.expires_at, history: checked.history,
      checkpoint: { accountVersion: checked.record.body.version, accountDigest: checked.digest, controlDigest: checked.controlDigest,
        devicesVersion: b.devices_version, devicesDigest: b.devices_digest } };
  }
  if (await verifyAccount(b.record, pin.network, owner) !== b.digest) throw new Error('account_head_digest_mismatch');
  return { record: b.record, digest: b.digest, expiresAt: b.expires_at };
}

export class AccountRecoveryClient {
  private options: Options;
  constructor(options: Options) {
    this.options = { ...options, pin: { ...options.pin } };
    if (![options.genesis, options.owner, options.device].every(hash)) throw new Error('invalid_account_client_context');
  }
  private assert() { if (!this.options.guard()) throw new Error('account_recovery_cancelled'); }
  private async http(path: string, body: unknown, authenticated: boolean, limit = 98304) {
    this.assert(); const o = this.options;
    const token = authenticated ? o.token() : '';
    if (authenticated && (!token || token.length > 32768)) throw new Error('account_recovery_login_required');
    const response = await (o.transport ?? fetch)(o.pin.url + '/api/auth/mesh/' + path, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Ionik-Client': '1', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    });
    this.assert();
    if (![200, 202].includes(response.status) || response.redirected || (response.url && new URL(response.url).origin !== o.pin.url)) {
      await response.body?.cancel(); throw new Error('account_recovery_http_' + response.status);
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error('invalid_account_recovery_response');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read(); this.assert(); if (next.done) break;
        size += next.value.length; if (size > limit) { await reader.cancel(); throw new Error('account_recovery_response_too_large'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  private async probe() {
    const nonce = entryProbeNonce(), o = this.options;
    if (await verifyEntryProbe(await this.http('entry/', { nonce }, false), o.pin, nonce) !== o.genesis) throw new Error('account_recovery_genesis_mismatch');
    this.assert();
  }
  async head(): Promise<Head> {
    await this.probe(); const nonce = entryProbeNonce(), o = this.options;
    const result = await verifyAccountHead(await this.http('account/head/', { nonce, controlled: true }, true), o.pin, o.genesis, o.owner, o.device, nonce);
    this.assert(); return result;
  }
  async controlledHead(): Promise<Head & { history: AccountControlHead[]; checkpoint: RootCheckpoint }> {
    await this.probe(); const nonce = entryProbeNonce(), o = this.options;
    const result = await verifyAccountHead(await this.http('account/head/', { nonce, controlled: true }, true), o.pin, o.genesis, o.owner, o.device, nonce);
    this.assert();
    if (!result.history || !result.checkpoint) throw new Error('account_control_checkpoint_required');
    return { ...result, history: result.history, checkpoint: result.checkpoint };
  }
  async deviceHead() {
    await this.probe(); const nonce=entryProbeNonce(),o=this.options;
    const value=await this.http('account/devices/',{nonce},true,1048576);
    if(!value || Object.keys(value).sort().join(',')!=='account,events')throw new Error('invalid_device_head');
    const head=await verifyAccountHead(value.account,o.pin,o.genesis,o.owner,o.device,nonce);
    if(!head.history || !head.checkpoint)throw new Error('device_checkpoint_required');
    const checked=await verifyControlledDeviceHistory({...head,history:head.history,checkpoint:head.checkpoint,events:value.events},o.pin.network,o.genesis,o.owner);
    this.assert();return checked;
  }
  async publishDevice(value: DeviceEvent) {
    const event=JSON.parse(JSON.stringify(value)) as DeviceEvent,o=this.options,digest=await accountDigest(accountBytes(event));
    const head=await this.deviceHead();
    const committed=head.events[event.body.version-1];
    if(committed && await accountDigest(accountBytes(committed))===digest){
      if(event.body.operation==='enroll'&&!head.devices[event.body.device_id]?.active)throw new Error('device_already_revoked');
      return {state:'confirmed' as const,digest};
    }
    await verifyDeviceEvent(event,o.pin.network,head.controllerPublic,o.owner);
    if(event.body.version!==head.checkpoint.devicesVersion+1 || event.body.previous!==head.checkpoint.devicesDigest ||
      event.body.operation==='revoke' && event.body.device_id===o.device)throw new Error('device_candidate_conflict');
    const staged:DeviceHead={...head,events:[...head.events,event],checkpoint:{...head.checkpoint,devicesVersion:event.body.version,devicesDigest:digest}};
    await verifyControlledDeviceHistory(staged,o.pin.network,o.genesis,o.owner);
    const result=await this.http('account/devices/',{event},true);
    if(!result || Object.keys(result).sort().join(',')!=='digest,state' || result.digest!==digest || !['pending','confirmed'].includes(result.state))throw new Error('invalid_device_publish_response');
    const fresh=await this.deviceHead(),confirmed=fresh.events[event.body.version-1];
    if(confirmed && await accountDigest(accountBytes(confirmed))===digest){
      if(event.body.operation==='enroll'&&!fresh.devices[event.body.device_id]?.active)throw new Error('device_already_revoked');
      return {state:'confirmed' as const,digest};
    }
    if(fresh.checkpoint.devicesDigest!==head.checkpoint.devicesDigest || fresh.checkpoint.controlDigest!==head.checkpoint.controlDigest)throw new Error('device_candidate_conflict');
    return {state:'pending' as const,digest};
  }
  async publishControl(value: Awaited<ReturnType<typeof prepareRootControl>>) {
    const candidate = JSON.parse(JSON.stringify(value)) as typeof value, o = this.options;
    const checked = await verifyControlledAccount(candidate.update.account, candidate.history, o.pin.network, o.genesis, o.owner);
    const tail = checked.history.at(-1);
    if (!tail || tail.digest !== await accountDigest(accountBytes(candidate.update.control)) ||
      accountBytes(candidate.update).length > 16384 || candidate.update.body.domain !== 'sfera-mesh-account-control-update-v1' ||
      candidate.update.body.network !== o.pin.network || candidate.update.body.genesis !== o.genesis ||
      await accountDigest(accountBytes(candidate.vault)) !== checked.record.body.vault_digest) throw new Error('invalid_root_control_candidate');
    const current = await this.controlledHead(), b = tail.record.body;
    if (current.digest === checked.digest && current.checkpoint.controlDigest === tail.digest) return { state: 'confirmed' as const, digest: checked.digest };
    if (b.account_version !== current.checkpoint.accountVersion || b.account_digest !== current.digest ||
      b.previous !== current.checkpoint.controlDigest || b.devices_version !== current.checkpoint.devicesVersion || b.devices_digest !== current.checkpoint.devicesDigest ||
      checked.record.body.previous !== current.digest || checked.record.body.version !== current.record.body.version + 1 ||
      checked.record.body.dialogs_digest !== current.record.body.dialogs_digest ||
      await accountDigest(accountBytes(checked.history.slice(0, -1))) !== await accountDigest(accountBytes(current.history))) throw new Error('root_control_candidate_conflict');
    const result = await this.http('account/publish/', { update: candidate.update, vault: candidate.vault }, true);
    if (!result || Object.keys(result).sort().join(',') !== 'digest,state' || result.digest !== checked.digest || !['pending','confirmed'].includes(result.state)) throw new Error('invalid_account_publish_response');
    const fresh = await this.controlledHead();
    if (fresh.digest === checked.digest && fresh.checkpoint.controlDigest === tail.digest) return { state: 'confirmed' as const, digest: checked.digest };
    if (fresh.digest !== current.digest || fresh.checkpoint.controlDigest !== current.checkpoint.controlDigest) throw new Error('root_control_candidate_conflict');
    return { state: 'pending' as const, digest: checked.digest };
  }
  async publish(record: AccountRecord, vault: Vault) {
    const candidate = JSON.parse(JSON.stringify({ record, vault })), o = this.options;
    const current = await this.head();
    const digest = (await verifyControlledAccount(candidate.record, current.history ?? [], o.pin.network, o.genesis, o.owner)).digest;
    if (await accountDigest(accountBytes(candidate.vault)) !== candidate.record.body.vault_digest) throw new Error('account_candidate_vault_mismatch');
    if (current.digest === digest) return { state: 'confirmed' as const, digest };
    if (candidate.record.body.previous !== current.digest || candidate.record.body.version !== current.record.body.version + 1 ||
      candidate.record.body.dialogs_digest !== current.record.body.dialogs_digest) throw new Error('account_candidate_conflict');
    const result = await this.http('account/publish/', candidate, true);
    if (!result || Object.keys(result).sort().join(',') !== 'digest,state' || result.digest !== digest || !['pending', 'confirmed'].includes(result.state)) throw new Error('invalid_account_publish_response');
    // Even HTTP 200 and a claimed "confirmed" result are insufficient. Require a
    // fresh nonce-bound signed head observing this exact candidate.
    const checked = await this.head();
    if (checked.digest === digest) return { state: 'confirmed' as const, digest };
    if (checked.digest !== current.digest) throw new Error('account_candidate_conflict');
    return { state: 'pending' as const, digest };
  }
}
