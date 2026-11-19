import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut, ShieldAlert } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api, type Status } from './api';
import { BRAND, SetupFlow } from './Setup';
import { Button } from './ui';

/**
 * The screen an account sees when the superuser requires two-factor and this
 * one has no authenticator yet.
 *
 * It is a courtesy, not the protection: the server already refuses every API
 * call and every socket from this account (ACCESS_GUARD in the module's guard).
 * Closing this overlay in the browser's inspector leaves the app just as dead —
 * and the set-up below works, because that one path stays open on purpose.
 */
export function Gate() {
  const t = useModuleT();
  const { authToken, currentServerIP, setAuthToken } = useCore();
  const conn = useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
  const [status, setStatus] = useState<Status | null>(null);

  const load = useCallback(() => {
    if (!authToken) return;
    api.status(conn).then(setStatus).catch(() => setStatus(null));
  }, [authToken, conn]);

  useEffect(() => {
    load();
    // The superuser may flip the switch while someone is sitting in the app.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!authToken || !status?.must_enable) return null;

  return (
    <div role="dialog" aria-modal="true"
      style={{ position: 'fixed', inset: 0, zIndex: 9400, background: 'var(--bg-primary)', overflow: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 620, margin: '32px auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 18, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <span style={{ width: 46, height: 46, borderRadius: 14, background: `color-mix(in srgb, ${BRAND} 16%, transparent)`, color: BRAND, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ShieldAlert size={23} />
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text-primary)' }}>{t('tf_gate_title')}</h1>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('tf_gate_sub')}</div>
          </div>
        </div>
        <SetupFlow conn={conn} onEnabled={() => { load(); window.location.reload(); }} />
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('tf_gate_foot')}</span>
          <Button onClick={() => { try { setAuthToken(''); } catch (e) { reportError(e); } }}>
            <LogOut size={15} /> {t('tf_sign_out')}
          </Button>
        </div>
      </div>
    </div>
  );
}
