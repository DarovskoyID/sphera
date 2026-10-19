import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../../context/AppContext';
import { useSlot } from '../../sdk/slots';
import { connectModules, connectPublicModules, disconnectModules, useModules } from './registry';
import { bindHost } from '../../sdk/runtime';
import { CommercialRuntime } from '../commercial/Runtime';

/** Loads the user's installed modules and mounts their providers and overlays. */
export function ModuleHost({ children }: { children: ReactNode }) {
  const { authToken, currentServerIP, language, setCurrentServer } = useApp();
  bindHost({ language, navigate: setCurrentServer });

  useEffect(() => {
    if (!authToken) {
      disconnectModules();
      connectPublicModules(currentServerIP);
      return;
    }
    connectModules(currentServerIP, authToken).catch(e => console.error('[modules] catalog failed', e));
  }, [authToken, currentServerIP]);

  // Module providers wrap the app, so adding them remounts it. Wait for the
  // first activation to settle before showing the UI, so nothing the user
  // does in the first seconds is thrown away by that remount.
  const { ready } = useModules();
  const [waitedEnough, setWaitedEnough] = useState(false);
  useEffect(() => {
    if (!authToken) return;
    const t = setTimeout(() => setWaitedEnough(true), 8000);  // never block on a broken catalog
    return () => clearTimeout(t);
  }, [authToken]);

  const providers = useSlot('app.provider');
  if (authToken && !ready && !waitedEnough) {
    return <div className="app-loading" style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)' }} />;
  }
  return providers.reduceRight<ReactNode>(
    (acc, p) => <p.render key={`${p.moduleId}:${p.id}`}>{acc}</p.render>,
    <><CommercialRuntime />{children}</>,
  );
}

export function ModuleOverlays() {
  const overlays = useSlot('app.overlay');
  return <>{overlays.map(o => <o.render key={`${o.moduleId}:${o.id}`} />)}</>;
}
