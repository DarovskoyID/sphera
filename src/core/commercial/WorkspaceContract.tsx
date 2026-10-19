import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { useApp } from '../../context/AppContext';
import { useCommercial } from './store';
import { parseServiceDocument } from './schema';

export function WorkspaceContract({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  const { currentServerIP, authToken, language, setCurrentServer, setCurrentSettingsPage } = useApp();
  const { services, status } = useCommercial();
  const available = status === 'ready' && services.some(service => service.id === moduleId && service.available);
  const [contract, setContract] = useState<'loading' | 'valid' | 'invalid'>('loading');
  const ru = language === 'ru';
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController(); setContract(current => current === 'valid' ? current : 'loading');
    void fetch(`${currentServerIP}/api/modules/commercial/${moduleId}/view/`, { headers: { Authorization: `Bearer ${authToken}` }, signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(response.status === 403 ? 'denied' : 'unavailable'); return parseServiceDocument(await response.json()); })
      .then(document => { if (!document.nodes.some(node => node.kind === 'workspace' && node.id === moduleId)) throw new Error(); if (!controller.signal.aborted) setContract('valid'); })
      .catch(error => { if (!controller.signal.aborted) setContract(current => current === 'valid' && error.message !== 'denied' ? 'valid' : 'invalid'); });
    return () => controller.abort();
  }, [moduleId, currentServerIP, authToken, available]);
  if (available && contract === 'loading') return <p role="status">{ru ? 'Открываем сервис…' : 'Opening service…'}</p>;
  if (available && contract === 'invalid') return <p role="alert">{ru ? 'Не удалось получить интерфейс сервиса.' : 'Could not load the service interface.'}</p>;
  const explicitlyDenied = status === 'ready' && services.some(service => service.id === moduleId && service.subscription.status !== 'active');
  const local = moduleId === 'conference' ? !explicitlyDenied : available || moduleId !== 'multiserver';
  return <div style={{ display: 'contents' }}>
    {!available && <div className="commercial-surface" role="status" style={{ position: 'fixed', right: 16, top: 12, zIndex: 90, maxWidth: 360, padding: 12, borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}>
      {ru ? 'Для платных операций нужен ключ. Ваши данные доступны на этом узле.' : 'Paid operations require an access key. Your data remains available on this node.'}
      <button style={{ display: 'block', marginTop: 10, padding: '9px 14px', borderRadius: 8, border: 0, background: 'var(--accent-primary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }} onClick={() => { setCurrentServer('settings'); setCurrentSettingsPage('subscriptions'); }}>{ru ? 'Активировать ключ' : 'Activate key'}</button>
    </div>}
    {local && children}
  </div>;
}

export function wrapWorkspaceComponent<T extends object>(moduleId: string, Render: ComponentType<T>): ComponentType<T> {
  return function WorkspaceView(props: T) { return <WorkspaceContract moduleId={moduleId}>{createElement(Render, props)}</WorkspaceContract>; };
}
