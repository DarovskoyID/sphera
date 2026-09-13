import { useEffect, type ReactNode } from 'react';
import { useApp } from '../../context/AppContext';
import { useSlot } from '../../sdk/slots';
import { connectModules, disconnectModules } from './registry';
import { bindHost } from '../../sdk/runtime';

/** Loads the user's installed modules and mounts their providers and overlays. */
export function ModuleHost({ children }: { children: ReactNode }) {
  const { authToken, currentServerIP, language, setCurrentServer } = useApp();
  bindHost({ language, navigate: setCurrentServer });

  useEffect(() => {
    if (!authToken) {
      disconnectModules();
      return;
    }
    connectModules(currentServerIP, authToken).catch(e => console.error('[modules] catalog failed', e));
  }, [authToken, currentServerIP]);

  const providers = useSlot('app.provider');
  return providers.reduceRight<ReactNode>(
    (acc, p) => <p.render key={`${p.moduleId}:${p.id}`}>{acc}</p.render>,
    <>{children}</>,
  );
}

export function ModuleOverlays() {
  const overlays = useSlot('app.overlay');
  return <>{overlays.map(o => <o.render key={`${o.moduleId}:${o.id}`} />)}</>;
}
