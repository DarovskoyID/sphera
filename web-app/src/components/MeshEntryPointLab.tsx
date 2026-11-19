import { useState } from 'react';
import { EntryPointSelection } from '../core/mesh/entryPoint';

export function MeshEntryPointLab() {
  const [selection, setSelection] = useState<EntryPointSelection | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [network, setNetwork] = useState('');
  const [url, setUrl] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entries = selection?.catalogue() ?? [];
  const selected = selection?.status().entry;
  const add = async () => {
    if (!reviewed || busy) return;
    setBusy(true); setError('');
    try {
      const prior = entries.map(({ label, network, nodeId, publicKey, url }) => ({ label, network, nodeId, publicKey, url }));
      const next = await EntryPointSelection.create([...prior, { label, network, nodeId, publicKey, url }]);
      setSelection(next); setChosen(null); setReviewed(false);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(code === 'entry_point_key_mismatch' ? 'Ключ не соответствует идентификатору сервера.' : code === 'duplicate_entry_point_address' ? 'Этот адрес уже добавлен.' : 'Проверьте поля. Нужен HTTPS-адрес без пути и два значения ключа и идентификатора по 64 символа.');
    } finally { setBusy(false); }
  };
  return <main style={{ maxWidth: 720, margin: '40px auto', padding: 24, display: 'grid', gap: 16 }}>
    <h1>Точка входа в сеть</h1>
    <p>Экран проверки выбора сервера. Авторизация здесь пока недоступна.</p>
    <p>Получите адрес и ключ через доверенный канал. Ключ, показанный самим неизвестным сервером, не подтверждает его подлинность.</p>
    <form onSubmit={event => { event.preventDefault(); void add(); }} style={{ display: 'grid', gap: 12 }}>
      <label>Название<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label>Сеть<input required value={network} onChange={event => setNetwork(event.target.value)} /></label>
      <label>Адрес сервера<input required type="url" placeholder="https://server.example" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label>Идентификатор сервера<input required value={nodeId} onChange={event => setNodeId(event.target.value)} /></label>
      <label>Открытый ключ<input required value={publicKey} onChange={event => setPublicKey(event.target.value)} /></label>
      <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> Я сверил адрес, идентификатор и ключ через доверенный канал</label>
      <button disabled={!reviewed || busy} type="submit">{busy ? 'Проверка…' : 'Добавить сервер'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <section aria-label="Серверы">
      {entries.length === 0 && <p>Список пуст. Сервер не выбран.</p>}
      {entries.map(entry => <article key={entry.id} style={{ marginBlock: 16 }}>
        <strong>{entry.label}</strong><div>{entry.url}</div><small>{entry.network}</small><br />
        <button type="button" aria-pressed={chosen === entry.id} onClick={() => { selection!.select(entry.id); setChosen(entry.id); }}>{chosen === entry.id ? 'Выбран' : 'Выбрать'}</button>
      </article>)}
    </section>
    {selected && <section aria-live="polite"><h2>Выбранный сервер</h2><p>{selected.label} · {selected.url}</p><p style={{ overflowWrap: 'anywhere' }}>Идентификатор: {selected.nodeId}<br />Ключ: {selected.publicKey}</p><p>Другой сервер выбирается вручную. Пароль и ключ пользователя этот экран не запрашивает.</p></section>}
  </main>;
}
