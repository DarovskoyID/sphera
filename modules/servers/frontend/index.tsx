import type { ReactNode } from 'react';
import { defineModule, tmStatic } from '@sfera/sdk';
import {
  addServerIcon, CreateGuildModal, joinServerIcon, JoinGuildModal, KickNotification, MobileVoiceBanner, MutualServers,
  ServerView, SidebarVoiceBar,
} from './extras';
import { ServersExploreBridge, serversSearch } from './ServersExploreBridge';
import { currentGuildStickers, ServersProvider } from './ServersContext';
import { ServersRail } from './ServersRail';
import { strings } from './i18n';
import { VoiceRoomProvider } from './voiceRoom';

function Providers({ children }: { children: ReactNode }) {
  return (
    <ServersProvider>
      <VoiceRoomProvider>
        <ServersExploreBridge />
        {children}
      </VoiceRoomProvider>
    </ServersProvider>
  );
}

const isModuleRoute = (server: string) => /^[a-z]+:/.test(server);

export default defineModule({
  id: 'servers',
  setup(ctx) {
    ctx.strings(strings);
    ctx.slot('app.provider', { id: 'servers', render: Providers });
    ctx.slot('nav.railScroll', { id: 'servers', render: ServersRail });
    ctx.slot('rail.addAction', { id: 'create', order: 0, label: () => tmStatic('guild_create_server'), icon: addServerIcon, render: CreateGuildModal });
    ctx.slot('rail.addAction', { id: 'join', order: 1, label: () => tmStatic('guild_join_server'), icon: joinServerIcon, render: JoinGuildModal });
    ctx.slot('main.view', {
      id: 'server',
      match: r => r.currentView === 'server' && !['home', 'settings', 'explore'].includes(r.currentServer) && !isModuleRoute(r.currentServer),
      render: ServerView,
    });
    ctx.slot('app.overlay', { id: 'kick', render: KickNotification });
    ctx.slot('app.overlay', { id: 'voice-banner', render: MobileVoiceBanner });
    ctx.slot('sidebar.userPanel', { id: 'voice', render: SidebarVoiceBar });
    ctx.slot('profile.section', { id: 'mutual', render: MutualServers });
    ctx.slot('picker.stickers', { id: 'guild', load: currentGuildStickers });
    ctx.slot('explore.search', serversSearch);
  },
});
