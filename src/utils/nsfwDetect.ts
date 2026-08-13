// On-device 18+ image detection.
//
// Runs a MobileNetV2 classifier (nsfwjs) entirely in the browser: nothing about
// the picture is uploaded anywhere. Both the library and its ~3.5 MB of weights
// are behind a dynamic import, so they are fetched only the first time a photo
// actually has to be checked — the main bundle is unaffected.
//
// Callers should treat "not yet classified" as unsafe and keep the media hidden
// until a verdict arrives, so explicit content never flashes on screen.

/**
 * 'unknown' means the check did not get to run — the model was still
 * downloading and failed, the tab ran out of memory, the decode lost a race.
 * It is not "safe": callers keep the cover on and come back for another go.
 */
export type Verdict = 'safe' | 'explicit' | 'unknown';

// nsfwjs returns probabilities over these five classes.
type Predictions = Array<{ className: string; probability: number }>;

/**
 * How sure we must be before hiding.
 *
 * These are deliberately high. MobileNetV2 is noisy on anything stylised —
 * illustrations, game art, AI-generated pictures — and leaks a large "Hentai"
 * score onto them purely because they are drawings, not because of what they
 * depict. "Sexy" is worse still: it covers swimwear, gym shots and close-up
 * portraits. Hiding someone's ordinary photo is a far more visible failure than
 * letting a borderline one through, so the bar is set where only confident
 * detections clear it.
 */
const THRESHOLDS: Record<string, number> = {
  // "Porn" is the one class the model is actually decisive about, so it does
  // not need a high bar — it needs the guards below. Set at 0.7 it missed
  // ordinary explicit photographs, which is the whole job.
  Porn: 0.55,
  // "Hentai" is the leaky one: it fires on anything drawn, illustrated or
  // AI-generated, regardless of subject. It stays high.
  Hentai: 0.85,
  // "Sexy" covers swimwear, gym shots and close-up portraits.
  Sexy: 0.95,
};

/** Classes that mean "nothing to hide here". */
const SAFE_CLASSES = ['Neutral', 'Drawing'];

/** Exported so the decision can be tested against known prediction vectors. */
export function judge(preds: Predictions): Verdict {
  // The winning class must itself be an explicit one. Without this a picture
  // the model calls Drawing at 0.6 could still be hidden on a 0.3 Hentai tail,
  // which is exactly how stylised art ends up behind an 18+ cover.
  const top = preds.reduce((a, b) => (b.probability > a.probability ? b : a), preds[0]);
  if (!top || THRESHOLDS[top.className] === undefined) return 'safe';
  if (top.probability < THRESHOLDS[top.className]) return 'safe';

  // The explicit class has to outweigh the safe ones taken together. This is a
  // comparison, not a ceiling: an earlier version demanded the safe classes
  // stay under 0.15 in absolute terms, which a real photograph rarely does —
  // Porn 0.62 with Neutral 0.22 is an ordinary reading, and it was being let
  // through. What actually distinguishes a hedge is the safe mass rivalling
  // the winner, not merely being present.
  const safeMass = preds
    .filter(p => SAFE_CLASSES.includes(p.className))
    .reduce((sum, p) => sum + p.probability, 0);
  if (safeMass >= top.probability) return 'safe';

  return 'explicit';
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
 * How many times one piece of media may fail before we stop hiding it.
 *
 * A failure used to resolve straight to 'safe', which is why the same photo
 * could be covered on one device and shown in the clear on another: whether
 * the 3.5 MB of weights finished downloading decided it, silently. Failures
 * are retried instead, and only a media item that has failed this many times
 * is let through — a device that genuinely cannot run the model must not end
 * up hiding every picture forever.
 */
const MAX_ATTEMPTS = 3;
const attempts = new Map<string, number>();

/**
 * Classify one image or video. `key` identifies the media for caching (use the
 * stable attachment URL, not a transient blob URL).
 *
 * Returns 'unknown' when the check could not run — the caller keeps the media
 * hidden and asks again. Only after `MAX_ATTEMPTS` failures does it give up
 * and answer 'safe'.
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
      attempts.delete(key);
      return verdict;
    } catch {
      const failed = (attempts.get(key) || 0) + 1;
      attempts.set(key, failed);
      if (failed < MAX_ATTEMPTS) return 'unknown';
      // Out of retries: remember it, so the queue is not chewing through the
      // same hopeless item on every scroll.
      cache.set(key, 'safe');
      return 'safe';
    }
  });

  // Keep the chain alive even if this link rejected.
  queue = run.catch(() => {});
  return run;
}
