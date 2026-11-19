import React from 'react';

/** Card used by «Исследовать сферу» tool entries (core and modules). */
export const ToolCard: React.FC<{
  icon: React.ReactNode;
  gradient: string;
  /** Colour stem like "rgba(88,101,242" — alpha is appended per state. */
  tint: string;
  title: string;
  subtitle: string;
  busy?: boolean;
  onClick: () => void;
}> = ({ icon, gradient, tint, title, subtitle, busy, onClick }) => (
  <div
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12,
      cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.7 : 1,
      background: `linear-gradient(135deg, ${tint},0.14), ${tint},0.10))`,
      border: `1px solid ${tint},0.35)`, transition: 'transform .15s, box-shadow .15s',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 8px 24px ${tint},0.2)`; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
  >
    <div style={{
      width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: gradient,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: `0 4px 12px ${tint},0.35)`,
    }}>
      {icon}
    </div>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14.5 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.35 }}>{subtitle}</div>
    </div>
  </div>
);

