import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';
import { AuthScreen } from './components/AuthScreen';
import { IncomingCallModal } from './components/IncomingCallModal';

function AppContent() {
  const { authToken, mobileActivePanel, isMobileSidebarOpen, toggleMobileSidebar } = useApp();

  if (!authToken) {
    return <AuthScreen />;
  }

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}`}>
      <ServerSidebar />
      {isMobileSidebarOpen && (
        <div className="mobile-overlay" onClick={toggleMobileSidebar} />
      )}
      <ChatSidebar />
      <ChatMain />
      <IncomingCallModal />
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
