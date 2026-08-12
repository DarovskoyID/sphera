// Last-messages cache.
//
// Opening a conversation used to mean two round-trips before anything could be
// drawn — create/resolve the conversation, then fetch its history. This keeps
// the tail of each recent conversation on the device so the chat paints from
// the first frame and the network result simply replaces it.
//
// ── What is kept, and what is not ────────────────────────────────────────────
// Only the tail: MAX_MESSAGES per conversation, MAX_CONVERSATIONS of them, the
// least recently opened evicted first. Attachments are kept as their metadata
// (id, name, url) — never their bytes, which stay behind the authenticated
// download route.
//
// ── Privacy ──────────────────────────────────────────────────────────────────
// This is plain text in localStorage: anyone with the device and the browser
// profile can read it. That is the cost of the instant paint, so the cache is
// wiped on sign-out, and `clear()` is the single place that has to be called
// whenever a session ends.

import type { ChatMessage } from '../types';

/** Bump when the stored shape changes; old entries are then simply ignored. */
const VERSION = 1;
const PREFIX = `sfera.msgs.v${VERSION}.`;
const INDEX_KEY = `${PREFIX}index`;

const MAX_MESSAGES = 60;
const MAX_CONVERSATIONS = 30;

/** Conversation ids, least recently used first. */
type Index = string[];

function readIndex(): Index {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(index: Index) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* full or blocked */ }
}

function drop(convoId: string) {
  try { localStorage.removeItem(PREFIX + convoId); } catch { /* ignore */ }
}

/**
 * The tail of a conversation, or null when nothing usable is stored.
 *
 * Anything malformed is treated as absent rather than repaired: a cache is
 * only ever an optimisation, and the network answer is on its way regardless.
 */
export function readCachedMessages(convoId: string): ChatMessage[] | null {
  if (!convoId) return null;
  try {
    const raw = localStorage.getItem(PREFIX + convoId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    // A stored entry must at least look like a message.
    if (!parsed.every(m => m && typeof m.id === 'string' && typeof m.created_at === 'string')) return null;
    return parsed as ChatMessage[];
  } catch {
    return null;
  }
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
 * Store the tail of a conversation and mark it most recently used.
 *
 * Optimistic messages are skipped: they have no server id yet, and a reload
 * that resurrected one would show a message that may never have been sent.
 */
export function writeCachedMessages(convoId: string, messages: ChatMessage[]) {
  if (!convoId) return;
  const real = messages.filter(m => !String(m.id).startsWith('optimistic-'));
  if (!real.length) return;

  const tail = real.slice(-MAX_MESSAGES).map(slim);
  const index = readIndex().filter(id => id !== convoId);
  index.push(convoId);

  // Evict the least recently opened conversations over the budget.
  while (index.length > MAX_CONVERSATIONS) drop(index.shift()!);

  try {
    localStorage.setItem(PREFIX + convoId, JSON.stringify(tail));
  } catch {
    // Out of space. Drop the oldest half and try once more; if it still fails,
    // the cache is simply not written — nothing depends on it.
    const half = Math.ceil(index.length / 2);
    for (const id of index.slice(0, half)) drop(id);
    index.splice(0, half);
    try { localStorage.setItem(PREFIX + convoId, JSON.stringify(tail)); } catch { /* give up */ }
  }
  writeIndex(index);
}

/** Wipe everything. Call on sign-out — see the privacy note at the top. */
export function clearMessageCache() {
  for (const id of readIndex()) drop(id);
  try { localStorage.removeItem(INDEX_KEY); } catch { /* ignore */ }
  // Entries orphaned by an older version or a failed write are swept too, so
  // stale plain text cannot linger after a sign-out.
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('sfera.msgs.')) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* ignore */ }
}
