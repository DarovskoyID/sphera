import React, { useState } from 'react';
import { EyeOff } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { useCensorConfig, isExplicitMedia } from '../utils/censor';

/**
 * Hides a photo/video behind a blur until the reader taps to reveal it, when
 * the explicit-content filter flags it (see `isExplicitMedia` for what counts
 * as a signal). Renders children untouched when the filter does not apply, so
 * it is safe to wrap every media element with it.
 */
export const BlurredMedia: React.FC<{
  filename?: string;
  /** Caption the media was sent with — the strongest available signal. */
  text?: string;
  authorId?: string;
  children: React.ReactNode;
}> = ({ filename, text, authorId, children }) => {
  const tr = useTranslation();
  const cfg = useCensorConfig();
  const [revealed, setRevealed] = useState(false);

  if (revealed || !isExplicitMedia({ filename, text, authorId }, cfg)) return <>{children}</>;

  return (
    <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ filter: 'blur(22px)', transform: 'scale(1.08)', pointerEvents: 'none', userSelect: 'none' }} aria-hidden="true">
        {children}
      </div>
      <button
        type="button"
        onClick={() => setRevealed(true)}
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 6,
          background: 'rgba(0,0,0,0.35)', border: 'none', cursor: 'pointer',
          color: '#fff', font: 'inherit', padding: 12, textAlign: 'center',
        }}
      >
        <EyeOff size={22} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>18+</span>
        <span style={{ fontSize: 12, opacity: 0.85 }}>{tr('media_tap_reveal')}</span>
      </button>
    </div>
  );
};

export default BlurredMedia;
