// The learning loop.
//
// Every token the scanner scores is remembered with the feature vector it had
// at discovery. On later runs the scanner looks the token up again at ~1h, ~6h
// and ~24h and records what actually happened. Once a token has a 24h outcome
// it becomes a training sample, and a small L2-regularised logistic regression
// is re-fitted on all samples. Its prediction ("probability this token is
// still alive and not down badly a day later") is blended into the score, with
// a weight that grows as evidence accumulates - so the bot starts from
// researched rules and gradually trusts its own track record.
import { clamp } from './util.js';

export const CHECKPOINTS = [
  { key: 'h1', afterMs: 60 * 60e3 },
  { key: 'h6', afterMs: 6 * 60 * 60e3 },
  { key: 'h24', afterMs: 24 * 60 * 60e3 },
];
export const MAX_SAMPLES = 6000;
export const MIN_SAMPLES_TO_TRAIN = 150;

/**
 * Outcome label at 24h. "Good" = the pool still has real liquidity and the
 * price held at least half of the discovery price. Everything else (rugged,
 * drained, bled out, vanished from the API) is "bad".
 */
export function labelOutcome(obs) {
  const c = obs.checks?.h24;
  if (!c) return null;
  if (c.gone) return 0;
  const priceRatio = obs.price0 > 0 && c.price > 0 ? c.price / obs.price0 : 0;
  const liqOk = c.liq >= Math.max(3000, 0.3 * (obs.liq0 || 0));
  return priceRatio >= 0.5 && liqOk ? 1 : 0;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

function standardise(X) {
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / X.length) || 1;
  return { mean, std };
}

/** Area under the ROC curve via the rank-sum identity. */
export function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let pos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avgRank = (i + j + 1) / 2; // ties share the average rank
    for (let k = i; k < j; k++) if (idx[k][1] === 1) { rankSum += avgRank; pos++; }
    i = j;
  }
  const neg = idx.length - pos;
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function fit(X, y, { mean, std }, { l2 = 0.05, iters = 400, lr = 0.3 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0);
  const base = y.reduce((a, b) => a + b, 0) / n;
  let b = Math.log(clamp(base, 0.01, 0.99) / (1 - clamp(base, 0.01, 0.99)));
  // Class weights so a 90%-bad dataset doesn't just learn "everything is bad".
  const wPos = 0.5 / Math.max(base, 1e-6);
  const wNeg = 0.5 / Math.max(1 - base, 1e-6);
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const err = (sigmoid(z) - y[i]) * (y[i] ? wPos : wNeg);
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b };
}

function predictRaw(model, x) {
  let z = model.bias;
  for (let j = 0; j < x.length; j++) z += model.weights[j] * ((x[j] - model.mean[j]) / model.std[j]);
  return sigmoid(z);
}

/**
 * Re-fit the model. Uses a time-ordered 80/20 split to report an honest
 * out-of-sample AUC, then trains the shipped weights on everything.
 */
export function train(samples, featureNames) {
  const usable = samples.filter((s) => Array.isArray(s.x) && s.x.length === featureNames.length && (s.y === 0 || s.y === 1));
  const n = usable.length;
  const baseRate = n ? usable.reduce((a, s) => a + s.y, 0) / n : null;
  const out = { featureNames, nSamples: n, baseRate, trainedAt: Date.now(), ready: false };
  const positives = usable.filter((s) => s.y === 1).length;
  if (n < MIN_SAMPLES_TO_TRAIN || positives < 15 || n - positives < 15) return out;

  usable.sort((a, b) => a.t - b.t);
  const cut = Math.floor(n * 0.8);
  const tr = usable.slice(0, cut);
  const te = usable.slice(cut);
  let testAuc = null;
  if (te.length >= 15 && tr.some((s) => s.y === 1) && tr.some((s) => s.y === 0)) {
    const st = standardise(tr.map((s) => s.x));
    const f = fit(tr.map((s) => s.x), tr.map((s) => s.y), st);
    const m = { weights: f.w, bias: f.b, mean: st.mean, std: st.std };
    testAuc = auc(te.map((s) => predictRaw(m, s.x)), te.map((s) => s.y));
  }

  const st = standardise(usable.map((s) => s.x));
  const f = fit(usable.map((s) => s.x), usable.map((s) => s.y), st);
  // Only trust the model if it beat a coin flip out of sample.
  const skill = testAuc == null ? 0 : clamp((testAuc - 0.5) / 0.25, 0, 1);
  const evidence = n / (n + 400);
  return {
    ...out,
    ready: true,
    weights: f.w,
    bias: f.b,
    mean: st.mean,
    std: st.std,
    testAuc,
    blend: +(0.5 * skill * evidence).toFixed(3), // share of the final score given to the model
    importance: featureNames
      .map((name, j) => ({ name, weight: +f.w[j].toFixed(3) }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
  };
}

/** Balanced-class probability (0..1) that a token ends up "good"; null if untrained. */
export function predict(model, x) {
  if (!model?.ready || !x || x.length !== model.weights.length) return null;
  return predictRaw(model, x);
}

/** How did past scores actually turn out? Buckets of score -> realised good rate. */
export function calibration(samples) {
  const buckets = [
    [0, 20], [20, 40], [40, 60], [60, 80], [80, 101],
  ].map(([lo, hi]) => ({ lo, hi: Math.min(hi, 100), n: 0, good: 0, avgReturn: 0 }));
  for (const s of samples) {
    if (s.score == null || s.y == null) continue;
    const b = buckets.find((k) => s.score >= k.lo && s.score < (k.hi === 100 ? 101 : k.hi));
    if (!b) continue;
    b.n++;
    b.good += s.y;
    b.avgReturn += clamp(s.ret ?? -1, -1, 20);
  }
  return buckets.map((b) => ({
    range: `${b.lo}-${b.hi}`,
    n: b.n,
    goodRate: b.n ? +(b.good / b.n).toFixed(3) : null,
    avgReturn: b.n ? +(b.avgReturn / b.n).toFixed(3) : null,
  }));
}
