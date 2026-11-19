import { useEffect, useRef, useState } from 'react';
import type { DmCipherSession } from '../core/mesh/dmCipherSession';
import type { CipherArchive } from '../core/mesh/cipherArchive';
import { HistoricalArchiveTransfer } from '../core/mesh/historicalArchiveTransfer';
import { validateTrustedEntryPoints, type TrustedEntryPoint } from '../core/mesh/entryPoint';

/** Source credentials authenticate the same new device at the original app.
 * Neither a backup nor a target account grants access to source conversations.
 */
export function ImportedCipherHistory({ session }: { session: DmCipherSession }) {
  const [pin, setPin] = useState<TrustedEntryPoint | null>(null), [confirmed, setConfirmed] = useState(false);
  const [keys, setKeys] = useState<File | null>(null), [password, setPassword] = useState('');
  const [backup, setBackup] = useState<File | null>(null), [keyFile, setKeyFile] = useState<File | null>(null), [keyPassword, setKeyPassword] = useState('');
  const [factor, setFactor] = useState(''), [needsFactor, setNeedsFactor] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [messages, setMessages] = useState<Awaited<ReturnType<HistoricalArchiveTransfer['read']>>>([]);
  const client = useRef<HistoricalArchiveTransfer | null>(null), archive = useRef<CipherArchive | null>(null);
  const revision = useRef(0), working = useRef(false);
  const reset = () => { revision.current++; client.current?.close(); archive.current?.close(); client.current = null; archive.current = null;
    setReady(false); setNeedsFactor(false); setFactor(''); setMessages([]); setPassword(''); setKeyPassword(''); setKeys(null); setKeyFile(null); setBackup(null); };
  useEffect(() => { reset(); return () => { revision.current++; client.current?.close(); archive.current?.close(); }; }, [session]);
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (working.current) return;
    const generation = revision.current;
    const valid = () => { try { session.coordinator.publicIdentity(); return revision.current === generation; } catch { return false; } };
    working.current = true; setBusy(true); setMessages([]); setNotice('');
    try { await operation(valid); }
    catch { if (valid()) setNotice('Не удалось проверить историю. Проверьте доверенный исходный сервер, файлы, пароль, допуск устройства и доступ к диалогам.'); }
    finally { working.current = false; setBusy(false); setPassword(''); setKeyPassword(''); setFactor(''); }
  };
  const connect = () => run(async valid => {
    if (!pin || !confirmed) throw new Error('trusted_source_required');
    let opened = client.current;
    if (needsFactor && opened) { if (!await opened.secondFactor(factor.trim())) throw new Error('factor_required'); }
    else {
      if (!keys || keys.size > 32768) throw new Error('device_credentials_required');
      opened = await HistoricalArchiveTransfer.login(pin, JSON.parse(await keys.text()), password, session.coordinator.publicIdentity(), valid);
      if (!valid()) { opened.close(); return; } client.current?.close(); client.current = opened;
      if (opened.needsFactor) { setNeedsFactor(true); return; }
    }
    const history = await opened.open(session.archive);
    if (!valid()) { history.close(); return; }
    archive.current?.close(); archive.current = history; setReady(true); setNeedsFactor(false); setKeys(null);
    setNotice('Исходный сервер подтвердил вход нового устройства. Можно перенести копию или открыть уже перенесённую историю.');
  });
  const importBackup = () => run(async valid => {
    if (!backup || backup.size > 16 * 1048576 || !keyFile || keyFile.size > 8192 || !client.current || !archive.current) throw new Error('historical_files_required');
    const count = await client.current.import(archive.current, JSON.parse(await backup.text()), JSON.parse(await keyFile.text()), keyPassword);
    if (valid()) { setBackup(null); setKeyFile(null); setNotice('Перенесено сообщений: ' + count + '. История зашифрована ключом текущего устройства.'); }
  });
  const read = () => run(async valid => { if (!client.current || !archive.current) throw new Error('historical_source_required');
    const results = await client.current.read(archive.current); if (valid()) { setMessages(results); setNotice('Доступ и удаления проверены на исходном сервере.'); } });
  return <details><summary>История с другого сервера</summary>
    <p>История хранится отдельно от текущих чатов и сохраняет подписи исходного сервера. При каждом открытии он проверяет текущий доступ и удаления. Нужны ключи нового устройства для входа на исходный сервер и отдельный ключ прежнего архива.</p>
    <p>Сохраните исходную копию и её архивный ключ: они нужны для повторного переноса после потери локальных данных. Обычная копия текущих чатов не включает этот отдельный исторический раздел.</p>
    <label>Доверенная точка исходного сервера<input type="file" accept=".json,application/json" disabled={busy || ready} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; reset(); setPin(null); setConfirmed(false);
      const generation = revision.current;
      if (file && file.size <= 32768) void file.text().then(text => validateTrustedEntryPoints([JSON.parse(text)])).then(entries => {
        if (revision.current === generation) setPin(entries[0]);
      }).catch(() => { if (revision.current === generation) setNotice('Файл доверенной точки не принят.'); });
    }} /></label>
    {pin && <><p>{pin.url}<br/>Ключ сервера: {pin.publicKey}</p><label><input type="checkbox" disabled={busy || ready} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>Адрес и ключ сверены независимо от копии истории</label></>}
    {!ready && <><label>Ключи нового устройства для исходного сервера<input type="file" accept=".json,application/json" disabled={busy} onChange={event => setKeys(event.target.files?.[0] ?? null)} /></label>
      {needsFactor ? <label>Код подтверждения исходного сервера<input value={factor} onChange={event => setFactor(event.target.value)} autoComplete="one-time-code"/></label>
        : <label>Пароль файла нового устройства<input type="password" autoComplete="off" disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label>}
      <button disabled={busy || !confirmed || (needsFactor ? !factor : !keys || !password)} onClick={() => void connect()}>Подтвердить доступ к исходному серверу</button></>}
    {ready && <><label>Копия истории прежнего устройства<input type="file" accept=".json,application/json" disabled={busy} onChange={event => setBackup(event.target.files?.[0] ?? null)}/></label>
      <label>Отдельный ключ прежнего архива<input type="file" accept=".json,application/json" disabled={busy} onChange={event => setKeyFile(event.target.files?.[0] ?? null)}/></label>
      <label>Пароль ключа прежнего архива<input type="password" autoComplete="off" disabled={busy} value={keyPassword} onChange={event => setKeyPassword(event.target.value)}/></label>
      <button disabled={busy || !backup || !keyFile || !keyPassword} onClick={() => void importBackup()}>Перенести историю в пустой исторический архив</button>
      <button disabled={busy} onClick={() => void read()}>Проверить и открыть перенесённую историю</button></>}
    <button disabled={busy} onClick={() => { reset(); setNotice('История закрыта.'); }}>Закрыть историю</button>
    {notice && <p role="status">{notice}</p>}
    {messages.map(message => <article key={message.source + message.scope + message.id}><small>{message.source} · {message.scope} · {message.id}</small><p style={{whiteSpace:'pre-wrap'}}>{message.text}</p></article>)}
  </details>;
}
