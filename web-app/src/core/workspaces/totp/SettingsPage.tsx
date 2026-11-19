import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, Search, ShieldCheck, ShieldOff, ShieldX, Users } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api, type Person, type ServerSettings, type Status } from './api';
import { BackupCodes, BRAND, CodeField, SetupFlow } from './Setup';
import { Avatar, Button, Confirm, Field, Modal, displayName, inputStyle } from './ui';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{title}</h3>
      {children}
    </section>
  );
}

function AdminPanel() {
  const t = useModuleT();
  const { authToken, currentServerIP, currentUser } = useCore();
  const conn = useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
  const [row, setRow] = useState<ServerSettings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [resetting, setResetting] = useState<Person | null>(null);

  const loadPeople = useCallback((q = '') => { api.people(conn, q).then(setPeople).catch(reportError); }, [conn]);
  useEffect(() => { api.settings(conn).then(setRow).catch(reportError); loadPeople(); }, [conn, loadPeople]);
  if (!row) return null;

  const save = (body: Partial<ServerSettings>) => api.saveSettings(conn, body).then(setRow).catch(reportError);
  const without = row.users_total - row.users_with_totp;
  const mineOff = !people.find(p => p.id === currentUser?.id)?.totp;

  return (
    <>
      <Section title={t('tf_admin_title')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ flex: 1, minWidth: 150, padding: 12, borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{row.users_with_totp} / {row.users_total}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{t('tf_admin_connected')}</div>
          </div>
          <div style={{ flex: 1, minWidth: 150, padding: 12, borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: without && row.required_for_all ? '#f59e0b' : 'var(--text-primary)' }}>{without}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{row.required_for_all ? t('tf_admin_blocked') : t('tf_admin_without')}</div>
          </div>
        </div>

        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: 12, border: '1px solid var(--border-color)' }}>
          <input type="checkbox" checked={row.required_for_all} style={{ marginTop: 3 }}
            onChange={e => (e.target.checked ? setConfirmAll(true) : void save({ required_for_all: false }))} />
          <span>
            <b style={{ color: 'var(--text-primary)' }}>{t('tf_admin_require')}</b>
            <span style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('tf_admin_require_hint')}</span>
          </span>
        </label>

        {row.required_for_all && mineOff && (
          <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: 'rgba(245,158,11,.12)', color: '#b45309', fontSize: 13, lineHeight: 1.5 }}>
            {t('tf_admin_self_warning')}
          </div>
        )}

        <Field label={t('tf_admin_issuer')} hint={t('tf_admin_issuer_hint')}>
          <input defaultValue={row.issuer} onBlur={e => { const v = e.target.value.trim(); if (v && v !== row.issuer) void save({ issuer: v }); }}
            style={{ ...inputStyle(), marginTop: 10 }} />
        </Field>
      </Section>

      <Section title={t('tf_admin_people')}>
        <div style={{ position: 'relative', maxWidth: 300, marginBottom: 10 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
          <input value={query} placeholder={t('tf_admin_search')}
            onChange={e => { setQuery(e.target.value); loadPeople(e.target.value); }}
            style={{ ...inputStyle(), paddingLeft: 30 }} />
        </div>
        {people.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-color)' }}>
            <Avatar user={p} size={28} serverIP={currentServerIP} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName(p)} {p.is_superuser && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>· {t('tf_admin_root')}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>@{p.username}</div>
            </div>
            <span title={p.totp ? t('tf_admin_has') : t('tf_admin_has_not')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: p.totp ? '#10b981' : 'var(--text-tertiary)' }}>
              {p.totp ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
            </span>
            {p.totp && (
              <Button small onClick={() => setResetting(p)}><RefreshCw size={13} /> {t('tf_admin_reset')}</Button>
            )}
          </div>
        ))}
        {people.length === 0 && <div style={{ fontSize: 13.5, color: 'var(--text-tertiary)' }}>{t('tf_admin_nobody')}</div>}
      </Section>

      {confirmAll && (
        <Confirm title={t('tf_admin_require')} message={t('tf_admin_require_confirm').replace('{n}', String(without))}
          confirmLabel={t('tf_admin_require_go')} cancelLabel={t('tf_cancel')}
          onCancel={() => setConfirmAll(false)}
          onConfirm={async () => { setConfirmAll(false); await save({ required_for_all: true }); }} />
      )}
      {resetting && (
        <Confirm title={t('tf_admin_reset')} message={t('tf_admin_reset_confirm').replace('{name}', displayName(resetting))}
          confirmLabel={t('tf_admin_reset')} cancelLabel={t('tf_cancel')}
          onCancel={() => setResetting(null)}
          onConfirm={async () => {
            const target = resetting;
            setResetting(null);
            try {
              await api.resetPerson(conn, target.id);
              loadPeople(query);
              api.settings(conn).then(setRow).catch(reportError);
            } catch (e) { reportError(e); }
          }} />
      )}
    </>
  );
}

export function SettingsPage() {
  const t = useModuleT();
  const { authToken, currentServerIP } = useCore();
  const conn = useMemo(() => ({ token: authToken, serverIP: currentServerIP }), [authToken, currentServerIP]);
  const [status, setStatus] = useState<Status | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [codeFor, setCodeFor] = useState<'' | 'disable' | 'codes'>('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<string[] | null>(null);

  const load = useCallback(() => { api.status(conn).then(setStatus).catch(reportError); }, [conn]);
  useEffect(load, [load]);
  if (!status) return <div style={{ color: 'var(--text-tertiary)' }}>…</div>;

  const submitCode = async () => {
    setError('');
    try {
      if (codeFor === 'disable') {
        setStatus(await api.disable(conn, code));
      } else {
        setFresh((await api.newBackupCodes(conn, code)).backup_codes);
        load();
      }
      setCodeFor('');
      setCode('');
    } catch (e) {
      const key = (e as { body?: { error?: string } }).body?.error ?? '';
      setError(t(`tf_err_${key}`) || t('tf_err_generic'));
    }
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <Section title={t('tf_my_title')}>
        {status.enabled ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border-color)', marginBottom: 12 }}>
              <ShieldCheck size={20} color="#10b981" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{t('tf_my_on')}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  {t('tf_my_backup_left').replace('{n}', String(status.backup_codes_left))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => { setCodeFor('codes'); setCode(''); setFresh(null); }}><KeyRound size={15} /> {t('tf_new_backup')}</Button>
              <Button style={{ color: '#ef4444' }} onClick={() => { setCodeFor('disable'); setCode(''); }}>
                <ShieldX size={15} /> {t('tf_disable')}
              </Button>
            </div>
            {status.required_for_all && (
              <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('tf_disable_blocked_hint')}</p>
            )}
            {fresh && <div style={{ marginTop: 14 }}><BackupCodes codes={fresh} /></div>}
          </>
        ) : connecting ? (
          <SetupFlow conn={conn} onEnabled={() => { setConnecting(false); load(); }} />
        ) : (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('tf_my_off_hint')}</p>
            <Button kind="primary" onClick={() => setConnecting(true)}><ShieldCheck size={15} /> {t('tf_connect')}</Button>
          </>
        )}
      </Section>

      {status.can_manage && <AdminPanel />}

      {codeFor && (
        <Modal title={codeFor === 'disable' ? t('tf_disable') : t('tf_new_backup')} onClose={() => { setCodeFor(''); setError(''); }} width={420}
          footer={<>
            <Button onClick={() => { setCodeFor(''); setError(''); }}>{t('tf_cancel')}</Button>
            <Button kind="primary" disabled={code.length < 6} onClick={() => void submitCode()}>{t('tf_confirm')}</Button>
          </>}>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {codeFor === 'disable' ? t('tf_disable_hint') : t('tf_new_backup_hint')}
          </p>
          <CodeField value={code} onChange={setCode} onEnter={() => void submitCode()} autoFocus />
          {error && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{error}</div>}
        </Modal>
      )}
    </div>
  );
}

export { BRAND, Users };
