import { useApp } from '../../context/AppContext';
import { useCommercial, refreshCommercial } from './store';

export function CommercialCards() {
  const { language, setCurrentServer, setCurrentSettingsPage, currentServerIP } = useApp();
  const { services, status, server } = useCommercial();
  const ru = language === 'ru';
  return <section style={{ padding: '20px 24px 0' }}>
    <h3>{ru ? 'Коммерческие сервисы' : 'Commercial services'}</h3>
    <button onClick={() => { setCurrentServer('settings'); setCurrentSettingsPage('subscriptions'); }}>{ru ? 'Все подписки на сервер' : 'All server subscriptions'}</button>
    {status === 'loading' ? <p role="status">{ru ? 'Загрузка каталога…' : 'Loading catalog…'}</p> : status !== 'ready' ? <p role="status">{ru ? 'Каталог подписок недоступен.' : 'Subscription catalog unavailable.'} <button onClick={() => void refreshCommercial()}>{ru ? 'Повторить' : 'Retry'}</button></p> : null}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, marginTop: 12 }}>
      {(server === currentServerIP ? services : []).filter(service => service.migrated).map(service => <button key={service.id} onClick={() => setCurrentServer(`${service.id}:`)} style={{ textAlign: 'left', padding: 16, border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' }}>
        <strong>{service.name[language] || service.name.en || service.id}</strong>
        <p>{service.available ? (ru ? 'Открыть сервис' : 'Open service') : (ru ? 'Проверить подписку' : 'Check subscription')}</p>
      </button>)}
    </div>
  </section>;
}
