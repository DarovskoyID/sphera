import { AccountCipherProvider, useAccountCipherRuntime } from './AccountCipherRuntime';
import { ImportedCipherHistory } from './ImportedCipherHistory';
import type { GuildCipherMessage } from '../core/mesh/guildCipherMessage';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../context/AppContext';
import { DmCipherSession, DmCipherQueuedError } from '../core/mesh/dmCipherSession';
import { applicationKeys } from '../core/mesh/applicationAuth';
import { accountBytes, accountDigest } from '../core/mesh/account';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
import type { CipherScopeBody } from '../core/mesh/cipherPolicy';
import type { DmOutboxRecord } from '../core/mesh/dmCipherOutbox';
type ChatMessage = { id: string; author: { id: string | number }; payload?: unknown; message_type?: string; cipher_read_receipt?: unknown };
type Target = { guild: string; scope: string; messages: ChatMessage[] };
type QueueRecord = DmOutboxRecord | DmOutboxRecord<GuildCipherMessage>;

type Access = {
  protected: boolean; checked: boolean; ready: boolean; readReceipts: boolean;
  send: (text: string, replyTo: string | null) => Promise<void>;
  texts: Record<string, { text: string; binding: string }>;
  unavailable: Record<string, string>;
  panel?: ReactNode;
  confirmRead: (message: ChatMessage) => Promise<void>;
  verifyRead: (message: ChatMessage) => Promise<boolean>;
};
const Context = createContext<Access | null>(null);
function binding(message: ChatMessage) {
  return new TextDecoder().decode(accountBytes([message.payload, String(message.author.id)]));
}
export function useDmCipher() { return useContext(Context); }
type Review = { body: CipherScopeBody; answer: (accepted: boolean) => void };

export function DmCipherProvider(props: { children: ReactNode; target?: Target }) {
  const runtime = useAccountCipherRuntime();
  return runtime ? <CipherChatProvider {...props}/> : <AccountCipherProvider><CipherChatProvider {...props}/></AccountCipherProvider>;
}
function CipherChatProvider({ children, target }: { children: ReactNode; target?: Target }) {
  const app = useApp(), shared = useAccountCipherRuntime()!;
  const { currentServerIP, authToken, userIDonServer } = app;
  const chatConversationId = target?.scope ?? app.chatConversationId, chatMessages = target?.messages ?? app.chatMessages;
  const source = target ? 'guild' : 'dm', guild = target?.guild;
  const routeKey = JSON.stringify([source, guild, chatConversationId]);
  const routeRef = useRef(routeKey); routeRef.current = routeKey;
  const identity = JSON.stringify([currentServerIP, authToken, userIDonServer]);
  const current = useRef(identity); current.current = identity;
  const session = shared.session;
  const closing = shared.closing;
  const revision = useRef(0), review = useRef<Review | null>(null);
  const approved = useRef(new Set<string>());
  const ready = shared.ready;
  const [busy, setBusy] = useState(false);
  const [textScope, setTextScope] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null), [password, setPassword] = useState('');
  const [backup, setBackup] = useState<File | null>(null);
  const [sourceArchiveKey, setSourceArchiveKey] = useState<File | null>(null), [sourceArchivePassword, setSourceArchivePassword] = useState('');
  const [archiveKeyFile, setArchiveKeyFile] = useState<File | null>(null), [archivePassword, setArchivePassword] = useState('');
  const [profileGuard, setProfileGuard] = useState(false);
  const [pendingArchiveKey, setPendingArchiveKey] = useState<unknown | null>(null);
  const [notice, setNotice] = useState(''), [question, setQuestion] = useState<CipherScopeBody | null>(null);
  const [mode, setMode] = useState<{ scope: string; route: string; identity: string; enabled: boolean; available: boolean } | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [texts, setTexts] = useState<Access['texts']>({});
  const [unavailable, setUnavailable] = useState<Access['unavailable']>({});
  const [records, setRecords] = useState<QueueRecord[]>([]);
  const scopeRef = useRef(chatConversationId); scopeRef.current = chatConversationId;
  const [refresh, setRefresh] = useState(0);
  const [automatic, setAutomatic] = useState(false);
  const automaticTask = useRef<() => Promise<boolean>>(async () => true);
  const scanCursor = useRef(0);
  const lock = () => {
    revision.current++;
    setAutomatic(false);
    review.current?.answer(false); review.current = null; approved.current.clear();
    shared.lock();
    setQuestion(null); setTexts({}); setUnavailable({}); setRecords([]); setPassword(''); setFile(null); setBackup(null);
    setArchiveKeyFile(null); setArchivePassword(''); setPendingArchiveKey(null);
    setSourceArchiveKey(null); setSourceArchivePassword('');
  };
  useEffect(() => {
    setSelected({}); setAutomatic(false); setNotice('');
    return () => { revision.current++; review.current?.answer(false); review.current = null; };
  }, [identity]);
  useEffect(() => {
    if (!ready) { review.current?.answer(false); review.current = null; approved.current.clear(); setQuestion(null); setTexts({}); setUnavailable({}); setRecords([]); setPassword(''); setFile(null); setBackup(null); setAutomatic(false); }
    if (!ready) { setArchiveKeyFile(null); setArchivePassword(''); setPendingArchiveKey(null); setSourceArchiveKey(null); setSourceArchivePassword(''); }
  }, [ready]);
  const reviewHandler = useRef<(body: CipherScopeBody) => Promise<boolean>>(async () => false);
  reviewHandler.current = body => {
    if (body.source !== source || body.scope !== chatConversationId) return Promise.resolve(false);
    const captured = routeKey, key = JSON.stringify([body.source, body.scope, body.epoch, body.roster]);
    if (approved.current.has(key)) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      review.current = { body, answer: accepted => {
        const valid = accepted && routeRef.current === captured;
        if (valid) approved.current.add(key); resolve(valid);
      } };
      setQuestion(body);
    });
  };
  useEffect(() => {
    const owner = {};
    const detach = shared.attachReviewer(owner, body => reviewHandler.current(body));
    return () => { detach(); review.current?.answer(false); review.current = null; };
  }, [identity, routeKey]);
  useEffect(() => {
    let cancelled = false;
    setMode(null); setTexts({}); setUnavailable({}); setRecords([]); setNotice(''); scanCursor.current = 0;
    review.current?.answer(false); review.current = null; setQuestion(null);
    if (!chatConversationId || !authToken) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    void fetch(currentServerIP + '/api/ws/authorize/', { method: 'POST', credentials: 'omit', redirect: 'error',
      signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Ionik-Client': '1', Authorization: 'Bearer ' + authToken },
      body: JSON.stringify(target ? { type: 'guild_channel', guild_id: guild, channel_id: chatConversationId } : { type: 'chat', conversation_id: chatConversationId }),
    }).then(async response => {
      if (!response.ok) throw new Error('mode_unavailable');
      const value = await response.json();
      if (typeof value.cipher_only !== 'boolean' || typeof value.cipher_messages !== 'boolean') throw new Error('mode_unavailable');
      if (!cancelled) setMode({ scope: chatConversationId, route: routeKey, identity, enabled: value.cipher_only, available: value.cipher_messages });
    }).catch(() => { if (!cancelled) setNotice('Не удалось проверить защиту диалога. Повторите проверку.'); });
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [routeKey, identity, refresh]);
  const isCurrentScope = (scope: string) => scopeRef.current === scope && routeRef.current === routeKey;
  const updateRecords = async (opened: DmCipherSession, scope: string) => {
    const values = target ? await opened.guild.outbox.list() : await opened.outbox.list();
    if (session.current === opened && isCurrentScope(scope)) setRecords(values.filter(value => value.scope === scope && (!target || value.guild === guild)));
  };
  useEffect(() => {
    const opened = session.current;
    if (ready && opened && chatConversationId) void updateRecords(opened, chatConversationId).catch(() => undefined);
  }, [ready, identity, routeKey]);
  const unlock = async () => {
    if (busy || !file || file.size > 32768) return;
    setBusy(true); setNotice('');
    const captured = identity, generation = revision.current, pinText = localStorage.getItem(ENTRY_PIN_KEY);
    const guard = () => current.current === captured && revision.current === generation && localStorage.getItem(ENTRY_PIN_KEY) === pinText;
    let opened: DmCipherSession | undefined;
    try {
      await closing.current;
      const pin = await loadEntryPointPin(localStorage);
      if (!pin || new URL(currentServerIP).origin !== pin.url) throw new Error('entry_pin_required');
      const keys = applicationKeys(JSON.parse(await file.text()), currentServerIP);
      if (archiveKeyFile && (archiveKeyFile.size > 8192 || !archivePassword)) throw new Error('invalid_archive_key');
      const archiveKey = archiveKeyFile ? { file: JSON.parse(await archiveKeyFile.text()), password: archivePassword } : undefined;
      opened = await shared.open(keys, pin, password, archiveKey, profileGuard);
      if (!guard()) throw new Error('cancelled'); setNotice('Ключи открыты на этом устройстве.');
      if (chatConversationId) await updateRecords(opened, chatConversationId);
    } catch {
      if (opened && session.current !== opened) await opened.close();
      if (guard()) setNotice('Не удалось открыть ключи. Нужны mesh-вход, закреплённый сервер и правильные файл и пароль.');
    } finally { setPassword(''); setFile(null); setArchiveKeyFile(null); setArchivePassword(''); setBusy(false); }
  };
  const send = async (text: string, replyTo: string | null) => {
    const opened = session.current, scope = chatConversationId;
    if (!opened || !scope || busy) throw new Error('cipher_locked');
    setBusy(true); setNotice('Сохраняю и отправляю…');
    try {
      const result = target ? await opened.guild.send(guild!, scope, { text, replyTo }) : await opened.send(scope, { text, replyTo });
      if (session.current === opened && isCurrentScope(scope)) {
        setSelected(previous => ({ ...previous, [routeKey]: true }));
        setNotice(result.state === 'accepted' ? 'Сервер принял сообщение. Это ещё не подтверждение прочтения.' : 'Сообщение ожидает подтверждения публикации.');
      }
    } catch (error) {
      if (session.current === opened && isCurrentScope(scope)) setNotice(error instanceof DmCipherQueuedError
        ? 'Отправка не завершена. Сохранённую запись можно повторить в очереди.'
        : 'Не удалось сохранить сообщение. Текст оставлен в поле ввода.');
      throw error;
    } finally {
      try { await updateRecords(opened, scope); } catch { /* A locked session cannot expose its queue. */ }
      setBusy(false);
    }
  };
  const retry = async (record: QueueRecord) => {
    const opened = session.current; if (!opened || busy) return;
    setBusy(true);
    try { if (target) await opened.guild.retry(record.id); else await opened.retry(record.id); setNotice('Повтор выполнен.'); }
    catch { setNotice('Повтор не завершён. Запись сохранена; проверьте доступ и состав получателей.'); }
    finally { try { await updateRecords(opened, record.scope); } catch { /* locked */ } setBusy(false); }
  };
  const openMessages = async (automaticRun = false): Promise<boolean> => {
    const opened = session.current, scope = chatConversationId;
    if (!opened || !scope || busy) return true;
    setBusy(true); if (!automaticRun) setNotice('Открываю сообщения…');
    // Hide previously opened text while its selected-server status is checked.
    // A failed/unknown status never leaves stale plaintext on screen.
    const snapshot = texts;
    setTexts({}); setUnavailable({});
    try {
      if (target) { await opened.guild.drain(guild!, scope); await opened.guild.receive(scope); }
      else { await opened.drain(scope); await opened.receive(scope); }
      const result: Access['texts'] = { ...snapshot }, missing = { ...unavailable };
      const candidates = chatMessages.filter(message => message.message_type === 'cipher');
      const start = scanCursor.current % Math.max(1, candidates.length);
      const batch = candidates.slice(start, start + 8);
      if (batch.length) {
        const received = (target ? await opened.guild.openMessages(guild!, scope, batch.map(message => message.payload)) : await opened.openMessages(scope, batch.map(message => message.payload)));
        for (let index = 0; index < batch.length; index++) {
          const message = batch[index], value = received[index];
          if (value.sender.user !== String(message.author.id) || value.id !== String(message.id)) throw new Error('cipher_author_mismatch');
          delete result[String(message.id)]; delete missing[String(message.id)];
          if (!value.deleted && value.text === null) missing[String(message.id)] = binding(message);
          if (!value.deleted && value.text !== null) result[String(message.id)] = { text: value.text, binding: binding(message) };
        }
        scanCursor.current = start + batch.length;
      }
      if (session.current === opened && isCurrentScope(scope)) {
        setTexts(result); setUnavailable(missing); setTextScope(routeKey);
        if (!automaticRun) setNotice('Сообщения проверены и сохранены в зашифрованном архиве устройства.');
      }
      await updateRecords(opened, scope);
      return true;
    } catch {
      if (session.current === opened && isCurrentScope(scope)) setNotice('Не удалось проверить сообщения. Текст скрыт; архив и очередь сохранены. Проверьте доступ и получателей.');
      return false;
    }
    finally { setBusy(false); }
  };
  const checked = mode?.route === routeKey && mode?.scope === chatConversationId && mode?.identity === identity;
  const protectedMode = !!(checked && mode.enabled) || !!(chatConversationId && selected[routeKey]) || chatMessages.some(message => message.message_type === 'cipher');
  const readyHere = ready;
  const confirmRead = async (message: ChatMessage) => {
    const opened = session.current, scope = chatConversationId;
    if (!opened || !scope || busy || texts[String(message.id)]?.binding !== binding(message)) throw new Error('cipher_read_requires_displayed_message');
    setBusy(true);
    try {
      await opened.confirmRead(scope, message.payload);
      if (session.current === opened && isCurrentScope(scope)) setNotice('Устройство подтвердило открытие сообщения.');
    } catch (error) { if (session.current === opened) setNotice('Подтверждение не отправлено. Его можно повторить после проверки доступа.'); throw error; }
    finally { setBusy(false); }
  };
  const verifyRead = async (message: ChatMessage) => {
    const opened = session.current, scope = chatConversationId;
    if (!opened || !scope || !message.cipher_read_receipt) return false;
    try { await opened.verifyRead(scope, message.payload, message.cipher_read_receipt); return session.current === opened && isCurrentScope(scope); }
    catch { return false; }
  };
  const exportBackup = async () => {
    const opened = session.current; if (!opened || busy) return;
    setBusy(true);
    try {
      const document = await opened.exportArchive();
      if (session.current !== opened) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: 'application/json' }));
      const link = window.document.createElement('a'); link.href = url; link.download = 'sphere-dm-archive-' + Date.now() + '.json';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice('Сохранён зашифрованный архив всех чатов этого устройства. Храните файл отдельно от ключей.');
    } catch { if (session.current === opened) setNotice('Не удалось сохранить копию. Архив не изменён.'); }
    finally { setBusy(false); }
  };
  const importBackup = async () => {
    const opened = session.current, file = backup; if (!opened || busy || !file) return;
    setBusy(true);
    try {
      if (file.size > 16 * 1048576) throw new Error('backup_too_large');
      const snapshot: unknown = JSON.parse(await file.text());
      if (sourceArchiveKey && (sourceArchiveKey.size > 8192 || !sourceArchivePassword)) throw new Error('invalid_source_archive_key');
      const result = sourceArchiveKey
        ? await opened.importDeviceArchive(snapshot, JSON.parse(await sourceArchiveKey.text()), sourceArchivePassword)
        : await opened.importArchive(snapshot);
      if (session.current === opened) setNotice('Восстановлено сообщений: ' + result.restored + '. Откройте их после проверки текущего состояния.');
    } catch (error) {
      if (session.current === opened) setNotice(error instanceof Error && error.message === 'cipher_archive_restore_requires_empty_store'
        ? 'Восстановление доступно только в пустой архив этого устройства. Текущие сообщения не заменены.'
        : 'Копия не восстановлена. Проверьте файл, ключи этого устройства и доступ к серверу.');
    } finally { setBackup(null); setSourceArchiveKey(null); setSourceArchivePassword(''); setBusy(false); }
  };
  const archiveKeyOperation = async () => {
    const opened = session.current; if (!opened || busy || !archivePassword) return;
    const generation = revision.current;
    const valid = () => session.current === opened && generation === revision.current;
    setBusy(true); setAutomatic(false); setNotice('');
    try {
      if (!pendingArchiveKey) {
        const keyDocument = await opened.prepareArchiveKey(archivePassword);
        if (!valid()) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(keyDocument)], { type: 'application/json' }));
        try { const link = document.createElement('a'); link.href = url; link.download = 'sphere-device-archive-key.json'; link.click(); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
        setPendingArchiveKey(keyDocument); setArchiveKeyFile(null);
        setNotice('Выберите сохранённый файл нового ключа ниже. До его проверки архив не изменится.');
      } else {
        if (!archiveKeyFile || archiveKeyFile.size > 8192) throw new Error('saved_archive_key_required');
        const document: unknown = JSON.parse(await archiveKeyFile.text());
        if (await accountDigest(accountBytes(document)) !== await accountDigest(accountBytes(pendingArchiveKey))) throw new Error('saved_archive_key_mismatch');
        if (!valid()) return;
        await opened.rotateArchiveKey(document, archivePassword);
        if (!valid()) return;
        lock(); setNotice('Ключ архива изменён. Откройте устройство с сохранённым отдельным ключом и сохраните новую копию истории. Старые копии требуют прежнего ключа.');
      }
    } catch {
      if (valid()) {
        try { opened.coordinator.publicIdentity(); } catch { lock(); }
        setNotice('Не удалось сменить ключ архива. Проверьте сохранённый файл и его пароль. При сбое после завершения откройте устройство с новым файлом ключа.');
      }
    } finally { setBusy(false); }
  };
  automaticTask.current = () => openMessages(true);
  useEffect(() => {
    if (!automatic || !readyHere || !chatConversationId || !protectedMode || !checked) return;
    let cancelled = false, delay = 30000;
    let timer: ReturnType<typeof setTimeout>;
    const step = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') {
        const succeeded = await automaticTask.current();
        delay = succeeded ? 30000 : Math.min(300000, delay * 2);
      }
      if (!cancelled) timer = setTimeout(() => void step(), delay);
    };
    timer = setTimeout(() => void step(), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [automatic, readyHere, routeKey, identity, protectedMode, checked]);
  const context: Access = { protected: protectedMode, checked, ready: readyHere, readReceipts: !target, send,
    texts: readyHere && textScope === routeKey ? texts : {}, unavailable: readyHere && textScope === routeKey ? unavailable : {}, confirmRead, verifyRead };
  const decide = (accepted: boolean) => { const pending = review.current; review.current = null; setQuestion(null); pending?.answer(accepted); };
  const panel = <section aria-label="Защита личного диалога" style={{ padding: 10, borderBottom: '1px solid var(--border-color)', overflowWrap: 'anywhere' }}>
      {!checked ? <button onClick={() => setRefresh(value => value + 1)}>Проверить защиту диалога</button> : <>
        <strong>{protectedMode ? 'Сквозное шифрование' : 'Обычный диалог'}</strong>
        {!protectedMode && mode.available && <button onClick={() => chatConversationId && setSelected(previous => ({ ...previous, [routeKey]: true }))}>Включить сквозное шифрование</button>}
        {protectedMode && !readyHere && <form onSubmit={event => { event.preventDefault(); void unlock(); }}>
          <p>Первое отправленное зашифрованное сообщение закрепит этот режим. Откройте файл ключей на этом устройстве.</p>
          <label>Зашифрованный файл ключей<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
          {file && <small>{file.name}</small>}
          <label>Пароль файла<input type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
          <label><input type="checkbox" disabled={busy} checked={profileGuard} onChange={event => setProfileGuard(event.target.checked)} />Проверять весь профиль ключей по сети</label>
          {profileGuard && <small>Нужен сервер с поддержкой защиты профиля. Прерванное изменение блокирует повторное использование этой копии; восстановление требует отдельного устройства.</small>}
          <label>Отдельный ключ архива устройства (если создан)<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { setArchiveKeyFile(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
          {archiveKeyFile && <><small>{archiveKeyFile.name}</small><label>Пароль отдельного ключа<input type="password" autoComplete="off" disabled={busy} value={archivePassword} onChange={event => setArchivePassword(event.target.value)} /></label></>}
          <button disabled={busy || !file || !password || !!archiveKeyFile && !archivePassword}>Открыть ключи</button>
        </form>}
        {readyHere && <>{protectedMode && <><button disabled={busy} onClick={() => void openMessages()}>Проверить ключи и открыть 8 сообщений</button>
          <label><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />Автоматически проверять сообщения</label>
          </>}<button onClick={lock}>Закрыть ключи</button></>}
        {readyHere && <details><summary>Резервная копия архива</summary>
          <p>Копия содержит зашифрованную историю всех чатов. Для восстановления нужны ключи того же устройства, отдельный ключ архива, если он создан, и пустой архив; сеансы SDK и очередь отправки в этот файл не входят.</p>
          <button disabled={busy} onClick={() => void exportBackup()}>Сохранить зашифрованную копию</button>
          <label>Файл резервной копии<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { setBackup(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
          {backup && <small>{backup.name}</small>}
          <label>Отдельный ключ архива прежнего устройства (для переноса)<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { setSourceArchiveKey(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
          {sourceArchiveKey && <><small>{sourceArchiveKey.name}</small><label>Пароль ключа прежнего архива<input type="password" autoComplete="off" disabled={busy} value={sourceArchivePassword} onChange={event => setSourceArchivePassword(event.target.value)} /></label></>}
          <p>Для переноса с другого устройства нужны его копия истории и отдельный ключ архива. Войдите новым допущенным устройством в тот же аккаунт исходного сервера. Прежнее устройство может быть отозвано.</p>
          <button disabled={busy || !backup || !!sourceArchiveKey && !sourceArchivePassword} onClick={() => void importBackup()}>Восстановить в пустой архив</button>
        </details>}
        {readyHere && session.current && <ImportedCipherHistory session={session.current} />}
        {readyHere && <details><summary>Отдельный ключ архива устройства</summary>
          <p>Один отдельный ключ для истории DM и Guild. Смена ключа закроет общую сессию; SDK и очередь отправки сохранят прежние ключи.</p>
          <label>Пароль нового ключа архива<input type="password" autoComplete="new-password" disabled={busy} value={archivePassword} onChange={event => setArchivePassword(event.target.value)} /></label>
          {pendingArchiveKey !== null && <label>Сохранённый новый ключ устройства<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { setArchiveKeyFile(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>}
          {archiveKeyFile && pendingArchiveKey !== null && <small>{archiveKeyFile.name}</small>}
          <button disabled={busy || !archivePassword || pendingArchiveKey !== null && !archiveKeyFile} onClick={() => void archiveKeyOperation()}>{pendingArchiveKey === null ? 'Сохранить новый ключ устройства' : 'Проверить файл и сменить ключ архива'}</button>
        </details>}
      </>}
      {!checked && <button onClick={() => setRefresh(value => value + 1)}>Повторить проверку защиты</button>}
      {notice && <p role="status">{notice}</p>}
      {question && <div role="dialog" aria-label="Подтверждение получателей">
        <h4>Подтвердите устройства получателей</h4>
        <p>Проверьте идентификаторы по независимому каналу. Эти устройства смогут читать новые сообщения. Выбор действует только до закрытия ключей; новый состав потребует подтверждения.</p>
        <p>Диалог: {question.scope}. Версия состава: {question.epoch}.</p>
        {question.certificates.map(certificate => <details key={certificate.body.owner + certificate.body.device}>
          <summary>Устройство {certificate.body.device}</summary>
          <p>Аккаунт: {question.owners.find(owner => owner.owner === certificate.body.owner)?.user}</p>
          <p>Владелец: {certificate.body.owner}</p><p>Подпись устройства: {certificate.body.ed25519}</p><p>Ключ шифрования: {certificate.body.curve25519}</p>
        </details>)}
        <button onClick={() => decide(true)}>Подтверждаю эти устройства</button><button onClick={() => decide(false)}>Отмена</button>
      </div>}
      {readyHere && records.filter(record => record.scope === chatConversationId).map(record => <div key={record.id}>
        <span>Сообщение: {record.state === 'accepted' ? 'принято сервером' : record.state === 'rejected' ? 'отклонено' : 'в очереди'}</span>
        {['draft', 'ready', 'pending', 'accepted'].includes(record.state) && <button disabled={busy} onClick={() => void retry(record)}>{record.state === 'accepted' ? 'Завершить сохранение' : 'Повторить'}</button>}
      </div>)}
    </section>;
  return <Context.Provider value={{ ...context, panel }}>{children}</Context.Provider>;
}
export function DmCipherPanel() { return <>{useDmCipher()?.panel}</>; }

export function DmCipherComposer({ replyTo, onSent }: { replyTo: string | null; onSent: () => void }) {
  const access = useDmCipher(); const [text, setText] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (!access?.ready) setText(''); }, [access?.ready]);
  return <form className="message-input-container glass-panel" onSubmit={event => {
    event.preventDefault(); if (!access?.ready || busy || !text.trim()) return;
    setBusy(true);
    void access.send(text, replyTo).then(() => { setText(''); onSent(); }).catch(error => {
      // Intent has already been journaled. Retry the existing queue row rather
      // than silently creating a second message with another UUID.
      if (error instanceof DmCipherQueuedError) setText('');
    }).finally(() => setBusy(false));
  }}>
    <label>Зашифрованное сообщение<textarea aria-label="Зашифрованное сообщение" value={access?.ready ? text : ''} disabled={!access?.ready || busy} onChange={event => setText(event.target.value)} autoComplete="off" /></label>
    <button disabled={!access?.ready || busy || !text.trim()}>Отправить</button>
  </form>;
}
export function DmCipherMessageView({ message }: { message: ChatMessage }) {
  const access = useDmCipher(), opened = access?.texts[String(message.id)];
  const { userIDonServer } = useApp();
  const [acknowledged, setAcknowledged] = useState(false), [verified, setVerified] = useState(false), [busy, setBusy] = useState(false);
  const text = opened?.binding === binding(message) ? opened.text : undefined;
  const key = binding(message);
  useEffect(() => { setAcknowledged(false); setVerified(false); }, [key, access?.ready]);
  useEffect(() => {
    let cancelled = false;
    setVerified(false);
    if (access?.ready && access.readReceipts && text !== undefined && message.cipher_read_receipt) {
      void access.verifyRead(message).then(value => { if (!cancelled) setVerified(value); });
    }
    return () => { cancelled = true; };
  }, [key, message.cipher_read_receipt, access?.ready, text]);
  return <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
    {text ?? (access?.unavailable[String(message.id)] === key ? 'История этой эпохи недоступна на этом устройстве.' : 'Зашифрованное сообщение. Откройте ключи и нажмите «Открыть сообщения».')}
    {access?.readReceipts && text !== undefined && String(message.author.id) !== userIDonServer && !acknowledged && <button disabled={busy} onClick={() => {
      if (!access) return; setBusy(true);
      void access.confirmRead(message).then(() => setAcknowledged(true)).catch(() => {}).finally(() => setBusy(false));
    }}>Подтвердить открытие</button>}
    {text !== undefined && acknowledged && <small> Открытие подтверждено устройством.</small>}
    {text !== undefined && verified && String(message.author.id) === userIDonServer && <small> Устройство получателя подтвердило открытие.</small>}
  </div>;
}
