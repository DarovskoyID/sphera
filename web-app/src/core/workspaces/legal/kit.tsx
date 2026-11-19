import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, CheckCircle2, Copy, ExternalLink, RefreshCw, Search, X, XCircle } from 'lucide-react';
import { reportError, useCore, useModuleT } from '@sfera/sdk';
import { Avatar, Button, Empty, Field, IconButton, Segmented, UserPicker, displayName, inputStyle, type UserBrief } from './ui';

/** Building blocks shared by the integration screens (log, user lists, instructions). */

export interface LogEvent {
  id: number;
  direction: 'in' | 'out';
  kind: string;
  summary: string;
  ok: boolean;
  entity_id: string;
  user: UserBrief | null;
  created_at: string;
}

export function EventLog({ load, empty }: { load: (direction?: 'in' | 'out') => Promise<LogEvent[]>; empty: string }) {
  const t = useModuleT();
  const { language, currentServerIP } = useCore();
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const [items, setItems] = useState<LogEvent[] | null>(null);
  const refresh = useCallback(() => {
    load(filter === 'all' ? undefined : filter).then(setItems).catch(e => { setItems([]); reportError(e); });
  }, [load, filter]);
  useEffect(() => { refresh(); }, [refresh]);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Segmented value={filter} onChange={setFilter} options={[
          { id: 'all', label: t('ik_all') },
          { id: 'out', label: t('ik_outgoing'), icon: <ArrowUpRight size={13} /> },
          { id: 'in', label: t('ik_incoming'), icon: <ArrowDownLeft size={13} /> },
        ]} />
        <IconButton title={t('ik_refresh')} onClick={refresh}><RefreshCw size={15} /></IconButton>
      </div>
      {items && items.length === 0 ? <Empty icon={<RefreshCw size={26} />} title={empty} /> : (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>
          {(items ?? []).map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
              <span title={e.direction === 'in' ? t('ik_incoming') : t('ik_outgoing')} style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: e.direction === 'in' ? 'rgba(16,185,129,.12)' : 'rgba(var(--accent-rgb), .12)', color: e.direction === 'in' ? '#10b981' : 'var(--accent-primary)',
              }}>
                {e.direction === 'in' ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.summary}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {new Date(e.created_at).toLocaleString(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {e.user && <><span>·</span><Avatar user={e.user} size={14} serverIP={currentServerIP} /> {displayName(e.user)}</>}
                </div>
              </div>
              {e.ok ? <CheckCircle2 size={16} color="#10b981" /> : <XCircle size={16} color="#ef4444" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UsersField({ label, hint, users, onChange, search }: {
  label: string; hint?: string; users: UserBrief[]; onChange: (u: UserBrief[]) => void; search: (q: string) => Promise<UserBrief[]>;
}) {
  const t = useModuleT();
  const { currentServerIP } = useCore();
  return (
    <Field label={label} hint={hint}>
      <UserPicker search={search} serverIP={currentServerIP} exclude={users.map(u => u.id)} placeholder={t('ik_find_user')} onPick={u => onChange([...users, u])} />
      {users.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {users.map(u => (
            <span key={u.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 3px', borderRadius: 999, background: 'var(--bg-tertiary)', fontSize: 13, color: 'var(--text-primary)' }}>
              <Avatar user={u} size={20} serverIP={currentServerIP} /> {displayName(u)}
              <X size={12} style={{ cursor: 'pointer' }} onClick={() => onChange(users.filter(x => x.id !== u.id))} />
            </span>
          ))}
        </div>
      )}
    </Field>
  );
}

export function CopyField({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input readOnly value={value} onFocus={e => e.currentTarget.select()} style={{ ...inputStyle(), fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }} />
        <Button onClick={() => { void navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(reportError); }}>
          {done ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
    </Field>
  );
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol style={{ margin: '0 0 14px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, background: 'rgba(var(--accent-rgb), .14)', color: 'var(--accent-primary)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
      color: ok ? '#10b981' : '#f59e0b', background: ok ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.12)',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }} /> {label}
    </span>
  );
}

export function SearchBox<T>({ placeholder, run, render }: { placeholder: string; run: (q: string) => Promise<T>; render: (r: T) => ReactNode }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setResult(null); return; }
    let dead = false;
    const timer = setTimeout(() => {
      setBusy(true);
      run(q.trim()).then(r => { if (!dead) setResult(r); }).catch(reportError).finally(() => { if (!dead) setBusy(false); });
    }, 350);
    return () => { dead = true; clearTimeout(timer); };
  }, [q, run]);
  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={16} style={{ position: 'absolute', left: 12, top: 12, color: 'var(--text-tertiary)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} style={{ ...inputStyle(), padding: '11px 12px 11px 36px', fontSize: 15 }} />
        {busy && <RefreshCw size={14} style={{ position: 'absolute', right: 12, top: 13, color: 'var(--text-tertiary)', animation: 'spin 1s linear infinite' }} />}
      </div>
      {result && render(result)}
    </div>
  );
}

export function ResultRow({ title, subtitle, url, icon, action }: { title: string; subtitle?: string; url?: string; icon: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
      <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}
      </div>
      {action}
      {url && <a href={url} target="_blank" rel="noopener noreferrer" title={url} style={{ color: 'var(--text-tertiary)', display: 'flex' }}><ExternalLink size={15} /></a>}
    </div>
  );
}

export function ResultGroup({ title, children, count }: { title: string; children: ReactNode; count: number }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{title} · {count}</div>
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

/** Toasts for events pushed from the external system. */
export function createEventToasts(accent: string, icon: ReactNode) {
  type Toast = { id: number; summary: string; url?: string };
  const listeners = new Set<(t: Toast) => void>();
  let seq = 0;
  const push = (summary: string, url?: string) => { const toast = { id: ++seq, summary, url }; listeners.forEach(l => l(toast)); };
  function Toasts() {
    const t = useModuleT();
    const [items, setItems] = useState<Toast[]>([]);
    useEffect(() => {
      const on = (toast: Toast) => {
        setItems(v => [...v, toast].slice(-4));
        setTimeout(() => setItems(v => v.filter(x => x.id !== toast.id)), 8000);
      };
      listeners.add(on);
      return () => { listeners.delete(on); };
    }, []);
    if (!items.length) return null;
    return (
      <div aria-live="polite" style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 8500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(340px, calc(100vw - 32px))' }}>
        {items.map(item => (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderLeft: `4px solid ${accent}`, borderRadius: 12, padding: '10px 12px', boxShadow: 'var(--shadow-lg)' }}>
            <span style={{ color: accent, display: 'flex' }}>{icon}</span>
            <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-primary)' }}>{item.summary}</span>
            {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer" title={t('ik_open')} style={{ color: 'var(--text-tertiary)', display: 'flex' }}><ExternalLink size={15} /></a>}
            <button type="button" aria-label={t('ik_close')} onClick={() => setItems(v => v.filter(x => x.id !== item.id))} style={{ border: 'none', background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
          </div>
        ))}
      </div>
    );
  }
  return { push, Toasts };
}

export const kitStrings = {
  ru: {
    ik_all: 'Все', ik_outgoing: 'Отправлено', ik_incoming: 'Получено', ik_refresh: 'Обновить', ik_find_user: 'Найти пользователя…',
    ik_open: 'Открыть', ik_close: 'Закрыть',
  },
  en: {
    ik_all: 'All', ik_outgoing: 'Sent', ik_incoming: 'Received', ik_refresh: 'Refresh', ik_find_user: 'Find a user…',
    ik_open: 'Open', ik_close: 'Close',
  },
};
