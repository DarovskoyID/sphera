import type React from 'react';

/** Styles of the core settings screens, so module settings pages look native. */
export const settingsUi = {
  card: { background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)', padding: 20, marginBottom: 16 } as React.CSSProperties,
  fieldLabel: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 } as React.CSSProperties,
  fieldInput: { width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 14, outline: 'none' } as React.CSSProperties,
  btnPrimary: { padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' } as React.CSSProperties,
  btnSecondary: { padding: '8px 16px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 13, cursor: 'pointer' } as React.CSSProperties,
  btnDanger: { padding: '8px 16px', background: 'var(--bg-tertiary)', color: '#ef4444', border: '1px solid #ef444444', borderRadius: 6, fontSize: 13, cursor: 'pointer' } as React.CSSProperties,
  sectionH3: { margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.5 } as React.CSSProperties,
  statusMsg: (type: 'ok' | 'err'): React.CSSProperties => ({ fontSize: 13, color: type === 'ok' ? '#22c55e' : '#ef4444', marginTop: 8 }),
};
