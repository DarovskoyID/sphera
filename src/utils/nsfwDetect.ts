// On-device 18+ image detection.
//
// Runs a MobileNetV2 classifier (nsfwjs) entirely in the browser: nothing about
// the picture is uploaded anywhere. Both the library and its ~3.5 MB of weights
// are behind a dynamic import, so they are fetched only the first time a photo
// actually has to be checked — the main bundle is unaffected.
//
// Callers should treat "not yet classified" as unsafe and keep the media hidden
// until a verdict arrives, so explicit content never flashes on screen.

export type Verdict = 'safe' | 'explicit';

// nsfwjs returns probabilities over these five classes.
type Predictions = Array<{ className: string; probability: number }>;

/**
 * How sure we must be before hiding. "Porn" and "Hentai" are unambiguous, so a
 * low bar is right; "Sexy" covers swimwear and gym photos and would otherwise
 * hide a lot of ordinary pictures, so it needs near-certainty.
 */
const THRESHOLDS: Record<string, number> = {
  Porn: 0.5,
  Hentai: 0.5,
  Sexy: 0.9,
};

function judge(preds: Predictions): Verdict {
  for (const p of preds) {
    const limit = THRESHOLDS[p.className];
    if (limit !== undefined && p.probability >= limit) return 'explicit';
  }
  return 'safe';
}

// ── model loading (once per session) ─────────────────────────────────────────

type Model = { classify: (el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, topk?: number) => Promise<Predictions> };

let modelPromise: Promise<Model> | null = null;

function loadModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (async () => {
      // tfjs must be imported for its side effects (it registers the backend)
      // before nsfwjs asks for one.
      await import('@tensorflow/tfjs');
      // Deliberately NOT `import('nsfwjs')`: its top-level `load` hard-codes a
      // list of all three bundled models, so the bundler emits chunks for
      // InceptionV3 and MobileNetV2Mid too (~34 MB of dist we never fetch).
      // The package exposes these subpaths precisely so one model can be
      // picked; going through them keeps only MobileNetV2 in the build.
      const [{ load }, { MobileNetV2Model }] = await Promise.all([
        import('nsfwjs/core'),
        import('nsfwjs/models/mobilenet_v2'),
      ]);
      return (await load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] })) as unknown as Model;
    })().catch((e) => {
      // Let a later call retry rather than wedging every image forever.
      modelPromise = null;
      throw e;
    });
  }
  return modelPromise;
}

// ── classification (cached + serialised) ─────────────────────────────────────

// Verdicts are cached per media URL so scrolling a conversation re-uses them.
const cache = new Map<string, Verdict>();
// Inference is GPU/CPU heavy; running a screenful in parallel janks the UI, so
// requests are chained one after another.
let queue: Promise<unknown> = Promise.resolve();

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

/** Grab a frame from a video so the same classifier can judge it. */
function grabVideoFrame(src: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    const fail = () => reject(new Error('frame failed'));
    video.onerror = fail;
    video.onloadeddata = () => {
      // A little way in — the very first frame is often black.
      video.currentTime = Math.min(1, (video.duration || 1) / 4);
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 224;
      canvas.height = video.videoHeight || 224;
      const ctx = canvas.getContext('2d');
      if (!ctx) return fail();
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    video.src = src;
  });
}

/**
 * Classify one image or video. `key` identifies the media for caching (use the
 * stable attachment URL, not a transient blob URL).
 *
 * On any failure — model unavailable, decode error — resolves to 'safe' so a
 * broken classifier cannot permanently hide someone's photos.
 */
export function classifyMedia(key: string, src: string, isVideo: boolean): Promise<Verdict> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const run = queue.then(async (): Promise<Verdict> => {
    const cached = cache.get(key);
    if (cached) return cached;
    try {
      const model = await loadModel();
      const el = isVideo ? await grabVideoFrame(src) : await decodeImage(src);
      const verdict = judge(await model.classify(el as HTMLImageElement));
      cache.set(key, verdict);
      return verdict;
    } catch {
      return 'safe';
    }
  });

  // Keep the chain alive even if this link rejected.
  queue = run.catch(() => {});
  return run;
}
