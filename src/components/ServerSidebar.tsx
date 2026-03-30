import React from 'react';
import { Settings, Home } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { serverChannels } from '../data/mockData';

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
          <span className="notification-badge">3</span>
        </button>

        <div className="server-divider"></div>

        {Object.values(serverChannels).map((server) => (
          <button
            key={server.id}
            className={`server-icon ${currentServer === server.id ? 'active' : ''}`}
            onClick={() => setCurrentServer(server.id)}
            title={server.name}
            style={{ background: server.accent }}
          >
            <span className="server-avatar">{server.abbr}</span>
            {server.notifications && server.notifications > 0 && (
              <span className="notification-badge">{server.notifications}</span>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
};
