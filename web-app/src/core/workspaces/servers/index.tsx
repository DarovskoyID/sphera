import { useState, type ReactNode, type CSSProperties } from 'react';
import { defineModule, tmStatic } from '@sfera/sdk';
import {
  addServerIcon, CreateGuildModal, joinServerIcon, JoinGuildModal, KickNotification, MobileVoiceBanner, MutualServers,
  ServerView, SidebarVoiceBar,
} from './extras';
import { ServersExploreBridge, serversSearch } from './ServersExploreBridge';
import { currentGuildStickers, ServersProvider, useApp } from './ServersContext';
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

function Workspace({ style }: { style?: CSSProperties }) {
  const { guilds, selectGuild, language } = useApp();
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const ru = language === 'ru';
  return <section style={{ overflowY: 'auto', padding: 24, ...style }}>
    <h1>{ru ? 'Сообщества' : 'Communities'}</h1>
    <button onClick={() => setDialog('create')}>{ru ? 'Создать' : 'Create'}</button>
    <button onClick={() => setDialog('join')}>{ru ? 'Присоединиться' : 'Join'}</button>
    {guilds.map(guild => <p key={guild.id}><button onClick={() => selectGuild(guild)}>{guild.name}</button></p>)}
    {dialog === 'create' && <CreateGuildModal onClose={() => setDialog(null)} />}
    {dialog === 'join' && <JoinGuildModal onClose={() => setDialog(null)} />}
  </section>;
}

export default defineModule({
  id: 'servers',
  setup(ctx) {
    ctx.slot('main.view', { id: 'servers-workspace', match: route => route.currentServer === 'servers:', render: Workspace });
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
