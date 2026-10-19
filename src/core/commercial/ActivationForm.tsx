import { useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { refreshCommercial } from './store';

type Props = { moduleId?: string; onActivated?: () => void; onPendingChange?: (pending: boolean) => void; autoFocus?: boolean };

export function ActivationForm({ moduleId, onActivated, onPendingChange, autoFocus = false }: Props) {
  const { currentUser, currentServerIP, authToken, language } = useApp();
  const ru = language === 'ru';
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  if (!currentUser?.is_superuser) return <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{ru ? 'Ключ доступа активирует администратор сервера.' : 'The server administrator activates access keys.'}</p>;
  return <form className="commercial-surface" autoComplete="off" onSubmit={async event => {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setPending(true); onPendingChange?.(true); setMessage('');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${currentServerIP}/api/modules/commercial/activate/`, {
        method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key.trim(), ...(moduleId ? { module_id: moduleId } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) {
        const messages: Record<string, [string, string]> = {
          license_module_mismatch: ['Этот ключ не включает выбранный модуль. Введите ключ для него.', 'This key does not include the selected module. Enter a matching key.'],
          license_already_bound: ['Ключ уже привязан к другому серверу.', 'This key is already bound to another server.'],
          license_invalid_or_expired: ['Ключ недействителен, отозван или срок его действия истёк.', 'This key is invalid, revoked or expired.'],
          invalid_activation: ['Проверьте формат ключа доступа.', 'Check the access key format.'],
          commercial_not_configured: ['Администратору нужно настроить адрес сервиса лицензий на узле.', 'Configure the license service address on this node first.'],
        };
        setMessage(messages[data.error]?.[ru ? 0 : 1] || (ru ? 'Не удалось активировать ключ. Повторите запрос позже.' : 'Could not activate the key. Try again later.'));
        return;
      }
      if (data.activated !== true || !Array.isArray(data.modules) || (moduleId && !data.modules.includes(moduleId))) throw new Error('invalid_activation_response');
      setKey('');
      setMessage(ru ? 'Ключ активирован для этого сервера.' : 'The key is activated for this server.');
      await refreshCommercial(true);
      onActivated?.();
    } catch { setMessage(ru ? 'Нет ответа сервиса. Повторите запрос с тем же ключом.' : 'No response. Retry with the same key.'); }
    finally { clearTimeout(timeout); lock.current = false; setPending(false); onPendingChange?.(false); }
  }} style={{ padding: 16, margin: '16px 0', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)' }}>
    <label style={{ display: 'block' }}>{ru ? 'Введите ключ' : 'Enter access key'}
      <input autoFocus={autoFocus} type="password" aria-label={ru ? 'Ключ доступа' : 'Access key'} autoComplete="new-password" value={key} maxLength={128} required disabled={pending} onChange={event => setKey(event.target.value)} placeholder="SFERA-…" style={{ display: 'block', width: '100%', margin: '10px 0 14px', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 15 }} />
    </label>
    <button type="submit" disabled={pending || !key.trim()} style={{ width: '100%', padding: '11px 16px', borderRadius: 10, border: 0, background: 'var(--accent-primary)', color: '#fff', fontWeight: 700, cursor: pending ? 'wait' : 'pointer', opacity: pending || !key.trim() ? 0.6 : 1 }}>{pending ? (ru ? 'Активация…' : 'Activating…') : (moduleId ? (ru ? 'Установить модуль' : 'Install module') : (ru ? 'Активировать на сервере' : 'Activate on this server'))}</button>
    <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{ru ? 'Ключ открывает указанные в нём модули всем пользователям этого сервера. К другому серверу его привязать нельзя.' : 'The key grants its included modules to everyone on this server and cannot be reused on another server.'}</p>
    {message && <p role="status">{message}</p>}
  </form>;
}
