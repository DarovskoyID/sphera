import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Briefcase, Check, ExternalLink, History, KeyRound, Plus, Search, Settings2, StickyNote, User, Webhook } from 'lucide-react';
import { reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, type Conn, type LeadBody, type Pipeline, type SearchResult, type Settings } from './api';
import * as amo from './store';
import { CopyField, EventLog, ResultGroup, ResultRow, SearchBox, StatusPill, Steps, UsersField } from './kit';
import { Button, Empty, Field, Modal, Segmented, inputStyle } from './ui';

export const ROUTE = 'amocrm';
export const BRAND = '#339dc7';

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, background: 'linear-gradient(135deg,#339dc7,#1b5f8c)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: size * 0.34, letterSpacing: '-0.5px', flexShrink: 0 }}>
      amo
    </div>
  );
}

/** New lead in amoCRM, optionally with a contact, a note and a task. */
export function LeadDialog({ onClose, initial }: { onClose: () => void; initial?: Partial<LeadBody> }) {
  const t = useModuleT();
  const conn = useConn();
  const [form, setForm] = useState<LeadBody>({ name: '', price: '', contact_name: '', phone: '', email: '', note: '', ...initial });
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [withTask, setWithTask] = useState(false);
  const [taskText, setTaskText] = useState(t('am_task_default'));
  const [taskDue, setTaskDue] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setHours(12, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string } | null>(null);
  const set = (k: keyof LeadBody, v: string) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => { api.pipelines(conn).then(setPipelines).catch(() => {}); }, [conn]);

  const submit = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    try {
      const body: LeadBody = { ...form, name: form.name.trim() };
      if (withTask && taskText.trim()) { body.task_text = taskText.trim(); body.task_due = Math.floor(new Date(taskDue).getTime() / 1000); }
      const r = await api.createLead(conn, body);
      setDone({ url: r.url });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title={t('am_new_lead')} onClose={onClose} width={420}>
        <div style={{ textAlign: 'center', padding: '10px 0 6px' }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(16,185,129,.14)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}><Check size={26} /></div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>{t('am_lead_created')}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <a href={done.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}><Button kind="primary"><ExternalLink size={14} /> {t('am_open_in_amo')}</Button></a>
            <Button onClick={onClose}>{t('am_close')}</Button>
          </div>
        </div>
      </Modal>
    );
  }

  const row: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0 12px' };
  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Logo size={26} /> {t('am_new_lead')}</span>} onClose={onClose} width={560} footer={
      <>
        <Button onClick={onClose}>{t('am_cancel')}</Button>
        <Button kind="primary" disabled={!form.name.trim() || busy} onClick={() => void submit()}>{busy ? '…' : t('am_create')}</Button>
      </>
    }>
      <div style={row}>
        <Field label={t('am_lead_name')}>
          <input autoFocus value={form.name} onChange={e => set('name', e.target.value)} placeholder={t('am_lead_name_ph')} style={inputStyle()} />
        </Field>
        <Field label={t('am_price')}>
          <input inputMode="decimal" value={form.price} onChange={e => set('price', e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0" style={inputStyle()} />
        </Field>
      </div>
      {pipelines.length > 1 && (
        <Field label={t('am_pipeline')}>
          <select value={form.pipeline_id ?? ''} onChange={e => setForm(f => ({ ...f, pipeline_id: e.target.value ? Number(e.target.value) : null }))} style={inputStyle()}>
            <option value="">{t('am_default_pipeline')}</option>
            {pipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', margin: '4px 0 8px' }}>{t('am_contact')}</div>
      <div style={row}>
        <Field label={t('am_contact_name')}><input value={form.contact_name} onChange={e => set('contact_name', e.target.value)} style={inputStyle()} autoComplete="off" /></Field>
        <Field label={t('am_phone')}><input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+7…" style={inputStyle()} autoComplete="off" /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={e => set('email', e.target.value)} style={inputStyle()} autoComplete="off" /></Field>
      </div>
      <Field label={t('am_note')}>
        <textarea value={form.note} onChange={e => set('note', e.target.value)} rows={3} placeholder={t('am_note_ph')} style={{ ...inputStyle(), resize: 'vertical' }} />
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: withTask ? 8 : 0 }}>
        <input type="checkbox" checked={withTask} onChange={e => setWithTask(e.target.checked)} /> {t('am_with_task')}
      </label>
      {withTask && (
        <div style={row}>
          <Field label={t('am_task')}><input value={taskText} onChange={e => setTaskText(e.target.value)} style={inputStyle()} /></Field>
          <Field label={t('am_task_due')}><input type="datetime-local" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={inputStyle()} /></Field>
        </div>
      )}
    </Modal>
  );
}

export function SettingsForm() {
  const t = useModuleT();
  const conn = useConn();
  const [s, setS] = useState<Settings | null>(null);
  const [mode, setMode] = useState<'token' | 'oauth'>('token');
  const [code, setCode] = useState('');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const search = useCallback((q: string) => api.users(conn, q), [conn]);

  useEffect(() => {
    api.settings(conn).then(r => { setS(r); setMode(r.oauth ? 'oauth' : 'token'); }).catch(reportError);
  }, [conn]);
  useEffect(() => { if (s?.configured) api.pipelines(conn).then(setPipelines).catch(() => {}); }, [conn, s?.configured]);

  if (!s) return <div style={{ color: 'var(--text-tertiary)' }}>…</div>;
  const webhookUrl = `${conn.serverIP.replace(/\/$/, '')}${s.webhook_path}`;

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        domain: s.domain, pipeline_id: s.pipeline_id,
        notify_user_ids: s.notify_users.map(u => u.id), allowed_user_ids: s.allowed_users.map(u => u.id), ...extra,
      };
      if (mode === 'token') body.access_token = s.access_token;
      else Object.assign(body, { client_id: s.client_id, client_secret: s.client_secret, redirect_uri: s.redirect_uri, ...(code ? { auth_code: code } : {}) });
      const r = await api.saveSettings(conn, body);
      setS(r);
      setCode('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void amo.refreshStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const section = (icon: React.ReactNode, title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '20px 0 10px' }}>{icon} {title}</div>
  );

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <StatusPill ok={s.configured && !s.last_error} label={s.configured ? (s.last_error ? t('am_status_error') : t('am_status_ok').replace('{name}', s.account_name || s.domain)) : t('am_status_off')} />
      </div>
      {s.last_error && <div style={{ fontSize: 12.5, color: '#ef4444', marginBottom: 8, wordBreak: 'break-word' }}>{s.last_error}</div>}

      {section(<KeyRound size={17} />, t('am_connection'))}
      <Field label={t('am_domain')} hint={t('am_domain_hint')}>
        <input value={s.domain} onChange={e => setS({ ...s, domain: e.target.value })} placeholder="company.amocrm.ru" style={inputStyle()} />
      </Field>
      <div style={{ marginBottom: 12 }}>
        <Segmented value={mode} onChange={setMode} options={[{ id: 'token', label: t('am_mode_token') }, { id: 'oauth', label: t('am_mode_oauth') }]} />
      </div>
      {mode === 'token' ? (
        <>
          <Steps items={[t('am_token_step1'), t('am_token_step2'), t('am_token_step3')]} />
          <Field label={t('am_long_token')}>
            <textarea value={s.access_token} onChange={e => setS({ ...s, access_token: e.target.value })} rows={3} style={{ ...inputStyle(), fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} />
          </Field>
        </>
      ) : (
        <>
          <Steps items={[t('am_oauth_step1'), t('am_oauth_step2'), t('am_oauth_step3')]} />
          <Field label={t('am_client_id')}><input value={s.client_id} onChange={e => setS({ ...s, client_id: e.target.value })} style={inputStyle()} /></Field>
          <Field label={t('am_client_secret')}><input type="password" value={s.client_secret} onChange={e => setS({ ...s, client_secret: e.target.value })} style={inputStyle()} autoComplete="new-password" /></Field>
          <Field label="Redirect URI"><input value={s.redirect_uri} onChange={e => setS({ ...s, redirect_uri: e.target.value })} placeholder="https://…" style={inputStyle()} /></Field>
          <Field label={t('am_auth_code')} hint={t('am_auth_code_hint')}><input value={code} onChange={e => setCode(e.target.value)} style={inputStyle()} /></Field>
        </>
      )}
      {pipelines.length > 0 && (
        <Field label={t('am_default_pipeline_label')}>
          <select value={s.pipeline_id ?? ''} onChange={e => setS({ ...s, pipeline_id: e.target.value ? Number(e.target.value) : null })} style={inputStyle()}>
            <option value="">{t('am_account_default')}</option>
            {pipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}

      {section(<Webhook size={17} />, t('am_webhooks'))}
      <Steps items={[t('am_webhook_step1'), t('am_webhook_step2')]} />
      <CopyField label={t('am_webhook_url')} value={webhookUrl} hint={t('am_webhook_hint')} />
      <Button small kind="plain" onClick={() => void save({ regenerate_webhook: true })}>{t('am_webhook_regenerate')}</Button>
      <UsersField label={t('am_notify_users')} hint={t('am_notify_users_hint')} users={s.notify_users} onChange={u => setS({ ...s, notify_users: u })} search={search} />

      {section(<User size={17} />, t('am_access'))}
      <UsersField label={t('am_allowed_users')} hint={t('am_allowed_users_hint')} users={s.allowed_users} onChange={u => setS({ ...s, allowed_users: u })} search={search} />

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button kind="primary" disabled={busy} onClick={() => void save()}>{saved ? <><Check size={14} /> {t('am_saved')}</> : busy ? '…' : t('am_save_check')}</Button>
      </div>
    </div>
  );
}

function SearchTab({ onNote }: { onNote: (leadId: number) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const run = useCallback((q: string) => api.search(conn, q), [conn]);
  return (
    <SearchBox<SearchResult> placeholder={t('am_search_ph')} run={run} render={r => (
      r.leads.length + r.contacts.length === 0 ? <Empty icon={<Search size={26} />} title={t('am_nothing_found')} /> : (
        <>
          {r.leads.length > 0 && (
            <ResultGroup title={t('am_leads')} count={r.leads.length}>
              {r.leads.map(l => (
                <ResultRow key={l.id} icon={<Briefcase size={16} />} title={l.name} subtitle={l.price ? `${l.price.toLocaleString()} ₽` : `#${l.id}`} url={l.url}
                  action={<Button small kind="plain" onClick={() => onNote(l.id)}><StickyNote size={14} /> {t('am_add_note')}</Button>} />
              ))}
            </ResultGroup>
          )}
          {r.contacts.length > 0 && (
            <ResultGroup title={t('am_contacts')} count={r.contacts.length}>
              {r.contacts.map(c => <ResultRow key={c.id} icon={<User size={16} />} title={c.name} subtitle={[...c.phones, ...c.emails].join(' · ')} url={c.url} />)}
            </ResultGroup>
          )}
        </>
      )
    )} />
  );
}

function NoteDialog({ leadId, onClose }: { leadId: number; onClose: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('am_add_note')} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('am_cancel')}</Button>
        <Button kind="primary" disabled={!text.trim() || busy} onClick={async () => {
          setBusy(true);
          try { await api.addNote(conn, leadId, text.trim()); onClose(); } catch (e) { reportError(e); } finally { setBusy(false); }
        }}>{t('am_add')}</Button>
      </>
    }>
      <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={5} style={{ ...inputStyle(), resize: 'vertical' }} placeholder={t('am_note_ph')} />
    </Modal>
  );
}

export function AmoView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const conn = useConn();
  const status = useModuleStore(amo.store, s => s.status);
  const [tab, setTab] = useState<'actions' | 'search' | 'log' | 'settings'>('actions');
  const [lead, setLead] = useState(false);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const loadEvents = useCallback((d?: 'in' | 'out') => api.events(conn, d), [conn]);

  useEffect(() => { if (status && !status.configured && status.can_manage) setTab('settings'); }, [status]);

  const tabs = [
    { id: 'actions' as const, label: t('am_tab_actions'), icon: <Plus size={14} /> },
    { id: 'search' as const, label: t('am_tab_search'), icon: <Search size={14} /> },
    { id: 'log' as const, label: t('am_tab_log'), icon: <History size={14} /> },
    ...(status?.can_manage ? [{ id: 'settings' as const, label: t('am_tab_settings'), icon: <Settings2 size={14} /> }] : []),
  ];

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)', ...style }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Logo />
          <div style={{ flex: 1, minWidth: 200 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>amoCRM</h1>
            {status && <StatusPill ok={status.configured} label={status.configured ? (status.account_name || status.domain) : t('am_status_off')} />}
          </div>
          {status?.can_act && <Button kind="primary" onClick={() => setLead(true)}><Plus size={15} /> {t('am_new_lead')}</Button>}
        </div>
        <div style={{ marginBottom: 18, overflowX: 'auto' }}><Segmented value={tab} onChange={setTab} options={tabs} /></div>

        {status && !status.configured && tab !== 'settings' ? (
          <Empty icon={<KeyRound size={28} />} title={t('am_not_configured')} hint={status.can_manage ? t('am_not_configured_admin') : t('am_not_configured_user')}
            action={status.can_manage ? <Button kind="primary" onClick={() => setTab('settings')}>{t('am_setup')}</Button> : undefined} />
        ) : status && !status.can_act && tab !== 'settings' ? (
          <Empty icon={<User size={28} />} title={t('am_no_access')} hint={t('am_no_access_hint')} />
        ) : tab === 'actions' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {[
              { icon: <Briefcase size={20} />, title: t('am_action_lead'), hint: t('am_action_lead_hint'), onClick: () => setLead(true) },
              { icon: <Search size={20} />, title: t('am_action_search'), hint: t('am_action_search_hint'), onClick: () => setTab('search') },
              { icon: <History size={20} />, title: t('am_action_log'), hint: t('am_action_log_hint'), onClick: () => setTab('log') },
            ].map(a => (
              <button key={a.title} type="button" onClick={a.onClick} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left', padding: 16, borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}>
                <span style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: `color-mix(in srgb, ${BRAND} 16%, transparent)`, color: BRAND, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{a.icon}</span>
                <span>
                  <span style={{ display: 'block', fontWeight: 700, color: 'var(--text-primary)', fontSize: 14.5, marginBottom: 3 }}>{a.title}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{a.hint}</span>
                </span>
              </button>
            ))}
          </div>
        ) : tab === 'search' ? <SearchTab onNote={setNoteFor} />
          : tab === 'log' ? <EventLog load={loadEvents} empty={t('am_log_empty')} />
            : <SettingsForm />}
      </div>
      {lead && <LeadDialog onClose={() => setLead(false)} />}
      {noteFor !== null && <NoteDialog leadId={noteFor} onClose={() => setNoteFor(null)} />}
    </div>
  );
}
