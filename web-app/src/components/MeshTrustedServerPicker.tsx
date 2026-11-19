import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { loadServers, saveServers, saveSelectedServer } from '../config/network';
import { entryProbeNonce, loadEntryPointPin, saveEntryPointPin, validateTrustedEntryPoints, verifyEntryProbe } from '../core/mesh/entryPoint';

export function MeshTrustedServerPicker() {
  const { currentServerIP, setCurrentServerIP, setAuthToken } = useApp();
  const [fields, setFields] = useState({ label: '', network: '', url: '', nodeId: '', publicKey: '' });
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current;
    void loadEntryPointPin(localStorage).then(pin => {
      if (pin && revision === generation.current) {
        const { label, network, url, nodeId, publicKey } = pin;
        setFields({ label, network, url, nodeId, publicKey });
      }
    }).catch(() => { if (revision === generation.current) setNotice('Сохранённая привязка повреждена. Сверьте и выберите сервер заново.'); });
    return () => { generation.current++; };
  }, [currentServerIP]);
  const select = async () => {
    if (!reviewed || busy) return;
    const revision = generation.current;
    setBusy(true); setNotice('');
    try {
      const [pin] = await validateTrustedEntryPoints([fields]);
      const nonce = entryProbeNonce();
      const response = await fetch(`${pin.url}/api/auth/mesh/entry/`, {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }),
      });
      if (!response.ok) throw new Error('unavailable');
      await verifyEntryProbe(await response.json(), pin, nonce);
      if (generation.current !== revision) return;
      saveEntryPointPin(localStorage, pin);
      const servers = loadServers();
      const existing = servers.findIndex(server => server.url === pin.url);
      if (existing < 0) servers.push({ url: pin.url, name: pin.label });
      else servers[existing] = { ...servers[existing], name: pin.label };
      saveServers(servers);
      saveSelectedServer(pin.url);
      setAuthToken('');
      setCurrentServerIP(pin.url);
      window.dispatchEvent(new Event('sfera-mesh-entry-change'));
      setReviewed(false); setNotice('Сервер выбран, подпись проверена. Теперь можно войти с mesh-ключами.');
    } catch {
      if (generation.current === revision) setNotice('Сервер не выбран. Проверьте адрес, ключ, идентификатор и доступность сети.');
    } finally { setBusy(false); }
  };
  return <details style={{ marginBlock: 20 }}><summary>Выбрать доверенный mesh-сервер</summary>
    <p>Сверьте адрес и ключ с оператором через доверенный канал. При недоступности другой сервер автоматически не выбирается.</p>
    <form onSubmit={event => { event.preventDefault(); void select(); }} style={{ display: 'grid', gap: 10 }}>
      {([['label', 'Название'], ['network', 'Сеть'], ['url', 'HTTPS-адрес'], ['nodeId', 'Идентификатор сервера'], ['publicKey', 'Открытый ключ']] as const).map(([name, label]) =>
        <label key={name}>{label}<input required disabled={busy} value={fields[name]} maxLength={name === 'url' ? 2048 : name === 'label' ? 80 : name === 'network' ? 128 : 64}
          type={name === 'url' ? 'url' : 'text'} onChange={event => { setReviewed(false); setFields(previous => ({ ...previous, [name]: event.target.value })); }} /></label>)}
      <label><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />Я сверил адрес и ключ через доверенный канал</label>
      <button disabled={busy || !reviewed} type="submit">{busy ? 'Проверка сервера…' : 'Проверить и выбрать сервер'}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
