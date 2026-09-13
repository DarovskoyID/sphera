import React, { useRef, useState } from 'react';
import { Compass, Home, Plus, Settings } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useTranslation } from '../i18n/useTranslation';
import { RailSlot, SlotList } from '../core/modules/Slots';
import { useSlot, type SlotEntry } from '../sdk/slots';
import { useAnchoredMenu } from './useAnchoredMenu';

/**
 * The "+" menu at the foot of the rail: whatever modules offer to create or join.
 * Its own component so it can use the shared anchoring hook.
 */
const AddMenu: React.FC<{
  pos: { x: number; y: number };
  anchorButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onPick: (action: SlotEntry<'rail.addAction'>) => void;
}> = ({ pos, anchorButton, onClose, onPick }) => {
  const { ref, style, portal } = useAnchoredMenu(pos, onClose, anchorButton);
  const actions = useSlot('rail.addAction');
  return portal(
    <div ref={ref} className="context-menu" style={{ ...style, minWidth: 180, zIndex: 9999 }}>
      {actions.map(a => (
        <button key={`${a.moduleId}:${a.id}`} className="context-menu-item" onClick={() => onPick(a)}>
          {a.icon} {a.label()}
        </button>
      ))}
    </div>
  );
};

/** The left rail: core destinations, then whatever installed modules put there. */
export const ServerSidebar: React.FC = () => {
  const { currentServer, setCurrentServer, isMobileSidebarOpen } = useApp();
  const tr = useTranslation();
  const addActions = useSlot('rail.addAction');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [moduleAction, setModuleAction] = useState<SlotEntry<'rail.addAction'> | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <aside className={`server-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`} data-tour="server-dock">
        <div className="server-list">
          <button
            className={`server-icon ${currentServer === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentServer('settings')}
            title={tr('nav_settings')}
            data-tour="nav-settings"
          >
            <Settings size={20} />
          </button>

          <button
            className={`server-icon ${currentServer === 'home' ? 'active' : ''}`}
            onClick={() => setCurrentServer('home')}
            title={tr('nav_direct_messages')}
            data-tour="nav-home"
          >
            <Home size={20} />
          </button>

          <div className="server-divider" />

          <button
            className={`server-icon ${currentServer === 'explore' ? 'active' : ''}`}
            onClick={() => setCurrentServer('explore')}
            title={tr('nav_explore')}
            data-tour="nav-explore"
          >
            <Compass size={20} />
          </button>

          <RailSlot />

          <div className="server-guild-scroll">
            <SlotList slot="nav.railScroll" />
            {addActions.length > 0 && (
              <button
                ref={addBtnRef}
                data-tour="nav-add"
                className="server-icon server-icon-add"
                onClick={() => {
                  const r = addBtnRef.current?.getBoundingClientRect();
                  if (r) setMenuPos({ x: r.right + 8, y: r.top });
                  setShowAddMenu(v => !v);
                }}
                title={tr('srv_add_title')}
              >
                <Plus size={20} />
              </button>
            )}
          </div>
        </div>
      </aside>

      {showAddMenu && menuPos && (
        <AddMenu
          pos={menuPos}
          anchorButton={addBtnRef}
          onClose={() => setShowAddMenu(false)}
          onPick={action => { setShowAddMenu(false); setModuleAction(action); }}
        />
      )}
      {moduleAction && <moduleAction.render onClose={() => setModuleAction(null)} />}
    </>
  );
};
