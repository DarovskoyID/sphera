// Diary cache.
//
// A diary is a private guild whose channels only its owner can read, and it is
// the one place in the app where the content is the user's own writing rather
// than a conversation. Opening it to a spinner — on a train, on a plane, on a
// phone that has just woken up — is the worst version of that, so the last
// hundred entries of each diary channel are kept on the device and drawn
// straight away.
//
// Only diaries. An ordinary guild channel is shared, frequently large, and
// belongs to other people as much as to the reader; there is no call to leave
// a copy of it lying on every device that ever opened it.
//
// The queueing and merging live in cachedTail.ts, shared with the message
// cache — see the note at the top of that file for how a fetch is merged into
// what is stored, and why it cannot simply overwrite it.

import type { GuildMessage } from '../types';
import { createTailCache } from './cachedTail';

const cache = createTailCache<GuildMessage>({
  store: 'diaries',
  version: 1,
  maxEntries: 100,
  // A diary is one guild with a handful of channels, and a person may keep a
  // few. Ten covers that with room to spare.
  maxThreads: 10,
  slim: (entry) => ({
    ...entry,
    // A blob URL from this session is dead on the next one; the metadata is
    // enough to re-request the bytes through the authenticated route.
    attachments: entry.attachments?.map(a => ({
      id: a.id, filename: a.filename, content_type: a.content_type,
      file_size: a.file_size, url: a.url,
    })),
  }),
});

export const readCachedDiary = cache.read;
export const writeCachedDiary = cache.write;

/** Wipe the cache. Call on sign-out — see the privacy note in deviceCache.ts. */
export const clearDiaryCache = cache.clear;
