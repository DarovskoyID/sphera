import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, KeyRound, QrCode, ShieldCheck, Smartphone } from 'lucide-react';
import { reportError, useModuleT } from '@sfera/sdk';
import { api, qrDataUrl, type Conn, type Setup as SetupData, type Status } from './api';
import { Button, Field, inputStyle } from './ui';

export const BRAND = '#0ea5e9';

export function CodeField({ value, onChange, onEnter, autoFocus, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  // Six digits from the app, or a backup code like ABCD-EFGH.
  const clean = (raw: string) => (/[A-Za-z]/.test(raw) ? raw.toUpperCase().slice(0, 9) : raw.replace(/\D/g, '').slice(0, 6));
  return (
    <input
      value={value} autoFocus={autoFocus} inputMode="text" autoComplete="one-time-code"
      placeholder={placeholder ?? '000000'}
      onChange={e => onChange(clean(e.target.value))}
      onKeyDown={e => { if (e.key === 'Enter') onEnter?.(); }}
      style={{ ...inputStyle(), letterSpacing: '5px', fontSize: 19, textAlign: 'center', fontFamily: 'ui-monospace, Consolas, monospace' }}
    />
  );
}

export function BackupCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const t = useModuleT();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const save = () => {
    const url = URL.createObjectURL(new Blob([`${t('tf_backup_file_head')}\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sfera-backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div>
      <div style={{ padding: 12, borderRadius: 12, background: 'rgba(245,158,11,.12)', color: '#b45309', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
        {t('tf_backup_warning')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
        {codes.map(code => (
          <code key={code} style={{ padding: '7px 9px', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 14, textAlign: 'center', letterSpacing: '1px' }}>
            {code}
          </code>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(reportError); }}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {t('tf_copy')}
        </Button>
        <Button onClick={save}><Download size={15} /> {t('tf_save_file')}</Button>
        {onDone && <Button kind="primary" onClick={onDone}>{t('tf_backup_saved')}</Button>}
      </div>
    </div>
  );
}

/**
 * Connecting an authenticator: QR, then the first code.
 *
 * Used both on the settings page and on the blocking screen, which is why it
 * takes the connection rather than reading it from the app context.
 */
export function SetupFlow({ conn, onEnabled }: { conn: Conn; onEnabled: (status: Status) => void }) {
  const t = useModuleT();
  const [data, setData] = useState<SetupData | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);

  const start = useCallback(async () => {
    setError('');
    try {
      const fresh = await api.setup(conn);
      setData(fresh);
      setQr(await qrDataUrl(fresh.uri).catch(() => ''));
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [conn]);

  useEffect(() => { void start(); }, [start]);

  const confirm = async () => {
    if (busy || code.length < 6) return;
    setBusy(true);
    setError('');
    try {
      const done = await api.confirm(conn, code);
      setCodes(done.backup_codes);
      setStatus(done);
    } catch (e) {
      const key = (e as { body?: { error?: string } }).body?.error ?? '';
      setError(t(`tf_err_${key}`) || t('tf_err_generic'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#10b981', fontWeight: 700, marginBottom: 10 }}>
          <ShieldCheck size={18} /> {t('tf_enabled_now')}
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('tf_backup_intro')}</p>
        <BackupCodes codes={codes} onDone={() => status && onEnabled(status)} />
      </div>
    );
  }

  return (
    <div>
      <ol style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <li>{t('tf_step_app')}</li>
        <li>{t('tf_step_scan')}</li>
        <li>{t('tf_step_code')}</li>
      </ol>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ width: 232, height: 232, borderRadius: 14, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {qr ? <img src={qr} alt={t('tf_qr_alt')} width={232} height={232} style={{ borderRadius: 14 }} />
            : <QrCode size={40} color="#999" />}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Field label={t('tf_code_label')}>
            <CodeField value={code} onChange={setCode} onEnter={() => void confirm()} autoFocus />
          </Field>
          {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <Button kind="primary" disabled={busy || code.length < 6} onClick={() => void confirm()}>
            <ShieldCheck size={15} /> {t('tf_confirm')}
          </Button>
          <div style={{ marginTop: 14 }}>
            <button type="button" onClick={() => setManual(v => !v)}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12.5, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Smartphone size={13} /> {t('tf_cannot_scan')}
            </button>
            {manual && data && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {t('tf_manual_hint')}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <KeyRound size={14} color="var(--text-tertiary)" />
                  <code style={{ wordBreak: 'break-all', fontSize: 13, color: 'var(--text-primary)' }}>{data.secret}</code>
                </div>
                <div style={{ marginTop: 4 }}>{t('tf_manual_params').replace('{digits}', String(data.digits)).replace('{period}', String(data.period))}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
