import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Briefcase, Building2, Check, CheckSquare, ExternalLink, History, KeyRound, MessageSquarePlus, Plus, Search, Settings2, User, Webhook } from 'lucide-react';
import { reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, type Conn, type CreateBody, type Kind, type PortalUser, type SearchResult, type Settings } from './api';
import * as bx from './store';
import { CopyField, EventLog, ResultGroup, ResultRow, SearchBox, StatusPill, Steps, UsersField } from './kit';
import { Button, Empty, Field, Modal, Segmented, inputStyle } from './ui';

export const ROUTE = 'bitrix';
export const BRAND = '#2fc6f6';

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, background: 'linear-gradient(135deg,#2fc6f6,#0b66c3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: size * 0.36, flexShrink: 0 }}>
      24
    </div>
  );
}

function ResponsiblePicker({ value, onChange }: { value: number | null | undefined; onChange: (id: number | null) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [users, setUsers] = useState<PortalUser[]>([]);
  useEffect(() => { api.portalUsers(conn).then(setUsers).catch(() => {}); }, [conn]);
  if (!users.length) return null;
  return (
    <Field label={t('bx_responsible')}>
      <select value={value ?? ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)} style={inputStyle()}>
        <option value="">{t('bx_responsible_default')}</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </Field>
  );
}

/** Lead, deal or task in Bitrix24. */
export function CreateDialog({ onClose, initialKind = 'lead', initial }: { onClose: () => void; initialKind?: Kind; initial?: Partial<CreateBody> }) {
  const t = useModuleT();
  const conn = useConn();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [form, setForm] = useState<CreateBody>({ title: '', name: '', phone: '', email: '', comment: '', amount: '', ...initial });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof CreateBody, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      const body: CreateBody = { ...form, title: form.title.trim() };
      if (kind === 'task' && form.deadline) body.deadline = new Date(form.deadline).toISOString();
      setDone((await api.create(conn, kind, body)).url);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Modal title={t('bx_name')} onClose={onClose} width={420}>
        <div style={{ textAlign: 'center', padding: '10px 0 6px' }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(16,185,129,.14)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}><Check size={26} /></div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>{t(`bx_created_${kind}`)}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {done && <a href={done} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}><Button kind="primary"><ExternalLink size={14} /> {t('bx_open_portal')}</Button></a>}
            <Button onClick={onClose}>{t('bx_close')}</Button>
          </div>
        </div>
      </Modal>
    );
  }

  const row: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0 12px' };
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Logo size={26} /> {t('bx_create_title')}</span>} onClose={onClose} width={560} footer={
      <>
        <Button onClick={onClose}>{t('bx_cancel')}</Button>
        <Button kind="primary" disabled={!form.title.trim() || busy} onClick={() => void submit()}>{busy ? '…' : t(`bx_create_${kind}`)}</Button>
      </>
    }>
      <div style={{ marginBottom: 14 }}>
        <Segmented value={kind} onChange={setKind} options={[
          { id: 'lead', label: t('bx_lead'), icon: <User size={14} /> },
          { id: 'deal', label: t('bx_deal'), icon: <Briefcase size={14} /> },
          { id: 'task', label: t('bx_task'), icon: <CheckSquare size={14} /> },
        ]} />
      </div>
      <div style={row}>
        <Field label={t(`bx_title_${kind}`)}>
          <input autoFocus value={form.title} onChange={e => set('title', e.target.value)} style={inputStyle()} />
        </Field>
        {kind !== 'task' ? (
          <Field label={t('bx_amount')}>
            <input inputMode="decimal" value={form.amount} onChange={e => set('amount', e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0" style={inputStyle()} />
          </Field>
        ) : (
          <Field label={t('bx_deadline')}>
            <input type="datetime-local" value={form.deadline ?? ''} onChange={e => set('deadline', e.target.value)} style={inputStyle()} />
          </Field>
        )}
      </div>
      {kind === 'lead' && (
        <div style={row}>
          <Field label={t('bx_client_name')}><input value={form.name} onChange={e => set('name', e.target.value)} style={inputStyle()} autoComplete="off" /></Field>
          <Field label={t('bx_phone')}><input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+7…" style={inputStyle()} autoComplete="off" /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={e => set('email', e.target.value)} style={inputStyle()} autoComplete="off" /></Field>
        </div>
      )}
      <ResponsiblePicker value={form.responsible_id} onChange={id => setForm(f => ({ ...f, responsible_id: id }))} />
      <Field label={kind === 'task' ? t('bx_description') : t('bx_comment')}>
        <textarea value={form.comment} onChange={e => set('comment', e.target.value)} rows={3} style={{ ...inputStyle(), resize: 'vertical' }} />
      </Field>
    </Modal>
  );
}

export function SettingsForm() {
  const t = useModuleT();
  const conn = useConn();
  const [s, setS] = useState<Settings | null>(null);
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const search = useCallback((q: string) => api.users(conn, q), [conn]);

  useEffect(() => { api.settings(conn).then(setS).catch(reportError); }, [conn]);
  useEffect(() => { if (s?.configured) api.portalUsers(conn).then(setUsers).catch(() => {}); }, [conn, s?.configured]);
  if (!s) return <div style={{ color: 'var(--text-tertiary)' }}>…</div>;

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await api.saveSettings(conn, {
        webhook_url: s.webhook_url, application_token: s.application_token, default_responsible_id: s.default_responsible_id,
        notify_user_ids: s.notify_users.map(u => u.id), allowed_user_ids: s.allowed_users.map(u => u.id), ...extra,
      });
      setS(r);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void bx.refreshStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const section = (icon: React.ReactNode, title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '20px 0 10px' }}>{icon} {title}</div>
  );
  const missing = s.configured ? ['crm', 'task', 'user'].filter(x => !s.scopes.includes(x)) : [];

  return (
    <div style={{ maxWidth: 640 }}>
      <StatusPill ok={s.configured && !s.last_error} label={s.configured ? (s.last_error ? t('bx_status_error') : t('bx_status_ok').replace('{name}', s.portal)) : t('bx_status_off')} />
      {s.last_error && <div style={{ fontSize: 12.5, color: '#ef4444', margin: '8px 0', wordBreak: 'break-word' }}>{s.last_error}</div>}
      {missing.length > 0 && <div style={{ fontSize: 12.5, color: '#f59e0b', margin: '8px 0' }}>{t('bx_missing_scopes').replace('{list}', missing.join(', '))}</div>}

      {section(<KeyRound size={17} />, t('bx_connection'))}
      <Steps items={[t('bx_step1'), t('bx_step2'), t('bx_step3')]} />
      <Field label={t('bx_webhook_url')} hint={t('bx_webhook_url_hint')}>
        <input type="password" value={s.webhook_url} onChange={e => setS({ ...s, webhook_url: e.target.value })} placeholder="https://company.bitrix24.ru/rest/1/xxxxxxxx/" style={inputStyle()} autoComplete="new-password" />
      </Field>
      {users.length > 0 && (
        <Field label={t('bx_default_responsible')}>
          <select value={s.default_responsible_id ?? ''} onChange={e => setS({ ...s, default_responsible_id: e.target.value ? Number(e.target.value) : null })} style={inputStyle()}>
            <option value="">{t('bx_webhook_owner')}</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      )}

      {section(<Webhook size={17} />, t('bx_events'))}
      <Steps items={[t('bx_out_step1'), t('bx_out_step2'), t('bx_out_step3')]} />
      <CopyField label={t('bx_handler_url')} value={`${conn.serverIP.replace(/\/$/, '')}${s.inbound_path}`} hint={t('bx_handler_hint')} />
      <Button small kind="plain" onClick={() => void save({ regenerate_inbound: true })}>{t('bx_regenerate')}</Button>
      <Field label={t('bx_app_token')} hint={t('bx_app_token_hint')}>
        <input type="password" value={s.application_token} onChange={e => setS({ ...s, application_token: e.target.value })} style={inputStyle()} autoComplete="new-password" />
      </Field>
      <UsersField label={t('bx_notify_users')} users={s.notify_users} onChange={u => setS({ ...s, notify_users: u })} search={search} />

      {section(<User size={17} />, t('bx_access'))}
      <UsersField label={t('bx_allowed_users')} hint={t('bx_allowed_users_hint')} users={s.allowed_users} onChange={u => setS({ ...s, allowed_users: u })} search={search} />

      <Button kind="primary" disabled={busy} onClick={() => void save()}>{saved ? <><Check size={14} /> {t('bx_saved')}</> : busy ? '…' : t('bx_save_check')}</Button>
    </div>
  );
}

function CommentDialog({ target, onClose }: { target: { entity: string; id: number }; onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('bx_add_comment')} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('bx_cancel')}</Button>
        <Button kind="primary" disabled={!text.trim() || busy} onClick={async () => {
          setBusy(true);
          try { await api.comment(conn, target.entity, target.id, text.trim()); onClose(); } catch (e) { reportError(e); } finally { setBusy(false); }
        }}>{t('bx_add')}</Button>
      </>
    }>
      <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={5} style={{ ...inputStyle(), resize: 'vertical' }} />
    </Modal>
  );
}

export function BitrixView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const conn = useConn();
  const status = useModuleStore(bx.store, s => s.status);
  const [tab, setTab] = useState<'actions' | 'search' | 'log' | 'settings'>('actions');
  const [create, setCreate] = useState<Kind | null>(null);
  const [commentFor, setCommentFor] = useState<{ entity: string; id: number } | null>(null);
  const loadEvents = useCallback((d?: 'in' | 'out') => api.events(conn, d), [conn]);
  const runSearch = useCallback((q: string) => api.search(conn, q), [conn]);

  useEffect(() => { if (status && !status.configured && status.can_manage) setTab('settings'); }, [status]);

  const tabs = [
    { id: 'actions' as const, label: t('bx_tab_actions'), icon: <Plus size={14} /> },
    { id: 'search' as const, label: t('bx_tab_search'), icon: <Search size={14} /> },
    { id: 'log' as const, label: t('bx_tab_log'), icon: <History size={14} /> },
    ...(status?.can_manage ? [{ id: 'settings' as const, label: t('bx_tab_settings'), icon: <Settings2 size={14} /> }] : []),
  ];
  const actions: { kind: Kind; icon: React.ReactNode }[] = [
    { kind: 'lead', icon: <User size={20} /> }, { kind: 'deal', icon: <Briefcase size={20} /> }, { kind: 'task', icon: <CheckSquare size={20} /> },
  ];
  const group = (key: 'leads' | 'deals' | 'contacts', entity: string, icon: React.ReactNode, r: SearchResult) => r[key].length > 0 && (
    <ResultGroup title={t(`bx_${key}`)} count={r[key].length}>
      {r[key].map(x => (
        <ResultRow key={x.id} icon={icon} title={x.title} subtitle={x.amount || [...(x.phones ?? []), ...(x.emails ?? [])].join(' · ') || `#${x.id}`} url={x.url}
          action={<Button small kind="plain" onClick={() => setCommentFor({ entity, id: x.id })}><MessageSquarePlus size={14} /> {t('bx_comment_short')}</Button>} />
      ))}
    </ResultGroup>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)', ...style }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Logo />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{t('bx_name')}</h1>
            {status && <StatusPill ok={status.configured} label={status.configured ? status.portal : t('bx_status_off')} />}
          </div>
          {status?.can_act && <Button kind="primary" onClick={() => setCreate('lead')}><Plus size={15} /> {t('bx_create_title')}</Button>}
        </div>
        <div style={{ marginBottom: 18, overflowX: 'auto' }}><Segmented value={tab} onChange={setTab} options={tabs} /></div>

        {status && !status.configured && tab !== 'settings' ? (
          <Empty icon={<Building2 size={28} />} title={t('bx_not_configured')} hint={status.can_manage ? t('bx_not_configured_admin') : t('bx_not_configured_user')}
            action={status.can_manage ? <Button kind="primary" onClick={() => setTab('settings')}>{t('bx_setup')}</Button> : undefined} />
        ) : status && !status.can_act && tab !== 'settings' ? (
          <Empty icon={<User size={28} />} title={t('bx_no_access')} hint={t('bx_no_access_hint')} />
        ) : tab === 'actions' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {actions.map(a => (
              <button key={a.kind} type="button" onClick={() => setCreate(a.kind)} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left', padding: 16, borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}>
                <span style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: `color-mix(in srgb, ${BRAND} 16%, transparent)`, color: '#0b8fc3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{a.icon}</span>
                <span>
                  <span style={{ display: 'block', fontWeight: 700, color: 'var(--text-primary)', fontSize: 14.5, marginBottom: 3 }}>{t(`bx_action_${a.kind}`)}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{t(`bx_action_${a.kind}_hint`)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : tab === 'search' ? (
          <SearchBox<SearchResult> placeholder={t('bx_search_ph')} run={runSearch} render={r => (
            r.leads.length + r.deals.length + r.contacts.length === 0 ? <Empty icon={<Search size={26} />} title={t('bx_nothing_found')} /> : (
              <>
                {group('leads', 'lead', <User size={16} />, r)}
                {group('deals', 'deal', <Briefcase size={16} />, r)}
                {group('contacts', 'contact', <User size={16} />, r)}
              </>
            )
          )} />
        ) : tab === 'log' ? <EventLog load={loadEvents} empty={t('bx_log_empty')} /> : <SettingsForm />}
      </div>
      {create && <CreateDialog initialKind={create} onClose={() => setCreate(null)} />}
      {commentFor && <CommentDialog target={commentFor} onClose={() => setCommentFor(null)} />}
    </div>
  );
}
