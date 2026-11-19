import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { MeshArchiveRecovery } from './MeshArchiveRecovery';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
import { RecoveryClient, RecoveryError, recoveryFilename, type RecoveryCatalog, type RecoveryScope, type RecoveryPage,
  type RecoveryMessage, type RecoveryFile } from '../core/mesh/recoveryClient';

/** A separate read-only view; never merges recovered rows into a live chat/cache. */
export function MeshHistoryRecovery() {
  const { currentServerIP, authToken, currentUser } = useApp();
  const context = `${currentServerIP}\n${authToken}\n${currentUser?.id ?? ''}`;
  const active = useRef(context); active.current = context;
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const client = useRef<RecoveryClient | null>(null);
  const working = useRef(false);
  const [bound, setBound] = useState('');
  const [catalog, setCatalog] = useState<{ legacy: RecoveryCatalog; paged: RecoveryCatalog } | null>(null);
  const [scopes, setScopes] = useState<RecoveryScope[]>([]);
  const [scope, setScope] = useState<RecoveryScope | null>(null);
  const [page, setPage] = useState<RecoveryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const reset = useCallback(() => {
    generation.current++; abort.current?.abort(); abort.current = null; client.current = null;
    working.current = false; setCatalog(null); setScopes([]); setScope(null); setPage(null); setBound(''); setBusy(false); setNotice('');
  }, []);
  useEffect(() => { reset(); return () => { generation.current++; abort.current?.abort(); }; }, [context, reset]);
  useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === null || [ENTRY_PIN_KEY, 'sfera_selected_server', 'authToken'].includes(event.key)) reset(); };
    window.addEventListener('sfera-mesh-entry-change', reset); window.addEventListener('storage', storage);
    return () => { window.removeEventListener('sfera-mesh-entry-change', reset); window.removeEventListener('storage', storage); };
  }, [reset]);
  const run = async (operation: (recovery: RecoveryClient, valid: () => boolean) => Promise<void>, fresh = false) => {
    if (working.current || !authToken || !currentUser) return;
    if (fresh) reset();
    const epoch = generation.current;
    const controller = abort.current ?? new AbortController(); abort.current = controller;
    const valid = () => generation.current === epoch && active.current === context && !controller.signal.aborted;
    working.current = true;
    const timeout = setTimeout(() => {
      if (valid()) { reset(); setNotice('Проверка заняла слишком много времени. Повторите позже.'); }
    }, 45000);
    setBusy(true); setNotice('');
    try {
      if (!client.current) {
        const pin = await loadEntryPointPin(localStorage);
        if (!pin) throw new RecoveryError('invalid');
        const next = await RecoveryClient.open(currentServerIP, pin, authToken, controller.signal, valid);
        if (!valid()) return;
        client.current = next;
      }
      await operation(client.current, valid);
    } catch (error) {
      if (!valid()) return;
      const code = error instanceof RecoveryError ? error.code : 'unavailable';
      if (code === 'cancelled') return;
      // Do not leave previously displayed text/files on access loss or a changed
      // index. A new catalogue must explicitly establish another current view.
      reset();
      setNotice(code === 'changed' ? 'История обновилась. Проверьте доступные диалоги заново.' :
        code === 'forbidden' ? 'Доступ к истории недоступен. Проверьте вход и права участника.' :
        code === 'invalid' ? 'Не удалось подтвердить историю. Проверьте выбранный доверенный сервер.' :
        'История пока недоступна. Возможно, сеть или обновление прав ещё не готовы. Повторите проверку позже.');
    } finally { clearTimeout(timeout); if (valid()) { working.current = false; setBusy(false); } }
  };
  const discover = (more = false) => run(async (recovery, valid) => {
    if (more && !catalog) throw new RecoveryError('invalid');
    const legacy = more && !catalog?.legacy.next_after ? catalog!.legacy :
      await recovery.scopes(more ? catalog?.legacy.next_after ?? undefined : undefined, more ? catalog?.legacy.catalog : undefined);
    const paged = more && !catalog?.paged.next_after ? catalog!.paged :
      await recovery.pagedScopes(more ? catalog?.paged.next_after ?? undefined : undefined, more ? catalog?.paged.catalog : undefined);
    if (!valid()) return;
    const added = [...(!more || catalog?.legacy.next_after ? legacy.scopes : []), ...(!more || catalog?.paged.next_after ? paged.scopes : [])];
    const combined = [...(more ? scopes : []), ...added];
    if (combined.length > 128 || new Set(combined.map(item => item.source + item.scope)).size !== combined.length) throw new RecoveryError('invalid');
    setCatalog({ legacy, paged }); setScopes(combined); setBound(context);
  }, !more);
  const open = (selected: RecoveryScope, before?: string) => run(async (recovery, valid) => {
    // Hide the old conversation while a different one is being authorized.
    setPage(null); setScope(null);
    const next = await recovery.messages(selected, before);
    if (!valid()) return;
    setScope(selected); setPage(next); setBound(context);
  });
  const download = (message: RecoveryMessage, file: RecoveryFile) => {
    if (!scope || !page) return;
    void run(async (recovery, valid) => {
      const blob = await recovery.attachment(scope, message, file);
      if (!valid()) return;
      const url = URL.createObjectURL(blob);
      try {
        if (!valid()) return;
        const link = document.createElement('a'); link.href = url; link.download = recoveryFilename(file.filename);
        document.body.appendChild(link); link.click(); link.remove();
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    });
  };
  const visible = bound === context;
  return <details style={{ marginBlock: 20 }} onToggle={event => { if (!event.currentTarget.open) reset(); }}>
    <summary>Восстановить историю</summary>
    <p>Откройте подтверждённую историю и сохранённые файлы, если обычный список переписки потерян. Здесь доступно только чтение.</p>
    <button type="button" disabled={busy || !authToken || !currentUser} onClick={() => { void discover(); }}>
      {busy ? 'Проверка…' : 'Проверить доступные диалоги'}
    </button>
    {notice && <p role="alert">{notice}</p>}
    {visible && catalog && <section aria-label="Доступная история">
      {!scopes.length && <p>{catalog.legacy.next_after || catalog.paged.next_after ? 'В этой части списка доступных диалогов нет.' : 'Подтверждённой истории для этого аккаунта не найдено.'}</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {scopes.map(item => <li key={item.source + item.scope} style={{ marginBlock: 8 }}>
          <button type="button" disabled={busy} onClick={() => { void open(item); }}>
            {item.source === 'dm' ? 'Личная переписка' : 'Групповая переписка'} · {item.messages} сообщ.
            {item.latest_at ? ` · ${new Date(item.latest_at).toLocaleString()}` : ''}
          </button>
        </li>)}
      </ul>
      {(catalog.legacy.next_after || catalog.paged.next_after) && <button disabled={busy} type="button" onClick={() => { void discover(true); }}>Проверить следующие диалоги</button>}
    </section>}
    {visible && page && scope && <section aria-label="Восстановленная переписка" style={{ marginTop: 16 }}>
      <p>Просмотр восстановленной истории. Имена участников могли не сохраниться. Отправка сообщений здесь недоступна.</p>
      {page.order === 'uuid_desc' && <p>Сообщения разбиты на страницы по идентификатору. Порядок не соответствует времени отправки.</p>}
      {page.order === 'time_desc' && <p>Сначала показаны новые сообщения.</p>}
      {page.messages.length === 0 && <p>В этой переписке нет доступных сообщений.</p>}
      <ol style={{ paddingInlineStart: 20 }}>
        {page.messages.map(message => <li key={message.id} style={{ marginBlock: 14, overflowWrap: 'anywhere' }}>
          <small>{new Date(message.created_at).toLocaleString()} · {message.author.id === String(currentUser?.id) ? 'Вы' : message.author.username === message.author.id ? 'Участник' : message.author.username}</small>
          <p style={{ whiteSpace: 'pre-wrap', marginBlock: 6 }}>{message.content}</p>
          {message.detail && <p style={{ whiteSpace: 'pre-wrap', marginBlock: 6 }}>{message.detail}</p>}
          {message.attachments.map(file => <div key={file.id}><button type="button" disabled={busy} onClick={() => download(message, file)}>
            Скачать {file.filename} ({Math.ceil(file.file_size / 1024)} КБ)
          </button></div>)}
        </li>)}
      </ol>
      {page.next_before && <button type="button" disabled={busy} onClick={() => { void open(scope, page.next_before ?? undefined); }}>{page.order === 'uuid_desc' ? 'Следующая страница' : 'Более ранние сообщения'}</button>}
    </section>}
    <p style={{ fontSize: 12 }}>Вход в аккаунт должен быть восстановлен заранее. Просмотр подтверждённой истории выше не сохраняет переписку на устройстве. Личный архив открывается отдельно ниже. Эти инструменты не восстанавливают аккаунты или права участников.</p>
    <MeshArchiveRecovery key={generation.current} />
  </details>;
}
