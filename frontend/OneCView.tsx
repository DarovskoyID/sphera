import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Boxes, Building, Check, Database, FileText, History, KeyRound, Plus, Search, Settings2, User, Webhook } from 'lucide-react';
import { reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, entityLabel, type Brief, type Conn, type RecordData, type Settings } from './api';
import * as onec from './store';
import { CopyField, EventLog, ResultGroup, ResultRow, SearchBox, StatusPill, Steps, UsersField } from './kit';
import { Button, Empty, Field, Modal, Segmented, inputStyle } from './ui';

export const ROUTE = 'onec';
export const BRAND = '#f2c200';

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, background: 'linear-gradient(135deg,#ffd43b,#f08c00)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b3261e', fontWeight: 900, fontSize: size * 0.4, flexShrink: 0, fontFamily: 'Arial, sans-serif' }}>
      1С
    </div>
  );
}

function entityIcon(entity: string) {
  if (entity.startsWith('Document_')) return <FileText size={16} />;
  if (/Номенклатур|Товар|Product/i.test(entity)) return <Boxes size={16} />;
  if (/Контрагент|Партнер|Клиент/i.test(entity)) return <Building size={16} />;
  return <Database size={16} />;
}

function formatValue(v: string | number | boolean, yes: string, no: string) {
  if (typeof v === 'boolean') return v ? yes : no;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s.startsWith('0001-') ? '—' : new Date(s).toLocaleString();
  return s;
}

export function RecordCard({ entity, keyId, onClose, onInsert }: { entity: string; keyId: string; onClose: () => void; onInsert?: (text: string) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [data, setData] = useState<RecordData | null>(null);
  const [open, setOpen] = useState<Brief | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { api.record(conn, entity, keyId).then(setData).catch(e => { reportError(e); closeRef.current(); }); }, [conn, entity, keyId]);
  if (open) return <RecordCard entity={open.entity} keyId={open.key} onClose={() => setOpen(null)} />;
  return (
    <Modal width={600} onClose={onClose} title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{entityIcon(entity)} {data?.brief.title ?? entityLabel(entity)}</span>}
      footer={onInsert && data ? (
        <Button kind="primary" onClick={() => {
          const inn = data.fields.find(f => /^ИНН$|^INN$/i.test(f.name));
          onInsert(`${data.brief.title}${inn ? `, ИНН ${inn.value}` : ''}`);
          onClose();
        }}>{t('oc_insert')}</Button>
      ) : undefined}>
      {!data ? <div style={{ color: 'var(--text-tertiary)' }}>…</div> : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{entityLabel(entity)}</div>
          <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
            {data.fields.filter(f => f.name !== 'Ref_Key' && f.name !== 'DataVersion').map(f => (
              <div key={f.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 38%) 1fr', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border-color)', fontSize: 13 }}>
                <span style={{ color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>{f.name.replace(/_Key$/, '')}</span>
                <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{formatValue(f.value, t('oc_yes'), t('oc_no'))}</span>
              </div>
            ))}
          </div>
          {data.documents && (
            data.documents.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('oc_no_documents')}</div> : (
              <ResultGroup title={t('oc_documents')} count={data.documents.length}>
                {data.documents.map(d => (
                  <ResultRow key={d.key} icon={<FileText size={16} />} title={d.title} subtitle={d.subtitle}
                    action={<Button small kind="plain" onClick={() => setOpen(d)}>{t('oc_open')}</Button>} />
                ))}
              </ResultGroup>
            )
          )}
        </>
      )}
    </Modal>
  );
}

function CreateCounterparty({ onClose }: { onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [name, setName] = useState('');
  const [inn, setInn] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Brief | null>(null);
  const innOk = !inn || /^\d{10}(\d{2})?$/.test(inn.replace(/\D/g, ''));
  if (done) {
    return (
      <Modal title={t('oc_new_counterparty')} onClose={onClose} width={420}>
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(16,185,129,.14)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}><Check size={26} /></div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('oc_created').replace('{name}', done.title)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', margin: '4px 0 14px' }}>{done.subtitle}</div>
          <Button onClick={onClose}>{t('oc_close')}</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Logo size={26} /> {t('oc_new_counterparty')}</span>} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('oc_cancel')}</Button>
        <Button kind="primary" disabled={!name.trim() || !innOk || busy} onClick={async () => {
          setBusy(true);
          try { setDone(await api.createCounterparty(conn, { name: name.trim(), inn: inn.replace(/\D/g, ''), comment })); } catch (e) { reportError(e); } finally { setBusy(false); }
        }}>{busy ? '…' : t('oc_create')}</Button>
      </>
    }>
      <Field label={t('oc_cp_name')}><input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('oc_name_ph')} style={inputStyle()} /></Field>
      <Field label={t('oc_inn')} hint={innOk ? t('oc_inn_hint') : t('oc_inn_bad')}>
        <input inputMode="numeric" value={inn} onChange={e => setInn(e.target.value)} style={inputStyle(!innOk)} />
      </Field>
      <Field label={t('oc_comment')}><textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} style={{ ...inputStyle(), resize: 'vertical' }} /></Field>
    </Modal>
  );
}

const SAMPLE_1C = (url: string) => `// Уведомление в Сферу (например, из обработчика проведения документа)
Процедура ОтправитьВСферу(Заголовок, Текст, Получатели = Неопределено, Ссылка = "") Экспорт
    Адрес = "${url}";
    Данные = Новый Структура("title, text, url", Заголовок, Текст, Ссылка);
    Если Получатели <> Неопределено Тогда
        Данные.Вставить("to", Получатели); // массив логинов или email; без него — ответственным из настроек
    КонецЕсли;
    Запись = Новый ЗаписьJSON; Запись.УстановитьСтроку();
    ЗаписатьJSON(Запись, Данные);
    Структура = СтруктураURI(Адрес);
    Соединение = Новый HTTPСоединение(Структура.Хост, Структура.Порт, , , , 15,
        ?(Структура.Схема = "https", Новый ЗащищенноеСоединениеOpenSSL, Неопределено));
    Запрос = Новый HTTPЗапрос(Структура.ПутьНаСервере);
    Запрос.Заголовки.Вставить("Content-Type", "application/json; charset=utf-8");
    Запрос.УстановитьТелоИзСтроки(Запись.Закрыть(), КодировкаТекста.UTF8, ИспользованиеByteOrderMark.НеИспользовать);
    Соединение.ОтправитьДляОбработки(Запрос);
КонецПроцедуры`;

export function SettingsForm() {
  const t = useModuleT();
  const conn = useConn();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const search = useCallback((q: string) => api.users(conn, q), [conn]);
  useEffect(() => { api.settings(conn).then(setS).catch(reportError); }, [conn]);
  if (!s) return <div style={{ color: 'var(--text-tertiary)' }}>…</div>;

  const inboundUrl = `${conn.serverIP.replace(/\/$/, '')}${s.inbound_path}`;
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await api.saveSettings(conn, {
        base_url: s.base_url, username: s.username, password: s.password,
        counterparty_entity: s.counterparty_entity, product_entity: s.product_entity, document_entity: s.document_entity,
        document_counterparty_field: s.document_counterparty_field, inn_field: s.inn_field,
        notify_user_ids: s.notify_users.map(u => u.id), allowed_user_ids: s.allowed_users.map(u => u.id), ...extra,
      });
      setS(r);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void onec.refreshStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const section = (icon: React.ReactNode, title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '20px 0 10px' }}>{icon} {title}</div>
  );
  const entitySelect = (field: 'counterparty_entity' | 'product_entity' | 'document_entity', label: string, prefix: string) => (
    <Field label={label}>
      {s.entity_sets.length ? (
        <select value={s[field]} onChange={e => setS({ ...s, [field]: e.target.value })} style={inputStyle()}>
          {!s.entity_sets.includes(s[field]) && <option value={s[field]}>{s[field]} ({t('oc_not_published')})</option>}
          {s.entity_sets.filter(x => x.startsWith(prefix)).map(x => <option key={x} value={x}>{entityLabel(x)}</option>)}
        </select>
      ) : <input value={s[field]} onChange={e => setS({ ...s, [field]: e.target.value })} style={inputStyle()} />}
    </Field>
  );

  return (
    <div style={{ maxWidth: 680 }}>
      <StatusPill ok={s.configured && !s.last_error} label={s.configured ? (s.last_error ? t('oc_status_error') : t('oc_status_ok').replace('{n}', String(s.entity_sets.length))) : t('oc_status_off')} />
      {s.last_error && <div style={{ fontSize: 12.5, color: '#ef4444', margin: '8px 0', wordBreak: 'break-word' }}>{s.last_error}</div>}

      {section(<KeyRound size={17} />, t('oc_connection'))}
      <Steps items={[t('oc_step1'), t('oc_step2'), t('oc_step3')]} />
      <Field label={t('oc_base_url')} hint={t('oc_base_url_hint')}>
        <input value={s.base_url} onChange={e => setS({ ...s, base_url: e.target.value })} placeholder="https://1c.company.ru/trade" style={inputStyle()} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
        <Field label={t('oc_username')}><input value={s.username} onChange={e => setS({ ...s, username: e.target.value })} style={inputStyle()} autoComplete="off" /></Field>
        <Field label={t('oc_password')}><input type="password" value={s.password} onChange={e => setS({ ...s, password: e.target.value })} style={inputStyle()} autoComplete="new-password" /></Field>
      </div>

      {section(<Database size={17} />, t('oc_objects'))}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
        {entitySelect('counterparty_entity', t('oc_counterparties'), 'Catalog_')}
        {entitySelect('product_entity', t('oc_products'), 'Catalog_')}
        {entitySelect('document_entity', t('oc_documents'), 'Document_')}
        <Field label={t('oc_doc_field')} hint={t('oc_doc_field_hint')}><input value={s.document_counterparty_field} onChange={e => setS({ ...s, document_counterparty_field: e.target.value })} style={inputStyle()} /></Field>
        <Field label={t('oc_inn_field')}><input value={s.inn_field} onChange={e => setS({ ...s, inn_field: e.target.value })} style={inputStyle()} /></Field>
      </div>

      {section(<Webhook size={17} />, t('oc_inbound'))}
      <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('oc_inbound_hint')}</p>
      <CopyField label={t('oc_inbound_url')} value={inboundUrl} hint={t('oc_inbound_secret')} />
      <Button small kind="plain" onClick={() => void save({ regenerate_inbound: true })}>{t('oc_regenerate')}</Button>
      <details style={{ margin: '8px 0 14px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13.5, color: 'var(--accent-primary)', fontWeight: 600 }}>{t('oc_sample')}</summary>
        <pre style={{ marginTop: 8, padding: 12, borderRadius: 10, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 12, overflowX: 'auto', whiteSpace: 'pre' }}>{SAMPLE_1C(inboundUrl)}</pre>
        <Button small onClick={() => void navigator.clipboard.writeText(SAMPLE_1C(inboundUrl)).catch(reportError)}>{t('oc_copy_code')}</Button>
      </details>
      <UsersField label={t('oc_notify_users')} hint={t('oc_notify_users_hint')} users={s.notify_users} onChange={u => setS({ ...s, notify_users: u })} search={search} />

      {section(<User size={17} />, t('oc_access'))}
      <UsersField label={t('oc_allowed_users')} hint={t('oc_allowed_users_hint')} users={s.allowed_users} onChange={u => setS({ ...s, allowed_users: u })} search={search} />
      <Button kind="primary" disabled={busy} onClick={() => void save()}>{saved ? <><Check size={14} /> {t('oc_saved')}</> : busy ? '…' : t('oc_save_check')}</Button>
    </div>
  );
}

export function Browser({ initialEntity, onInsert }: { initialEntity?: string; onInsert?: (text: string) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const status = useModuleStore(onec.store, s => s.status);
  const [sets, setSets] = useState<string[]>([]);
  const [entity, setEntity] = useState(initialEntity ?? status?.entities.counterparty ?? 'Catalog_Контрагенты');
  const [open, setOpen] = useState<Brief | null>(null);
  useEffect(() => { api.entitySets(conn).then(setSets).catch(() => {}); }, [conn]);
  const run = useCallback((q: string) => api.search(conn, entity, q), [conn, entity]);
  const quick = status ? [status.entities.counterparty, status.entities.product, status.entities.document] : [];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {quick.map(q => (
          <Button key={q} small kind={entity === q ? 'primary' : 'ghost'} onClick={() => setEntity(q)}>{entityIcon(q)} {entityLabel(q)}</Button>
        ))}
        {sets.length > 0 && (
          <select aria-label={t('oc_other_object')} value={quick.includes(entity) ? '' : entity} onChange={e => e.target.value && setEntity(e.target.value)} style={{ ...inputStyle(), width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
            <option value="">{t('oc_other_object')}</option>
            {sets.filter(x => x.startsWith('Catalog_') || x.startsWith('Document_')).map(x => <option key={x} value={x}>{entityLabel(x)}</option>)}
          </select>
        )}
      </div>
      <SearchBox<Brief[]> key={entity} placeholder={entity.startsWith('Document_') ? t('oc_search_doc_ph') : t('oc_search_ph')} run={run} render={rows => (
        rows.length === 0 ? <Empty icon={<Search size={26} />} title={t('oc_nothing_found')} /> : (
          <ResultGroup title={entityLabel(entity)} count={rows.length}>
            {rows.map(r => <ResultRow key={r.key} icon={entityIcon(entity)} title={r.title} subtitle={r.subtitle} action={<Button small kind="plain" onClick={() => setOpen(r)}>{t('oc_open')}</Button>} />)}
          </ResultGroup>
        )
      )} />
      {open && <RecordCard entity={open.entity} keyId={open.key} onClose={() => setOpen(null)} onInsert={onInsert} />}
    </div>
  );
}

export function OneCView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const conn = useConn();
  const status = useModuleStore(onec.store, s => s.status);
  const [tab, setTab] = useState<'browse' | 'log' | 'settings'>('browse');
  const [create, setCreate] = useState(false);
  const loadEvents = useCallback((d?: 'in' | 'out') => api.events(conn, d), [conn]);
  useEffect(() => { if (status && !status.configured && status.can_manage) setTab('settings'); }, [status]);

  const tabs = [
    { id: 'browse' as const, label: t('oc_tab_browse'), icon: <Search size={14} /> },
    { id: 'log' as const, label: t('oc_tab_log'), icon: <History size={14} /> },
    ...(status?.can_manage ? [{ id: 'settings' as const, label: t('oc_tab_settings'), icon: <Settings2 size={14} /> }] : []),
  ];

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)', ...style }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Logo />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{t('oc_name_full')}</h1>
            {status && <StatusPill ok={status.configured} label={status.configured ? t('oc_connected') : t('oc_status_off')} />}
          </div>
          {status?.can_act && <Button kind="primary" onClick={() => setCreate(true)}><Plus size={15} /> {t('oc_new_counterparty')}</Button>}
        </div>
        <div style={{ marginBottom: 18, overflowX: 'auto' }}><Segmented value={tab} onChange={setTab} options={tabs} /></div>
        {status && !status.configured && tab !== 'settings' ? (
          <Empty icon={<Database size={28} />} title={t('oc_not_configured')} hint={status.can_manage ? t('oc_not_configured_admin') : t('oc_not_configured_user')}
            action={status.can_manage ? <Button kind="primary" onClick={() => setTab('settings')}>{t('oc_setup')}</Button> : undefined} />
        ) : status && !status.can_act && tab !== 'settings' ? (
          <Empty icon={<User size={28} />} title={t('oc_no_access')} hint={t('oc_no_access_hint')} />
        ) : tab === 'browse' ? <Browser /> : tab === 'log' ? <EventLog load={loadEvents} empty={t('oc_log_empty')} /> : <SettingsForm />}
      </div>
      {create && <CreateCounterparty onClose={() => setCreate(false)} />}
    </div>
  );
}
