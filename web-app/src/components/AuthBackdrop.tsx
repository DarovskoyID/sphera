import { useCallback, useEffect, useRef, useState } from 'react';
import { Mountain } from 'lucide-react';
import {
  BIRD_COUNT, CLOUD_COUNT, H, POLY_COUNT, SPARK_COUNT, SCENES, SCENE_ORDER, W,
  paletteFor, timeOfDay,
  type Palette, type SceneName,
} from './authScenes';

/**
 * The scene behind the sign-in screen.
 *
 * Two things are going on. The layers sit at different depths and shift as the
 * pointer moves (or the phone tilts), which is what reads as depth. And a click
 * anywhere on the background morphs the current scene into the next one —
 * every scene is built from the same slots, so the change is one interpolation
 * rather than a crossfade between two pictures.
 *
 * ── Why none of this is React state ─────────────────────────────────────────
 * A pointer emits events at screen rate and a morph runs at frame rate. Pushing
 * either through `setState` would re-render the whole auth screen tens of times
 * a second and make typing feel heavy. The parallax writes two CSS custom
 * properties; the morph writes SVG attributes through refs. React renders the
 * scene once.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MORPH_MS = 900;
const STORE_KEY = 'sfera.authScene';

/** Depth in px at the edge of the viewport — bigger means nearer the reader. */
const DEPTH = { sky: 10, far: 26, mid: 48, near: 78 };

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const mix = (a: Rgb, b: Rgb, t: number) =>
  `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;

/** Slow at both ends, quick through the middle — the shapes read as settling. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Everything one frame of the morph needs, with colours already resolved. */
interface Frame {
  polys: Array<{ pts: number[]; rgb: Rgb; alpha: number }>;
  orb: [number, number, number];
  sparks: Array<[number, number, number]>;
  clouds: Array<[number, number, number, number]>;
  birds: number[][];
  sky: Rgb; glow: Rgb; orbC: Rgb; sparkC: Rgb; accent: Rgb;
}

function frameFor(name: SceneName, pal: Palette): Frame {
  const s = SCENES[name];
  return {
    polys: s.polys.map(p => ({ pts: p.pts, rgb: toRgb(pal[p.role]), alpha: p.alpha })),
    orb: s.orb,
    sparks: s.sparks,
    clouds: s.clouds,
    birds: s.birds.map(b => [...b]),
    sky: toRgb(pal.sky), glow: toRgb(pal.glow), orbC: toRgb(pal.orb),
    sparkC: toRgb(pal.spark), accent: toRgb(pal.accent),
  };
}

const nums = (a: number[], b: number[], t: number) => a.map((v, i) => lerp(v, b[i], t));

export const AuthBackdrop = () => {
  const scene = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [index, setIndex] = useState(() => {
    const saved = Number(localStorage.getItem(STORE_KEY));
    return Number.isInteger(saved) && saved >= 0 && saved < SCENE_ORDER.length ? saved : 0;
  });
  // The hour is read once per mount and again when the tab is brought back, so
  // a session left open overnight is not still painted in daylight.
  const [time, setTime] = useState(timeOfDay);

  // ── parallax ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scene.current;
    if (!el || window.matchMedia?.(REDUCED_MOTION).matches) return;

    let frame = 0;
    let x = 0, y = 0, targetX = 0, targetY = 0;

    const step = () => {
      frame = 0;
      x += (targetX - x) * 0.08;
      y += (targetY - y) * 0.08;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      if (Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001) {
        frame = requestAnimationFrame(step);
      }
    };
    const aim = (nx: number, ny: number) => {
      targetX = Math.max(-1, Math.min(1, nx));
      targetY = Math.max(-1, Math.min(1, ny));
      if (!frame) frame = requestAnimationFrame(step);
    };

    const onPointer = (e: PointerEvent) =>
      aim((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    // Phones have no pointer to follow, so the scene answers to tilt instead.
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

  // Re-check the clock when the tab comes back, so an overnight session catches up.
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') setTime(timeOfDay()); };
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 10 * 60 * 1000);
    return () => { document.removeEventListener('visibilitychange', check); clearInterval(timer); };
  }, []);

  // ── painting and morphing ─────────────────────────────────────────────────
  const paint = useCallback((f: Frame) => {
    const root = svg.current;
    if (!root) return;
    const set = (id: string, attrs: Record<string, string>) => {
      const el = root.querySelector(`#${id}`);
      if (el) for (const k in attrs) el.setAttribute(k, attrs[k]);
    };

    set('sky', { fill: mix(f.sky, f.sky, 0) });
    set('glow', { cx: String(f.orb[0]), cy: String(f.orb[1]), r: String(f.orb[2] * 3.1), fill: mix(f.glow, f.glow, 0) });
    set('orb', { cx: String(f.orb[0]), cy: String(f.orb[1]), r: String(f.orb[2]), fill: mix(f.orbC, f.orbC, 0) });

    f.polys.forEach((p, i) => {
      const pts: string[] = [];
      for (let k = 0; k < p.pts.length; k += 2) pts.push(`${p.pts[k].toFixed(1)},${p.pts[k + 1].toFixed(1)}`);
      set(`poly${i}`, { points: pts.join(' '), fill: mix(p.rgb, p.rgb, 0), 'fill-opacity': p.alpha.toFixed(3) });
    });

    f.sparks.forEach((s, i) =>
      set(`spark${i}`, { cx: s[0].toFixed(1), cy: s[1].toFixed(1), r: Math.max(0, s[2]).toFixed(2), fill: mix(f.sparkC, f.sparkC, 0) }));

    f.clouds.forEach((c, i) =>
      set(`cloud${i}`, {
        x: (c[0] - c[2] / 2).toFixed(1), y: (c[1] - c[3] / 2).toFixed(1),
        width: Math.max(0, c[2]).toFixed(1), height: Math.max(0, c[3]).toFixed(1),
        rx: (c[3] / 2).toFixed(1), fill: mix(f.accent, f.accent, 0),
      }));

    f.birds.forEach((b, i) =>
      set(`bird${i}`, {
        points: `${b[0].toFixed(1)},${b[1].toFixed(1)} ${b[2].toFixed(1)},${b[3].toFixed(1)} ${b[4].toFixed(1)},${b[5].toFixed(1)}`,
        stroke: mix(f.accent, f.accent, 0),
      }));
  }, []);

  const morph = useRef(0);
  const current = useRef<Frame | null>(null);

  // Repaint on scene or hour change, morphing from whatever is on screen.
  useEffect(() => {
    const target = frameFor(SCENE_ORDER[index], paletteFor(SCENE_ORDER[index], time));
    const from = current.current;
    // Nothing to animate from on the first paint; nothing worth animating when
    // the reader asked for less motion, or when the tab is hidden — there
    // requestAnimationFrame is throttled to a standstill and a tween would
    // simply leave the old scene on screen until the tab came back.
    const still = window.matchMedia?.(REDUCED_MOTION).matches
      || document.visibilityState !== 'visible';

    if (!from || still) {
      current.current = target;
      paint(target);
      return;
    }

    const start = performance.now();
    const tween = (now: number) => {
      const t = ease(Math.min(1, (now - start) / MORPH_MS));
      const f: Frame = {
        polys: target.polys.map((p, i) => ({
          pts: nums(from.polys[i].pts, p.pts, t),
          rgb: [
            lerp(from.polys[i].rgb[0], p.rgb[0], t),
            lerp(from.polys[i].rgb[1], p.rgb[1], t),
            lerp(from.polys[i].rgb[2], p.rgb[2], t),
          ] as Rgb,
          alpha: lerp(from.polys[i].alpha, p.alpha, t),
        })),
        orb: nums(from.orb, target.orb, t) as [number, number, number],
        sparks: target.sparks.map((s, i) => nums(from.sparks[i], s, t) as [number, number, number]),
        clouds: target.clouds.map((c, i) => nums(from.clouds[i], c, t) as [number, number, number, number]),
        birds: target.birds.map((b, i) => nums(from.birds[i], b, t)),
        sky: nums(from.sky, target.sky, t) as Rgb,
        glow: nums(from.glow, target.glow, t) as Rgb,
        orbC: nums(from.orbC, target.orbC, t) as Rgb,
        sparkC: nums(from.sparkC, target.sparkC, t) as Rgb,
        accent: nums(from.accent, target.accent, t) as Rgb,
      };
      paint(f);
      current.current = f;
      if (t < 1) morph.current = requestAnimationFrame(tween);
      else { current.current = target; morph.current = 0; }
    };
    morph.current = requestAnimationFrame(tween);
    return () => { if (morph.current) cancelAnimationFrame(morph.current); };
  }, [index, time, paint]);

  const next = useCallback(() => {
    setIndex(i => {
      const n = (i + 1) % SCENE_ORDER.length;
      try { localStorage.setItem(STORE_KEY, String(n)); } catch { /* private mode */ }
      return n;
    });
  }, []);

  // A click on the backdrop advances the scene. The form sits above it, so the
  // listener has to ignore anything that landed on something interactive —
  // otherwise pressing "sign in" would also change the wallpaper.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest('.auth-card, .auth-hero, a, button, input, select, textarea, label')) return;
      next();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [next]);

  return (
    <>
      <div ref={scene} className="auth-scene" aria-hidden="true">
        <svg
          ref={svg}
          className="auth-art"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid slice"
        >
          <rect id="sky" x="0" y="0" width={W} height={H} />
          <g className="auth-depth" style={{ '--depth': DEPTH.sky } as React.CSSProperties}>
            <circle id="glow" opacity="0.5" />
            <circle id="orb" />
            {Array.from({ length: CLOUD_COUNT }, (_, i) => (
              <rect key={i} id={`cloud${i}`} opacity="0.16" />
            ))}
          </g>
          <g className="auth-depth" style={{ '--depth': DEPTH.far } as React.CSSProperties}>
            {[0, 1].map(i => <polygon key={i} id={`poly${i}`} />)}
          </g>
          <g className="auth-depth" style={{ '--depth': DEPTH.mid } as React.CSSProperties}>
            {[2, 3].map(i => <polygon key={i} id={`poly${i}`} />)}
          </g>
          <g className="auth-depth" style={{ '--depth': DEPTH.near } as React.CSSProperties}>
            {Array.from({ length: POLY_COUNT - 4 }, (_, k) => (
              <polygon key={k} id={`poly${k + 4}`} />
            ))}
            {Array.from({ length: SPARK_COUNT }, (_, i) => (
              <circle key={i} id={`spark${i}`} opacity="0.65" />
            ))}
            {Array.from({ length: BIRD_COUNT }, (_, i) => (
              <polyline key={i} id={`bird${i}`} fill="none" strokeWidth="3" strokeLinecap="round" opacity="0.5" />
            ))}
          </g>
        </svg>
        <div className="auth-vignette" />
      </div>

      <button
        type="button"
        className="auth-scene-switch"
        onClick={next}
        title={SCENE_ORDER[(index + 1) % SCENE_ORDER.length]}
        aria-label="Сменить фон"
      >
        <Mountain size={16} />
      </button>
    </>
  );
};

export default AuthBackdrop;
