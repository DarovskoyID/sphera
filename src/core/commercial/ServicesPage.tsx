import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { CommercialDocument } from './ServiceDocument';
import { parseServiceDocument } from './schema';
import { refreshCommercial, useCommercial } from './store';
import { ActivationForm } from './ActivationForm';
import { openWorkspace } from './navigation';


export function CommercialServicesPage({ initialModule }: { initialModule?: string }) {
  const { currentServerIP, authToken, language, setCurrentServer, setCurrentSettingsPage } = useApp();
  const ru = language === 'ru';
  const { services, status, server } = useCommercial();
  const selection = useRef(0);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const request = useCallback(async (path: string, values?: Record<string, unknown>, signal?: AbortSignal, requestId?: string) => {
    const response = await fetch(`${currentServerIP}/api/modules/commercial/${path}`, {
      method: values === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: values === undefined ? undefined : JSON.stringify({ values, request_id: requestId }),
    });
    const body = await response.json();
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'commercial_unavailable';
      const details: Record<string, [string, string]> = {
        subscription_required: ['Нужна активная подписка на этот модуль.', 'An active subscription is required.'],
        admin_required: ['Настройка доступна только администратору сервера.', 'Only the server administrator can configure this integration.'],
        integration_not_configured: ['Администратору нужно настроить подключение.', 'The administrator needs to configure the integration.'],
        invalid_values: ['Проверьте заполненные поля.', 'Check the form fields.'],
        action_outcome_unknown: ['Не удалось подтвердить результат. Проверьте запись в CRM перед новым запросом: повтор того же запроса заблокирован.', 'The outcome could not be confirmed. Check the CRM before starting a new request; replaying this request is blocked.'],
        integration_request_failed: ['Интеграция не подтвердила результат. Проверьте подключение и CRM перед новым запросом.', 'The integration did not confirm the result. Check the connection and CRM before a new request.'],
      };
      throw Object.assign(new Error(code), { userMessage: details[code]?.[ru ? 0 : 1] });
    }
    return body;
  }, [currentServerIP, authToken, ru]);
  useEffect(() => {
    ++selection.current; setSelected(null); setDocument(null); setError('');
    return () => { ++selection.current; };
  }, [request]);
  const open = async (id: string) => {
    const version = ++selection.current;
    setDocument(null); setSelected(id); setError('');
    try { const data = parseServiceDocument(await request(`${encodeURIComponent(id)}/view/`)); if (selection.current === version) setDocument(data); }
    catch (error) { if (selection.current === version) { setError(error instanceof Error ? error.message : 'commercial_unavailable'); setSelected(null); } }
  };
  useEffect(() => {
    if (initialModule && status === 'ready' && server === currentServerIP && services.find(service => service.id === initialModule)?.available) void open(initialModule);
  }, [initialModule, status, server, currentServerIP, request]);
  return <section className="commercial-surface">
    {initialModule && <button onClick={() => { setCurrentServer('settings'); setCurrentSettingsPage('subscriptions'); }}>{ru ? 'Все сервисы' : 'All services'}</button>}
    <h1>{initialModule ? services.find(service => service.id === initialModule)?.name[language] || initialModule : ru ? 'Подписки на сервер' : 'Server subscriptions'}</h1>
    <p>{ru ? 'Одна подписка на модуль действует для всех пользователей этого сервера. Базовое общение остаётся доступным без подписки.' : 'One module subscription covers everyone on this server. Basic messaging remains available without a subscription.'}</p>
    {!initialModule && <ActivationForm />}
    <button onClick={() => void refreshCommercial()} disabled={status === 'loading'}>{ru ? 'Обновить подписки' : 'Refresh subscriptions'}</button>
    {error && <p role="alert">{error === 'subscription_required' ? (ru ? 'Для этого действия нужна активная подписка.' : 'An active subscription is required.') : (ru ? 'Не удалось открыть сервис. Проверьте подключение и права доступа.' : 'Could not open the service. Check your connection and permissions.')}</p>}
    {status === 'loading' && <p role="status">{ru ? 'Загрузка…' : 'Loading…'}</p>}
    {status !== 'ready' && status !== 'loading' && <p role="status">{status === 'commercial_not_configured'
      ? (ru ? 'Сервис подписок ещё не подключён администратором.' : 'The administrator has not connected the subscription service yet.')
      : (ru ? 'Сервис подписок сейчас недоступен.' : 'The subscription service is currently unavailable.')}</p>}
    {selected ? <>
      <button onClick={() => { ++selection.current; setSelected(null); setDocument(null); }}>{ru ? 'К списку модулей' : 'Back to modules'}</button>
      {document === null ? <p role="status">{ru ? 'Загрузка…' : 'Loading…'}</p> : <CommercialDocument key={`${selected}:${revision}`} document={document} onWorkspace={id => { if (id === selected) openWorkspace(id, setCurrentServer, setCurrentSettingsPage); }}
        messages={{ invalid: ru ? 'Не удалось показать модуль: неверный ответ сервиса.' : 'The service returned an invalid document.', pending: ru ? 'Выполняется…' : 'Working…', failed: ru ? 'Действие не выполнено.' : 'The action failed.', openWorkspace: ru ? 'Открыть' : 'Open' }}
        onAction={async (action, values, requestId) => { const version = selection.current; const result = await request(`${encodeURIComponent(selected)}/actions/${encodeURIComponent(action)}/`, values, undefined, requestId); if (selection.current !== version) return; const data = parseServiceDocument(result.document ?? await request(`${encodeURIComponent(selected)}/view/`)); if (selection.current === version) { setDocument(data); setRevision(value => value + 1); } }} />}
    </> : (server === currentServerIP ? services : []).filter(service => !initialModule || service.id === initialModule).map(service => <div key={service.id} style={{ padding: 16, marginBottom: 12, border: '1px solid var(--border-color)', borderRadius: 8 }}>
      <h3>{service.name[language] || service.name.en || service.id}</h3>
      <p>{service.migrated ? (ru ? 'Работает через сервис компании' : 'Runs through the company service') : (ru ? 'Функции модуля ещё переносятся' : 'Module migration is in progress')}</p>
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
