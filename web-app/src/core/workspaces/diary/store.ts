import { createModuleStore, createTailCache, type RichMessageType } from '@sfera/sdk';
import { api, type Conn } from './api';
import type { Diary, DiaryEntry } from './types';

interface State {
  loaded: boolean;
  diaries: Diary[];
  entries: Record<string, DiaryEntry[]>;
}

export const store = createModuleStore<State>({ loaded: false, diaries: [], entries: {} });

// The last hundred entries of each diary stay on the device, so a diary opens
// instantly even offline. Only diaries: they are the user's own writing.
const cache = createTailCache<DiaryEntry>({
  store: 'diaries',
  version: 2,
  maxEntries: 100,
  maxThreads: 10,
  slim: e => ({ ...e, attachments: e.attachments?.map(a => ({ ...a })) }),
});

let conn: Conn | null = null;

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) {
    store.reset();
    return;
  }
  if (changed) void refreshDiaries();
}

const need = () => {
  if (!conn) throw new Error('diary: not connected');
  return conn;
};

const sortEntries = (list: DiaryEntry[]) => [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));

function upsert(entry: DiaryEntry) {
  store.set(s => {
    const list = s.entries[entry.diary_id] ?? [];
    const next = list.some(e => e.id === entry.id)
      ? list.map(e => (e.id === entry.id ? entry : e))
      : sortEntries([...list, entry]);
    void cache.write(entry.diary_id, next);
    return { entries: { ...s.entries, [entry.diary_id]: next } };
  });
}

function drop(diaryId: string, entryId: string) {
  store.set(s => {
    const next = (s.entries[diaryId] ?? []).filter(e => e.id !== entryId);
    void cache.write(diaryId, next);
    return { entries: { ...s.entries, [diaryId]: next } };
  });
}

export async function refreshDiaries() {
  const diaries = await api.list(need());
  store.set({ loaded: true, diaries });
}

export async function openDiary(id: string) {
  if (!store.get().entries[id]) {
    const cached = await cache.read(id).catch(() => null);
    if (cached?.length && !store.get().entries[id]) store.set(s => ({ entries: { ...s.entries, [id]: cached } }));
  }
  const fresh = await api.entries(need(), id);
  store.set(s => ({ entries: { ...s.entries, [id]: fresh } }));
  void cache.write(id, fresh);
}

export async function createDiary(name: string) {
  const d = await api.create(need(), name);
  store.set(s => ({ diaries: [...s.diaries, d] }));
  return d;
}

export async function deleteDiary(id: string, password: string) {
  await api.remove(need(), id, password);
  store.set(s => {
    const entries = { ...s.entries };
    delete entries[id];
    return { diaries: s.diaries.filter(d => d.id !== id), entries };
  });
}

export async function addEntry(diaryId: string, content: string, tags: string[], files: File[]) {
  const c = need();
  const ids: string[] = [];
  for (const f of files) ids.push((await api.upload(c, diaryId, f)).id);
  upsert(await api.addEntry(c, diaryId, { content, tags, attachment_ids: ids }));
}

export async function addRich(diaryId: string, type: RichMessageType, payload: unknown, tags: string[]) {
  upsert(await api.addRich(need(), diaryId, type, payload, tags));
}

export async function editEntry(entryId: string, body: { content?: string; payload?: unknown }) {
  upsert(await api.edit(need(), entryId, body));
}

export async function deleteEntry(diaryId: string, entryId: string) {
  await api.removeEntry(need(), entryId);
  drop(diaryId, entryId);
}

/** Poll/todo/location changes: reload the entry through the list (small, owner-only). */
async function thenReload(diaryId: string, p: Promise<unknown>) {
  await p;
  await openDiary(diaryId);
}

export const votePoll = (diaryId: string, entryId: string, ids: string[]) => thenReload(diaryId, api.vote(need(), entryId, ids));
export const closePoll = (diaryId: string, entryId: string) => thenReload(diaryId, api.closePoll(need(), entryId));
export const toggleTodo = (diaryId: string, entryId: string, itemId: string) => thenReload(diaryId, api.toggleTodo(need(), entryId, itemId));
export const stopLive = (diaryId: string, entryId: string) => thenReload(diaryId, api.stopLive(need(), entryId));

// ── Realtime from the owner's other devices (signaling → wsBus) ─────────────
export const onRemoteEntry = (frame: { entry?: DiaryEntry }) => { if (frame.entry) upsert(frame.entry); };
export const onRemoteDeleted = (frame: { entry_id?: string; diary_id?: string }) => {
  if (frame.entry_id && frame.diary_id) drop(frame.diary_id, frame.entry_id);
};
export const onRemoteChanged = () => { if (conn) void refreshDiaries(); };

export const clearCache = () => cache.clear();
