import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { CommercialDocument } from './ServiceDocument';
import { parseServiceCatalog, type CommercialService } from './schema';


export function CommercialServicesPage() {
  const { currentServerIP, authToken, language } = useApp();
  const ru = language === 'ru';
  const [services, setServices] = useState<CommercialService[]>([]);
  const selection = useRef(0);
  const [status, setStatus] = useState('loading');
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const request = useCallback(async (path: string, values?: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(`${currentServerIP}/api/modules/commercial/${path}`, {
      method: values === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: values === undefined ? undefined : JSON.stringify({ values }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'commercial_unavailable');
    return body;
  }, [currentServerIP, authToken]);
  useEffect(() => {
    const controller = new AbortController();
    ++selection.current;
    setStatus('loading'); setSelected(null); setDocument(null);
    void request('', undefined, controller.signal).then(body => {
      setServices(parseServiceCatalog(body)); setStatus('ready');
    }).catch(error => { if (!controller.signal.aborted) setStatus(error.message); });
    return () => controller.abort();
  }, [request]);
  const open = async (id: string) => {
    const version = ++selection.current;
    setDocument(null); setSelected(id);
    try { const data = await request(`${encodeURIComponent(id)}/view/`); if (selection.current === version) setDocument(data); }
    catch (error) { if (selection.current === version) { setStatus(error instanceof Error ? error.message : 'commercial_unavailable'); setSelected(null); } }
  };
  return <section>
    <h1>{ru ? 'Подписки на сервер' : 'Server subscriptions'}</h1>
    <p>{ru ? 'Одна подписка на модуль действует для всех пользователей этого сервера. Базовое общение остаётся доступным без подписки.' : 'One module subscription covers everyone on this server. Basic messaging remains available without a subscription.'}</p>
    {status === 'loading' && <p role="status">{ru ? 'Загрузка…' : 'Loading…'}</p>}
    {status !== 'ready' && status !== 'loading' && <p role="status">{status === 'commercial_not_configured'
      ? (ru ? 'Сервис подписок ещё не подключён администратором.' : 'The administrator has not connected the subscription service yet.')
      : (ru ? 'Сервис подписок сейчас недоступен.' : 'The subscription service is currently unavailable.')}</p>}
    {selected ? <>
      <button onClick={() => { ++selection.current; setSelected(null); setDocument(null); }}>{ru ? 'К списку модулей' : 'Back to modules'}</button>
      {document === null ? <p role="status">{ru ? 'Загрузка…' : 'Loading…'}</p> : <CommercialDocument key={selected} document={document}
        messages={{ invalid: ru ? 'Не удалось показать модуль: неверный ответ сервиса.' : 'The service returned an invalid document.', pending: ru ? 'Выполняется…' : 'Working…', failed: ru ? 'Действие не выполнено.' : 'The action failed.' }}
        onAction={async (action, values) => { const version = selection.current; await request(`${encodeURIComponent(selected)}/actions/${encodeURIComponent(action)}/`, values); const data = await request(`${encodeURIComponent(selected)}/view/`); if (selection.current === version) setDocument(data); }} />}
    </> : services.map(service => <div key={service.id} style={{ padding: 16, marginBottom: 12, border: '1px solid var(--border-color)', borderRadius: 8 }}>
      <h3>{service.name[language] || service.name.en || service.id}</h3>
      <p>{service.subscription.status === 'active'
        ? (service.available ? (ru ? 'Подписка активна' : 'Subscription active') : (ru ? 'Подписка активна. Перенос функций модуля ещё не завершён.' : 'Subscription active. Module migration is not complete yet.'))
        : service.subscription.status === 'expired' ? (ru ? 'Подписка истекла' : 'Subscription expired')
          : service.subscription.status === 'revoked' ? (ru ? 'Подписка отозвана' : 'Subscription revoked')
            : service.subscription.status === 'paused' ? (ru ? 'Подписка приостановлена' : 'Subscription paused')
              : (ru ? 'Нужна подписка' : 'Subscription required')}</p>
      {service.available && <button onClick={() => void open(service.id)}>{ru ? 'Открыть' : 'Open'}</button>}
    </div>)}
    <footer style={{ marginTop: 24, fontSize: 12, color: 'var(--text-secondary)' }}>
      AGPLv3 · <a href="https://github.com/DarovskoyID/sphera" target="_blank" rel="noopener noreferrer">{ru ? 'Исходный код ядра' : 'Core source code'}</a>
    </footer>
  </section>;
}
