// The learned half of the disable-the-filter check.
//
// censor.ts matches stems, and a stem only has to be avoided once: "otkl v
// nastroikah" carries no complete verb stem, so no rule fires. This scores the
// message with a small classifier over character n-grams instead, where every
// surviving fragment contributes on its own and there is no single thing to
// dodge.
//
// It is a second opinion, never a veto: the rules' verdict stands, and this can
// only add to it. The threshold ships with the weights and is chosen heavily in
// favour of precision — a false positive hides an ordinary message behind
// asterisks, a false negative only leaves the filter where it already was. See
// scripts/train-censor-model.mjs for how the model is built, what it was
// measured against, and what those numbers do and do not mean.
//
// Cost is a few microseconds: 16K int8 weights, a hash per n-gram, one dot
// product. The weights are bundled, so nothing is fetched and it works offline.

import { featurize, score, MAX_MODEL_INPUT, FEATURE_BUCKETS } from './censorFeatures';
import { censorModel } from '../data/censorModel';

interface CensorModel {
  weights: Float32Array;
  bias: number;
  threshold: number;
}

let model: CensorModel | null | undefined;

/**
 * Decode the weights on first use.
 *
 * A model that fails to decode, or that was trained against a different feature
 * space, is treated as absent rather than as an error: the rules are the filter,
 * and they do not need this to work.
 */
function load(): CensorModel | null {
  if (model !== undefined) return model;
  model = null;
  try {
    const data = censorModel;
    if (data.buckets !== FEATURE_BUCKETS) return model;

    const binary = atob(data.weights);
    if (binary.length !== FEATURE_BUCKETS) return model;

    const weights = new Float32Array(FEATURE_BUCKETS);
    for (let i = 0; i < FEATURE_BUCKETS; i++) {
      // int8, stored unsigned.
      const byte = binary.charCodeAt(i);
      weights[i] = (byte > 127 ? byte - 256 : byte) * data.scale;
    }
    model = { weights, bias: data.bias, threshold: data.threshold };
  } catch {
    model = null;
  }
  return model;
}

/**
 * How confident the model is that this message is an appeal to switch the
 * filter off, from 0 to 1. Returns 0 when the model is unavailable.
 *
 * Exported for the settings screen's developer mode, which shows the score next
 * to a message so the threshold can be sanity-checked against real text.
 */
export function appealScore(text: string): number {
  const m = load();
  if (!m || !text) return 0;
  return score(featurize(text), m.weights, m.bias);
}

/**
 * Does the model consider this an appeal, at the shipped threshold?
 *
 * Long messages are skipped outright. These appeals are short — a sentence or
 * two — and the model never saw anything longer during training, so its opinion
 * about a wall of text is not one worth acting on.
 */
export function modelSaysAppeal(text: string): boolean {
  const m = load();
  if (!m || !text || text.length > MAX_MODEL_INPUT) return false;
  return score(featurize(text), m.weights, m.bias) >= m.threshold;
}
