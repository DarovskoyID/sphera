import React from 'react';
import { AppProvider } from './context/AppContext';
import { ServerSidebar } from './components/ServerSidebar';
import { ChatSidebar } from './components/ChatSidebar';
import { ChatMain } from './components/ChatMain';

function App() {
  return (
    <AppProvider>
      <div className="app-container">
        <ServerSidebar />
        <ChatSidebar />
        <ChatMain />
      </div>
    </AppProvider>
  );
}

export default App;
