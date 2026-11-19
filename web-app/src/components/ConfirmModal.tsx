import React from 'react';

const ConfirmModal: React.FC<{
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }}>
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 24, maxWidth: 380, width: '90%', border: '1px solid var(--border-color)' }}>
      <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: 18, fontWeight: 700 }}>{title}</h3>
      <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: 14 }}>{message}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '8px 20px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>
          {cancelLabel}
        </button>
        <button onClick={onConfirm} style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
);

export default ConfirmModal;
