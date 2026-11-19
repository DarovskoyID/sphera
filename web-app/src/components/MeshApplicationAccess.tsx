import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { applicationKeys, answerApplicationChallenge } from '../core/mesh/applicationAuth';
import { meshUserId } from '../core/mesh/account';
import { meshDeviceId } from '../core/mesh/devices';
import { ENTRY_PIN_KEY, entryProbeNonce, loadEntryPointPin, verifyEntryProbe } from '../core/mesh/entryPoint';

export function MeshApplicationAccess({ bind = false }: { bind?: boolean }) {
  const { currentServerIP, authToken, setAuthToken } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [factor, setFactor] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => { generation.current++; setFactor(''); setPassword(''); setNotice(''); return () => { generation.current++; }; }, [currentServerIP, authToken]);
  useEffect(() => {
    const changed = () => { generation.current++; setFactor(''); setPassword(''); setFile(null); setCode(''); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === ENTRY_PIN_KEY || event.key === 'sfera_selected_server') changed();
    };
    window.addEventListener('sfera-mesh-entry-change', changed);
    window.addEventListener('storage', storageChanged);
    return () => { window.removeEventListener('sfera-mesh-entry-change', changed); window.removeEventListener('storage', storageChanged); };
  }, []);
  const submit = async () => {
    if (busy) return;
    const requestGeneration = generation.current;
    setBusy(true); setNotice('');
    try {
      const pin = await loadEntryPointPin(localStorage);
      let pinnedGenesis: string | undefined;
      if (pin) {
        if (new URL(currentServerIP).origin !== pin.url) throw new Error('selected_entry_mismatch');
        const nonce = entryProbeNonce();
        const response = await fetch(`${pin.url}/api/auth/mesh/entry/`, {
          method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }),
        });
        if (!response.ok) throw new Error('entry_unavailable');
        pinnedGenesis = await verifyEntryProbe(await response.json(), pin, nonce);
      }
      if (generation.current !== requestGeneration) throw new Error('cancelled');
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${currentServerIP}/api/auth/mesh/${path}`, {
          method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/json', ...(bind ? { Authorization: `Bearer ${authToken}` } : {}) },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (generation.current !== requestGeneration) throw new Error('cancelled');
        if (response.status === 409 && data.error === 'second_factor_required' && typeof data.challenge === 'string') {
          setFactor(data.challenge); setPassword(''); return null;
        }
        if (!response.ok) throw new Error('rejected');
        return data;
      };
      let result;
      if (factor) {
        result = await post('login/2fa/', { challenge: factor, code: code.trim() });
      } else {
        if (!file || file.size > 32768) throw new Error('invalid_file');
        const keys = applicationKeys(JSON.parse(await file.text()), currentServerIP);
        if (pin && (keys.entry !== pin.nodeId || keys.network !== pin.network || keys.genesis !== pinnedGenesis)) throw new Error('application_entry_pin_mismatch');
        const challenge = await post(bind ? 'challenge/' : 'login/challenge/', {
          owner: await meshUserId(keys.ownerPublic), device: await meshDeviceId(keys.devicePublic),
        });
        if (!challenge) throw new Error('rejected');
        let jti: string | undefined;
        if (bind) jti = JSON.parse(atob(authToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).jti;
        const proof = await answerApplicationChallenge(keys, password, challenge, bind ? 'bind' : 'login', jti);
        if (generation.current !== requestGeneration) throw new Error('cancelled');
        result = await post(bind ? 'bind/' : 'login/', proof);
      }
      if (result) {
        if (typeof result.access !== 'string' || !result.mesh_session) throw new Error('rejected');
        setPassword(''); setCode(''); setFactor(''); setFile(null);
        setAuthToken(result.access);
        setNotice(bind ? 'Устройство привязано. Соединения обновлены.' : 'Вход выполнен.');
      }
    } catch (error) {
      if (generation.current === requestGeneration) setNotice(error instanceof Error && error.message === 'invalid_file'
        ? 'Выберите зашифрованный файл ключей размером до 32 КБ.'
        : 'Не удалось подтвердить вход. Проверьте файл, пароль и доступность сети.');
    } finally { setBusy(false); }
  };
  return <details style={{ marginBlock: 20 }}><summary>{bind ? 'Привязать mesh-устройство' : 'Войти с mesh-ключами'}</summary>
    <p>{bind ? 'Привяжите уже зарегистрированное в сети устройство к этому аккаунту.' : 'Для аккаунта, к которому ранее привязано mesh-устройство.'} Файл открывается на этом устройстве.</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} style={{ display: 'grid', gap: 12 }}>
      {factor ? <label>Код подтверждения<input required autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} /></label> : <>
        <label>Зашифрованный файл ключей<input required type="file" accept="application/json,.json" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
        <label>Пароль файла<input required type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
      </>}
      <button disabled={busy} type="submit">{busy ? 'Проверка…' : factor ? 'Подтвердить код' : bind ? 'Привязать устройство' : 'Войти'}</button>
      {factor && <button disabled={busy} type="button" onClick={() => { setFactor(''); setCode(''); }}>Начать заново</button>}
    </form>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
