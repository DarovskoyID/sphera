import './commercial.css';
import { useEffect, type CSSProperties } from 'react';
import { useApp } from '../../context/AppContext';
import { registerSlot } from '../../sdk/slots';
import { CommercialServicesPage } from './ServicesPage';
import { connectCommercial, refreshCommercial } from './store';

export const MIGRATED_COMMERCIAL_IDS = new Set(['amocrm', 'bitrix', 'onec']);

/** Built into the open core. Company data never supplies executable components. */
export function CommercialRuntime() {
  const { authToken, currentServerIP } = useApp();
  useEffect(() => connectCommercial(currentServerIP, authToken), [currentServerIP, authToken]);
  useEffect(() => {
    if (!authToken) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshCommercial(true); }, 15000);
    return () => clearInterval(timer);
  }, [authToken, currentServerIP]);
  useEffect(() => {
    if (!authToken) return;
    const cleanup = [...MIGRATED_COMMERCIAL_IDS].map(id => registerSlot('commercial-core', 'main.view', {
      id, match: route => route.currentServer.startsWith(`${id}:`),
      render: function ServiceView({ style }: { style?: CSSProperties }) { return <div style={{ flex: 1, overflowY: 'auto', padding: 24, ...style }}><CommercialServicesPage initialModule={id} /></div>; },
    }));
    return () => cleanup.forEach(dispose => dispose());
  }, [authToken]);
  return null;
}
