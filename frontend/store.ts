import { createModuleStore, openModuleSocket, type ModuleSocket, type PollPayload, type RichMessageType } from '@sfera/sdk';
import { api, type Conn } from './api';
import type { FeedChannel, Post, PostComment } from './types';

interface State {
  loaded: boolean;
  /** Channels the user owns or is subscribed to. */
  channels: FeedChannel[];
  /** Any channel opened, including previews of ones not subscribed to. */
  byId: Record<string, FeedChannel>;
  posts: Record<string, Post[]>;
  loading: Record<string, boolean>;
}

export const store = createModuleStore<State>({ loaded: false, channels: [], byId: {}, posts: {}, loading: {} });

let conn: Conn | null = null;
let socket: { channelId: string; ws: ModuleSocket } | null = null;
const commentListeners = new Set<(ev: CommentEvent) => void>();

export type CommentEvent =
  | { type: 'added'; postId: string; comment: PostComment }
  | { type: 'deleted'; postId: string; commentId: string };

const need = () => {
  if (!conn) throw new Error('channels: not connected');
  return conn;
};

export function connect(next: Conn | null) {
  const changed = conn?.token !== next?.token || conn?.serverIP !== next?.serverIP;
  conn = next;
  if (!next) {
    closeChannel();
    store.reset();
    return;
  }
  if (changed) void refresh().catch(() => {});
}

export async function refresh() {
  const channels = await api.mine(need());
  store.set(s => ({ loaded: true, channels, byId: { ...s.byId, ...Object.fromEntries(channels.map(c => [c.id, c])) } }));
}

function putChannel(ch: FeedChannel) {
  store.set(s => {
    const subscribed = !!ch.my_role;
    const rest = s.channels.filter(c => c.id !== ch.id);
    return {
      byId: { ...s.byId, [ch.id]: ch },
      channels: subscribed ? (s.channels.some(c => c.id === ch.id) ? s.channels.map(c => (c.id === ch.id ? ch : c)) : [...s.channels, ch]) : rest,
    };
  });
}

function dropChannel(id: string) {
  store.set(s => {
    const byId = { ...s.byId };
    const posts = { ...s.posts };
    delete byId[id];
    delete posts[id];
    return { channels: s.channels.filter(c => c.id !== id), byId, posts };
  });
}

// ── Posts state helpers ────────────────────────────────────────────────────
const sortPosts = (list: Post[]) => [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));

function setPosts(channelId: string, fn: (list: Post[]) => Post[]) {
  store.set(s => ({ posts: { ...s.posts, [channelId]: fn(s.posts[channelId] ?? []) } }));
}

function patchPost(channelId: string, postId: string, fn: (p: Post) => Post) {
  setPosts(channelId, list => list.map(p => (String(p.id) === String(postId) ? fn(p) : p)));
}

function upsertPost(channelId: string, post: Post) {
  setPosts(channelId, list => {
    if (list.some(p => p.id === post.id)) return list.map(p => (p.id === post.id ? { ...p, ...post } : p));
    // A real post replaces this author's optimistic placeholder, if any.
    const opt = list.findIndex(p => p.id.startsWith('optimistic-') && p.author.id === post.author.id);
    if (opt !== -1) {
      const next = [...list];
      next[opt] = post;
      return sortPosts(next);
    }
    return sortPosts([...list, post]);
  });
}

// ── Opening a channel ──────────────────────────────────────────────────────
export async function openChannel(id: string) {
  const c = need();
  if (socket?.channelId !== id) {
    closeChannel();
    socket = {
      channelId: id,
      ws: openModuleSocket({
        serverIP: c.serverIP, token: c.token, path: `/ws/m/channels/${id}/`,
        onFrame: frame => onFrame(id, frame),
        onReopen: () => { void loadPosts(id); },
      }),
    };
  }
  store.set(s => ({ loading: { ...s.loading, [id]: !s.posts[id] } }));
  try {
    const [ch] = await Promise.all([api.get(c, id), loadPosts(id)]);
    putChannel(ch);
  } finally {
    store.set(s => ({ loading: { ...s.loading, [id]: false } }));
  }
}

export function closeChannel() {
  socket?.ws.close();
  socket = null;
}

async function loadPosts(id: string) {
  const fresh = await api.posts(need(), id);
  setPosts(id, list => {
    const ids = new Set(fresh.map(p => p.id));
    // Keep optimistic placeholders and anything that arrived over the socket meanwhile.
    return sortPosts([...fresh, ...list.filter(p => !ids.has(p.id))]);
  });
}

function onFrame(channelId: string, f: { type: string; [k: string]: any }) {
  switch (f.type) {
    case 'post_created':
    case 'post_updated':
      upsertPost(channelId, f.post);
      break;
    case 'post_deleted':
      setPosts(channelId, list => list.filter(p => p.id !== f.post_id));
      break;
    case 'reaction_update':
      // Broadcast has no personal flags: keep this user's own `me`.
      patchPost(channelId, f.post_id, p => {
        const mine = new Set((p.reactions ?? []).filter(r => r.me).map(r => r.emoji));
        return { ...p, reactions: (f.reactions as Post['reactions'])!.map(r => ({ ...r, me: mine.has(r.emoji) })) };
      });
      break;
    case 'poll_update':
      patchPost(channelId, f.post_id, p => {
        const mine = p.payload as PollPayload | undefined;
        const next = f.poll as PollPayload;
        const me = new Map((mine?.options ?? []).map(o => [o.id, o.me]));
        return { ...p, payload: { ...next, options: next.options.map(o => ({ ...o, me: me.get(o.id) ?? false })), voted: mine?.voted ?? false } };
      });
      break;
    case 'todo_update':
      patchPost(channelId, f.post_id, p => ({ ...p, payload: f.todo }));
      break;
    case 'location_update':
      patchPost(channelId, f.post_id, p => ({ ...p, payload: f.location }));
      break;
    case 'comment_added':
      patchPost(channelId, f.post_id, p => ({ ...p, comments_count: (p.comments_count ?? 0) + 1 }));
      commentListeners.forEach(l => l({ type: 'added', postId: f.post_id, comment: f.comment }));
      break;
    case 'comment_deleted':
      patchPost(channelId, f.post_id, p => ({ ...p, comments_count: Math.max(0, (p.comments_count ?? 1) - 1) }));
      commentListeners.forEach(l => l({ type: 'deleted', postId: f.post_id, commentId: f.comment_id }));
      break;
    case 'channel_updated':
      store.set(s => {
        const prev = s.byId[channelId];
        const ch = { ...f.channel, my_role: prev?.my_role ?? '', my_notifications_muted: prev?.my_notifications_muted ?? false };
        return {
          byId: { ...s.byId, [channelId]: ch },
          channels: s.channels.map(c => (c.id === channelId ? ch : c)),
        };
      });
      break;
    case 'channel_deleted':
      closeChannel();
      dropChannel(channelId);
      break;
  }
}

export function onComment(listener: (ev: CommentEvent) => void) {
  commentListeners.add(listener);
  return () => { commentListeners.delete(listener); };
}

// ── Actions ────────────────────────────────────────────────────────────────
export async function createChannel(name: string, description = '') {
  const ch = await api.create(need(), name, description);
  putChannel(ch);
  return ch;
}

export async function join(by: { invite_code?: string; channel_id?: string }) {
  const ch = await api.join(need(), by);
  putChannel(ch);
  return ch;
}

export async function leave(id: string) {
  await api.leave(need(), id);
  const ch = store.get().byId[id];
  if (ch) putChannel({ ...ch, my_role: '', subscriber_count: Math.max(0, ch.subscriber_count - 1) });
}

export async function deleteChannel(id: string, password: string) {
  await api.remove(need(), id, password);
  if (socket?.channelId === id) closeChannel();
  dropChannel(id);
}

export async function update(id: string, data: {
  name?: string; description?: string; tags?: string; icon?: File | null; banner?: File | null;
  removeIcon?: boolean; removeBanner?: boolean; is_discoverable?: boolean; comments_enabled?: boolean;
}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (k === 'removeIcon') form.append('remove_icon', v ? 'true' : 'false');
    else if (k === 'removeBanner') form.append('remove_banner', v ? 'true' : 'false');
    else if (v instanceof File) form.append(k, v, v.name);
    else form.append(k, typeof v === 'boolean' ? String(v) : String(v));
  }
  putChannel(await api.update(need(), id, form));
}

export async function toggleNotifications(id: string) {
  const { notifications_muted } = await api.toggleNotifications(need(), id);
  const ch = store.get().byId[id];
  if (ch) putChannel({ ...ch, my_notifications_muted: notifications_muted });
}

export const upload = (channelId: string, file: File) => api.upload(need(), channelId, file);

export async function publishPost(channelId: string, content: string, attachmentIds: string[]) {
  const post = await api.post(need(), channelId, content, attachmentIds);
  upsertPost(channelId, post);
  return post;
}

export const schedulePost = (channelId: string, content: string, delaySeconds: number, attachmentIds: string[]) =>
  api.schedule(need(), channelId, content, delaySeconds, attachmentIds);

export async function publishRich(channelId: string, type: RichMessageType, payload: unknown, tags?: string[]) {
  upsertPost(channelId, await api.rich(need(), channelId, type, payload, tags));
}

export async function editPost(channelId: string, postId: string, body: { content?: string; payload?: unknown }) {
  upsertPost(channelId, await api.edit(need(), postId, body));
}

export async function removePost(channelId: string, postId: string) {
  await api.removePost(need(), postId);
  setPosts(channelId, list => list.filter(p => p.id !== postId));
}

export function addOptimistic(channelId: string, author: Post['author'], text: string, fileCount: number) {
  const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setPosts(channelId, list => [...list, {
    id, author, content: text, created_at: new Date().toISOString(), is_pinned: false,
    attachments: Array.from({ length: fileCount }, (_, i) => ({ id: `${id}-${i}`, filename: '', content_type: 'uploading', file_size: 0, url: '' })),
  }]);
  return id;
}

export function resolveOptimistic(channelId: string, optimisticId: string, real: Post[]) {
  setPosts(channelId, list => sortPosts([...list.filter(p => p.id !== optimisticId && !real.some(r => r.id === p.id)), ...real]));
}

export const removeOptimistic = (channelId: string, optimisticId: string) =>
  setPosts(channelId, list => list.filter(p => p.id !== optimisticId));

export async function react(channelId: string, postId: string, emoji: string) {
  const { reactions } = await api.react(need(), postId, emoji);
  patchPost(channelId, postId, p => ({ ...p, reactions }));
}

const viewed = new Set<string>();
export async function registerView(channelId: string, postId: string) {
  if (viewed.has(postId) || postId.startsWith('optimistic-')) return;
  viewed.add(postId);
  try {
    const { views } = await api.view(need(), postId);
    patchPost(channelId, postId, p => ({ ...p, views }));
  } catch {
    viewed.delete(postId);
  }
}

export const loadComments = (postId: string) => api.comments(need(), postId);
export const addComment = (postId: string, content: string) => api.comment(need(), postId, content);
export const removeComment = (commentId: string) => api.removeComment(need(), commentId);

export async function vote(channelId: string, postId: string, ids: string[]) {
  const { poll } = await api.vote(need(), postId, ids);
  patchPost(channelId, postId, p => ({ ...p, payload: poll as Post['payload'] }));
}
export async function closePoll(channelId: string, postId: string) {
  const { poll } = await api.closePoll(need(), postId);
  patchPost(channelId, postId, p => ({ ...p, payload: poll as Post['payload'] }));
}
export const pollVoters = (postId: string, optionId: string, offset?: number, limit?: number) =>
  api.voters(need(), postId, optionId, offset, limit);
export async function toggleTodo(channelId: string, postId: string, itemId: string) {
  const { todo } = await api.toggleTodo(need(), postId, itemId);
  patchPost(channelId, postId, p => ({ ...p, payload: todo as Post['payload'] }));
}
export async function pushLocation(channelId: string, postId: string, body: { lat?: number; lng?: number; stop?: boolean }) {
  const { location } = await api.location(need(), postId, body);
  patchPost(channelId, postId, p => ({ ...p, payload: location as Post['payload'] }));
}

export const connection = () => conn;
