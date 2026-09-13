import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { registerSlot } from '../sdk/slots';

interface ExploreGuild {
  id: string;
  name: string;
  description: string;
  icon: string;
  member_count: number;
  invite_code: string;
  is_member?: boolean;
}

/**
 * Servers search for «Исследовать сферу». Transitional: registered by the core
 * until servers become a module, which takes this provider over.
 */
export function ServersExploreBridge() {
  const app = useApp();
  const ref = useRef(app);
  ref.current = app;

  useEffect(() => registerSlot('servers', 'explore.search', {
    id: 'servers',
    order: 10,
    label: () => (ref.current.language === 'ru' ? 'Серверы' : 'Servers'),
    async search(query, signal) {
      const { currentServerIP, authToken } = ref.current;
      const res = await fetch(`${currentServerIP}/api/guilds/explore/?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${authToken}` }, signal,
      });
      if (!res.ok) return [];
      const rows: ExploreGuild[] = await res.json();
      const isRu = ref.current.language === 'ru';
      return rows.map(g => ({
        id: `server:${g.id}`,
        kind: 'server',
        title: g.name,
        subtitle: `${g.member_count} ${isRu ? 'участн.' : 'members'}${g.description ? ` · ${g.description}` : ''}`,
        avatar: g.icon || null,
        badge: g.is_member ? (isRu ? 'Вы здесь' : "You're in") : undefined,
        open: async () => {
          const { guilds, selectGuild, joinGuild } = ref.current;
          const existing = guilds.find(x => String(x.id) === String(g.id));
          if (existing) { selectGuild(existing); return; }
          const joined = await joinGuild(g.invite_code);
          if (joined) selectGuild(joined);
        },
      }));
    },
  }), []);

  return null;
}
