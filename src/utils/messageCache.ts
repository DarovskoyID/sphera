// Last-messages cache.
//
// Opening a conversation used to mean two round-trips before anything could be
// drawn — create/resolve the conversation, then fetch its history. This keeps
// the tail of each recent conversation on the device so the chat paints from
// the first frame and the network result simply replaces it.
//
// ── A queue, not a snapshot ──────────────────────────────────────────────────
// The stored tail is merged with what arrives, never overwritten by it. A
// hundred messages are kept per conversation; when twenty more are said, the
// twenty oldest fall off the front and the new ones go on the back. So the
// cache survives a reload with everything it had, and grows to the limit
// instead of shrinking to whatever the last fetch happened to return.
//
// Merging cannot be blind, though, or a message deleted on the server would
// live in the cache forever. A fetch of recent history is authoritative *for
// the stretch of time it covers*: anything stored inside that window and
// missing from the answer is gone, and is dropped. Anything older than the
// window is untouched, because the answer says nothing about it.
//
// ── What is kept, and what is not ────────────────────────────────────────────
// MAX_MESSAGES per conversation, MAX_CONVERSATIONS of them, the least recently
// written evicted first. Attachments are kept as their metadata (id, name, url)
// — never their bytes, which stay behind the authenticated download route.
//
// Privacy: see the note at the top of deviceCache.ts.

import type { ChatMessage } from '../types';
import { sortByDate } from './messageOrder';
import { readRecord, writeRecord, readAll, deleteRecords, clearStore } from './deviceCache';

/** Bump when the stored shape changes; older records are then ignored. */
const VERSION = 2;

const MAX_MESSAGES = 100;
const MAX_CONVERSATIONS = 30;

/** Keys of the localStorage cache this replaced, swept on first use. */
const LEGACY_PREFIX = 'sfera.msgs.';

interface CachedConversation {
  id: string;
  version: number;
  /** When this record was last written; the eviction order. */
  updatedAt: number;
  messages: ChatMessage[];
}

function timeOf(message: ChatMessage): number {
  const t = Date.parse(message.created_at);
  return Number.isNaN(t) ? 0 : t;
}

/** Optimistic messages have no server id yet and must never outlive the tab. */
function isReal(message: ChatMessage): boolean {
  return !String(message.id).startsWith('optimistic-');
}

/** Strip anything that must not outlive the session, or that is simply bulk. */
function slim(m: ChatMessage): ChatMessage {
  return {
    ...m,
    // A blob URL from this session is dead on the next one, and keeping it
    // would make the renderer try to load an object URL that no longer exists.
    attachments: m.attachments?.map(a => ({
      id: a.id, filename: a.filename, content_type: a.content_type,
      file_size: a.file_size, url: a.url,
    })),
  };
}

/**
 * The tail of a conversation, or null when nothing usable is stored.
 *
 * Anything malformed is treated as absent rather than repaired: a cache is
 * only ever an optimisation, and the network answer is on its way regardless.
 */
export async function readCachedMessages(convoId: string): Promise<ChatMessage[] | null> {
  if (!convoId) return null;
  const record = await readRecord<CachedConversation>('messages', convoId);
  if (!record || record.version !== VERSION) return null;
  const { messages } = record;
  if (!Array.isArray(messages) || !messages.length) return null;
  // A stored entry must at least look like a list of messages.
  if (!messages.every(m => m && typeof m.id === 'string' && typeof m.created_at === 'string')) return null;
  return messages;
}

/**
 * Merge these messages into the conversation's stored tail.
 *
 * `messages` is the whole of what the client currently holds for the
 * conversation, so the window it spans is the authoritative one — see the note
 * at the top about why that matters.
 */
export async function writeCachedMessages(convoId: string, messages: ChatMessage[]): Promise<void> {
  if (!convoId) return;
  const incoming = messages.filter(isReal).map(slim);
  if (!incoming.length) return;

  const stored = (await readCachedMessages(convoId)) ?? [];

  // The stretch of time the incoming messages account for.
  let windowStart = Infinity;
  let windowEnd = -Infinity;
  for (const m of incoming) {
    const t = timeOf(m);
    if (t < windowStart) windowStart = t;
    if (t > windowEnd) windowEnd = t;
  }

  const incomingIds = new Set(incoming.map(m => String(m.id)));
  const merged = stored.filter(m => {
    if (incomingIds.has(String(m.id))) return false;   // superseded by the new copy
    const t = timeOf(m);
    // Inside the authoritative window and not in the answer: deleted.
    return t < windowStart || t > windowEnd;
  });

  const tail = sortByDate([...merged, ...incoming]).slice(-MAX_MESSAGES);

  await writeRecord('messages', {
    id: convoId,
    version: VERSION,
    updatedAt: Date.now(),
    messages: tail,
  } satisfies CachedConversation);

  await prune();
}

/** Evict the least recently written conversations over the budget. */
async function prune(): Promise<void> {
  const all = await readAll<CachedConversation>('messages');
  if (all.length <= MAX_CONVERSATIONS) return;
  const stale = all
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, all.length - MAX_CONVERSATIONS)
    .map(record => record.id);
  await deleteRecords('messages', stale);
}

/** Wipe the cache. Call on sign-out — see the privacy note in deviceCache.ts. */
export function clearMessageCache(): Promise<void> {
  return clearStore('messages');
}

// The localStorage cache this replaced is swept the moment this module loads,
// rather than on the next sign-out. It is plain text that nothing reads any
// more, and leaving it on the device until some future event happens to fire
// would be leaving it there for good.
try {
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(LEGACY_PREFIX)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
} catch { /* unavailable, or already gone */ }
