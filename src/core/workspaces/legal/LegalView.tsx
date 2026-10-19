import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  BadgeCheck, Check, Copy, Download, FileSignature, FileText, History, Link2, Lock, Printer, Scale, Search,
  Settings2, ShieldAlert, ShieldCheck, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { navigate, reportError, useCore, useModuleStore, useModuleT } from '@sfera/sdk';
import { api, downloadProtocol, type ChatScope, type Conn, type Protocol, type Settings } from './api';
import { BRAND, VerifyPanel } from './Verify';
import * as legal from './store';
import { StatusPill, UsersField } from './kit';
import { Button, Confirm, Empty, Field, Modal, Segmented, displayName, inputStyle, type UserBrief } from './ui';

export const ROUTE = 'legal';

export function useConn(): Conn {
  const { authToken, currentServerIP } = useCore();
  return useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
}

function useDate() {
  const { language } = useCore();
  return useCallback((iso: string | null) => (iso ? new Date(iso).toLocaleString(language, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'), [language]);
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.3, background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
      <Scale size={size * 0.5} />
    </div>
  );
}

export function ChainBadge({ ok, note }: { ok: boolean | null; note?: string }) {
  const t = useModuleT();
  const color = ok === true ? '#10b981' : ok === false ? '#ef4444' : 'var(--text-tertiary)';
  return (
    <span title={note} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color }}>
      {ok === true ? <ShieldCheck size={14} /> : ok === false ? <ShieldAlert size={14} /> : null}
      {ok === true ? t('lg_chain_ok') : ok === false ? t('lg_chain_broken') : t('lg_chain_none')}
    </span>
  );
}

function CopyLine({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title={label} onClick={() => { void navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(reportError); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', padding: 0, wordBreak: 'break-all', textAlign: 'left' }}>
      {done ? <Check size={13} color="#10b981" /> : <Copy size={13} />} {value}
    </button>
  );
}

export function CreateDialog({ onClose, onCreated, lockScope }: { onClose: () => void; onCreated: (p: Protocol) => void; lockScope?: string }) {
  const t = useModuleT();
  const conn = useConn();
  const [scopes, setScopes] = useState<ChatScope[]>([]);
  const [scope, setScope] = useState(lockScope ?? '');
  const [title, setTitle] = useState('');
  const [range, setRange] = useState<'all' | '30' | 'custom'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.conversations(conn).then(rows => {
      setScopes(rows);
      setScope(s => s || lockScope || rows[0]?.scope || '');
    }).catch(reportError);
  }, [conn, lockScope]);

  const submit = async () => {
    if (!scope || busy) return;
    setBusy(true);
    try {
      const period = range === 'all' ? {}
        : range === '30' ? { period_from: new Date(Date.now() - 30 * 86400_000).toISOString() }
          : { period_from: from ? new Date(from).toISOString() : null, period_to: to ? new Date(to).toISOString() : null };
      onCreated(await api.create(conn, { scope, title: title.trim() || undefined, ...period }));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Logo size={26} /> {t('lg_new')}</span>} onClose={onClose} width={540} footer={
      <>
        <Button onClick={onClose}>{t('lg_cancel')}</Button>
        <Button kind="primary" disabled={!scope || busy} onClick={() => void submit()}>{t('lg_create')}</Button>
      </>
    }>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('lg_new_intro')}</p>
      <Field label={t('lg_conversation')}>
        <select value={scope} disabled={!!lockScope} onChange={e => setScope(e.target.value)} style={inputStyle()}>
          {scopes.map(s => <option key={s.scope} value={s.scope}>{s.title}</option>)}
        </select>
      </Field>
      <Field label={t('lg_title_field')} hint={t('lg_title_hint')}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('lg_title_ph')} style={inputStyle()} />
      </Field>
      <Field label={t('lg_period')}>
        <Segmented value={range} onChange={setRange} options={[
          { id: 'all', label: t('lg_period_all') }, { id: '30', label: t('lg_period_30') }, { id: 'custom', label: t('lg_period_custom') },
        ]} />
        {range === 'custom' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle()} />
            <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} style={inputStyle()} />
          </div>
        )}
      </Field>
    </Modal>
  );
}

function SignDialog({ protocol, onClose, onSigned }: { protocol: Protocol; onClose: () => void; onSigned: (p: Protocol) => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [method, setMethod] = useState<'code' | 'file'>('code');
  const [sent, setSent] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => onSigned(await api.get(conn, protocol.id));
  const sendCode = async () => {
    setBusy(true);
    setError('');
    try {
      setSent((await api.requestCode(conn, protocol.id)).email);
    } catch (e) {
      setError((e as { body?: { error?: string } }).body?.error === 'no_email' ? t('lg_sign_no_email') : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const signCode = async () => {
    setBusy(true);
    setError('');
    try {
      await api.signWithCode(conn, protocol.id, code.trim());
      await refresh();
      onClose();
    } catch (e) {
      const key = (e as { body?: { error?: string } }).body?.error ?? '';
      setError(t(`lg_err_${key}`) || t('lg_sign_failed'));
    } finally {
      setBusy(false);
    }
  };
  const signFile = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      await api.signWithFile(conn, protocol.id, file);
      await refresh();
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><FileSignature size={18} /> {t('lg_sign')}</span>} onClose={onClose} width={520}>
      <div style={{ padding: 10, borderRadius: 10, background: 'var(--bg-tertiary)', fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
        {t('lg_sign_hash')}: <code style={{ wordBreak: 'break-all' }}>{protocol.content_hash}</code>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Segmented value={method} onChange={setMethod} options={[{ id: 'code', label: t('lg_method_code') }, { id: 'file', label: t('lg_method_file') }]} />
      </div>
      {method === 'code' ? (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('lg_sign_code_intro')}</p>
          {!sent ? (
            <Button kind="primary" disabled={busy} onClick={() => void sendCode()}>{t('lg_sign_send_code')}</Button>
          ) : (
            <>
              <Field label={t('lg_sign_code_label').replace('{email}', sent)}>
                <input autoFocus value={code} inputMode="numeric" maxLength={6} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => { if (e.key === 'Enter') void signCode(); }} style={{ ...inputStyle(), letterSpacing: '4px', fontSize: 18, textAlign: 'center' }} />
              </Field>
              <Button kind="primary" disabled={busy || code.length < 6} onClick={() => void signCode()}>{t('lg_sign_confirm')}</Button>
            </>
          )}
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('lg_sign_file_intro')}</p>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: 13.5, color: 'var(--text-primary)' }}>
            <Upload size={15} /> {t('lg_sign_pick_file')}
            <input type="file" accept=".sig,.p7s,.sgn,.bin,application/pkcs7-signature" hidden disabled={busy}
              onChange={e => { const f = e.target.files?.[0]; if (f) void signFile(f); e.target.value = ''; }} />
          </label>
        </>
      )}
      {error && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

function AskSignatureDialog({ protocol, onClose, onDone }: { protocol: Protocol; onClose: () => void; onDone: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const [users, setUsers] = useState<UserBrief[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const search = useCallback((q: string) => api.users(conn, q), [conn]);
  const submit = async () => {
    setBusy(true);
    try {
      for (const u of users) await api.askSignature(conn, protocol.id, { user_id: u.id });
      if (email.includes('@')) await api.askSignature(conn, protocol.id, { email: email.trim() });
      onDone();
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('lg_ask_signature')} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>{t('lg_cancel')}</Button>
        <Button kind="primary" disabled={busy || (!users.length && !email.includes('@'))} onClick={() => void submit()}>{t('lg_ask_send')}</Button>
      </>
    }>
      <UsersField label={t('lg_ask_users')} users={users} onChange={setUsers} search={search} />
      <Field label={t('lg_ask_email')} hint={t('lg_ask_email_hint')}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="partner@company.ru" style={inputStyle()} />
      </Field>
    </Modal>
  );
}

function ProtocolCard({ p, onOpen }: { p: Protocol; onOpen: () => void }) {
  const t = useModuleT();
  const date = useDate();
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      style={{ padding: 14, borderRadius: 14, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 36, height: 36, borderRadius: 11, flexShrink: 0, background: `color-mix(in srgb, ${BRAND} 14%, transparent)`, color: BRAND, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {p.status === 'sealed' ? <Lock size={17} /> : <FileText size={17} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{p.scope_title}</div>
        </div>
        <StatusPill ok={p.status === 'sealed'} label={p.status === 'sealed' ? t('lg_sealed') : t('lg_draft')} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-tertiary)' }}>
        <span>{t('lg_messages')}: {p.message_count}</span>
        {p.status === 'sealed' && <ChainBadge ok={p.chain_ok} note={p.chain_note} />}
        {p.signatures.length > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#10b981' }}><BadgeCheck size={13} /> {p.signatures.length}</span>}
        <span style={{ marginLeft: 'auto' }}>{date(p.sealed_at ?? p.created_at)}</span>
      </div>
    </div>
  );
}

function ProtocolDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useModuleT();
  const conn = useConn();
  const date = useDate();
  const { currentServerIP, currentUser } = useCore();
  const [p, setP] = useState<Protocol | null>(null);
  const [busy, setBusy] = useState(false);
  const [sign, setSign] = useState(false);
  const [ask, setAsk] = useState(false);
  const [remove, setRemove] = useState(false);

  const load = useCallback(() => { api.get(conn, id).then(setP).catch(() => onBack()); }, [conn, id, onBack]);
  useEffect(load, [load]);
  if (!p) return <div style={{ padding: 20, color: 'var(--text-tertiary)' }}>…</div>;

  const mine = p.signatures.some(s => s.user_id === currentUser?.id);
  const verifyUrl = `${currentServerIP.replace(/\/$/, '')}/?verify=${p.code}`;
  const seal = async () => {
    setBusy(true);
    try { setP(await api.seal(conn, p.id)); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 34%) 1fr', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13.5 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <Button kind="plain" onClick={onBack} style={{ marginBottom: 10 }}>← {t('lg_back')}</Button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <Logo />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text-primary)' }}>{p.title}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{p.scope_title}</div>
        </div>
        <StatusPill ok={p.status === 'sealed'} label={p.status === 'sealed' ? t('lg_sealed') : t('lg_draft')} />
      </div>

      {p.status === 'draft' ? (
        <div style={{ padding: 14, borderRadius: 12, background: 'rgba(245,158,11,.1)', color: '#b45309', fontSize: 13.5, lineHeight: 1.5, marginBottom: 14 }}>
          {t('lg_draft_hint')}
        </div>
      ) : null}

      <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, padding: '4px 14px 10px', background: 'var(--bg-secondary)', marginBottom: 14 }}>
        {row(t('lg_messages'), p.message_count)}
        {row(t('lg_participants'), p.participants.map(x => `${x.name} (@${x.username})`).join(', '))}
        {row(t('lg_period'), `${date(p.period_from)} — ${date(p.period_to)}`)}
        {p.status === 'sealed' && row(t('lg_sealed_at'), date(p.sealed_at))}
        {p.status === 'sealed' && row(t('lg_chain'), <ChainBadge ok={p.chain_ok} note={p.chain_note} />)}
        {p.status === 'sealed' && row('SHA-256', <CopyLine value={p.content_hash} label={t('lg_copy')} />)}
        {p.status === 'sealed' && row(t('lg_verify_code'), <CopyLine value={p.code} label={t('lg_copy')} />)}
        {p.status === 'sealed' && row(t('lg_verify_link'), <CopyLine value={verifyUrl} label={t('lg_copy')} />)}
        {p.has_timestamp && row(t('lg_timestamp'), date(p.timestamp_at))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {p.status === 'draft' && p.is_owner && (
          <Button kind="primary" disabled={busy} onClick={() => void seal()}><Lock size={15} /> {t('lg_seal')}</Button>
        )}
        {p.status === 'sealed' && (
          <>
            <Button onClick={() => void downloadProtocol(conn, p.id, 'html', p.code).catch(reportError)}><Printer size={15} /> {t('lg_print')}</Button>
            <Button onClick={() => void downloadProtocol(conn, p.id, 'json', p.code).catch(reportError)}><Download size={15} /> {t('lg_download_json')}</Button>
            {p.has_timestamp && <Button onClick={() => void downloadProtocol(conn, p.id, 'tsr', p.code).catch(reportError)}><Download size={15} /> {t('lg_download_tsr')}</Button>}
            {!mine && <Button kind="primary" onClick={() => setSign(true)}><FileSignature size={15} /> {t('lg_sign')}</Button>}
            {p.is_owner && <Button onClick={() => setAsk(true)}><UserPlus size={15} /> {t('lg_ask_signature')}</Button>}
            <Button onClick={() => void navigator.clipboard.writeText(verifyUrl).catch(reportError)}><Link2 size={15} /> {t('lg_copy_link')}</Button>
          </>
        )}
        {p.is_owner && (p.status === 'draft' || p.signatures.length === 0) && (
          <Button kind="plain" style={{ color: '#ef4444' }} onClick={() => setRemove(true)}><Trash2 size={15} /> {t('lg_delete')}</Button>
        )}
      </div>

      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>
        {t('lg_signatures')} · {p.signatures.length}
      </div>
      {p.signatures.length === 0 && <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)', marginBottom: 10 }}>{t('lg_no_signatures')}</div>}
      {p.signatures.map(s => (
        <div key={s.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
          <BadgeCheck size={18} color={s.matches_protocol ? '#10b981' : '#f59e0b'} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {date(s.signed_at)} · {s.method === 'code' ? t('lg_method_code') : t('lg_method_file')}{s.email ? ` · ${s.email}` : ''}
            </div>
            {s.cert_subject && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>{s.cert_subject}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{s.note}</div>
            {!s.matches_protocol && <div style={{ fontSize: 12, color: '#f59e0b' }}>{t('lg_sig_outdated')}</div>}
          </div>
        </div>
      ))}
      {(p.requests ?? []).filter(r => !r.signed_at).length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
          {t('lg_awaiting')}: {(p.requests ?? []).filter(r => !r.signed_at).map(r => r.user ? displayName(r.user) : r.email).join(', ')}
        </div>
      )}

      {sign && <SignDialog protocol={p} onClose={() => setSign(false)} onSigned={setP} />}
      {ask && <AskSignatureDialog protocol={p} onClose={() => setAsk(false)} onDone={load} />}
      {remove && (
        <Confirm title={t('lg_delete')} message={t('lg_delete_hint')} confirmLabel={t('lg_delete')} cancelLabel={t('lg_cancel')}
          onCancel={() => setRemove(false)}
          onConfirm={async () => { setRemove(false); try { await api.remove(conn, p.id); onBack(); } catch (e) { reportError(e); } }} />
      )}
    </div>
  );
}

export function SettingsForm() {
  const t = useModuleT();
  const conn = useConn();
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.settings(conn).then(setS).catch(reportError); }, [conn]);
  if (!s) return <div style={{ color: 'var(--text-tertiary)' }}>…</div>;
  const save = async () => {
    try {
      setS(await api.saveSettings(conn, s));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void legal.refreshStatus();
    } catch (e) { reportError(e); }
  };
  return (
    <div style={{ maxWidth: 620 }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: 12, border: '1px solid var(--border-color)', marginBottom: 14 }}>
        <input type="checkbox" checked={s.record_chain} onChange={e => setS({ ...s, record_chain: e.target.checked })} style={{ marginTop: 3 }} />
        <span>
          <b style={{ color: 'var(--text-primary)' }}>{t('lg_set_record')}</b>
          <span style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('lg_set_record_hint')}</span>
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('lg_set_links').replace('{n}', String(s.chain_links))}</span>
        </span>
      </label>
      <Field label={t('lg_set_org')} hint={t('lg_set_org_hint')}>
        <input value={s.org_name} onChange={e => setS({ ...s, org_name: e.target.value })} style={inputStyle()} />
      </Field>
      <Field label={t('lg_set_org_details')}>
        <input value={s.org_details} onChange={e => setS({ ...s, org_details: e.target.value })} placeholder="ИНН 7700000000, г. Москва" style={inputStyle()} />
      </Field>
      <Field label={t('lg_set_tsa')} hint={t('lg_set_tsa_hint')}>
        <input value={s.tsa_url} onChange={e => setS({ ...s, tsa_url: e.target.value })} placeholder="https://tsa.example.ru/tsp" style={inputStyle()} />
      </Field>
      <Button kind="primary" onClick={() => void save()}>{saved ? <><Check size={14} /> {t('lg_saved')}</> : t('lg_save')}</Button>
    </div>
  );
}

export function LegalView({ style }: { style?: CSSProperties }) {
  const t = useModuleT();
  const conn = useConn();
  const { currentServer, setCurrentServer } = useCore();
  const status = useModuleStore(legal.store, s => s.status);
  const rest = navigate.parseModuleRoute(currentServer, ROUTE) ?? '';
  const [tab, setTab] = useState<'list' | 'verify' | 'settings'>('list');
  const [items, setItems] = useState<Protocol[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(() => { api.list(conn).then(setItems).catch(e => { setItems([]); reportError(e); }); }, [conn]);
  useEffect(() => { if (!rest) load(); }, [rest, load]);

  const open = (id: string) => setCurrentServer(navigate.moduleRoute(ROUTE, id));
  const shown = (items ?? []).filter(p => !query.trim() || p.title.toLowerCase().includes(query.trim().toLowerCase()) || p.code.includes(query.trim().toUpperCase()));

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)', ...style }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <Logo />
          <div style={{ flex: 1, minWidth: 220 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{t('lg_title')}</h1>
            {status && (
              <StatusPill ok={status.recording} label={status.recording ? t('lg_recording_on') : t('lg_recording_off')} />
            )}
          </div>
          {!rest && <Button kind="primary" onClick={() => setCreating(true)}><FileText size={15} /> {t('lg_new')}</Button>}
        </div>

        {rest ? <ProtocolDetail id={rest} onBack={() => { setCurrentServer(navigate.moduleRoute(ROUTE, '')); load(); }} /> : (
          <>
            <div style={{ marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <Segmented value={tab} onChange={setTab} options={[
                { id: 'list', label: t('lg_tab_list'), icon: <History size={14} /> },
                { id: 'verify', label: t('lg_tab_verify'), icon: <ShieldCheck size={14} /> },
                ...(status?.can_manage ? [{ id: 'settings' as const, label: t('lg_tab_settings'), icon: <Settings2 size={14} /> }] : []),
              ]} />
              {tab === 'list' && (
                <div style={{ position: 'relative', flex: 1, minWidth: 180, maxWidth: 280 }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('lg_search')} style={{ ...inputStyle(), paddingLeft: 30 }} />
                </div>
              )}
            </div>

            {tab === 'list' && (
              items && shown.length === 0 ? (
                <Empty icon={<Scale size={28} />} title={t('lg_empty')} hint={t('lg_empty_hint')}
                  action={<Button kind="primary" onClick={() => setCreating(true)}>{t('lg_new')}</Button>} />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                  {shown.map(p => <ProtocolCard key={p.id} p={p} onOpen={() => open(p.id)} />)}
                </div>
              )
            )}
            {tab === 'verify' && <VerifyPanel />}
            {tab === 'settings' && <SettingsForm />}
          </>
        )}
      </div>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={p => { setCreating(false); open(p.id); }} />}
    </div>
  );
}
