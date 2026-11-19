import { useState } from 'react';
import { Server } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { ServerSelector } from '../core/workspaces/multiserver/ServerSelector';

/** The same server panel is available before sign-in, even without modules. */
export function AuthServerPicker() {
  const tr = useTranslation();
  const [open, setOpen] = useState(false);
  return <div style={{ marginTop: 8 }}>
    <button type="button" aria-expanded={open} aria-controls="auth-server-panel"
      onClick={() => setOpen(value => !value)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, padding: 0 }}>
      <Server size={13} />{tr('srv_title')}
    </button>
    {open && <div id="auth-server-panel" style={{ marginTop: 12 }}>
      <ServerSelector compact maxListHeight={200} />
    </div>}
  </div>;
}
