import { accountBytes, accountDigest } from './account';
import type { EntryPointPin } from './auth';

export type TrustedEntryPoint = EntryPointPin & { url: string; label: string; id: string };
export type EntryPointTicket = { revision: number; entry: TrustedEntryPoint };
const hex32 = /^[0-9a-f]{64}$/;
export const ENTRY_PIN_KEY = 'sfera_mesh_selected_entry_v1';
type PinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export async function loadEntryPointPin(storage: PinStorage): Promise<TrustedEntryPoint | null> {
  const raw = storage.getItem(ENTRY_PIN_KEY);
  if (raw === null) return null;
  if (raw.length > 32768) throw new Error('invalid_entry_point_pin');
  const entries = await validateTrustedEntryPoints([JSON.parse(raw)]);
  return entries[0];
}

export function saveEntryPointPin(storage: PinStorage, entry: TrustedEntryPoint | null) {
  if (!entry) { storage.removeItem(ENTRY_PIN_KEY); return; }
  const { network, nodeId, publicKey, url, label } = entry;
  storage.setItem(ENTRY_PIN_KEY, JSON.stringify({ network, nodeId, publicKey, url, label }));
}

export const entryProbeNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');

export async function verifyEntryProbe(value: unknown, pin: TrustedEntryPoint, nonce: string,
  now = Math.floor(Date.now() / 1000)): Promise<string> {
  const message = value as { body: Record<string, unknown>; signature: string };
  if (!message || Object.keys(message).sort().join(',') !== 'body,signature' ||
      !message.body || !['domain,entry,expires_at,genesis,issued_at,network,nonce','domain,entry,expires_at,genesis,issued_at,network,nonce,profile_guard'].includes(Object.keys(message.body).sort().join(',')) ||
      ('profile_guard' in message.body && message.body.profile_guard !== true) ||
      typeof message.signature !== 'string' || !/^[0-9a-f]{128}$/.test(message.signature)) throw new Error('invalid_entry_probe');
  const body = message.body;
  if (body.domain !== 'sfera-mesh-application-entry-v1' || body.network !== pin.network || body.entry !== pin.nodeId ||
      !hex32.test(nonce) || body.nonce !== nonce || typeof body.genesis !== 'string' || !hex32.test(body.genesis) ||
      typeof body.issued_at !== 'number' || typeof body.expires_at !== 'number' ||
      !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) ||
      body.issued_at > now + 5 || body.issued_at < now - 15 || body.expires_at <= now ||
      body.expires_at !== body.issued_at + 15) throw new Error('entry_probe_context_mismatch');
  const { network, nodeId, publicKey, url, label } = pin;
  await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
  const raw = Uint8Array.from(publicKey.match(/../g)!, part => parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', raw.buffer, 'Ed25519', false, ['verify']);
  const signature = Uint8Array.from(message.signature.match(/../g)!, part => parseInt(part, 16));
  const bytes = new Uint8Array(accountBytes(body));
  if (!await crypto.subtle.verify('Ed25519', key, signature.buffer, bytes.buffer)) throw new Error('invalid_entry_signature');
  return body.genesis;
}

/** Input must come from a trusted local catalogue or explicit fingerprint review.
 * A server advertising its own key cannot establish this trust binding.
 */
export async function validateTrustedEntryPoints(input: unknown): Promise<TrustedEntryPoint[]> {
  if (!Array.isArray(input) || input.length > 64) throw new Error('invalid_entry_point_catalogue');
  const result: TrustedEntryPoint[] = [], origins = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'label,network,nodeId,publicKey,url') throw new Error('invalid_entry_point_schema');
    const { network, nodeId, publicKey, url, label } = value as Record<string, unknown>;
    if (typeof network !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(network) || typeof nodeId !== 'string' || !hex32.test(nodeId) || typeof publicKey !== 'string' || !hex32.test(publicKey) || typeof label !== 'string' || !label.trim() || label.length > 80 || typeof url !== 'string') throw new Error('invalid_entry_point_fields');
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash || (address.pathname !== '/' && address.pathname !== '')) throw new Error('https_entry_point_origin_required');
    const domain = new TextEncoder().encode('sfera-mesh-node-v1\0');
    const bytes = Uint8Array.from(publicKey.match(/../g)!, part => parseInt(part, 16));
    const combined = new Uint8Array(domain.length + bytes.length); combined.set(domain); combined.set(bytes, domain.length);
    if (await accountDigest(combined) !== nodeId) throw new Error('entry_point_key_mismatch');
    if (origins.has(address.origin)) throw new Error('duplicate_entry_point_address');
    origins.add(address.origin);
    result.push({ network, nodeId, publicKey, url: address.origin, label: label.trim(), id: `${network}:${nodeId}@${address.origin}` });
  }
  return result;
}

/** Explicit selection only. Offline events never change the selected server. */
export class EntryPointSelection {
  private entries: TrustedEntryPoint[];
  private selected: TrustedEntryPoint | null = null;
  private revision = 0;
  private offline = false;

  private constructor(entries: TrustedEntryPoint[]) { this.entries = entries; }
  static async create(input: unknown) { return new EntryPointSelection(await validateTrustedEntryPoints(input)); }
  catalogue() { return this.entries.map(entry => ({ ...entry })); }
  status() { return { entry: this.selected ? { ...this.selected } : null, offline: this.offline, revision: this.revision }; }
  select(id: string) {
    const entry = this.entries.find(candidate => candidate.id === id);
    if (!entry) throw new Error('unknown_trusted_entry_point');
    this.selected = entry; this.revision++; this.offline = false;
    return this.status();
  }
  clear() { this.selected = null; this.offline = false; this.revision++; }
  beginRequest(): EntryPointTicket {
    if (!this.selected) throw new Error('entry_point_selection_required');
    return { revision: this.revision, entry: { ...this.selected } };
  }
  assertCurrent(ticket: EntryPointTicket) {
    if (!this.selected || ticket.revision !== this.revision || ticket.entry.id !== this.selected.id || ticket.entry.url !== this.selected.url || ticket.entry.publicKey !== this.selected.publicKey || ticket.entry.nodeId !== this.selected.nodeId || ticket.entry.network !== this.selected.network) throw new Error('entry_point_selection_changed');
  }
  markUnavailable(ticket: EntryPointTicket) { this.assertCurrent(ticket); this.offline = true; }
}
