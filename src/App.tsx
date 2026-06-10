import { AppProvider, useApp } from './context/AppContext';
import { useTranslation } from './i18n/useTranslation';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';
import { GuildSidebar } from './components/GuildSidebar';
import { GuildChatMain } from './components/GuildChatMain';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCallModal } from './components/IncomingCallModal';
import { CallWindow } from './components/CallWindow';
import { GuildVoiceRoom } from './components/GuildVoiceRoom';
import { Volume2, PhoneOff } from 'lucide-react';

function useMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}


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

const TOAST_DURATION = 5000;

function ToastItem({ id, message, onDismiss }: { id: number; message: string; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainRef = useRef(TOAST_DURATION);
  const startRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const barRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>();

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onDismiss(id), 300);
  }, [id, onDismiss]);

  const startTimer = useCallback(() => {
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, remainRef.current);
  }, [dismiss]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    remainRef.current -= Date.now() - startRef.current;
    if (remainRef.current < 0) remainRef.current = 0;
  }, []);

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [startTimer]);

  useEffect(() => {
    const animate = () => {
      if (barRef.current) {
        const elapsed = paused
          ? TOAST_DURATION - remainRef.current
          : TOAST_DURATION - remainRef.current + (Date.now() - startRef.current);
        const pct = Math.min(100, (elapsed / TOAST_DURATION) * 100);
        barRef.current.style.width = `${100 - pct}%`;
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [paused]);

  return (
    <div
      onMouseEnter={() => { setPaused(true); pauseTimer(); }}
      onMouseLeave={() => { setPaused(false); startTimer(); }}
      style={{
        background: 'var(--bg-primary, #1a1a2e)',
        border: '1px solid var(--border-color, #333)',
        borderLeft: '4px solid #ed4245',
        borderRadius: 8,
        padding: '12px 16px 10px',
        minWidth: 300,
        maxWidth: 420,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        display: 'flex', flexDirection: 'column' as const, gap: 8,
        animation: exiting ? 'toast-out 0.3s ease forwards' : 'toast-in 0.3s ease',
        overflow: 'hidden',
        position: 'relative' as const,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#ed4245', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Error</div>
          <div style={{ color: 'var(--text-primary, #fff)', fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word' }}>{message}</div>
        </div>
        <button
          onClick={dismiss}
          style={{
            background: 'none', border: 'none', color: 'var(--text-secondary, #888)',
            cursor: 'pointer', padding: 2, fontSize: 18, lineHeight: 1, flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{
        height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)',
        overflow: 'hidden', marginTop: 2,
      }}>
        <div ref={barRef} style={{
          height: '100%', background: '#ed4245', borderRadius: 2,
          width: '100%', transition: paused ? 'none' : undefined,
        }} />
      </div>
    </div>
  );
}

function ToastContainer() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div style={{
      position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'auto',
    }}>
      {toasts.map(t => (
        <ToastItem key={t.id} id={t.id} message={t.message} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

function AppContent() {
  const { authToken, isCallActive, currentView, currentChat, mobileActivePanel, currentGuild, currentVoiceChannel, leaveVoiceChannel } = useApp();
  const isMobile = useMobile();

  if (!authToken) {
    return <AuthScreen />;
  }

  const inChat = isCallActive && currentView === 'home' && !!currentChat;
  const inGuild = currentView === 'server' && !!currentGuild;

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}${currentVoiceChannel ? ' voice-connected' : ''}`}>
      <ServerSidebar />
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
      {isMobile && currentVoiceChannel && (
        <div className="app-voice-banner">
          <Volume2 size={13} style={{ color: '#3ba55c', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: '#3ba55c', fontWeight: 600, lineHeight: 1 }}>Voice Connected</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentGuild ? `${currentGuild.name} / ${currentVoiceChannel.name}` : currentVoiceChannel.name}
            </div>
          </div>
          <button onClick={leaveVoiceChannel} title="Disconnect" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ed4245', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}>
            <PhoneOff size={14} />
          </button>
        </div>
      )}
      <IncomingCallModal />
      {isCallActive && !inChat && <CallWindow />}
      {currentVoiceChannel && <GuildVoiceRoom />}
      <ToastContainer />
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
