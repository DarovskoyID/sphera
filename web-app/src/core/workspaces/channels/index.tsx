import { Plus, Rss } from 'lucide-react';
import { defineModule, goTo, tmStatic, type ExploreSearchResult } from '@sfera/sdk';
import { api } from './api';
import * as feed from './store';
import { ChannelRail, ChannelRoute, ChannelsConnector, CreateChannelDialog, JoinChannelDialog } from './components';
import { ROUTE } from './useFeed';
import { strings } from './i18n';

async function search(query: string, signal: AbortSignal): Promise<ExploreSearchResult[]> {
  const conn = feed.connection();
  if (!conn) return [];
  const [channels, posts] = await Promise.all([
    api.explore(conn, query, signal),
    query.trim().length >= 2 ? api.searchPosts(conn, query, signal).catch(() => []) : Promise.resolve([]),
  ]);
  const open = (id: string) => () => goTo(`${ROUTE}:${id}`);
  return [
    ...channels.map(ch => ({
      id: `channel:${ch.id}`,
      kind: 'channel',
      title: ch.name,
      subtitle: `${ch.subscriber_count} · ${ch.description || ''}`.trim(),
      avatar: ch.icon || null,
      badge: ch.is_member ? tmStatic('ch_subscribed') : undefined,
      open: open(ch.id),
    })),
    ...posts.map(p => ({
      id: `post:${p.id}`,
      kind: 'post',
      title: p.channel.name,
      subtitle: p.content,
      avatar: p.channel.icon || null,
      open: open(p.channel.id),
    })),
  ];
}

export default defineModule({
  id: 'channels',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'connector', render: ChannelsConnector });
    ctx.slot('nav.rail', { id: 'channels', order: 30, render: ChannelRail });
    ctx.slot('rail.addAction', { id: 'create', order: 10, label: () => tmStatic('guild_create_channel'), icon: <Rss size={14} />, render: CreateChannelDialog });
    ctx.slot('rail.addAction', { id: 'join', order: 11, label: () => tmStatic('guild_join_channel'), icon: <Plus size={14} />, render: JoinChannelDialog });
    ctx.slot('main.view', { id: 'feed', match: r => r.currentServer.startsWith(`${ROUTE}:`), render: ChannelRoute });
    ctx.slot('explore.search', { id: 'channels', order: 20, label: () => tmStatic('ch_search_label'), search });
    ctx.onDispose(() => feed.connect(null));
  },
});
