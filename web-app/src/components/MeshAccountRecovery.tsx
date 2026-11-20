import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { accountBytes, accountDigest, meshUserId, signIdentityStatement, type AccountRecord } from '../core/mesh/account';
import { prepareRootControl, verifyControlledAccount } from '../core/mesh/accountControls';
import { meshDeviceId } from '../core/mesh/devices';
import { applicationKeys, replaceOwnerCredentials, type ApplicationKeys } from '../core/mesh/applicationAuth';
import { AccountRecoveryClient } from '../core/mesh/accountRecoveryClient';
import { prepareAccountPasswordChange, prepareAccountRecovery, recoverAccount, type RecoveryPackage } from '../core/mesh/accountRecovery';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
import { unlockVault, type Vault } from '../core/mesh/vault';

type Candidate = { record: AccountRecord; vault: Vault; control?: Omit<Awaited<ReturnType<typeof prepareRootControl>>, 'vault'>; credentials?: ApplicationKeys };
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function read(file: File | null, limit: number) {
  if (!file || file.size > limit) throw new Error('invalid_recovery_file');
  return JSON.parse(await file.text());
}
export function MeshAccountRecovery({initialMode}:{initialMode?:'backup'|'password'}={}) {
  const { currentServerIP, authToken } = useApp();
  const [keysFile, setKeysFile] = useState<File | null>(null), [accountFile, setAccountFile] = useState<File | null>(null);
  const [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [secret, setSecret] = useState('');
  const [mode, setMode] = useState<'backup' | 'password' | 'recover' | 'publish' | 'root'>(initialMode??'backup');
  const [savedFile, setSavedFile] = useState<File | null>(null), [savedPassword, setSavedPassword] = useState(''), [savedChecked, setSavedChecked] = useState(false);
  const [devicePassword, setDevicePassword] = useState('');
  const [candidate, setCandidate] = useState<Candidate | null>(null), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const revision = useRef(0), working = useRef(false);
  const actor = useRef(''); actor.current = JSON.stringify([currentServerIP, authToken]);
  const clear = () => { revision.current++; setCandidate(null); setSavedFile(null); setSavedPassword(''); setDevicePassword(''); setSavedChecked(false); setPassword(''); setNewPassword(''); setSecret(''); setNotice(''); setKeysFile(null); setAccountFile(null); };
  useEffect(() => { clear(); return () => { revision.current++; }; }, [currentServerIP, authToken]);
  useEffect(() => {
    const changed = () => clear();
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === ENTRY_PIN_KEY || event.key === 'sfera_selected_server') changed(); };
    window.addEventListener('storage', storage); window.addEventListener('sfera-mesh-entry-change', changed);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('sfera-mesh-entry-change', changed); };
  }, []);
  const run = async (publish = false) => {
    if (working.current) return; working.current = true; setBusy(true); setNotice('');
    const generation = revision.current, identity = actor.current, pinned = localStorage.getItem(ENTRY_PIN_KEY);
    const guard = () => revision.current === generation && actor.current === identity && localStorage.getItem(ENTRY_PIN_KEY) === pinned;
    try {
      const pin = await loadEntryPointPin(localStorage);
      if (!pin || new URL(currentServerIP).origin !== pin.url) throw new Error('trusted_entry_required');
      const keys = applicationKeys(await read(keysFile, 98304), currentServerIP);
      if (keys.network !== pin.network || keys.entry !== pin.nodeId) throw new Error('entry_mismatch');
      const owner = await meshUserId(keys.ownerPublic), device = await meshDeviceId(keys.devicePublic);
      const client = new AccountRecoveryClient({ pin, genesis: keys.genesis, owner, device, token: () => authToken, guard });
      if (publish) {
        if (!candidate) throw new Error('candidate_missing');
        if (candidate.control && !savedChecked) throw new Error('saved_root_file_required');
        const result = candidate.control ? await client.publishControl({ ...candidate.control, vault: candidate.vault }) : await client.publish(candidate.record, candidate.vault);
        if (!guard()) throw new Error('cancelled');
        setNotice(result.state === 'confirmed' ? 'Новая версия подтверждена сетью. Сохраните обновлённый файл аккаунта.' : 'Версия отправлена. Подтверждение ещё не получено; повторите проверку этой же версии.');
        if (result.state === 'confirmed') {
          if (candidate.credentials) download('sphere-device-keys.json', candidate.credentials);
          setCandidate(null);
        }
      } else {
        const file = await read(accountFile, 98304);
        const head = mode === 'root' || (mode === 'publish' && file.control) ? await client.controlledHead() : await client.head();
        const checkpoint = { version: head.record.body.version, digest: head.digest };
        const control = head.history ? { genesis: keys.genesis, history: head.history } : undefined;
        if (head.record.body.public_key !== keys.ownerPublic) throw new Error('owner_mismatch');
        if (mode === 'publish') {
          if (!guard()) throw new Error('cancelled');
          setSavedChecked(false); setCandidate(file as Candidate); setNotice('Сохранённая версия загружена. Публикация проверит её подпись и текущую версию сети.');
        } else if (mode === 'root') {
          if (!head.history || !head.checkpoint) throw new Error('root_checkpoint_required');
          const next = await prepareRootControl(file.record, accountBytes(file.vault), password, newPassword, keys.network, keys.genesis, owner, head.history, head.checkpoint);
          if (!guard()) throw new Error('cancelled');
          const credentials = await replaceOwnerCredentials(keys, next.update.account, next.history, next.vault, devicePassword, newPassword);
          if (!guard()) throw new Error('cancelled');
          const saved: Candidate = { record: next.update.account, vault: next.vault, control: { update: next.update, history: next.history }, credentials };
          download('sphere-root-candidate.json', saved); setCandidate(saved); setSavedChecked(false); setSavedFile(null); setSavedPassword('');
          setNotice('Новый корень подготовлен. Выберите сохранённый файл и проверьте его новым паролем перед публикацией. Идентификатор и ключ устройства сохраняются.');
        } else if (mode === 'backup') {
          const result = await prepareAccountRecovery(file.record, accountBytes(file.vault), password, keys.network, keys.genesis, owner, checkpoint, control);
          if (!guard()) throw new Error('cancelled');
          download('sphere-account-recovery.json', result.recovery);
          setSecret(result.recoverySecret); setNotice('Пакет сохранён. Запишите показанный секрет отдельно от файла.');
        } else {
          const next = mode === 'recover'
            ? await recoverAccount(file as RecoveryPackage, secret.trim(), newPassword, keys.network, keys.genesis, owner, checkpoint, control)
            : await prepareAccountPasswordChange(file.record, accountBytes(file.vault), password, newPassword, keys.network, owner, checkpoint, control);
          if (!guard()) throw new Error('cancelled');
          const saved = { record: next.record, vault: next.vault };
          download('sphere-account-candidate.json', saved); setCandidate(saved); setSecret('');
          setNotice('Обновлённый файл сохранён. Опубликуйте эту версию и дождитесь подтверждения. Пароль файла устройства меняется отдельно.');
        }
        setPassword(''); setNewPassword(''); setDevicePassword('');
      }
    } catch {
      if (guard()) setNotice('Не удалось завершить операцию. Проверьте файлы, пароль или секрет и доступность сети. При потере ответа повторите публикацию сохранённой версии.');
    } finally { working.current = false; setBusy(false); }
  };
  const checkSaved = async () => {
    if (working.current || !candidate?.control) return;
    working.current = true; setBusy(true); const generation = revision.current;
    let root: Uint8Array | undefined;
    try {
      const loaded = await read(savedFile, 98304);
      if (await accountDigest(accountBytes(loaded)) !== await accountDigest(accountBytes(candidate))) throw new Error('saved_candidate_mismatch');
      const pin = await loadEntryPointPin(localStorage), keys = applicationKeys(await read(keysFile, 98304), currentServerIP);
      if (!pin || pin.network !== keys.network || pin.nodeId !== keys.entry || new URL(currentServerIP).origin !== pin.url) throw new Error('entry_mismatch');
      const owner = await meshUserId(keys.ownerPublic);
      const checked = await verifyControlledAccount(loaded.record, loaded.control.history, keys.network, keys.genesis, owner);
      if (await accountDigest(accountBytes(loaded.control.update.account)) !== checked.digest) throw new Error('candidate_mismatch');
      root = await unlockVault(loaded.vault, owner, savedPassword);
      const signature = Array.from(await signIdentityStatement(root, accountBytes(loaded.record.body)), x => x.toString(16).padStart(2, '0')).join('');
      if (signature !== loaded.record.signature) throw new Error('wrong_candidate_root');
      if (loaded.credentials) {
        const credentials = applicationKeys(loaded.credentials, currentServerIP);
        if (credentials.devicePublic !== keys.devicePublic || credentials.ownerPublic !== keys.ownerPublic || credentials.entry !== keys.entry || credentials.genesis !== keys.genesis || credentials.applicationUser !== keys.applicationUser) throw new Error('candidate_credentials_mismatch');
        await replaceOwnerCredentials(credentials, loaded.record, loaded.control.history, loaded.vault, savedPassword, savedPassword);
      }
      if (generation !== revision.current) return;
      setSavedChecked(true); setSavedPassword(''); setNotice('Сохранённый файл проверен. Можно опубликовать смену корня.');
    } catch { if (generation === revision.current) { setSavedChecked(false); setNotice('Файл или пароль не совпадает с подготовленной сменой корня.'); } }
    finally { root?.fill(0); working.current = false; setBusy(false); }
  };
  return <details style={{ marginBlock: 20 }}><summary>Восстановление mesh-аккаунта</summary>
    <p>Для ранее привязанного активного устройства. Пароли и секрет восстановления открываются только здесь. Замена утраченного устройства — отдельная операция.</p>
    <form onSubmit={event => { event.preventDefault(); void run(); }} style={{ display: 'grid', gap: 12 }}>
      <label>Действие<select disabled={busy || !!candidate} value={mode} onChange={event => { setMode(event.target.value as typeof mode); setSecret(''); setNotice(''); }}>
        <option value="backup">Создать пакет восстановления</option><option value="password">Сменить пароль аккаунта</option><option value="recover">Восстановить из пакета</option><option value="publish">Повторить публикацию сохранённой версии</option>
        <option value="root">Сменить управляющий корень</option>
      </select></label>
      <label>Файл ключей устройства<input disabled={busy || !!candidate} type="file" accept=".json,application/json" required onChange={e => setKeysFile(e.target.files?.[0] ?? null)} /></label>
      <label>{mode === 'recover' ? 'Пакет восстановления' : 'Файл аккаунта с зашифрованным корнем'}<input disabled={busy || !!candidate} type="file" accept=".json,application/json" required onChange={e => setAccountFile(e.target.files?.[0] ?? null)} /></label>
      {(mode === 'backup' || mode === 'password' || mode === 'root') && <label>Текущий пароль<input disabled={busy || !!candidate} type="password" autoComplete="off" required value={password} onChange={e => setPassword(e.target.value)} /></label>}
      {mode === 'recover' && <label>Секрет восстановления<input disabled={busy || !!candidate} type="password" autoComplete="off" required value={secret} onChange={e => setSecret(e.target.value)} /></label>}
      {(mode === 'password' || mode === 'recover' || mode === 'root') && <label>Новый пароль аккаунта<input disabled={busy || !!candidate} type="password" autoComplete="new-password" required value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>}
      {mode === 'root' && <label>Текущий пароль файла устройства<input disabled={busy || !!candidate} type="password" autoComplete="off" required value={devicePassword} onChange={e => setDevicePassword(e.target.value)} /></label>}
      <button disabled={busy || !!candidate}>{busy ? 'Проверка…' : 'Подготовить и сохранить'}</button>
    </form>
    {mode === 'backup' && secret && <label>Сохраните секрет отдельно<input readOnly value={secret} aria-label="Секрет нового пакета" /><button onClick={() => setSecret('')}>Скрыть секрет</button></label>}
    {candidate?.control && <><label>Сохранённый файл нового корня<input disabled={busy} type="file" accept=".json,application/json" onChange={e => { setSavedFile(e.target.files?.[0] ?? null); setSavedChecked(false); }} /></label><label>Пароль сохранённого нового корня<input disabled={busy} type="password" autoComplete="off" value={savedPassword} onChange={e => { setSavedPassword(e.target.value); setSavedChecked(false); }} /></label><button disabled={busy || !savedFile || !savedPassword} onClick={() => void checkSaved()}>Проверить сохранённый корень</button></>}
    {candidate && <><button disabled={busy || (!!candidate.control && !savedChecked)} onClick={() => void run(true)}>Опубликовать / проверить эту версию</button><button disabled={busy} onClick={() => download('sphere-account-candidate.json', candidate)}>Сохранить файл ещё раз</button><button disabled={busy} onClick={() => { setCandidate(null); setSavedChecked(false); setSavedPassword(''); setSavedFile(null); }}>Закрыть подготовленную версию</button></>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
