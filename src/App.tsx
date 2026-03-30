import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';

function AppContent() {
  const { mobileActivePanel, isMobileSidebarOpen, toggleMobileSidebar } = useApp();

  return (
    <div className={`app-container mobile-panel-${mobileActivePanel}`}>
      <ServerSidebar />
      {isMobileSidebarOpen && (
        <div className="mobile-overlay" onClick={toggleMobileSidebar} />
      )}
      <ChatSidebar />
      <ChatMain />
    </div>
  );
}

export default App;
