import { AppProvider, useApp } from './context/AppContext';
import { useTranslation } from './i18n/useTranslation';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';
import { GuildSidebar } from './components/GuildSidebar';
import { GuildChatMain } from './components/GuildChatMain';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCallModal } from './components/IncomingCallModal';
import { CallWindow } from './components/CallWindow';
import { GuildVoiceRoom } from './components/GuildVoiceRoom';

function GuildKickNotification() {
  const { guildKickNotification, clearGuildKickNotification } = useApp();
  const tr = useTranslation();
  if (!guildKickNotification) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      zIndex: 99999, background: '#ed4245', borderRadius: 10,
      padding: '14px 24px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: 16, maxWidth: 420, width: '90%',
    }}>
      <div style={{ flex: 1, color: '#fff' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{tr('guild_kicked_title')}</div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>{tr('guild_kicked_msg')} <b>{guildKickNotification.message}</b></div>
      </div>
      <button onClick={clearGuildKickNotification} style={{
        background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 6,
        color: '#fff', fontWeight: 600, fontSize: 13, padding: '6px 14px', cursor: 'pointer',
      }}>{tr('cancel')}</button>
    </div>
  );
}

function ErrorModal() {
  const { errorMessage, clearError } = useApp();
  if (!errorMessage) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
    }}>
      <div style={{
        background: 'var(--bg-primary, #1a1a2e)',
        border: '1px solid var(--border-color, #333)',
        borderRadius: 12,
        padding: '28px 32px',
        maxWidth: 360,
        width: '90%',
        boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <div style={{ color: '#ff6666', fontWeight: 700, fontSize: 15 }}>Error</div>
        <div style={{ color: 'var(--text-primary, #fff)', fontSize: 14, lineHeight: 1.5 }}>{errorMessage}</div>
        <button
          onClick={clearError}
          style={{
            alignSelf: 'flex-end', padding: '8px 24px',
            background: 'var(--accent-primary, #5865f2)', border: 'none',
            borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer',
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}

function AppContent() {
  const { authToken, isCallActive, currentView, currentChat, mobileActivePanel, isMobileSidebarOpen, toggleMobileSidebar, currentGuild, currentVoiceChannel } = useApp();

  if (!authToken) {
    return <AuthScreen />;
  }

  const inChat = isCallActive && currentView === 'home' && !!currentChat;
  const inGuild = currentView === 'server' && !!currentGuild;

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}`}>
      <ServerSidebar />
      {isMobileSidebarOpen && (
        <div className="mobile-overlay" onClick={toggleMobileSidebar} />
      )}
      {inGuild ? (
        <>
          <GuildSidebar />
          <GuildChatMain />
        </>
      ) : (
        <>
          <ChatSidebar />
          <ChatMain />
        </>
      )}
      <IncomingCallModal />
      {isCallActive && !inChat && <CallWindow />}
      {currentVoiceChannel && <GuildVoiceRoom />}
      <ErrorModal />
      <GuildKickNotification />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
