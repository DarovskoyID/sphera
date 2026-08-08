import React, { useEffect, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';
import { useCensorConfig, isExplicitMedia, explicitApplies } from '../utils/censor';
import { classifyMedia, type Verdict } from '../utils/nsfwDetect';
import { useCensorOff } from './CensorScope';

/**
 * Hides a photo or video behind a blur until the reader taps to reveal it.
 *
 * Two signals decide. The cheap one is wording — an explicit caption or file
 * name hides the media instantly. Otherwise an on-device classifier looks at
 * the picture itself; while it is thinking the media stays hidden, so nothing
 * explicit can flash on screen before the verdict lands.
 *
 * Renders children untouched whenever the explicit filter does not apply, so
 * it is safe to wrap every media element with it.
 */
export const BlurredMedia: React.FC<{
  filename?: string;
  /** Caption the media was sent with — the strongest textual signal. */
  text?: string;
  authorId?: string;
  /** Displayable source (blob URL) the classifier reads. */
  src?: string;
  /** Stable id for caching the verdict — the attachment URL, not the blob. */
  mediaKey?: string;
  isVideo?: boolean;
  /**
   * Stretch to the parent instead of hugging the media. Gallery tiles live in
   * a cell of a fixed size and expect their child to fill it; a standalone
   * photo must keep its own dimensions, or the cover would balloon to the full
   * width of the message row.
   */
  fill?: boolean;
  children: React.ReactNode;
}> = ({ filename, text, authorId, src, mediaKey, isVideo, fill, children }) => {
  const tr = useTranslation();
  const cfg = useCensorConfig();
  const censorOff = useCensorOff();
  const [revealed, setRevealed] = useState(false);

  const applies = !censorOff && cfg.blur_enabled && explicitApplies(cfg, authorId);
  const flaggedByText = applies && isExplicitMedia({ filename, text, authorId }, cfg);
  // Only worth classifying when the filter is on and wording didn't already decide.
  const shouldClassify = applies && !flaggedByText && !!src;
  const [verdict, setVerdict] = useState<Verdict | 'pending'>('pending');

  useEffect(() => {
    if (!shouldClassify || !src) return;
    let alive = true;
    setVerdict('pending');
    classifyMedia(mediaKey || src, src, !!isVideo).then(v => { if (alive) setVerdict(v); });
    return () => { alive = false; };
  }, [shouldClassify, src, mediaKey, isVideo]);

  if (!applies || revealed) return <>{children}</>;
  // Without a source to inspect we can only go on wording.
  if (!flaggedByText && !shouldClassify) return <>{children}</>;
  if (!flaggedByText && verdict === 'safe') return <>{children}</>;

  const checking = !flaggedByText && verdict === 'pending';

  return (
    <div style={{
      position: 'relative', maxWidth: '100%', borderRadius: 10, overflow: 'hidden',
      ...(fill
        ? { display: 'block', width: '100%', height: '100%' }
        : { display: 'inline-block', lineHeight: 0 }),
    }}>
      <div style={{ filter: 'blur(22px)', transform: 'scale(1.08)', pointerEvents: 'none', userSelect: 'none' }} aria-hidden="true">
        {children}
      </div>
      <button
        type="button"
        onClick={() => setRevealed(true)}
        aria-label={checking ? tr('media_checking') : tr('media_tap_reveal')}
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 6,
          background: 'rgba(0,0,0,0.35)', border: 'none', cursor: 'pointer',
          color: '#fff', font: 'inherit', padding: 12, textAlign: 'center',
        }}
      >
        {checking ? (
          <>
            <div style={{ width: 20, height: 20, border: '2px solid rgba(255,255,255,0.85)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <span style={{ fontSize: 12, opacity: 0.85 }}>{tr('media_checking')}</span>
          </>
        ) : (
          <>
            <EyeOff size={22} />
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>18+</span>
            <span style={{ fontSize: 12, opacity: 0.85 }}>{tr('media_tap_reveal')}</span>
          </>
        )}
      </button>
    </div>
  );
};

export default BlurredMedia;
