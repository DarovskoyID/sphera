import type { CSSProperties } from 'react';
import { LogIn, PhoneOff, Plus, Volume2 } from 'lucide-react';
import { useCore, useModuleT } from '@sfera/sdk';
import { GuildChatMain } from './GuildChatMain';
import { GuildSidebar } from './GuildSidebar';
import { useApp, useServers } from './ServersContext';
import { CreateGuildModal, JoinGuildModal } from './ServersRail';
import { GuildVoiceStage } from './voiceRoom';

/** The open server: channel list + chat, or the voice stage of the room you are in. */
export function ServerView(_: { style?: CSSProperties }) {
  const { currentGuild, currentGuildChannel, currentVoiceChannel } = useServers();
  if (!currentGuild) return null;
  return (
    <>
      <GuildSidebar />
      {/* Looking at the voice channel you're connected to → the card grid;
          otherwise the text channel (or its welcome screen). */}
      {currentVoiceChannel && !currentGuildChannel && currentGuild.channels?.some(c => c.id === currentVoiceChannel.id)
        ? <GuildVoiceStage />
        : <GuildChatMain />}
    </>
  );
}

/** "You were removed from a server" toast. */
export function KickNotification() {
  const { guildKickNotification, clearGuildKickNotification } = useServers();
  const t = useModuleT();
  if (!guildKickNotification) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 99999, background: '#ed4245',
      borderRadius: 10, padding: '14px 24px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: 16, maxWidth: 420, width: '90%',
    }}>
      <div style={{ flex: 1, color: '#fff' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{t('guild_kicked_title')}</div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>{t('guild_kicked_msg')} <b>{guildKickNotification.message}</b></div>
      </div>
      <button onClick={clearGuildKickNotification} style={{
        background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600,
        fontSize: 13, padding: '6px 14px', cursor: 'pointer',
      }}>{t('cancel')}</button>
    </div>
  );
}

function VoiceBanner({ className, style }: { className: string; style: CSSProperties }) {
  const { currentVoiceChannel, currentGuild, leaveVoiceChannel } = useServers();
  const t = useModuleT();
  if (!currentVoiceChannel) return null;
  return (
    <div className={className} style={style}>
      <Volume2 size={13} style={{ color: '#3ba55c', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: '#3ba55c', fontWeight: 600, lineHeight: 1 }}>{t('voice_connected')}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentGuild ? `${currentGuild.name} / ${currentVoiceChannel.name}` : currentVoiceChannel.name}
        </div>
      </div>
      <button onClick={leaveVoiceChannel} title={t('voice_disconnect')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ed4245', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}>
        <PhoneOff size={14} />
      </button>
    </div>
  );
}

/** Voice connection row above the user panel. */
export function SidebarVoiceBar() {
  return (
    <VoiceBanner className="voice-banner-sidebar" style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexShrink: 0,
      background: 'rgba(59,165,92,0.12)', borderTop: '1px solid rgba(59,165,92,0.25)', borderBottom: '1px solid rgba(59,165,92,0.25)',
    }} />
  );
}

/** Voice connection banner on phones, where the sidebar is not on screen. */
export function MobileVoiceBanner() {
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  if (!isMobile) return null;
  return <VoiceBanner className="app-voice-banner" style={{}} />;
}

/** "N mutual servers" in someone's profile. */
export function MutualServers({ profile }: { userId: string; profile: Record<string, unknown> }) {
  const t = useModuleT();
  const guilds = (profile.mutual_guilds as { id: string; name: string }[] | undefined) ?? [];
  if (!guilds.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {guilds.length} {t('profile_mutual_servers')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {guilds.map(g => (
          <span key={g.id} style={{ fontSize: 12, padding: '4px 9px', borderRadius: 999, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            {g.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export const addServerIcon = <Plus size={14} />;
export const joinServerIcon = <LogIn size={14} />;
export { CreateGuildModal, JoinGuildModal };
export const useServerRoute = () => {
  const { currentServer, currentView } = useCore();
  return { currentServer, currentView };
};
void useApp;
