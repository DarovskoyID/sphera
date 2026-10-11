import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, FileCheck2, FileWarning, Scale, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { api, fileHash, type PublicInfo } from './api';
import { Button, Empty, Field, inputStyle } from './ui';

export const BRAND = '#7c3aed';

function fmt(iso: string | null, language: string) {
  return iso ? new Date(iso).toLocaleString(language, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

/** Public check of a protocol: anyone with the code sees hashes and signatures, never the messages. */
export function VerifyPanel({ initialCode, compact }: { initialCode?: string; compact?: boolean }) {
  const t = useModuleT();
  const { currentServerIP, language } = useCore();
  const [code, setCode] = useState(initialCode ?? '');
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileState, setFileState] = useState<{ name: string; hash: string; ok: boolean } | null>(null);

  const check = useCallback(async (value: string, hash?: string) => {
    const clean = value.trim().toUpperCase();
    if (clean.length < 6) return;
    setBusy(true);
    setError('');
    try {
      setInfo(await api.verify(currentServerIP, clean, hash));
    } catch (e) {
      setInfo(null);
      setError((e as { status?: number }).status === 404 ? t('lg_verify_not_found') : t('lg_verify_failed'));
    } finally {
      setBusy(false);
    }
  }, [currentServerIP, t]);

  useEffect(() => { if (initialCode) void check(initialCode); }, [initialCode, check]);

  const onFile = async (file: File) => {
    try {
      const hash = await fileHash(file);
      const fresh = await api.verify(currentServerIP, (info?.code ?? code).trim().toUpperCase(), hash);
      setInfo(fresh);
      setFileState({ name: file.name, hash, ok: fresh.hash_matches === true });
    } catch (e) {
      reportError(e);
    }
  };

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 38%) 1fr', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13.5 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ maxWidth: 640 }}>
      {!compact && (
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('lg_verify_intro')}</p>
      )}
      <Field label={t('lg_verify_code')} hint={t('lg_verify_code_hint')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') void check(code); }}
            placeholder="ABCD-EFGH-JKLM" style={{ ...inputStyle(), fontFamily: 'ui-monospace, Consolas, monospace', letterSpacing: '1px' }} />
          <Button kind="primary" disabled={busy || code.trim().length < 6} onClick={() => void check(code)}>{t('lg_verify_check')}</Button>
        </div>
      </Field>
      {error && <div style={{ color: '#ef4444', fontSize: 13.5, marginBottom: 12 }}>{error}</div>}
      {info && (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 14, padding: 16, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, background: `color-mix(in srgb, ${BRAND} 16%, transparent)`, color: BRAND, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Scale size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--text-primary)' }}>{info.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('lg_verify_sealed').replace('{date}', fmt(info.sealed_at, language))}</div>
            </div>
          </div>
          {row(t('lg_messages'), info.message_count)}
          {row(t('lg_participants'), info.participants.map(p => `${p.name} (@${p.username})`).join(', ') || '—')}
          {row(t('lg_period'), `${fmt(info.period_from, language)} — ${fmt(info.period_to, language)}`)}
          {row(t('lg_chain'), (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: info.chain_ok === true ? '#10b981' : info.chain_ok === false ? '#ef4444' : 'var(--text-secondary)' }}>
              {info.chain_ok === true ? <ShieldCheck size={15} /> : info.chain_ok === false ? <ShieldAlert size={15} /> : null}
              {info.chain_ok === true ? t('lg_chain_ok') : info.chain_ok === false ? t('lg_chain_broken') : t('lg_chain_none')}
              <span style={{ color: 'var(--text-tertiary)' }}>{info.chain_note}</span>
            </span>
          ))}
          {info.has_timestamp && row(t('lg_timestamp'), fmt(info.timestamp_at, language))}
          {row('SHA-256', <code style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{info.content_hash}</code>)}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
              {t('lg_signatures')} · {info.signatures.length}
            </div>
            {info.signatures.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('lg_no_signatures')}</div>}
            {info.signatures.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0' }}>
                <BadgeCheck size={16} color={s.matches_protocol ? '#10b981' : '#f59e0b'} style={{ marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {fmt(s.signed_at, language)} · {s.method === 'code' ? t('lg_method_code') : t('lg_method_file')}
                    {!s.matches_protocol && ` · ${t('lg_sig_outdated')}`}
                  </div>
                  {s.cert_subject && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>{s.cert_subject}</div>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('lg_verify_file_intro')}</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: 13.5, color: 'var(--text-primary)' }}>
              <Upload size={15} /> {t('lg_verify_pick_file')}
              <input type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
            </label>
            {fileState && (
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 8, color: fileState.ok ? '#10b981' : '#ef4444', fontSize: 13.5 }}>
                {fileState.ok ? <FileCheck2 size={16} /> : <FileWarning size={16} />}
                <div>
                  <div>{fileState.ok ? t('lg_file_match') : t('lg_file_mismatch')}</div>
                  <code style={{ fontSize: 11, color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>{fileState.name}: {fileState.hash}</code>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {!info && !error && !busy && !compact && <Empty icon={<Scale size={26} />} title={t('lg_verify_empty')} hint={t('lg_verify_empty_hint')} />}
    </div>
  );
}

/** Stand-alone page for a judge or a counterparty: opens from a ?verify=<code> link without signing in. */
export function VerifyScreen() {
  const t = useModuleT();
  const code = (new URLSearchParams(window.location.search).get('verify') ?? '').toUpperCase();
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', overflow: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 680, margin: '24px auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 18, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{ width: 46, height: 46, borderRadius: 14, background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Scale size={23} />
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' }}>{t('lg_verify_title')}</h1>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('lg_verify_subtitle')}</div>
          </div>
        </div>
        <VerifyPanel initialCode={code} />
        <div style={{ marginTop: 18, textAlign: 'center' }}>
          <Button kind="plain" onClick={() => { window.dispatchEvent(new CustomEvent('sfera:legal-signin')); }}>{t('lg_to_app')}</Button>
        </div>
      </div>
    </div>
  );
}
