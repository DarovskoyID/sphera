import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { applicationKeys, ownerController } from '../core/mesh/applicationAuth';
import { AccountRecoveryClient } from '../core/mesh/accountRecoveryClient';
import { verifyControlledAccount } from '../core/mesh/accountControls';
import { accountBytes, accountDigest, meshUserId, personalArchiveRoot } from '../core/mesh/account';
import { meshDeviceId } from '../core/mesh/devices';
import { unlockVault } from '../core/mesh/vault';
import { CipherArchive } from '../core/mesh/cipherArchive';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
import { RecoveryClient, type RecoveryScope } from '../core/mesh/recoveryClient';
import { createArchiveKeyFile, openArchiveKeyFile, type ArchiveKeyFile } from '../core/mesh/archiveKeys';

/** Archive credentials and decrypted text stay in memory on this device. */
export function MeshArchiveRecovery() {
  const { currentServerIP, authToken, currentUser } = useApp();
  const context = `${currentServerIP}\n${authToken}\n${currentUser?.id ?? ''}`;
  const active = useRef(context); active.current = context;
  const epoch = useRef(0), working = useRef(false);
  const archive = useRef<CipherArchive | null>(null);
  const client = useRef<RecoveryClient | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [keysFile, setKeysFile] = useState<File | null>(null);
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [archiveKeyFile, setArchiveKeyFile] = useState<File | null>(null);
  const [archivePassword, setArchivePassword] = useState('');
  const [pendingKey, setPendingKey] = useState<ArchiveKeyFile | null>(null), [confirmationFile, setConfirmationFile] = useState<File | null>(null);
  const archiveDescriptor = useRef<ArchiveKeyFile | undefined>(undefined), archiveOwner = useRef('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [bound, setBound] = useState('');
  const [scopes, setScopes] = useState<RecoveryScope[]>([]);
  const [messages, setMessages] = useState<{ id: string; text: string; sender: { owner: string; device: string } }[]>([]);
  const reset = useCallback(() => {
    epoch.current++; abort.current?.abort(); abort.current = null;
    archive.current?.close(); archive.current = null; client.current = null;
    working.current = false; setBusy(false); setBound(''); setMessages([]); setScopes([]);
    setPassword(''); setKeysFile(null); setBackupFile(null); setNotice('');
    setArchiveKeyFile(null); setArchivePassword(''); archiveDescriptor.current = undefined; archiveOwner.current = '';
    setPendingKey(null); setConfirmationFile(null);
  }, []);
  useEffect(() => { reset(); return () => { epoch.current++; abort.current?.abort(); archive.current?.close(); }; }, [context, reset]);
  useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === null || [ENTRY_PIN_KEY, 'sfera_selected_server', 'authToken'].includes(event.key)) reset(); };
    window.addEventListener('sfera-mesh-entry-change', reset); window.addEventListener('storage', storage);
    return () => { window.removeEventListener('sfera-mesh-entry-change', reset); window.removeEventListener('storage', storage); };
  }, [reset]);
  const run = async (operation: (valid: () => boolean) => Promise<void>) => {
    if (working.current || !authToken || !currentUser) return;
    const generation = epoch.current;
    const controller = abort.current ?? new AbortController(); abort.current = controller;
    const valid = () => generation === epoch.current && active.current === context && !controller.signal.aborted;
    working.current = true; setBusy(true); setNotice(''); setMessages([]);
    // A catalogue may contain 128 scopes. Each individual network operation is
    // bounded by the server; the whole import also has a finite deadline.
    const timeout = setTimeout(() => { if (valid()) { reset(); setNotice('Проверка архива заняла слишком много времени. Повторите позже.'); } }, 60000);
    try { await operation(valid); }
    catch {
      if (valid()) { reset(); setNotice('Архив не открыт. Проверьте файл ключей, пароль, вход и доступ ко всем сохранённым диалогам.'); }
    } finally { clearTimeout(timeout); if (valid()) { working.current = false; setBusy(false); } }
  };
  const open = () => run(async valid => {
    if (!keysFile || keysFile.size > 32768 || (backupFile && backupFile.size > 16 * 1048576)) throw new Error('invalid_archive_file');
    const pin = await loadEntryPointPin(localStorage);
    if (!pin) throw new Error('trusted_entry_required');
    const keys = applicationKeys(JSON.parse(await keysFile.text()), currentServerIP);
    if ((!keys.ownerVault && !archiveKeyFile) || keys.applicationUser !== String(currentUser!.id) || keys.entry !== pin.nodeId || keys.network !== pin.network || (archiveKeyFile && archiveKeyFile.size > 98304)) throw new Error('archive_keys_context');
    const recovery = await RecoveryClient.open(currentServerIP, pin, authToken, abort.current!.signal, valid);
    const owner = await meshUserId(keys.ownerPublic);
    let identityRoot: Uint8Array | undefined, root: Uint8Array | undefined;
    let opened: CipherArchive | undefined;
    try {
      let descriptor: ArchiveKeyFile | undefined;
      if (archiveKeyFile) {
        const openedKey = await openArchiveKeyFile(JSON.parse(await archiveKeyFile.text()), password, keys.network, keys.genesis, keys.ownerPublic);
        root = openedKey.root; descriptor = openedKey.file;
      } else {
        identityRoot = await unlockVault(keys.ownerVault!, owner, password);
        root = await personalArchiveRoot(identityRoot, keys.ownerPublic, keys.network, keys.genesis);
      }
      if (!valid()) return;
      opened = await CipherArchive.open({ network: keys.network, genesis: keys.genesis, owner,
        device: await meshDeviceId(keys.devicePublic) }, pin, String(currentUser!.id), root);
      if (!valid()) return;
      const backup: unknown = backupFile ? JSON.parse(await backupFile.text()) : undefined;
      const available = await recovery.openArchive(opened, backup);
      if (!valid()) return;
      archive.current?.close(); archive.current = opened; opened = undefined;
      client.current = recovery; setScopes(available); setBound(context);
      archiveDescriptor.current = descriptor; archiveOwner.current = keys.ownerPublic; setArchiveKeyFile(null);
      setPassword(''); setKeysFile(null); setBackupFile(null);
      setNotice(available.length ? 'Архив открыт. Доступ и удаления проверены.' : 'В локальном архиве пока нет сообщений.');
    } finally { identityRoot?.fill(0); root?.fill(0); opened?.close(); }
  });
  const rotate = () => run(async valid => {
    const existing = archive.current, recovery = client.current;
    if (!existing || !recovery || !keysFile || keysFile.size > 32768 || !archivePassword) throw new Error('archive_key_rotation_required');
    const pin = await loadEntryPointPin(localStorage); if (!pin) throw new Error('trusted_entry_required');
    const keys = applicationKeys(JSON.parse(await keysFile.text()), currentServerIP);
    if (!keys.ownerVault || keys.ownerPublic !== archiveOwner.current || keys.entry !== pin.nodeId || keys.network !== pin.network || keys.applicationUser !== String(currentUser!.id)) throw new Error('archive_key_owner_mismatch');
    existing.assertNetwork(keys.network, keys.genesis);
    let identityRoot: Uint8Array | undefined, nextRoot: Uint8Array | undefined, reopened: CipherArchive | undefined;
    try {
      await recovery.openArchive(existing);
      const owner = await meshUserId(keys.ownerPublic);
      const head = await new AccountRecoveryClient({ pin, genesis: keys.genesis, owner, device: await meshDeviceId(keys.devicePublic), token: () => authToken, guard: valid }).head();
      const checked = await verifyControlledAccount(head.record, head.history ?? [], keys.network, keys.genesis, owner);
      if (checked.controllerPublic !== await ownerController(keys)) throw new Error('archive_owner_root_obsolete');
      let next: { file: ArchiveKeyFile; root: Uint8Array };
      if (pendingKey) {
        if (!confirmationFile || confirmationFile.size > 98304) throw new Error('saved_archive_key_required');
        const confirmed: unknown = JSON.parse(await confirmationFile.text());
        if (await accountDigest(accountBytes(confirmed)) !== await accountDigest(accountBytes(pendingKey))) throw new Error('saved_archive_key_mismatch');
        next = await openArchiveKeyFile(confirmed, archivePassword, keys.network, keys.genesis, keys.ownerPublic);
      } else {
        identityRoot = await unlockVault(keys.ownerVault, await meshUserId(keys.ownerPublic), password);
        next = await createArchiveKeyFile(identityRoot, keys.ownerPublic, keys.network, keys.genesis, archivePassword, archiveDescriptor.current, keys.ownerControl);
        identityRoot.fill(0); identityRoot = undefined;
      }
      nextRoot = next.root;
      if (!valid()) return;
      if (!pendingKey) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(next.file)], { type: 'application/json' }));
        try { const link = document.createElement('a'); link.href = url; link.download = 'sphere-personal-archive-key.json'; link.click(); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
        setPendingKey(next.file); setPassword('');
        setNotice('Выберите скачанный файл нового ключа ниже. Архив сменит ключ только после проверки сохранённого файла.');
        return;
      }
      await existing.rotateRoot(nextRoot);
      if (!valid()) return;
      reopened = await CipherArchive.open({ network: keys.network, genesis: keys.genesis,
        owner: await meshUserId(keys.ownerPublic), device: await meshDeviceId(keys.devicePublic) }, pin, String(currentUser!.id), nextRoot);
      const available = await recovery.openArchive(reopened);
      if (!valid()) return;
      archive.current = reopened; reopened = undefined; archiveDescriptor.current = next.file;
      setScopes(available); setPassword(''); setArchivePassword(''); setKeysFile(null);
      setPendingKey(null); setConfirmationFile(null);
      setNotice('Архив перешифрован отдельным ключом. Сохраните скачанный файл ключа и новую зашифрованную копию архива. Старые копии требуют прежнего ключа.');
    } finally { identityRoot?.fill(0); nextRoot?.fill(0); reopened?.close(); }
  });
  const read = (scope: RecoveryScope) => run(async valid => {
    if (!archive.current || !client.current) throw new Error('archive_closed');
    await client.current.syncArchiveDeletions(scope, archive.current);
    const result = await archive.current.messages(scope.source, scope.scope);
    if (valid()) { setMessages(result); setNotice(result.length ? '' : 'Доступных сообщений нет.'); }
  });
  const download = () => run(async valid => {
    if (!archive.current || !client.current) throw new Error('archive_closed');
    const available = await client.current.openArchive(archive.current);
    const saved = await archive.current.export();
    if (!valid()) return;
    setScopes(available);
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved)], { type: 'application/json' }));
    try {
      const link = document.createElement('a'); link.href = url; link.download = 'sphere-encrypted-history-v2.json';
      document.body.appendChild(link); link.click(); link.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
  return <details style={{ marginBlock: 16 }} onToggle={event => { if (!event.currentTarget.open) reset(); }}>
    <summary>Открыть личный зашифрованный архив</summary>
    <p>Файлы и пароль открываются только на этом устройстве. Перед чтением и импортом проверяются доступ к сохранённым диалогам и подтверждённые удаления. Нужен вход с mesh-устройством и файл ключей владельца.</p>
    {bound !== context && <form key={epoch.current} onSubmit={event => { event.preventDefault(); void open(); }} style={{ display: 'grid', gap: 12 }}>
      <label>Зашифрованный файл ключей<input required disabled={busy} type="file" accept="application/json,.json" onChange={event => setKeysFile(event.target.files?.[0] ?? null)} /></label>
      <label>Отдельный ключ архива (если создан)<input disabled={busy} type="file" accept="application/json,.json" onChange={event => setArchiveKeyFile(event.target.files?.[0] ?? null)} /></label>
      <label>{archiveKeyFile ? 'Пароль отдельного ключа архива' : 'Пароль файла'}<input required disabled={busy} type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Архив для восстановления (необязательно)<input disabled={busy} type="file" accept="application/json,.json" onChange={event => setBackupFile(event.target.files?.[0] ?? null)} /></label>
      <button type="submit" disabled={busy || !authToken || !currentUser}>{busy ? 'Проверка…' : 'Открыть архив'}</button>
    </form>}
    {notice && <p role="status">{notice}</p>}
    {bound === context && <section aria-label="Личный архив">
      <p>Исторические текстовые копии. Текущий доступ проверен при открытии; отправка сообщений и восстановление аккаунта здесь недоступны.</p>
      <ul>{scopes.map(scope => <li key={scope.source + scope.scope}><button disabled={busy} type="button" onClick={() => { void read(scope); }}>{scope.source === 'dm' ? 'Личная переписка' : 'Групповая переписка'} · {scope.scope}</button></li>)}</ul>
      <ol>{messages.map(message => <li key={message.id}><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</p></li>)}</ol>
      <button disabled={busy} type="button" onClick={() => { void download(); }}>Сохранить зашифрованную копию</button>{' '}
      <button type="button" onClick={reset}>Закрыть архив</button>
      <details><summary>Сменить отдельный ключ личного архива</summary>
        <p>Ключ не даёт права подписи или входа. Сначала сохраняется новый файл ключа, затем архив перешифровывается одной операцией. Старые резервные копии сохраняют прежний ключ.</p>
        <form onSubmit={event => { event.preventDefault(); void rotate(); }} style={{ display: 'grid', gap: 12 }}>
          <label>Файл ключей владельца<input required disabled={busy} type="file" accept="application/json,.json" onChange={event => setKeysFile(event.target.files?.[0] ?? null)} /></label>
          {!pendingKey && <label>Пароль ключей владельца<input required disabled={busy} type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>}
          <label>Пароль нового ключа архива<input required disabled={busy} type="password" autoComplete="new-password" value={archivePassword} onChange={event => setArchivePassword(event.target.value)} /></label>
          {pendingKey && <label>Сохранённый новый ключ<input required disabled={busy} type="file" accept="application/json,.json" onChange={event => setConfirmationFile(event.target.files?.[0] ?? null)} /></label>}
          <button disabled={busy}>{pendingKey ? 'Проверить файл и перешифровать архив' : 'Сохранить новый ключ'}</button>
        </form>
      </details>
    </section>}
  </details>;
}
