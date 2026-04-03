import React from 'react';
import { Settings, Home } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';

export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen } = useApp();
  const tr = useTranslation();

  return (
    <aside className={`server-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
      <div className="server-list">
        <button
          className={`server-icon ${currentServer === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentServer('settings')}
          title={tr('nav_settings')}
        >
          <Settings size={20} />
        </button>

        <button
          className={`server-icon ${currentServer === 'home' ? 'active' : ''}`}
          onClick={() => setCurrentServer('home')}
          title={tr('nav_direct_messages')}
        >
          <Home size={20} />
        </button>
      </div>
    </aside>
  );
};
