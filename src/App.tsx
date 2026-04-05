import { AppProvider, useApp } from './context/AppContext';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCallModal } from './components/IncomingCallModal';
import { CallWindow } from './components/CallWindow';

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
  const { authToken, isCallActive, currentView, currentChat, mobileActivePanel, isMobileSidebarOpen, toggleMobileSidebar } = useApp();

  if (!authToken) {
    return <AuthScreen />;
  }

  // CallWindow is rendered inline inside ChatHeader when the user is in the chat.
  // When they navigate away (settings, different view, no chat selected) it floats.
  const inChat = isCallActive && currentView === 'home' && !!currentChat;

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}`}>
      <ServerSidebar />
      {isMobileSidebarOpen && (
        <div className="mobile-overlay" onClick={toggleMobileSidebar} />
      )}
      <ChatSidebar />
      <ChatMain />
      <IncomingCallModal />
      {isCallActive && !inChat && <CallWindow />}
      <ErrorModal />
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
