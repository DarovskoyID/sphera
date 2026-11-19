import { tmStatic, type ExploreSearchProvider } from '@sfera/sdk';
import { useApp } from './ServersContext';

interface ExploreGuild {
  id: string;
  name: string;
  description: string;
  icon: string;
  member_count: number;
  invite_code: string;
  is_member?: boolean;
}

type AppValue = ReturnType<typeof useApp>;
let app: AppValue | null = null;

/** Keeps the search provider pointed at the live servers state. */
export function ServersExploreBridge() {
  app = useApp();
  return null;
}

/** Servers search for «Исследовать сферу». */
export const serversSearch: ExploreSearchProvider = {
  id: 'servers',
  order: 10,
  label: () => tmStatic('srv_search_label'),
  async search(query, signal) {
    if (!app) return [];
    const { currentServerIP, authToken } = app;
    const res = await fetch(`${currentServerIP}/api/guilds/explore/?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${authToken}` }, signal,
    });
    if (!res.ok) return [];
    const rows: ExploreGuild[] = await res.json();
    return rows.map(g => ({
      id: `server:${g.id}`,
      kind: 'server',
      title: g.name,
      subtitle: `${g.member_count} ${tmStatic('srv_members_short')}${g.description ? ` · ${g.description}` : ''}`,
      avatar: g.icon || null,
      badge: g.is_member ? tmStatic('srv_you_are_here') : undefined,
      open: async () => {
        if (!app) return;
        const existing = app.guilds.find(x => String(x.id) === String(g.id));
        if (existing) { app.selectGuild(existing); return; }
        const joined = await app.joinGuild(g.invite_code);
        if (joined) app.selectGuild(joined);
      },
    }));
  },
};
