import { GuildCipherMessages, parseGuildCipherMessage, openGuildCipherBody } from './guildCipherMessage';
import { verifyGuildCipherStatus } from './guildCipherStatus';
import type { CipherScopeProof } from './cipherPolicy';
/** One persistent device SDK; the entire policy/SDK/ACK operation owns its route. */
import { PairwiseCipher, type CipherIdentity } from './pairwiseCipher';
import { AuthorizedCipher, verifyCipherCertificate, type CipherCertificate, type CipherScopeBody } from './cipherPolicy';
import { accountBytes, accountDigest } from './account';
import { CipherRelayClient } from './cipherRelayClient';
import { receivePendingDmKeys, receivePendingGuildKeys } from './cipherKeyInbox';
import { DmCipherMessages, parseDmCipherMessage, openDmCipherBody, type DmCipherText } from './dmCipherMessage';
import type { CipherArchive } from './cipherArchive';
import { verifyDmCipherStatus } from './dmCipherStatus';
import { entryProbeNonce, validateTrustedEntryPoints, verifyEntryProbe, type TrustedEntryPoint } from './entryPoint';
import { CipherProfileGuard } from './cipherProfileGuard';
import { confirmArchiveDevice } from './archiveDeviceAdmission';

type Options = {
  distributed?:boolean;
  guard: () => boolean; token: () => string;
  review: (body: CipherScopeBody) => Promise<boolean>;
  transport?: typeof fetch;
  profile?: { signer: CryptoKey; devicePublic: string; enabled: boolean };
};
type Channel = { relay: CipherRelayClient; messages: DmCipherMessages; guildMessages: GuildCipherMessages; policy: AuthorizedCipher };
export class DmCipherCoordinator {
  private cipher!: PairwiseCipher;
  private queue: Promise<unknown> = Promise.resolve();
  private active?: Channel;
  private stopping = false;
  private closing?: Promise<void>;
  private abort = new AbortController();
  private pin: TrustedEntryPoint;
  private own: CipherIdentity;
  private user: string;
  private options: Options;
  private profileGuard?: CipherProfileGuard;
  private probeUntil=0;
  private constructor(pin: TrustedEntryPoint, own: CipherIdentity, user: string, options: Options) {
    this.pin = pin; this.own = own; this.user = user; this.options = options;
  }

  static async open(own: CipherIdentity, pin: TrustedEntryPoint, user: string, passphrase: string, options: Options) {
    const { network, nodeId, publicKey, url, label } = pin;
    pin = (await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]))[0];
    own = { ...own };
    if (pin.network !== own.network || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(user) ||
        typeof options.review !== 'function') throw new Error('invalid_dm_coordinator_context');
    const coordinator = new DmCipherCoordinator(pin, own, user, { ...options });
    coordinator.assert();
    const nonce=entryProbeNonce(),probe=await coordinator.http('/api/auth/mesh/entry/',{nonce},false,65536);
    if(await verifyEntryProbe(probe,pin,nonce)!==own.genesis)throw new Error('dm_cipher_entry_changed');
    const required=(probe as {body:{profile_guard?:boolean}}).body.profile_guard===true;
    if(required && !options.profile)throw new Error('cipher_profile_signer_required');
    if (options.profile && (required || options.profile.enabled)) coordinator.profileGuard=new CipherProfileGuard(own,options.profile.devicePublic,pin,options.profile.signer,
      body=>coordinator.post('/api/auth/mesh/cipher/profile/',body),`sphere-e2ee-v1:${own.network}:${own.genesis}:${own.owner}:${own.device}`);
    coordinator.cipher = await PairwiseCipher.open(own, async request => {
      coordinator.assert();
      if (!coordinator.active) {if(coordinator.options.distributed && request.type===0)return JSON.stringify(await coordinator.bootstrap(request));throw new Error('dm_cipher_route_missing');}
      return coordinator.active.relay.relay(request);
    }, { mode: 'persistent', passphrase, profileGuard: coordinator.profileGuard });
    try { coordinator.assert(); return coordinator; }
    catch (error) { await coordinator.cipher.close(); throw error; }
  }
  private assert = () => {
    if (this.stopping || !this.options.guard()) throw new Error('dm_cipher_context_changed_or_closed');
  };
  publicIdentity() { this.assert(); return this.cipher.publicIdentity(); }
  async registerDevice(certificate: CipherCertificate) {
    certificate = JSON.parse(JSON.stringify(certificate));
    const peer = await verifyCipherCertificate(certificate, this.own.network, this.own.genesis);
    const own = this.publicIdentity();
    if ((['network', 'genesis', 'owner', 'device', 'ed25519', 'curve25519'] as const).some(field => peer[field] !== own[field])) throw new Error('dm_cipher_certificate_mismatch');
    let response: unknown;
    const attempts = this.options.distributed ? 4 : 40;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { response = await this.post('/api/auth/mesh/cipher/device/', { certificate }); break; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'dm_cipher_http_503' || attempt === attempts - 1) throw error;
        // The exact persistent SDK certificate may await its consensus commit.
        // Never generate replacement keys or mark an unconfirmed pin ready.
        await new Promise(resolve => setTimeout(resolve, 1000)); this.assert();
      }
    }
    this.assert();
    if (!response || typeof response !== 'object' || Object.keys(response).join(',') !== 'digest' ||
        (response as { digest: unknown }).digest !== await accountDigest(accountBytes(certificate))) throw new Error('dm_cipher_certificate_response_mismatch');
    await this.profileGuard?.activate();
    if(this.options.distributed)await this.cipher.publishDeviceKeys();
  }

  private async bootstrap(request:{id:string;type:number;body:string}) {
    const catalog=await this.http('/api/distribution/catalog/',undefined,false,1048576) as {network:string;genesis:string;profiles:{id:string;owner:string;devices_version:number}[]};
    const profile=catalog.profiles.find(p=>p.owner===this.own.owner && p.id===this.user);
    if(catalog.network!==this.own.network || catalog.genesis!==this.own.genesis || !profile)throw new Error('sdk_bootstrap_profile');
    const body=JSON.parse(request.body);
    for(const [field,kind] of [['one_time_keys','upload'],['fallback_keys','fallback']] as const) {
      if(!Object.keys(body[field]??{}).length)continue;
      const value=await this.cipher.signApplicationKeyCommand({domain:'sfera-mesh-application-key-v1',...this.own,
        devices_version:profile.devices_version,request:await accountDigest(accountBytes([request.id,field])),kind,
        dialog:'',target_owner:'',target_device:'',keys_utf8:Array.from(accountBytes(body[field]),b=>b.toString(16).padStart(2,'0')).join('')});
      let confirmed=false;
      for(let i=0;i<40;i++){this.assert();const result=await this.post('/api/distribution/keys/',{record:value}) as {state:string;receipt?:{digest:string;record:unknown}};
        if(result.state==='confirmed' && result.receipt && result.receipt.digest===await accountDigest(accountBytes(value)) && await accountDigest(accountBytes(result.receipt.record))===result.receipt.digest){confirmed=true;break;}
        if(result.state!=='pending')throw new Error('sdk_bootstrap_key_receipt');await new Promise(r=>setTimeout(r,1000));}
      if(!confirmed)throw new Error('application_key_confirmation_pending');delete body[field];
    }
    delete body.one_time_keys;delete body.fallback_keys;
    const now=Math.floor(Date.now()/1000),payload={domain:'sfera-mesh-sdk-relay-v1',...this.own,source:'device',scope:this.user,
      roster:await accountDigest(accountBytes(['sfera-mesh-sdk-device-scope-v1',this.own.network,this.own.genesis,this.own.owner,this.own.device,profile.devices_version])),
      epoch:profile.devices_version,request:{...request,body:JSON.stringify(body)},issued_at:now,expires_at:now+60};
    return this.post('/api/auth/mesh/cipher/relay/',{record:{body:payload,signature:await this.cipher.signApplicationPayload(payload)}});
  }

  private async http(path: string, body: unknown, authenticated: boolean, limit: number) {
    this.assert();
    const token = authenticated ? this.options.token() : '';
    if (authenticated && (!token || typeof token !== 'string' || token.length > 32768)) throw new Error('dm_cipher_login_required');
    const controller = new AbortController(), abort = () => controller.abort();
    this.abort.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort,path==='/api/auth/mesh/cipher/relay/'?45000:15000);
    try {
      const response = await (this.options.transport ?? fetch)(this.pin.url + path, {
        method: body===undefined?'GET':'POST', body: body===undefined?undefined:JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Ionik-Client': '1',
          ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
      });
      this.assert();
      if ((response.status !== 200 && !(path==='/api/distribution/keys/' && response.status===202)) || response.redirected || (response.url && new URL(response.url).origin !== this.pin.url) ||
          Number(response.headers.get('Content-Length')) > limit) {
        await response.body?.cancel(); throw new Error('dm_cipher_http_' + response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('invalid_dm_cipher_response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); this.assert();
          if (controller.signal.aborted) throw new Error('dm_cipher_request_timed_out');
          if (next.done) break;
          size += next.value.length;
          if (size > limit) { await reader.cancel(); throw new Error('dm_cipher_response_too_large'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const raw = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
    } finally { clearTimeout(timer); controller.abort(); this.abort.signal.removeEventListener('abort', abort); }
  }
  private post = async (path: string, body: unknown) => {
    this.assert();
    if(this.probeUntil<=Date.now()/1000+2) {
      const nonce = entryProbeNonce();
      const probe = await this.http('/api/auth/mesh/entry/', { nonce }, false, 65536);
      if (await verifyEntryProbe(probe, this.pin, nonce) !== this.own.genesis) throw new Error('dm_cipher_entry_changed');
      this.probeUntil=(probe as {body:{expires_at:number}}).body.expires_at;
    }
    this.assert();
    return this.http(path, body, true, 1048576);
  };
  private run<T>(scope: string, task: (channel: Channel) => Promise<T>, source: 'dm' | 'guild' = 'dm'): Promise<T> {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope)) return Promise.reject(new Error('invalid_dm_cipher_scope'));
    const next = this.queue.then(async () => {
      this.assert();
      // No permanent per-chat cache: policy and relay always fetch fresh proofs.
      const relay = new CipherRelayClient({ pin: this.pin, user: this.user, scope, source,
        identity: () => this.publicIdentity(), post: this.post, signKey:body=>this.cipher.signApplicationKeyCommand(body), signPayload:body=>this.cipher.signApplicationPayload(body), review: this.options.review, guard: this.assert });
      const policy = new AuthorizedCipher(this.cipher, this.pin, this.user,
        request => this.post('/api/auth/mesh/cipher/scope/', request), this.assert, this.options.review);
      const channel = { relay, policy, messages: new DmCipherMessages(policy, this.own, this.user), guildMessages: new GuildCipherMessages(policy, this.own, this.user) };
      this.active = channel;
      try { const result = await task(channel); this.assert(); return result; }
      finally { this.active = undefined; }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  publishMessage(scope:string,cipher:unknown,queuedAt:number) { return this.run(scope,channel=>channel.relay.publishMessage(cipher,queuedAt)); }
  publishKeys(scope: string) { return this.run(scope, () => this.cipher.publishKeys()); }
  confirmArchiveDevice(device: string, publicKey: string) {
    this.assert(); return confirmArchiveDevice(this.post, this.pin, this.own, this.user, device, publicKey);
  }
  seal(scope: string, id: string, payload: DmCipherText) {
    const frozen = { text: payload.text, replyTo: payload.replyTo };
    return this.run(scope, channel => channel.messages.seal(scope, id, frozen));
  }
  sealAuthorized(scope: string, id: string, payload: DmCipherText) {
    const frozen = { ...payload };
    return this.run(scope, channel => channel.messages.sealAuthorized(scope, id, frozen));
  }
  async openMessage(scope: string, value: unknown) {
    const frozen = parseDmCipherMessage(value, scope);
    return this.run(scope, channel => channel.messages.open(scope, frozen));
  }
  receiveKeys(scope: string) {
    return this.run(scope, channel => receivePendingDmKeys(channel.policy, channel.relay, scope));
  }
  async archiveOutgoing(scope: string, value: unknown, payload: DmCipherText, archive: CipherArchive, authorization?: CipherScopeProof) {
    const wire = parseDmCipherMessage(value, scope), frozen = { ...payload };
    if (wire.sender.owner !== this.own.owner || wire.sender.device !== this.own.device || wire.sender.user !== this.user) throw new Error('cipher_outgoing_archive_context_mismatch');
    return this.run(scope, async channel => {
      const saved = await archive.rememberOutgoing(channel.policy, scope, wire.envelope,
        JSON.stringify({ domain: wire.domain, scope, id: wire.id, sender: wire.sender, payload: frozen }), authorization);
      return openDmCipherBody(wire, saved.text, saved.authorization);
    });
  }
  async messageStatus(scope: string, values: unknown[]) {
    const wires = values.map(value => parseDmCipherMessage(value, scope));
    if (!wires.length || wires.length > 16 || new Set(wires.map(wire => wire.id)).size !== wires.length) throw new Error('invalid_dm_cipher_status');
    return this.run(scope, async () => {
      const nonce = entryProbeNonce(), response = await this.post('/api/conversations/' + scope + '/messages/cipher/status/', { nonce, messages: wires });
      return verifyDmCipherStatus(response, this.pin, this.publicIdentity(), this.user, scope, nonce, wires);
    });
  }
  acknowledgeRead(scope: string, receipt: unknown) {
    const frozen = JSON.parse(JSON.stringify(receipt));
    return this.run(scope, () => this.post('/api/conversations/' + scope + '/messages/cipher/read/', { receipt: frozen }));
  }
  async openArchived(scope: string, value: unknown, archive: CipherArchive) {
    const wire = parseDmCipherMessage(value, scope);
    return this.run(scope, async channel => {
      let saved = await archive.read('dm', scope, wire.id);
      if (!saved) {
        // Validate all authenticated DM fields before allowing an archive insert.
        await archive.receive(channel.policy, 'dm', scope, wire.sender, wire.envelope, undefined, result => {
          if (result.id !== wire.id) throw new Error('dm_cipher_authenticated_context_mismatch');
          openDmCipherBody(wire, result.text, result.authorization);
        });
        saved = await archive.read('dm', scope, wire.id);
      }
      if (!saved || await accountDigest(accountBytes(saved.envelope)) !== await accountDigest(accountBytes(wire.envelope)) ||
          saved.sender.owner !== wire.sender.owner || saved.sender.device !== wire.sender.device) throw new Error('cipher_archive_message_fork');
      return openDmCipherBody(wire, saved.text, saved.authorization);
    });
  }
  publishGuildKeys(scope: string) { return this.run(scope, () => this.cipher.publishKeys(), 'guild'); }
  sealGuild(guild: string, scope: string, id: string, payload: DmCipherText) {
    const frozen = { ...payload };
    return this.run(scope, channel => channel.guildMessages.seal(guild, scope, id, frozen), 'guild');
  }
  receiveGuildKeys(scope: string) {
    return this.run(scope, channel => receivePendingGuildKeys(channel.policy, channel.relay, scope), 'guild');
  }
  async guildMessageStatus(guild: string, scope: string, values: unknown[]) {
    const wires = values.map(value => parseGuildCipherMessage(value, guild, scope));
    if (!wires.length || wires.length > 16 || new Set(wires.map(wire => wire.id)).size !== wires.length) throw new Error('invalid_guild_cipher_status');
    return this.run(scope, async () => {
      const nonce = entryProbeNonce(), response = await this.post('/api/guilds/' + guild + '/channels/' + scope + '/messages/cipher/status/', { nonce, messages: wires });
      return verifyGuildCipherStatus(response, this.pin, this.publicIdentity(), this.user, guild, scope, nonce, wires);
    }, 'guild');
  }
  async archiveGuildOutgoing(guild: string, scope: string, value: unknown, payload: DmCipherText, archive: CipherArchive, authorization?: CipherScopeProof) {
    const wire = parseGuildCipherMessage(value, guild, scope), frozen = { ...payload };
    if (wire.sender.owner !== this.own.owner || wire.sender.device !== this.own.device || wire.sender.user !== this.user) throw new Error('cipher_outgoing_archive_context_mismatch');
    return this.run(scope, async channel => {
      const saved = await archive.rememberOutgoing(channel.policy, scope, wire.envelope,
        JSON.stringify({ domain: wire.domain, guild, scope, id: wire.id, sender: wire.sender, payload: frozen }), authorization, 'guild');
      return openGuildCipherBody(wire, saved.text, saved.authorization);
    }, 'guild');
  }
  async openGuildArchived(guild: string, scope: string, value: unknown, archive: CipherArchive, authorization?: CipherScopeProof) {
    const wire = parseGuildCipherMessage(value, guild, scope);
    return this.run(scope, async channel => {
      let saved = await archive.read('guild', scope, wire.id);
      if (!saved) {
        if (authorization) {
          const result = await channel.policy.decryptHistorical('guild', scope, wire.sender, wire.envelope, authorization);
          openGuildCipherBody(wire, result.text, result.authorization);
        } else await channel.guildMessages.open(guild, scope, wire);
        await archive.receive(channel.policy, 'guild', scope, wire.sender, wire.envelope, authorization);
        saved = await archive.read('guild', scope, wire.id);
      }
      if (!saved || await accountDigest(accountBytes(saved.envelope)) !== await accountDigest(accountBytes(wire.envelope)) ||
          saved.sender.owner !== wire.sender.owner || saved.sender.device !== wire.sender.device) throw new Error('cipher_archive_message_fork');
      return openGuildCipherBody(wire, saved.text, saved.authorization);
    }, 'guild');
  }
  close() {
    if (!this.closing) {
      this.stopping = true; this.abort.abort();
      this.closing = this.queue.then(() => this.cipher.close());
    }
    return this.closing;
  }
}
