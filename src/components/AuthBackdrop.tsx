import { useEffect, useRef } from 'react';

/**
 * The parallax scene behind the sign-in screen.
 *
 * Five layers sit at different depths and shift by different amounts as the
 * pointer moves (or, on a phone, as the device tilts), which is what reads as
 * depth. Nothing here is interactive — it is `pointer-events: none` all the way
 * down so it can never swallow a click meant for the form.
 *
 * ── Why no React state ──────────────────────────────────────────────────────
 * A pointer emits events at screen rate. Feeding those through `setState` would
 * re-render the whole auth screen on every one of them and make typing feel
 * heavy on weaker machines. Instead the handler writes two CSS custom
 * properties on the scene element and the layers are positioned from those, so
 * the work stays on the compositor and React renders exactly once.
 *
 * Motion is also rate-limited to one update per animation frame and disabled
 * outright for readers who asked for reduced motion.
 */

interface Layer {
  /** How far this layer travels, in px, at the edge of the viewport. */
  depth: number;
  content: React.ReactNode;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export const AuthBackdrop = () => {
  const scene = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scene.current;
    if (!el) return;
    if (window.matchMedia?.(REDUCED_MOTION).matches) return;

    let frame = 0;
    // Where the parallax currently is, and where it is heading. Easing between
    // the two keeps a fast flick of the mouse from snapping the layers.
    let x = 0, y = 0, targetX = 0, targetY = 0;

    const step = () => {
      frame = 0;
      x += (targetX - x) * 0.08;
      y += (targetY - y) * 0.08;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      // Keep easing until the layers have effectively arrived.
      if (Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001) {
        frame = requestAnimationFrame(step);
      }
    };

    const aim = (nx: number, ny: number) => {
      targetX = Math.max(-1, Math.min(1, nx));
      targetY = Math.max(-1, Math.min(1, ny));
      if (!frame) frame = requestAnimationFrame(step);
    };

    const onPointer = (e: PointerEvent) => {
      aim(
        (e.clientX / window.innerWidth) * 2 - 1,
        (e.clientY / window.innerHeight) * 2 - 1,
      );
    };

    // Phones have no pointer to follow, so the scene answers to tilt instead.
    // gamma is the left/right roll and beta the front/back pitch; both are
    // divided down so a comfortable hand movement covers the full range.
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma === null || e.beta === null) return;
      aim(e.gamma / 35, (e.beta - 45) / 35);
    };

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('deviceorientation', onTilt, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('deviceorientation', onTilt);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={scene} className="auth-scene" aria-hidden="true">
      {LAYERS.map((layer, i) => (
        <div
          key={i}
          className="auth-layer"
          style={{ '--depth': layer.depth } as React.CSSProperties}
        >
          {layer.content}
        </div>
      ))}
      {/* Vignette, on top of everything, to keep the form readable whatever
          the layers underneath happen to be doing. */}
      <div className="auth-vignette" />
    </div>
  );
};

/** Furthest away first, so the nearest layers paint on top. */
const LAYERS: Layer[] = [
  { depth: 8, content: <div className="auth-stars" /> },
  {
    depth: 22,
    content: (
      <>
        <span className="auth-orb auth-orb-a" />
        <span className="auth-orb auth-orb-b" />
      </>
    ),
  },
  { depth: 40, content: <div className="auth-grid" /> },
  {
    depth: 64,
    content: (
      <>
        <span className="auth-ring auth-ring-1" />
        <span className="auth-ring auth-ring-2" />
        <span className="auth-ring auth-ring-3" />
      </>
    ),
  },
  {
    depth: 96,
    content: (
      <>
        <span className="auth-orb auth-orb-c" />
        <span className="auth-mote auth-mote-1" />
        <span className="auth-mote auth-mote-2" />
        <span className="auth-mote auth-mote-3" />
      </>
    ),
  },
];

export default AuthBackdrop;
