import React from 'react';
import { Settings, Home } from 'lucide-react';
import { useApp } from '../context/AppContext';

export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen } = useApp();

  return (
    <aside className={`server-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
      <div className="server-list">
        <button
          className={`server-icon ${currentServer === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentServer('settings')}
          title="Settings"
        >
          <Settings size={20} />
        </button>

        <button
          className={`server-icon ${currentServer === 'home' ? 'active' : ''}`}
          onClick={() => setCurrentServer('home')}
          title="Direct Messages"
        >
          <Home size={20} />
        </button>
      </div>
    </aside>
  );
};
