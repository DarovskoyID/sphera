// Scenes for the sign-in backdrop.
//
// Everything here is drawn from primitives — triangles, rectangles, circles —
// and nothing is fetched from anywhere. That is the point: the screen has to
// look composed without shipping a single photograph.
//
// ── Why every scene has the same shape budget ────────────────────────────────
// Clicking the backdrop morphs one scene into the next, and morphing means
// interpolating numbers. So every scene is described by exactly the same set of
// slots: POLY_COUNT polygons of POINT_COUNT points, plus a fixed number of
// sparks, clouds and birds. A scene that does not need a slot collapses it to a
// single point or a zero radius, which reads as absent and still interpolates
// cleanly. Add a slot here and you must add it to all four scenes.
//
// ── Colour ───────────────────────────────────────────────────────────────────
// The palette follows the reader's local clock, not the scene: the same
// mountains are rose at dawn and near-black at night. Each scene still gets its
// own ramp at each hour — a forest is not the colour of a city at dusk — which
// is what `TERRAIN` holds. Sky, sun and highlight are shared per time, since
// those genuinely are properties of the hour rather than the place.

export const W = 1200;
export const H = 800;
export const POLY_COUNT = 7;
export const POINT_COUNT = 6;
export const SPARK_COUNT = 10;
export const CLOUD_COUNT = 3;
export const BIRD_COUNT = 3;

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type SceneName = 'mountains' | 'city' | 'forest' | 'lake';

/** Which colour a polygon takes from the resolved palette. */
export type Role = 'b0' | 'b1' | 'b2' | 'b3' | 'accent' | 'water';

export interface Poly {
  /** POINT_COUNT pairs, flattened: x0,y0,x1,y1… */
  pts: number[];
  role: Role;
  alpha: number;
}

export interface SceneDef {
  polys: Poly[];
  /** cx, cy, r of the sun or moon. */
  orb: [number, number, number];
  /** x, y, r — stars, lit windows, fireflies, ripple dots. */
  sparks: Array<[number, number, number]>;
  /** x, y, w, h capsules. Zero width means no cloud in this scene. */
  clouds: Array<[number, number, number, number]>;
  /** Three points of an open chevron: a bird at this distance is two strokes. */
  birds: Array<[number, number, number, number, number, number]>;
}

/** A slot the scene does not use: every point on top of the next one. */
const none = (x: number, y: number): number[] =>
  Array.from({ length: POINT_COUNT * 2 }, (_, i) => (i % 2 ? y : x));

// ── mountains ────────────────────────────────────────────────────────────────

const mountains: SceneDef = {
  polys: [
    { role: 'b0', alpha: 1, pts: [-60, 800, 150, 300, 430, 620, 640, 250, 940, 620, 1260, 800] },
    { role: 'b1', alpha: 1, pts: [-60, 800, 260, 430, 540, 690, 800, 380, 1080, 690, 1260, 800] },
    { role: 'b2', alpha: 1, pts: [-60, 800, 120, 560, 420, 770, 720, 520, 1020, 750, 1260, 800] },
    { role: 'b3', alpha: 1, pts: [-60, 800, 200, 700, 520, 790, 840, 715, 1140, 800, 1260, 800] },
    { role: 'accent', alpha: 0.9, pts: [640, 250, 700, 340, 668, 318, 640, 350, 610, 318, 578, 340] },
    { role: 'accent', alpha: 0.75, pts: [150, 300, 196, 372, 172, 356, 150, 380, 127, 356, 103, 372] },
    { role: 'accent', alpha: 0, pts: none(600, 800) },
  ],
  orb: [880, 200, 76],
  sparks: [
    [120, 90, 2.2], [300, 150, 1.6], [480, 70, 2], [660, 130, 1.5], [1020, 90, 1.8],
    [1140, 190, 2.1], [220, 220, 1.4], [780, 60, 1.7], [980, 300, 1.3], [400, 260, 1.5],
  ],
  clouds: [[260, 180, 190, 26], [700, 120, 130, 20], [1000, 250, 96, 16]],
  birds: [
    [330, 330, 356, 314, 382, 330],
    [396, 306, 418, 292, 440, 306],
    [268, 296, 288, 284, 308, 296],
  ],
};

// ── city ─────────────────────────────────────────────────────────────────────

const city: SceneDef = {
  polys: [
    { role: 'b0', alpha: 1, pts: [-60, 800, -60, 560, 180, 560, 180, 440, 430, 440, 430, 800] },
    { role: 'b1', alpha: 1, pts: [330, 800, 330, 380, 560, 380, 560, 520, 800, 520, 800, 800] },
    { role: 'b2', alpha: 1, pts: [720, 800, 720, 320, 910, 320, 910, 480, 1260, 480, 1260, 800] },
    { role: 'b3', alpha: 1, pts: [-60, 800, -60, 700, 420, 700, 420, 655, 1260, 655, 1260, 800] },
    { role: 'accent', alpha: 0.85, pts: [884, 320, 894, 214, 906, 214, 916, 320, 916, 320, 884, 320] },
    { role: 'accent', alpha: 0.7, pts: [196, 440, 203, 356, 211, 356, 218, 440, 218, 440, 196, 440] },
    { role: 'accent', alpha: 0, pts: none(600, 800) },
  ],
  orb: [270, 210, 66],
  sparks: [
    [206, 480, 7], [240, 480, 7], [206, 520, 7], [372, 420, 7], [372, 470, 7],
    [500, 420, 7], [500, 470, 7], [770, 370, 7], [770, 420, 7], [840, 370, 7],
  ],
  clouds: [[560, 170, 150, 22], [980, 230, 110, 18], [120, 300, 0, 14]],
  birds: [
    [600, 260, 622, 246, 644, 260],
    [660, 232, 680, 220, 700, 232],
    [540, 300, 556, 290, 572, 300],
  ],
};

// ── forest ───────────────────────────────────────────────────────────────────

const forest: SceneDef = {
  polys: [
    { role: 'b0', alpha: 1, pts: [-60, 800, 120, 430, 360, 660, 640, 380, 940, 660, 1260, 800] },
    { role: 'b1', alpha: 1, pts: [-60, 800, 230, 540, 500, 750, 790, 480, 1090, 750, 1260, 800] },
    { role: 'b2', alpha: 1, pts: [110, 800, 235, 300, 360, 800, 330, 800, 235, 360, 140, 800] },
    { role: 'b2', alpha: 1, pts: [830, 800, 975, 250, 1120, 800, 1085, 800, 975, 320, 865, 800] },
    { role: 'b3', alpha: 1, pts: [520, 800, 600, 470, 680, 800, 662, 800, 600, 520, 538, 800] },
    { role: 'b3', alpha: 1, pts: [-60, 800, -60, 720, 400, 690, 800, 712, 1260, 680, 1260, 800] },
    { role: 'accent', alpha: 0, pts: none(600, 800) },
  ],
  orb: [660, 190, 58],
  sparks: [
    [300, 620, 3], [420, 680, 2.4], [520, 600, 2.8], [700, 660, 2.2], [780, 590, 3],
    [880, 690, 2.4], [180, 660, 2.6], [1040, 620, 2.2], [620, 720, 2], [400, 560, 2.4],
  ],
  clouds: [[300, 190, 160, 22], [880, 150, 120, 18], [560, 260, 90, 14]],
  birds: [
    [420, 280, 442, 266, 464, 280],
    [500, 240, 520, 228, 540, 240],
    [360, 320, 378, 310, 396, 320],
  ],
};

// ── lake ─────────────────────────────────────────────────────────────────────

const lake: SceneDef = {
  polys: [
    { role: 'b0', alpha: 1, pts: [-60, 470, 190, 250, 450, 470, 720, 210, 1000, 470, 1260, 470] },
    { role: 'b1', alpha: 1, pts: [-60, 470, 330, 330, 610, 470, 890, 300, 1160, 470, 1260, 470] },
    { role: 'water', alpha: 1, pts: [-60, 470, 1260, 470, 1260, 800, -60, 800, -60, 800, -60, 470] },
    { role: 'accent', alpha: 0.16, pts: [700, 470, 760, 470, 900, 800, 560, 800, 560, 800, 700, 470] },
    { role: 'b0', alpha: 0.4, pts: [-60, 470, 190, 690, 450, 470, 720, 730, 1000, 470, 1260, 470] },
    { role: 'b1', alpha: 0.4, pts: [-60, 470, 330, 610, 610, 470, 890, 640, 1160, 470, 1260, 470] },
    { role: 'b3', alpha: 1, pts: [-60, 800, -60, 762, 420, 748, 820, 766, 1260, 752, 1260, 800] },
  ],
  orb: [730, 180, 68],
  sparks: [
    [200, 560, 2.4], [340, 620, 2], [520, 690, 2.6], [880, 580, 2.2], [1020, 660, 2.4],
    [140, 700, 2], [660, 600, 2.8], [960, 730, 2], [420, 540, 1.8], [1100, 520, 2.2],
  ],
  clouds: [[240, 150, 170, 24], [980, 120, 120, 18], [520, 220, 100, 15]],
  birds: [
    [380, 250, 402, 236, 424, 250],
    [452, 214, 472, 202, 492, 214],
    [318, 288, 336, 278, 354, 288],
  ],
};

export const SCENE_ORDER: SceneName[] = ['mountains', 'city', 'forest', 'lake'];

export const SCENES: Record<SceneName, SceneDef> = { mountains, city, forest, lake };

// ── palettes ─────────────────────────────────────────────────────────────────

/** Shared by every scene at a given hour — these belong to the sky, not the place. */
export const SKY: Record<TimeOfDay, { sky: string; glow: string; orb: string; accent: string; spark: string }> = {
  dawn:  { sky: '#241a33', glow: '#4c3152', orb: '#ffb27a', accent: '#ffd7a8', spark: '#ffe2bd' },
  day:   { sky: '#132437', glow: '#204064', orb: '#ffeeb5', accent: '#cbe9ff', spark: '#ffffff' },
  dusk:  { sky: '#1c1430', glow: '#472449', orb: '#ff8f5e', accent: '#ffb08a', spark: '#ffd2b4' },
  night: { sky: '#090d1a', glow: '#161e3c', orb: '#e3e9ff', accent: '#93a6dd', spark: '#cdd8ff' },
};

/**
 * The nearest terrain band, per scene per hour. The three bands behind it are
 * derived by darkening, which keeps a scene's ramp internally consistent while
 * letting each place keep its own hue: the forest stays green-leaning at every
 * hour, the city stays cool, the lake sits between them.
 */
const TERRAIN: Record<SceneName, Record<TimeOfDay, string>> = {
  mountains: { dawn: '#6b5078', day: '#3d6f8c', dusk: '#6a3c5c', night: '#2a3560' },
  city:      { dawn: '#5b4a7d', day: '#2f6382', dusk: '#5a3468', night: '#212c56' },
  forest:    { dawn: '#4f5a5c', day: '#2f6b5c', dusk: '#4a4448', night: '#1e3340' },
  lake:      { dawn: '#63527e', day: '#33688f', dusk: '#5d3a63', night: '#232f58' },
};

/** Water is its own surface — darker and flatter than the land in front of it. */
const WATER: Record<TimeOfDay, string> = {
  dawn: '#2a2038', day: '#153043', dusk: '#241732', night: '#0d1428',
};

export interface Palette {
  sky: string; glow: string; orb: string; accent: string; spark: string;
  b0: string; b1: string; b2: string; b3: string; water: string;
}

/** Scale a hex colour's channels — used to build the band ramp. */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => Math.max(0, Math.min(255, Math.round(v * factor))));
  return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function paletteFor(scene: SceneName, time: TimeOfDay): Palette {
  const base = TERRAIN[scene][time];
  return {
    ...SKY[time],
    b0: base,
    b1: shade(base, 0.78),
    b2: shade(base, 0.56),
    b3: shade(base, 0.38),
    water: WATER[time],
  };
}

/** Which palette the reader's own clock calls for. */
export function timeOfDay(date = new Date()): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 21) return 'dusk';
  return 'night';
}
