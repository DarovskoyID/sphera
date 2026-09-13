import { AppProvider, useApp } from './context/AppContext';
import { useTranslation } from './i18n/useTranslation';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCallModal } from './components/IncomingCallModal';
import { CallWindow } from './components/CallWindow';
import { ExploreSphere } from './core/explore/ExploreSphere';
import { OnboardingTour } from './components/OnboardingTour';
import { applyA11y } from './utils/accessibility';
import { applyDisplayPrefs } from './utils/displayPrefs';
import { getKeybindings, onKeybindingsUpdate, eventToCombo, comboMainKey, toggleDeafen, type ActionId } from './utils/keybindings';
import { initNativeBridge } from './utils/nativeBridge';
import { ModuleHost, ModuleOverlays } from './core/modules/ModuleHost';
import { useSlot } from './sdk/slots';

// Apply saved accessibility + display preferences as early as possible.
applyA11y();
applyDisplayPrefs();
// Expose the WebView "allow scale" value to the native shell.
initNativeBridge();



const TOAST_DURATION = 5000;

function ToastItem({ id, message: rawMessage, onDismiss }: { id: number; message: string; onDismiss: (id: number) => void }) {
  const tr = useTranslation();
  const message = rawMessage.startsWith('error_') ? (tr(rawMessage as any) || rawMessage) : rawMessage;
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
          <div style={{ color: '#ed4245', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{tr('error_label')}</div>
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

function useKeybindings() {
  const { isMicActive, setMicActive, toggleTheme, setCurrentServer } = useApp();
  const ref = useRef({ isMicActive, setMicActive, toggleTheme, setCurrentServer });
  ref.current = { isMicActive, setMicActive, toggleTheme, setCurrentServer };
  const bindingsRef = useRef(getKeybindings());
  const pttKeyRef = useRef<string | null>(null);

  useEffect(() => onKeybindingsUpdate(() => { bindingsRef.current = getKeybindings(); }), []);

  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t || !t.tagName) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    };
    const run = (action: ActionId) => {
      const a = ref.current;
      switch (action) {
        case 'toggle_mic': a.setMicActive(!a.isMicActive); break;
        case 'toggle_deafen': toggleDeafen(); break;
        case 'toggle_theme': a.toggleTheme(); break;
        case 'open_settings': a.setCurrentServer('settings'); break;
        case 'focus_search': {
          const el = document.querySelector<HTMLInputElement>('.chat-sidebar input, input[type="search"]');
          el?.focus();
          break;
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const combo = eventToCombo(e);
      if (!combo) return;
      for (const b of bindingsRef.current) {
        if (b.keys !== combo) continue;
        e.preventDefault();
        if (b.action === 'push_to_talk') {
          if (!pttKeyRef.current) {
            pttKeyRef.current = comboMainKey(b.keys);
            ref.current.setMicActive(true);
          }
        } else {
          run(b.action);
        }
        break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!pttKeyRef.current) return;
      const released = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const isMod = e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta';
      if (released === pttKeyRef.current || isMod) {
        pttKeyRef.current = null;
        ref.current.setMicActive(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}

function AppContent() {
  const { authToken, isCallActive, currentView, currentChat, mobileActivePanel } = useApp();
  const moduleViews = useSlot('main.view');
  useKeybindings();

  if (!authToken) {
    return <>
      <AuthScreen />
      <ToastContainer />
    </>;
  }

  const inChat = isCallActive && currentView === 'home' && !!currentChat;
  const { currentServer } = useApp();
  const inExplore = currentServer === 'explore';
  const moduleView = moduleViews.find(v => v.match({ currentServer, currentView }));

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}${isCallActive ? ' call-active' : ''}`}>
      <ServerSidebar />
      {moduleView ? (
        <moduleView.render style={{ gridColumn: '2 / -1' }} />
      ) : inExplore ? (
        <ExploreSphere style={{ gridColumn: '2 / -1' }} />
      ) : (
        <>
          <ChatSidebar />
          <ChatMain />
        </>
      )}
      <IncomingCallModal />
      {isCallActive && !inChat && <CallWindow />}
      <ToastContainer />
      <ModuleOverlays />
      <OnboardingTour />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <ModuleHost>
        <AppContent />
      </ModuleHost>
    </AppProvider>
  );
}

export default App;
