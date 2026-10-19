/**
 * The feed UI was written against the core guild context. This hook gives it the
 * same shape backed by the channels module store, so the component stays intact.
 */
import { useMemo } from 'react';
import { navigate, reportError, useCore, useModuleStore, type RichMessageType } from '@sfera/sdk';
import * as feed from './store';
import type { FeedChannel, Post, PostComment } from './types';

export const ROUTE = 'channels';
const EMPTY: Post[] = [];

type Scope = unknown;

export function useChannelId() {
  const { currentServer } = useCore();
  return navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
}

function commentHandlerRef() {
  let off: (() => void) | null = null;
  let current: ((ev: { type: 'added' | 'deleted'; messageId: string; comment?: PostComment; commentId?: string }) => void) | null = null;
  return {
    get current() { return current; },
    set current(fn) {
      off?.();
      off = null;
      current = fn;
      if (fn) {
        off = feed.onComment(ev => fn(ev.type === 'added'
          ? { type: 'added', messageId: ev.postId, comment: ev.comment }
          : { type: 'deleted', messageId: ev.postId, commentId: ev.commentId }));
      }
    },
  };
}

const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try { return await p; } catch (e) { reportError(e); return null; }
};

export function useFeed() {
  const core = useCore();
  const channelId = useChannelId();
  const channel = useModuleStore(feed.store, s => s.byId[channelId]);
  const posts = useModuleStore(feed.store, s => s.posts[channelId]) ?? EMPTY;
  const channels = useModuleStore(feed.store, s => s.channels);

  const api = useMemo(() => {
    const me = (): Post['author'] => ({
      id: String(core.currentUser?.id ?? ''), username: core.currentUser?.username ?? '',
      nickname: core.currentUser?.nickname ?? '', avatar: core.currentUser?.avatar ?? '', status: 'online',
    });
    return {
      postCommentHandler: commentHandlerRef(),
      toggleReaction: (_g: string, postId: string, emoji: string) => safe(feed.react(channelId, postId, emoji)).then(() => {}),
      registerMessageView: (_g: string, postId: string) => feed.registerView(channelId, postId),
      deleteGuildMessage: (postId: string) => safe(feed.removePost(channelId, postId)).then(() => {}),
      votePoll: (_g: string, postId: string, ids: string[]) => safe(feed.vote(channelId, postId, ids)).then(() => {}),
      closePoll: (_g: string, postId: string) => safe(feed.closePoll(channelId, postId)).then(() => {}),
      fetchPollVoters: (_g: string, postId: string, optionId: string, offset?: number, limit?: number) =>
        feed.pollVoters(postId, optionId, offset, limit),
      toggleTodoItem: (_s: Scope, postId: string, itemId: string) => safe(feed.toggleTodo(channelId, postId, itemId)).then(() => {}),
      pushLiveLocation: (_s: Scope, postId: string, body: { lat?: number; lng?: number; stop?: boolean }) =>
        safe(feed.pushLocation(channelId, postId, body)).then(() => {}),
      loadPostComments: async (_g: string, postId: string) => (await safe(feed.loadComments(postId))) ?? [],
      addPostComment: (_g: string, postId: string, content: string) => safe(feed.addComment(postId, content)),
      deletePostComment: (_g: string, commentId: string) => safe(feed.removeComment(commentId)).then(() => {}),

      updateGuild: (id: string, data: Parameters<typeof feed.update>[1]) => safe(feed.update(id, data)).then(() => {}),
      deleteGuild: async (id: string, password = '') => {
        try {
          await feed.deleteChannel(id, password);
          core.setCurrentServer('home');
          return true;
        } catch {
          return false;
        }
      },
      joinGuild: async (inviteCode: string) => safe(feed.join({ invite_code: inviteCode })),
      leaveGuild: (id: string) => safe(feed.leave(id)).then(() => {}),
      toggleGuildNotifications: (id: string) => safe(feed.toggleNotifications(id)).then(() => {}),

      sendGuildMessage: (text: string) => { void safe(feed.publishPost(channelId, text, [])); },
      scheduleGuildMessage: (text: string, delaySecs: number, _reply?: string, attachmentIds?: string[]) =>
        safe(feed.schedulePost(channelId, text, delaySecs, attachmentIds ?? [])),
      addOptimisticGuildPost: (text: string, fileCount: number) => feed.addOptimistic(channelId, me(), text, fileCount),
      removeOptimisticGuildPost: (id: string) => feed.removeOptimistic(channelId, id),
      resolveGuildPost: (optimisticId: string, real: Post[]) => feed.resolveOptimistic(channelId, optimisticId, real),
      sendRichMessage: (_s: Scope, type: RichMessageType, payload: Record<string, unknown>, tags?: string[]) =>
        feed.publishRich(channelId, type, payload, tags),
      editMessage: (_s: Scope, postId: string, body: { content?: string; payload?: Record<string, unknown> }) =>
        feed.editPost(channelId, postId, body),
      uploadPostFile: (file: File) => feed.upload(channelId, file),
      publishPost: (content: string, attachmentIds: string[]) => safe(feed.publishPost(channelId, content, attachmentIds)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, core.currentUser?.id]);

  return {
    ...core,
    ...api,
    currentGuild: channel as FeedChannel | undefined,
    currentGuildChannel: channel ? { id: channel.id } : null,
    guildMessages: posts,
    guilds: channels,
  };
}
