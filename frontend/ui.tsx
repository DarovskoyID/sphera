import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';

/** Small UI kit in the app's look (CSS variables of the core theme). */

export function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const h = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

export const inputStyle = (error = false): CSSProperties => ({
  width: '100%', padding: '9px 11px', borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
  border: `1px solid ${error ? '#ef4444' : 'var(--border-color)'}`,
  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
});

export function Button({ children, onClick, kind = 'ghost', disabled, title, style, type = 'button', small }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'plain';
  disabled?: boolean; title?: string; style?: CSSProperties; type?: 'button' | 'submit'; small?: boolean;
}) {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: small ? '5px 10px' : '8px 16px', borderRadius: 8, fontSize: small ? 12.5 : 14, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, fontFamily: 'inherit',
    transition: 'background .15s, border-color .15s', whiteSpace: 'nowrap',
  };
  const kinds: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent-primary)', color: '#fff', border: 'none' },
    ghost: { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' },
    danger: { background: '#ef4444', color: '#fff', border: 'none' },
    plain: { background: 'transparent', color: 'var(--text-secondary)', border: 'none', padding: small ? '4px 6px' : '6px 8px' },
  };
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} style={{ ...base, ...kinds[kind], ...style }}>
      {children}
    </button>
  );
}

export function IconButton({ children, onClick, title, active, style }: {
  children: ReactNode; onClick?: (e: React.MouseEvent) => void; title?: string; active?: boolean; style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 32, height: 32, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', cursor: 'pointer', flexShrink: 0,
        background: active ? 'rgba(var(--accent-rgb), .16)' : 'transparent',
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)', ...style,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--hover-bg)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, width = 440, footer }: {
  title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div role="dialog" aria-modal="true" style={{
        background: 'var(--bg-secondary)', borderRadius: 14, width: '100%', maxWidth: width, maxHeight: 'calc(100vh - 32px)',
        border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 18px 10px' }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', minWidth: 0 }}>{title}</div>
          <IconButton title="Esc" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div style={{ padding: '4px 18px 16px', overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '12px 18px', borderTop: '1px solid var(--border-color)' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div role="group" aria-label={label} style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export interface UserBrief {
  id: string;
  username: string;
  nickname?: string;
  avatar?: string;
}

export const displayName = (u: UserBrief) => u.nickname || u.username;

export function Avatar({ user, size = 24, serverIP = '', ring }: { user: UserBrief; size?: number; serverIP?: string; ring?: boolean }) {
  const name = displayName(user);
  const hue = [...user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const src = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : serverIP + user.avatar) : '';
  const style: CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0, objectFit: 'cover',
    boxShadow: ring ? '0 0 0 2px var(--bg-secondary)' : undefined,
  };
  return src
    ? <img src={src} alt={name} title={name} style={style} />
    : (
      <span title={name} style={{
        ...style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
        fontSize: size * 0.42, fontWeight: 700, background: `hsl(${hue},55%,48%)`,
      }}>{name.slice(0, 1).toUpperCase()}</span>
    );
}

/** Search users of this server and pick one. */
export function UserPicker({ search, exclude = [], onPick, placeholder, serverIP }: {
  search: (q: string) => Promise<UserBrief[]>; exclude?: string[]; onPick: (u: UserBrief) => void;
  placeholder: string; serverIP?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserBrief[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      search(q.trim()).then(r => { if (n === seq.current) setResults(r); }).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q, search]);
  const shown = results.filter(u => !exclude.includes(u.id));
  return (
    <div style={{ position: 'relative' }}>
      <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-tertiary)' }} />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} style={{ ...inputStyle(), paddingLeft: 30 }} />
      {shown.length > 0 && (
        <div style={{
          marginTop: 4, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)',
          maxHeight: 200, overflow: 'auto',
        }}>
          {shown.map(u => (
            <button key={u.id} type="button" onClick={() => { onPick(u); setQ(''); }} style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none',
              background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13.5, textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover-bg)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              <Avatar user={u} size={24} serverIP={serverIP} />
              <span style={{ fontWeight: 600 }}>{displayName(u)}</span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>@{u.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 40, textAlign: 'center', flex: 1 }}>
      <div style={{ width: 64, height: 64, borderRadius: 20, background: 'rgba(var(--accent-rgb), .12)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      {hint && <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 360, lineHeight: 1.5 }}>{hint}</div>}
      {action}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { id: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" style={{ display: 'inline-flex', background: 'var(--bg-tertiary)', borderRadius: 9, padding: 3, gap: 2 }}>
      {options.map(o => (
        <button key={o.id} role="tab" aria-selected={value === o.id} type="button" onClick={() => onChange(o.id)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
          background: value === o.id ? 'var(--bg-primary)' : 'transparent',
          color: value === o.id ? 'var(--text-primary)' : 'var(--text-secondary)',
          boxShadow: value === o.id ? 'var(--shadow-sm)' : 'none',
        }}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

/** Menu anchored to a point; closes on outside click or Esc. */
export function PopMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 260);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500 }} onMouseDown={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" style={{ position: 'fixed', left, top, zIndex: 9501, minWidth: 190 }}>{children}</div>
    </>
  );
}

export function MenuItem({ icon, label, onClick, danger }: { icon?: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className="context-menu-item" style={danger ? { color: '#ef4444' } : undefined} onClick={onClick}>
      {icon} {label}
    </button>
  );
}

export function Confirm({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} width={400} footer={
      <>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button kind="danger" onClick={onConfirm}>{confirmLabel}</Button>
      </>
    }>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}
