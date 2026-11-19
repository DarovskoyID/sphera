/** The pinned entry attests a deletion it verified against consensus.
 * This signature is an entry attestation, not a browser-verified BFT proof.
 */
import { accountBytes } from './account';
import { validateTrustedEntryPoints, type TrustedEntryPoint } from './entryPoint';

export type LegacyArchiveDeletion = { body: {
  domain: 'sfera-mesh-archive-deletions-v1'; network: string; genesis: string;
  entry: string; user: string; owner: string; publisher: string;
  source: 'dm' | 'guild'; scope: string; root: string; version: number;
  deleted: string[]; nonce: string; issued_at: number; expires_at: number;
  authority: 'selected_entry_verified_consensus';
}; signature: string };
export type ArchiveDeletionPage = { body: Omit<LegacyArchiveDeletion['body'], 'domain'> & {
  domain: 'sfera-mesh-archive-deletion-page-v2'; before: string | null; next_before: string | null; total_deleted: number;
}; signature: string };
export type PagedArchiveDeletion = { body: Omit<LegacyArchiveDeletion['body'], 'domain'> & {
  domain: 'sfera-mesh-archive-deletions-checkpoint-v2';
}; pages: ArchiveDeletionPage[] };
export type ArchiveDeletion = LegacyArchiveDeletion | PagedArchiveDeletion;
export const ARCHIVE_DELETION_LIMIT = 16384;
type DeletionContext = { genesis: string; user: string; owner: string; publisher: string; source: 'dm' | 'guild'; scope: string };
const hex = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function verifySigned(value: unknown, pin: TrustedEntryPoint, context: DeletionContext,
  nonce: string, now: number, paged: boolean): Promise<LegacyArchiveDeletion | ArchiveDeletionPage> {
  const receipt: LegacyArchiveDeletion | ArchiveDeletionPage = JSON.parse(JSON.stringify(value));
  const body = receipt?.body;
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'body,signature' || !body ||
      Object.keys(body).sort().join(',') !== (paged ? 'authority,before,deleted,domain,entry,expires_at,genesis,issued_at,network,next_before,nonce,owner,publisher,root,scope,source,total_deleted,user,version' :
        'authority,deleted,domain,entry,expires_at,genesis,issued_at,network,nonce,owner,publisher,root,scope,source,user,version') ||
      accountBytes(receipt).length > 16384 || body.domain !== (paged ? 'sfera-mesh-archive-deletion-page-v2' : 'sfera-mesh-archive-deletions-v1') ||
      body.authority !== 'selected_entry_verified_consensus' || body.entry !== pin.nodeId || body.network !== pin.network ||
      !['genesis', 'owner', 'publisher', 'root', 'nonce'].every(field => typeof body[field as 'root'] === 'string' && hex.test(body[field as 'root'])) ||
      typeof body.user !== 'string' || !uuid.test(body.user) || typeof body.scope !== 'string' || !uuid.test(body.scope) || !['dm', 'guild'].includes(body.source) ||
      !Object.entries(context).every(([key, expected]) => body[key as keyof typeof context] === expected) ||
      !hex.test(nonce) || body.nonce !== nonce || !Number.isSafeInteger(body.version) || body.version < 1 ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(body.issued_at) || !Number.isSafeInteger(body.expires_at) ||
      body.expires_at !== body.issued_at + 15 || body.issued_at > now + 5 || body.issued_at < now - 15 || body.expires_at <= now ||
      !Array.isArray(body.deleted) || body.deleted.length > 256 || !body.deleted.every(id => typeof id === 'string' && uuid.test(id)) ||
      JSON.stringify(body.deleted) !== JSON.stringify(paged ? [...new Set(body.deleted)].sort().reverse() : [...new Set(body.deleted)].sort()) ||
      typeof receipt.signature !== 'string' || !/^[0-9a-f]{128}$/.test(receipt.signature)) throw new Error('invalid_archive_deletion_receipt');
  if (paged) {
    const page = (receipt as ArchiveDeletionPage).body;
    if (!Number.isSafeInteger(page.total_deleted) || page.total_deleted < 0 || page.deleted.length > page.total_deleted ||
        (page.before !== null && (typeof page.before !== 'string' || !uuid.test(page.before) || page.deleted.some(id => id >= page.before!))) ||
        (page.next_before !== null && (page.deleted.length !== 256 || page.next_before !== page.deleted.at(-1)))) throw new Error('invalid_archive_deletion_cursor');
  }
  const { network, nodeId, publicKey, url, label } = pin;
  await validateTrustedEntryPoints([{ network, nodeId, publicKey, url, label }]);
  const bytes = (s: string) => Uint8Array.from(s.match(/../g)!, part => parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', bytes(publicKey).buffer, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, bytes(receipt.signature).buffer, new Uint8Array(accountBytes(body)).buffer)) throw new Error('invalid_archive_deletion_signature');
  return receipt;
}

/** A local complete checkpoint consists of signed ranges, never a fabricated
 * aggregate entry signature. Every page is independently verified on import.
 */
export function assembleArchiveDeletion(pages: ArchiveDeletionPage[]): PagedArchiveDeletion {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 64) throw new Error('archive_deletion_page_limit');
  const { domain: _domain, before: _before, next_before: _next, total_deleted: _total, ...base } = pages.at(-1)!.body;
  return { body: { ...base, domain: 'sfera-mesh-archive-deletions-checkpoint-v2',
    deleted: pages.flatMap(page => page.body.deleted).sort() }, pages };
}

export async function verifyArchiveDeletionPage(value: unknown, pin: TrustedEntryPoint, context: DeletionContext,
  nonce: string, now = Math.floor(Date.now() / 1000)): Promise<ArchiveDeletionPage> {
  return await verifySigned(value, pin, context, nonce, now, true) as ArchiveDeletionPage;
}

export async function verifyArchiveDeletion(value: unknown, pin: TrustedEntryPoint, context: DeletionContext,
  nonce: string, now = Math.floor(Date.now() / 1000)): Promise<ArchiveDeletion> {
  const receipt = JSON.parse(JSON.stringify(value)) as ArchiveDeletion;
  if (receipt?.body?.domain !== 'sfera-mesh-archive-deletions-checkpoint-v2') {
    return await verifySigned(receipt, pin, context, nonce, now, false) as LegacyArchiveDeletion;
  }
  const bundle = receipt as PagedArchiveDeletion;
  if (Object.keys(bundle).sort().join(',') !== 'body,pages' || !Array.isArray(bundle.pages) ||
      bundle.pages.length < 1 || bundle.pages.length > 64 || accountBytes(bundle).length > 2 * 1048576) throw new Error('invalid_archive_deletion_bundle');
  const last = bundle.pages.at(-1)?.body;
  if (!last) throw new Error('invalid_archive_deletion_bundle');
  let before: string | null = null, count = 0;
  for (let index = 0; index < bundle.pages.length; index++) {
    const page = bundle.pages[index];
    await verifyArchiveDeletionPage(page, pin, context, nonce, index === bundle.pages.length - 1 ? now : page?.body?.issued_at);
    const body = page.body;
    if (body.before !== before || body.root !== last.root || body.version !== last.version || body.total_deleted !== last.total_deleted ||
        body.issued_at < last.issued_at - 120 || body.issued_at > last.issued_at + 5 ||
        (index < bundle.pages.length - 1 ? body.next_before === null : body.next_before !== null)) throw new Error('incomplete_archive_deletion_bundle');
    before = body.next_before; count += body.deleted.length;
  }
  const decoder = new TextDecoder();
  if (count !== last.total_deleted || count > ARCHIVE_DELETION_LIMIT ||
      decoder.decode(accountBytes(bundle.body)) !== decoder.decode(accountBytes(assembleArchiveDeletion(bundle.pages).body))) throw new Error('incomplete_archive_deletion_bundle');
  return bundle;
}
