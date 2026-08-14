// The tail-of-a-thing cache, shared by conversations and diaries.
//
// Both keep the last N entries of each of the last M threads on the device so
// the view paints from the first frame, and both have to solve the same two
// problems — how to merge an answer into what is already stored, and what to
// throw away when there is too much. Those are subtle enough that having one
// copy of them matters more than the small indirection.
//
// ── A queue, not a snapshot ──────────────────────────────────────────────────
// The stored tail is merged with what arrives, never overwritten by it. When
// twenty new entries turn up on a full thread, the twenty oldest fall off the
// front and the new ones go on the back. So the cache survives a reload with
// everything it had, and grows to the limit instead of shrinking to whatever
// the last fetch happened to return.
//
// Merging cannot be blind, though, or an entry deleted on the server would live
// on the device forever. A fetch is authoritative *for the stretch of time it
// covers*: anything stored inside that window and missing from the answer is
// gone, and is dropped. Anything older than the window is untouched, because
// the answer says nothing about it.
//
// Privacy: see the note at the top of deviceCache.ts.

import { readRecord, writeRecord, readAll, deleteRecords, clearStore } from './deviceCache';
import type { StoreName } from './deviceCache';

/** The least an entry has to look like to be cached and ordered. */
export interface TailEntry {
  id: string;
  created_at: string;
}

interface CachedThread<T> {
  id: string;
  version: number;
  /** When this record was last written; the eviction order. */
  updatedAt: number;
  entries: T[];
}

export interface TailCache<T> {
  read(threadId: string): Promise<T[] | null>;
  write(threadId: string, entries: T[]): Promise<void>;
  clear(): Promise<void>;
}

export interface TailCacheOptions<T> {
  store: StoreName;
  /** Bump when the stored shape changes; older records are then ignored. */
  version: number;
  /** Entries kept per thread. */
  maxEntries: number;
  /** Threads kept, least recently written evicted first. */
  maxThreads: number;
  /** Drop anything that must not outlive the session, or that is simply bulk. */
  slim?: (entry: T) => T;
}

function timeOf(entry: TailEntry): number {
  const t = Date.parse(entry.created_at);
  return Number.isNaN(t) ? 0 : t;
}

/** Optimistic entries have no server id yet and must never outlive the tab. */
function isReal(entry: TailEntry): boolean {
  return !String(entry.id).startsWith('optimistic-');
}

export function createTailCache<T extends TailEntry>(options: TailCacheOptions<T>): TailCache<T> {
  const { store, version, maxEntries, maxThreads, slim } = options;

  /**
   * The stored tail, or null when nothing usable is there.
   *
   * Anything malformed is treated as absent rather than repaired: a cache is
   * only ever an optimisation, and the network answer is on its way regardless.
   */
  async function read(threadId: string): Promise<T[] | null> {
    if (!threadId) return null;
    const record = await readRecord<CachedThread<T>>(store, threadId);
    if (!record || record.version !== version) return null;
    const { entries } = record;
    if (!Array.isArray(entries) || !entries.length) return null;
    if (!entries.every(e => e && typeof e.id === 'string' && typeof e.created_at === 'string')) return null;
    return entries;
  }

  /**
   * Merge these entries into the thread's stored tail.
   *
   * `entries` is the whole of what the client currently holds for the thread,
   * so the window it spans is the authoritative one — see the note at the top
   * about why that matters.
   */
  async function write(threadId: string, entries: T[]): Promise<void> {
    if (!threadId) return;
    const incoming = entries.filter(isReal).map(e => (slim ? slim(e) : e));
    if (!incoming.length) return;

    const stored = (await read(threadId)) ?? [];

    // The stretch of time the incoming entries account for.
    let windowStart = Infinity;
    let windowEnd = -Infinity;
    for (const e of incoming) {
      const t = timeOf(e);
      if (t < windowStart) windowStart = t;
      if (t > windowEnd) windowEnd = t;
    }

    const incomingIds = new Set(incoming.map(e => String(e.id)));
    const kept = stored.filter(e => {
      if (incomingIds.has(String(e.id))) return false;   // superseded by the new copy
      const t = timeOf(e);
      // Inside the authoritative window and not in the answer: deleted.
      return t < windowStart || t > windowEnd;
    });

    const tail = [...kept, ...incoming]
      .sort((a, b) => timeOf(a) - timeOf(b) || String(a.id).localeCompare(String(b.id)))
      .slice(-maxEntries);

    await writeRecord(store, {
      id: threadId,
      version,
      updatedAt: Date.now(),
      entries: tail,
    } satisfies CachedThread<T>);

    await prune();
  }

  /** Evict the least recently written threads over the budget. */
  async function prune(): Promise<void> {
    const all = await readAll<CachedThread<T>>(store);
    if (all.length <= maxThreads) return;
    const stale = all
      .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
      .slice(0, all.length - maxThreads)
      .map(record => record.id);
    await deleteRecords(store, stale);
  }

  return { read, write, clear: () => clearStore(store) };
}
