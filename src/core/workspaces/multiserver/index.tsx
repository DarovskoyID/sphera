import { useState } from 'react';
import { Lock, Server } from 'lucide-react';
import { defineModule, tmStatic, useT } from '@sfera/sdk';
import { ServerSelector } from './ServerSelector';

/** Under the sign-in form: pick which Sfera server to sign in to. */
function AuthServerPicker() {
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, padding: 0 }}>
        <Lock size={13} />
        {tr('srv_title')}
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <ServerSelector compact maxListHeight={200} />
        </div>
      )}
    </div>
  );
}

function ServersSettings() {
  const tr = useT();
  return (
    <section>
      <h1><Server size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />{tr('srv_title')}</h1>
      <p>{tr('srv_desc')}</p>
      <ServerSelector />
    </section>
  );
}

export default defineModule({
  id: 'multiserver',
  setup(ctx) {
    ctx.slot('auth.footer', { id: 'server-picker', render: AuthServerPicker });
    ctx.slot('settings.page', { id: 'servers', label: () => tmStatic('settings_servers'), render: ServersSettings });
  },
});
