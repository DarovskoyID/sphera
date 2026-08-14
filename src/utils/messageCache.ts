// Last-messages cache.
//
// Opening a conversation used to mean two round-trips before anything could be
// drawn — create/resolve the conversation, then fetch its history. This keeps
// the tail of each recent conversation on the device so the chat paints from
// the first frame and the network result simply replaces it.
//
// The queueing and merging live in cachedTail.ts, which the diary cache shares.
// What is here is what is particular to a conversation: how many to keep, and
// what must be stripped before a message is written down.

import type { ChatMessage } from '../types';
import { createTailCache } from './cachedTail';

/** Keys of the localStorage cache this replaced, swept on first use. */
const LEGACY_PREFIX = 'sfera.msgs.';

const cache = createTailCache<ChatMessage>({
  store: 'messages',
  version: 2,
  maxEntries: 100,
  maxThreads: 30,
  // Attachments are kept as their metadata — never their bytes, which stay
  // behind the authenticated download route.
  slim: (m) => ({
    ...m,
    // A blob URL from this session is dead on the next one, and keeping it
    // would make the renderer try to load an object URL that no longer exists.
    attachments: m.attachments?.map(a => ({
      id: a.id, filename: a.filename, content_type: a.content_type,
      file_size: a.file_size, url: a.url,
    })),
  }),
});

export const readCachedMessages = cache.read;
export const writeCachedMessages = cache.write;

/** Wipe the cache. Call on sign-out — see the privacy note in deviceCache.ts. */
export const clearMessageCache = cache.clear;

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
