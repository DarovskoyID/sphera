import { entryProbeNonce, validateTrustedEntryPoints, verifyEntryProbe, type TrustedEntryPoint } from './entryPoint';
import type { CipherArchive } from './cipherArchive';
import { ARCHIVE_DELETION_LIMIT, assembleArchiveDeletion, type ArchiveDeletion, type ArchiveDeletionPage } from './archiveDeletion';

export type RecoveryScope = { source: 'dm' | 'guild'; scope: string; root_hash: string; generation: number; messages: number; latest_at: string | null;
  format?: 2; deleted_count?: number };
export type RecoveryFile = { id: string; filename: string; content_type: string; file_size: number };
export type RecoveryMessage = { id: string; content: string; created_at: string;
  author: { id: string; username: string }; attachments: RecoveryFile[]; detail?: string; message_type?: unknown; payload?: unknown };
export type RecoveryPage = { publisher: string; genesis: string; source: 'dm' | 'guild'; scope: string;
  root_hash: string; generation: number; messages: RecoveryMessage[]; deleted_ids: string[]; next_before: string | null; order?: 'uuid_desc' | 'time_desc' };
export type RecoveryCatalog = { publisher: string; genesis: string; catalog: string; scopes: RecoveryScope[]; next_after: string | null };
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
type PagedEntry = { message_id: string; author_id: string; created_at: string | null; snapshot_hash: string;
  cluster: string; digest: string; size: number; deleted: boolean; order_key?: string };
/** Exact microseconds since year 1 plus UUID, matching the server time radix key. */
export function recoveryOrderKey(createdAt: string, id: string): string {
  const match = typeof createdAt === 'string' ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(createdAt) : null;
  const millis = Date.parse(createdAt);
  if (!match || !Number.isFinite(millis) || typeof id !== 'string' || !uuid.test(id)) throw new RecoveryError('invalid');
  const micros = BigInt(millis) * 1000n + BigInt((match[1] ?? '').padEnd(6, '0').slice(3)) + 62135596800000000n;
  if (micros < 0 || micros > 315537897599999999n) throw new RecoveryError('invalid');
  return micros.toString(16).padStart(16, '0') + id.replace(/-/g, '');
}
export class RecoveryError extends Error {
  readonly code: 'cancelled' | 'changed' | 'forbidden' | 'unavailable' | 'invalid';
  constructor(code: RecoveryError['code']) { super(code); this.code = code; }
}
export function recoveryFilename(value: string) {
  const name = value.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200).trim();
  return !name || /^\.+$/.test(name) ? 'recovered-file' : name;
}
export function recoveryDetails(value: { message_type?: unknown; payload?: unknown }): string {
  const kind = value.message_type;
  if (kind === undefined || kind === 'text') return '';
  if (kind === 'cipher') return 'Зашифрованное сообщение';
  const payload = value.payload as Record<string, unknown> | null;
  const text = (field: unknown, max = 4096): string => {
    if (typeof field !== 'string' || field.length > max) throw new RecoveryError('invalid');
    return field;
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RecoveryError('invalid');
  if (kind === 'todo') {
    if (!Array.isArray(payload.items) || payload.items.length > 25) throw new RecoveryError('invalid');
    return [text(payload.title), ...payload.items.map((item: { done?: unknown; text?: unknown }) => {
      if (!item || typeof item.done !== 'boolean') throw new RecoveryError('invalid');
      return `${item.done ? '✓' : '○'} ${text(item.text, 200)}`;
    })].join('\n');
  }
  if (kind === 'poll') {
    if (!Array.isArray(payload.options) || payload.options.length > 10) throw new RecoveryError('invalid');
    return ['Сохранённые результаты опроса', text(payload.question), ...payload.options.map((option: { text?: unknown; count?: unknown }) => {
      if (!option || !integer(option.count, 256)) throw new RecoveryError('invalid');
      return `${text(option.text)} — ${option.count}`;
    })].join('\n');
  }
  if (kind === 'contact') {
    if (payload.kind === 'manual') return `Контакт: ${text(payload.name)}\n${text(payload.phone, 1024)}`;
    if (payload.kind === 'user') return `Контакт: ${text(payload.nickname) || text(payload.username)}`;
  }
  if (kind === 'location' && typeof payload.lat === 'number' && Number.isFinite(payload.lat) && Math.abs(payload.lat) <= 90 &&
      typeof payload.lng === 'number' && Number.isFinite(payload.lng) && Math.abs(payload.lng) <= 180) {
    return `Сохранённая геопозиция${payload.label ? ': ' + text(payload.label) : ''}\nКоординаты: ${payload.lat}, ${payload.lng}`;
  }
  throw new RecoveryError('invalid');
}

/** Read-only server-verified BFT recovery over an explicitly pinned HTTPS entry.
 * This client does not claim to independently verify BFT proofs in the browser.
 * No recovered plaintext or response is written to a browser cache.
 */
export class RecoveryClient {
  private genesis = '';
  private publisher: string | null = null;
  private checkedAt = 0;
  private pin: TrustedEntryPoint;
  private token: string;
  private signal: AbortSignal;
  private guard: () => boolean;
  private transport: typeof fetch;
  private timeCursors = new Map<string, { root: string; id: string; key: string }>();
  private constructor(pin: TrustedEntryPoint, token: string, signal: AbortSignal, guard: () => boolean, transport: typeof fetch) {
    this.pin = pin; this.token = token; this.signal = signal; this.guard = guard; this.transport = transport;
  }
  static async open(origin: string, pin: TrustedEntryPoint, token: string, signal: AbortSignal,
    guard: () => boolean, transport: typeof fetch = fetch) {
    const validated = (await validateTrustedEntryPoints([{
      network: pin.network, nodeId: pin.nodeId, publicKey: pin.publicKey, url: pin.url, label: pin.label,
    }]))[0];
    const address = new URL(origin);
    if (address.origin !== validated.url || address.pathname !== '/' || address.search || address.hash ||
        address.username || address.password || !token) throw new RecoveryError('invalid');
    const client = new RecoveryClient(validated, token, signal, guard, transport);
    client.assert(); await client.probe(); return client;
  }
  private assert() { if (this.signal.aborted || !this.guard()) throw new RecoveryError('cancelled'); }
  private async bytes(response: Response, limit: number) {
    const size = Number(response.headers.get('Content-Length'));
    if (size > limit) throw new RecoveryError('invalid');
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        this.assert(); const part = await reader.read(); this.assert();
        if (part.done) break;
        length += part.value.length;
        if (length > limit) { await reader.cancel(); throw new RecoveryError('invalid'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
  private async request(path: string, init: RequestInit = {}, authenticated = true) {
    for (let attempt = 0; ; attempt++) {
      this.assert();
      if (attempt) await this.trusted();
      const response = await this.transport(this.pin.url + path, { ...init, signal: this.signal, redirect: 'error',
        credentials: 'omit', cache: 'no-store', headers: { ...(authenticated ? { Authorization: 'Bearer ' + this.token } : {}), ...init.headers } });
      this.assert();
      if (response.ok) return response;
      if (response.status === 503 && authenticated && (init.method ?? 'GET') === 'GET' &&
          path.startsWith('/api/mesh/recovery/') && response.headers.get('Retry-After') === '1' && attempt < 31) {
        const value = await this.json(response, 1024) as { detail?: unknown } | null;
        if (value && typeof value === 'object' && value.detail === 'history_verification_in_progress') {
          await this.waitForVerification();
          continue;
        }
      }
      throw new RecoveryError(response.status === 409 ? 'changed' : [401, 403].includes(response.status) ? 'forbidden' : 'unavailable');
    }
  }
  private async waitForVerification() {
    this.assert();
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => { clearTimeout(timer); this.signal.removeEventListener('abort', cancelled); reject(new RecoveryError('cancelled')); };
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', cancelled); resolve(); }, 1000);
      this.signal.addEventListener('abort', cancelled, { once: true });
      if (this.signal.aborted) cancelled();
    });
    this.assert();
  }
  private async json(response: Response, limit = 5 * 1048576): Promise<unknown> {
    const raw = await this.bytes(response, limit); this.assert();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new RecoveryError('invalid'); }
  }
  private async probe() {
    const nonce = entryProbeNonce();
    const response = await this.request('/api/auth/mesh/entry/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }),
    }, false);
    const genesis = await verifyEntryProbe(await this.json(response, 65536), this.pin, nonce);
    this.assert();
    if (this.genesis && this.genesis !== genesis) throw new RecoveryError('invalid');
    this.genesis = genesis; this.checkedAt = Date.now();
  }
  private async trusted() { this.assert(); if (Date.now() < this.checkedAt || Date.now() - this.checkedAt > 10000) await this.probe(); }
  private context(value: unknown) {
    if (!value || typeof value !== 'object' || !('genesis' in value) || !('publisher' in value) ||
        value.genesis !== this.genesis || typeof value.publisher !== 'string' || !hex.test(value.publisher) ||
        (this.publisher !== null && value.publisher !== this.publisher)) throw new RecoveryError('invalid');
  }
  async scopes(after?: string, catalog?: string): Promise<RecoveryCatalog> {
    await this.trusted();
    if ((after !== undefined && (!hex.test(after) || !catalog || !hex.test(catalog)))) throw new RecoveryError('invalid');
    const query = after ? `?after=${after}&catalog=${catalog}` : '';
    const value = await this.json(await this.request('/api/mesh/recovery/scopes/' + query)) as RecoveryCatalog & { domain: unknown };
    this.context(value);
    if (value.domain !== 'sfera-mesh-recovery-catalog-v1' || !hex.test(value.catalog) || !Array.isArray(value.scopes) || value.scopes.length > 4 ||
        (value.next_after !== null && (!hex.test(value.next_after) || (after && value.next_after <= after))) || (catalog && value.catalog !== catalog)) throw new RecoveryError('invalid');
    const identities = new Set<string>();
    for (const scope of value.scopes) {
      if (!scope || !['dm', 'guild'].includes(scope.source) || !uuid.test(scope.scope) || !hex.test(scope.root_hash) ||
          !integer(scope.generation, Number.MAX_SAFE_INTEGER) || scope.generation < 1 || !integer(scope.messages, 256) ||
          (scope.latest_at !== null && !timestamp(scope.latest_at)) || identities.has(scope.source + scope.scope)) throw new RecoveryError('invalid');
      identities.add(scope.source + scope.scope);
    }
    this.publisher = value.publisher; this.assert(); return value;
  }
  async messages(scope: RecoveryScope, before?: string): Promise<RecoveryPage> {
    if (scope.format === 2) return this.pagedMessages(scope, before);
    await this.trusted();
    if (this.publisher === null) throw new RecoveryError('invalid');
    if (!['dm', 'guild'].includes(scope.source) || !uuid.test(scope.scope) || !hex.test(scope.root_hash) || (before !== undefined && !uuid.test(before))) throw new RecoveryError('invalid');
    const value = await this.json(await this.request(`/api/mesh/recovery/${scope.source}/${scope.scope}/messages/?root=${scope.root_hash}${before ? '&before=' + before : ''}`)) as RecoveryPage & { domain: unknown };
    this.context(value);
    if (value.domain !== 'sfera-mesh-recovered-message-page-v1' || value.source !== scope.source || value.scope !== scope.scope || value.root_hash !== scope.root_hash ||
        value.generation !== scope.generation || !Array.isArray(value.messages) || value.messages.length > 32 || !Array.isArray(value.deleted_ids) || value.deleted_ids.length > 256 ||
        !value.deleted_ids.every((id: unknown) => typeof id === 'string' && uuid.test(id)) || new Set(value.deleted_ids).size !== value.deleted_ids.length ||
        (value.next_before !== null && !uuid.test(value.next_before))) throw new RecoveryError('invalid');
    const seen = new Set<string>();
    for (const row of value.messages) {
      if (!row || !uuid.test(row.id) || seen.has(row.id) || value.deleted_ids.includes(row.id) || typeof row.content !== 'string' || row.content.length > 131000 ||
          !timestamp(row.created_at) || !row.author || !uuid.test(row.author.id) || typeof row.author.username !== 'string' || row.author.username.length > 256 ||
          !Array.isArray(row.attachments) || row.attachments.length > 15) throw new RecoveryError('invalid');
      const files = new Set<string>();
      for (const file of row.attachments) {
        if (!file || !uuid.test(file.id) || files.has(file.id) || typeof file.filename !== 'string' || file.filename.length > 1024 ||
            typeof file.content_type !== 'string' || file.content_type.length > 1024 || !integer(file.file_size, 64 * 120000)) throw new RecoveryError('invalid');
        files.add(file.id);
      }
      seen.add(row.id);
      row.detail = recoveryDetails(row);
    }
    if (value.next_before !== null && !seen.has(value.next_before)) throw new RecoveryError('invalid');
    this.assert(); return value;
  }
  async pagedScopes(after?: string, catalog?: string): Promise<RecoveryCatalog> {
    await this.trusted();
    if ((catalog !== undefined && !hex.test(catalog)) || (after !== undefined && (!hex.test(after) || !catalog))) throw new RecoveryError('invalid');
    const query = new URLSearchParams();
    query.set('limit', '1');
    if (after) query.set('after', after);
    if (catalog) query.set('catalog', catalog);
    const value = await this.json(await this.request('/api/mesh/recovery/paged-scopes/?' + query)) as RecoveryCatalog & { domain: unknown };
    this.context(value);
    if (value.domain !== 'sfera-mesh-recovery-catalog-v2' || typeof value.catalog !== 'string' || !hex.test(value.catalog) ||
        (catalog && value.catalog !== catalog) || !Array.isArray(value.scopes) || value.scopes.length > 4 ||
        (value.next_after !== null && (typeof value.next_after !== 'string' || !hex.test(value.next_after) || (after && value.next_after <= after)))) throw new RecoveryError('invalid');
    const seen = new Set<string>();
    for (const scope of value.scopes) {
      if (!scope || !['dm', 'guild'].includes(scope.source) || typeof scope.scope !== 'string' || !uuid.test(scope.scope) ||
          typeof scope.root_hash !== 'string' || !hex.test(scope.root_hash) || !integer(scope.generation, Number.MAX_SAFE_INTEGER) || scope.generation < 1 ||
          !integer(scope.messages, Number.MAX_SAFE_INTEGER) || !integer(scope.deleted_count, Number.MAX_SAFE_INTEGER) ||
          !Number.isSafeInteger(scope.messages + scope.deleted_count!) || seen.has(scope.source + scope.scope)) throw new RecoveryError('invalid');
      seen.add(scope.source + scope.scope); scope.format = 2; scope.latest_at = null;
    }
    this.publisher = value.publisher; this.assert(); return value;
  }
  private async pagedMessages(selected: RecoveryScope, before?: string): Promise<RecoveryPage> {
    const scope = { ...selected };
    await this.trusted();
    if (!this.publisher || !['dm', 'guild'].includes(scope.source) || !uuid.test(scope.scope) || !hex.test(scope.root_hash) ||
        !integer(scope.generation, Number.MAX_SAFE_INTEGER) || scope.generation < 1 || !integer(scope.messages, Number.MAX_SAFE_INTEGER) ||
        !integer(scope.deleted_count, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(scope.messages + scope.deleted_count!) ||
        (before !== undefined && !uuid.test(before))) throw new RecoveryError('invalid');
    const base = `/api/mesh/recovery/${scope.source}/${scope.scope}/`;
    const cursorContext = scope.source + scope.scope;
    const cursor = this.timeCursors.get(cursorContext);
    if (before !== undefined && (!cursor || cursor.root !== scope.root_hash || cursor.id !== before)) throw new RecoveryError('invalid');
    const value = await this.json(await this.request(`${base}entries/?root=${scope.root_hash}&order=time${before ? '&before=' + before : ''}`)) as {
      domain: string; source: string; scope: string; root_hash: string; generation: number; order: string;
      count: number; deleted_count: number; entries: PagedEntry[]; next_before: string | null };
    this.context(value);
    if (value.domain !== 'sfera-mesh-recovery-entries-v2' || value.source !== scope.source || value.scope !== scope.scope ||
        value.root_hash !== scope.root_hash || value.generation !== scope.generation || value.order !== 'time_desc' ||
        value.count !== scope.messages + scope.deleted_count! || value.deleted_count !== scope.deleted_count ||
        !Array.isArray(value.entries) || value.entries.length > 32 || value.entries.length > value.count) throw new RecoveryError('invalid');
    let previous = before !== undefined ? cursor!.key : undefined;
    const identities = new Set<string>();
    for (const entry of value.entries) {
      if (!entry || typeof entry.message_id !== 'string' || !uuid.test(entry.message_id) || identities.has(entry.message_id) ||
          typeof entry.author_id !== 'string' || !uuid.test(entry.author_id) || entry.deleted !== false || !timestamp(entry.created_at) ||
          entry.order_key !== recoveryOrderKey(entry.created_at!, entry.message_id) || (previous !== undefined && entry.order_key >= previous) ||
          ![entry.snapshot_hash, entry.cluster, entry.digest].every(item => typeof item === 'string' && hex.test(item)) ||
          !integer(entry.size, 262144) || entry.size < 1) throw new RecoveryError('invalid');
      previous = entry.order_key;
      identities.add(entry.message_id);
    }
    const deleted = value.entries.filter(entry => entry.deleted).length;
    if (deleted > value.deleted_count || value.entries.length - deleted > scope.messages) throw new RecoveryError('invalid');
    if (value.next_before !== null && (value.entries.length === 0 || value.next_before !== value.entries.at(-1)!.message_id)) throw new RecoveryError('invalid');
    const messages: RecoveryMessage[] = [];
    if (value.entries.length) {
      const bodies = await this.json(await this.request(`${base}bodies/?root=${scope.root_hash}&ids=${value.entries.map(entry => entry.message_id).join(',')}`)) as {
        domain: string; source: string; scope: string; root_hash: string; generation: number;
        messages: { message_id: string; status: string; display: RecoveryMessage | null }[] };
      this.context(bodies);
      if (bodies.domain !== 'sfera-mesh-recovered-bodies-v2' || bodies.source !== scope.source || bodies.scope !== scope.scope ||
          bodies.root_hash !== scope.root_hash || bodies.generation !== scope.generation || !Array.isArray(bodies.messages) ||
          bodies.messages.length !== value.entries.length) throw new RecoveryError('invalid');
      bodies.messages.forEach((item, index) => {
        const entry = value.entries[index];
        if (!item || item.message_id !== entry.message_id || item.status !== (entry.deleted ? 'deleted' : 'live') ||
            (entry.deleted && item.display !== null)) throw new RecoveryError('invalid');
        if (entry.deleted) return;
        const row = item.display;
        if (!row || row.id !== entry.message_id || row.created_at !== entry.created_at || typeof row.content !== 'string' || row.content.length > 131000 ||
            !row.author || row.author.id !== entry.author_id || typeof row.author.username !== 'string' || row.author.username.length > 256 ||
            !Array.isArray(row.attachments) || row.attachments.length > 15) throw new RecoveryError('invalid');
        const seen = new Set<string>();
        for (const file of row.attachments) {
          if (!file || typeof file.id !== 'string' || !uuid.test(file.id) || seen.has(file.id) || typeof file.filename !== 'string' || file.filename.length > 1024 ||
              typeof file.content_type !== 'string' || file.content_type.length > 1024 || !integer(file.file_size, 64 * 120000)) throw new RecoveryError('invalid');
          seen.add(file.id);
        }
        row.detail = recoveryDetails(row); messages.push(row);
      });
    }
    this.assert();
    const last = value.entries.at(-1);
    if (last) {
      this.timeCursors.set(cursorContext, { root: scope.root_hash, id: last.message_id, key: last.order_key! });
      if (this.timeCursors.size > 128) this.timeCursors.delete(this.timeCursors.keys().next().value!);
    }
    return { publisher: this.publisher, genesis: this.genesis, source: scope.source, scope: scope.scope,
      root_hash: scope.root_hash, generation: scope.generation, messages, order: 'time_desc',
      deleted_ids: value.entries.filter(entry => entry.deleted).map(entry => entry.message_id), next_before: value.next_before };
  }
  async attachment(scope: RecoveryScope, message: RecoveryMessage, file: RecoveryFile): Promise<Blob> {
    await this.trusted();
    if (this.publisher === null) throw new RecoveryError('invalid');
    if (!['dm', 'guild'].includes(scope.source) || !uuid.test(scope.scope) || !hex.test(scope.root_hash) || !uuid.test(message.id) ||
        !uuid.test(file.id) || !integer(file.file_size, 64 * 120000)) throw new RecoveryError('invalid');
    const response = await this.request(`/api/mesh/recovery/${scope.source}/${scope.scope}/messages/${message.id}/attachments/${file.id}/?root=${scope.root_hash}`);
    if (response.headers.get('X-Recovery-Root') !== scope.root_hash) throw new RecoveryError('invalid');
    const bytes = await this.bytes(response, 64 * 120000); this.assert();
    if (bytes.length !== file.file_size) throw new RecoveryError('invalid');
    return new Blob([bytes], { type: 'application/octet-stream' });
  }
  async syncArchiveDeletions(scope: RecoveryScope, archive: CipherArchive) {
    scope = { ...scope };
    await this.trusted();
    const publisher = this.publisher;
    if (!publisher || !['dm', 'guild'].includes(scope.source) || !uuid.test(scope.scope) ||
        !hex.test(scope.root_hash) || !integer(scope.generation, Number.MAX_SAFE_INTEGER) || scope.generation < 1) throw new RecoveryError('invalid');
    const nonce = entryProbeNonce();
    if (scope.format === 2) {
      if (!integer(scope.deleted_count, ARCHIVE_DELETION_LIMIT)) throw new RecoveryError('unavailable');
      const pages: ArchiveDeletionPage[] = [];
      let before: string | null = null;
      const started = Date.now();
      for (let index = 0; index < 64; index++) {
        this.assert();
        if (Date.now() < started || Date.now() - started > 120000) throw new RecoveryError('unavailable');
        const value = await this.json(await this.request(`/api/mesh/recovery/${scope.source}/${scope.scope}/deletion-pages/?root=${scope.root_hash}&nonce=${nonce}${before ? '&before=' + before : ''}`), 16384);
        const page = await archive.verifyDeletionPage(value, scope.source, scope.scope, publisher, nonce);
        this.assert();
        if (page.body.root !== scope.root_hash || page.body.version !== scope.generation) throw new RecoveryError('changed');
        if (page.body.before !== before || page.body.total_deleted !== scope.deleted_count) throw new RecoveryError('invalid');
        pages.push(page); before = page.body.next_before;
        if (before === null) {
          const result = await archive.applyDeletions(assembleArchiveDeletion(pages), scope.source, scope.scope, publisher, nonce);
          this.assert(); return result;
        }
      }
      throw new RecoveryError('unavailable');
    }
    const receipt = await this.json(await this.request(`/api/mesh/recovery/${scope.source}/${scope.scope}/deletions/?root=${scope.root_hash}&nonce=${nonce}`), 16384) as ArchiveDeletion;
    this.assert();
    if (receipt?.body?.root !== scope.root_hash || receipt.body.version !== scope.generation) throw new RecoveryError('changed');
    const result = await archive.applyDeletions(receipt, scope.source, scope.scope, publisher, nonce);
    this.assert(); return result;
  }
  /** All archive scopes must appear in unchanged authorized catalogues.
   * No imported plaintext is exposed if any scope lacks a fresh receipt.
   */
  async openArchive(archive: CipherArchive, backup?: unknown) {
    await this.trusted(); archive.assertNetwork(this.pin.network, this.genesis);
    const wanted = await archive.exportScopes();
    if (backup !== undefined) wanted.push(...await archive.exportScopes(backup));
    const catalog = new Map<string, RecoveryScope>();
    for (const paged of [false, true]) {
      let after: string | undefined, digest: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 32) throw new RecoveryError('invalid');
        const result = await (paged ? this.pagedScopes(after, digest) : this.scopes(after, digest));
        digest = result.catalog;
        for (const scope of result.scopes) {
          const key = scope.source + scope.scope;
          if (catalog.has(key)) throw new RecoveryError('invalid');
          catalog.set(key, scope);
        }
        if (!result.next_after) break;
        after = result.next_after;
      }
    }
    const selected = new Map<string, RecoveryScope>();
    for (const item of wanted) {
      const scope = catalog.get(item.source + item.scope);
      if (!scope) throw new RecoveryError('forbidden');
      selected.set(item.source + item.scope, scope);
    }
    for (const scope of selected.values()) await this.syncArchiveDeletions(scope, archive);
    this.assert();
    if (backup !== undefined) await archive.restore(backup, { currentCheckpointsRequired: true });
    this.assert(); return [...selected.values()];
  }
}
