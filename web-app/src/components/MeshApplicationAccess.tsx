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
  const [backups,setBackups]=useState<{handle:string;keys:unknown}[]>([]);
  useEffect(()=>{
    const found:{handle:string;keys:unknown}[]=[];
    for(let index=0;index<localStorage.length;index++) {
      const name=localStorage.key(index);
      if(!name?.startsWith('sfera_distributed_credentials_v1:'))continue;
      try {
        const raw=localStorage.getItem(name);if(!raw || raw.length>32768)continue;
        const value=JSON.parse(raw);const keys=applicationKeys(value.keys,currentServerIP);
        const handle=value.bundle.profile.body.handle;
        if(typeof handle==='string' && /^[a-z][a-z0-9_]{2,31}$/.test(handle))found.push({handle,keys});
      } catch { /* Other servers and malformed local records are not exported. */ }
    }
    setBackups(found);
  },[currentServerIP,authToken]);
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
        let value=JSON.parse(await file.text());
        if(pin && pinnedGenesis && value.network===pin.network && value.genesis===pinnedGenesis
            && (value.entry!==pin.nodeId || new URL(value.server).origin!==new URL(currentServerIP).origin)) {
          const response=await fetch(`${currentServerIP}/api/distribution/config/`,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
          const mode=response.ok?await response.json():null;
          if(mode?.mode!=='distributed' || mode.genesis!==pinnedGenesis || mode.entry!==pin.nodeId)throw new Error('application_entry_pin_mismatch');
          value={...value,entry:pin.nodeId,server:new URL(currentServerIP).origin+'/'};
        }
        const keys = applicationKeys(value, currentServerIP);
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
    {backups.map(({handle,keys})=><p key={handle}><button type="button" onClick={()=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(keys)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`sphere-${handle}-keys.json`;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }}>Скачать зашифрованные ключи «{handle}»</button></p>)}
    {backups.length>0 && <p>Этот файл и пароль позволяют войти с другого устройства или через другой поинт.</p>}
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
