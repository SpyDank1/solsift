// SolSift scanner - one run = discover, enrich, learn, score, publish.
// Usage: node scanner/index.js            (writes ./data/*.json)
//        DATA_DIR=somewhere node scanner/index.js
import { join } from 'node:path';
import { readJson, writeJson, httpStats, now } from './util.js';
import { discover, marketMetas, jupiterBatch, dexscreenerBatch, rugcheckBatch, sellProbe, buildToken, isMint } from './sources.js';
import { scoreToken, finalise, features, FEATURES } from './score.js';
import { tagToken, detectTrends, trendFit } from './trends.js';
import { CHECKPOINTS, MAX_SAMPLES, MIN_SAMPLES_TO_TRAIN, labelOutcome, train, predict, calibration } from './learn.js';
import { stepPaper } from './paper.js';
import { enrichSocial, socialKeys } from './social.js';

const DATA = process.env.DATA_DIR || 'data';
const MAX_AGE_MIN = 72 * 60; // "newly launched" window shown on the site
const GRACE_MIN = 30; // how long a brand-new mint may sit with no traction before we stop tracking it
const TRACK_CAP = 700;
const DISPLAY_CAP = 300;
const RUGCHECK_CAP = 230;
const SELL_PROBE_CAP = 12;

const t0 = now();
const log = (...a) => console.log(`[${((now() - t0) / 1000).toFixed(1)}s]`, ...a);

const state = await readJson(join(DATA, 'state.json'), {});
state.tracked ||= {}; // mint -> { firstSeen, meta, rc, soc, probe, miss }
state.obs ||= {}; // mint -> observation awaiting outcomes
state.samples ||= []; // labelled training rows
state.trendHist ||= [];
state.socialSeen ||= {}; // social key -> [mints] (to catch links reused across tokens)
state.xCache ||= {};
state.runs = (state.runs || 0) + 1;
let model = await readJson(join(DATA, 'model-internal.json'), null);
let paper = await readJson(join(DATA, 'paper.json'), null);

// ---- 1. discovery -------------------------------------------------------
const [found, metas] = await Promise.all([discover(), marketMetas()]);
const live = new Map(); // per-run raw objects from discovery feeds, not persisted
let fresh = 0;
for (const [mint, f] of found) {
  const tr = (state.tracked[mint] ||= (fresh++, { firstSeen: t0, meta: {} }));
  const { jup, dat, ...meta } = f.meta;
  live.set(mint, { jup, dat });
  tr.meta = { ...meta, ...tr.meta, links: { ...(meta.links || {}), ...(tr.meta.links || {}) }, src: [...new Set([...(tr.meta.src || []), ...f.src])].slice(0, 8) };
  if (meta.boost) tr.meta.boost = Math.max(meta.boost, tr.meta.boost || 0);
}
log(`discovered ${found.size} mints (${fresh} new); tracking ${Object.keys(state.tracked).length}`);

// ---- 2. market data for everything we track (plus mints we owe an outcome check) ----
const due = [];
for (const [mint, o] of Object.entries(state.obs)) for (const c of CHECKPOINTS) if (!o.checks[c.key] && t0 - o.t0 >= c.afterMs) { due.push(mint); break; }
const extra = [...new Set([...due, ...(paper?.open || []).map((p) => p.mint)])].filter((m) => !state.tracked[m] && isMint(m));
const trackedMints = Object.keys(state.tracked);
const allMints = [...trackedMints, ...extra];
const [{ jup, dat }, ds] = await Promise.all([jupiterBatch(allMints), dexscreenerBatch(allMints)]);
log(`market data: jupiter ${jup.size}, jupiter-data ${dat.size}, dexscreener ${ds.size} of ${allMints.length}`);
const feedsUp = jup.size + dat.size > 0;

const prelim = [];
for (const mint of trackedMints) {
  const tr = state.tracked[mint];
  const raw = { jup: jup.get(mint), dat: dat.get(mint) || live.get(mint)?.dat, ds: ds.get(mint), meta: { ...tr.meta, jup: live.get(mint)?.jup }, rc: tr.rc };
  if (!raw.jup && !raw.dat && !raw.ds && !raw.meta.jup) {
    if (feedsUp && (tr.miss = (tr.miss || 0) + 1) >= 2) delete state.tracked[mint];
    continue;
  }
  tr.miss = 0;
  const t = buildToken(mint, raw, t0);
  if (t.ageMin == null || t.ageMin > MAX_AGE_MIN) { delete state.tracked[mint]; continue; }
  const trades = t.tx.h24[0] + t.tx.h24[1];
  const traction = (t.liq ?? 0) >= 1000 && t.price > 0 && (trades >= 20 || (t.holders ?? 0) >= 25);
  if (!traction) {
    if (t.ageMin > GRACE_MIN) delete state.tracked[mint];
    continue; // too new or too dead to say anything useful about
  }
  prelim.push(t);
}
prelim.sort((a, b) => (b.vol.h1 || 0) + (b.liq || 0) / 10 - ((a.vol.h1 || 0) + (a.liq || 0) / 10));
const shown = prelim.slice(0, DISPLAY_CAP);
log(`${prelim.length} tokens have traction; scoring ${shown.length}`);

// ---- 3. on-chain risk reports (cached; refreshed faster while a token is very young) ----
const needRc = shown
  .filter((t) => {
    const rc = state.tracked[t.mint].rc;
    return !rc || t0 - rc.at > (t.ageMin < 180 ? 40 : 240) * 60e3;
  })
  .sort((a, b) => (state.tracked[a.mint].rc ? 1 : 0) - (state.tracked[b.mint].rc ? 1 : 0))
  .slice(0, RUGCHECK_CAP);
const rcs = await rugcheckBatch(needRc.map((t) => t.mint));
for (const [mint, rc] of rcs) state.tracked[mint].rc = rc;
log(`rugcheck: ${rcs.size}/${needRc.length} reports fetched`);

// ---- 4. social lookups (cached per account/domain) ----
await enrichSocial(shown, state, t0);

// Rebuild with risk + social data attached.
let tokens = shown.map((p) => {
  const tr = state.tracked[p.mint];
  const t = buildToken(p.mint, { jup: jup.get(p.mint), dat: dat.get(p.mint) || live.get(p.mint)?.dat, ds: ds.get(p.mint), meta: { ...tr.meta, jup: live.get(p.mint)?.jup }, rc: tr.rc }, t0);
  for (const k of ['x', 'tg', 'web']) if (t.social[k] && tr.soc?.[k]) Object.assign(t.social[k], tr.soc[k]);
  // Same links on several different tokens = a link farm.
  const keys = socialKeys(t);
  let reuse = 0;
  for (const k of keys) {
    const seen = (state.socialSeen[k] ||= []);
    if (!seen.includes(t.mint)) seen.push(t.mint);
    if (seen.length > 30) seen.splice(0, seen.length - 30);
    reuse = Math.max(reuse, seen.length - 1);
  }
  t.social.reuse = reuse;
  if (tr.probe) Object.assign(t.safety, { sellable: tr.probe.sellable, impactPct: tr.probe.impactPct });
  t._tags = tagToken(t);
  return t;
});
// Several launches under one ticker: the deepest pool is the original, the rest ride its name.
const byTicker = new Map();
for (const t of tokens) {
  const k = t.symbol.toLowerCase();
  if (!byTicker.has(k)) byTicker.set(k, []);
  byTicker.get(k).push(t);
}
for (const group of byTicker.values()) {
  if (group.length < 2) continue;
  group.sort((a, b) => (b.liq || 0) - (a.liq || 0));
  for (const t of group.slice(1)) t.dupTicker = true;
}

// ---- 5. outcomes for the learning loop ----
const priceOf = (mint) => {
  const j = jup.get(mint) || dat.get(mint);
  const d = ds.get(mint);
  const price = Number(j?.usdPrice) || Number(d?.priceUsd) || 0;
  return price > 0 ? { price, liq: Number(d?.liquidity?.usd) || Number(j?.liquidity) || 0 } : null;
};
let labelled = 0;
if (feedsUp) {
  for (const [mint, o] of Object.entries(state.obs)) {
    for (const c of CHECKPOINTS) {
      if (o.checks[c.key] || t0 - o.t0 < c.afterMs) continue;
      const p = priceOf(mint);
      // Tokens that vanish from every feed are recorded as failures, otherwise survivors would flatter the model.
      o.checks[c.key] = p ? { price: p.price, liq: Math.round(p.liq), t: t0 } : { gone: true, t: t0 };
    }
    const y = labelOutcome(o);
    if (y == null) continue;
    const c = o.checks.h24;
    state.samples.push({ t: o.t0, x: o.x, y, score: o.score, ret: c.gone || !(o.price0 > 0) ? -1 : +(c.price / o.price0 - 1).toFixed(3) });
    delete state.obs[mint];
    labelled++;
  }
}
if (state.samples.length > MAX_SAMPLES) state.samples = state.samples.slice(-MAX_SAMPLES);
// Feature layout changes invalidate old rows.
state.samples = state.samples.filter((s) => s.x?.length === FEATURES.length);
if (labelled || !model || model.featureNames?.length !== FEATURES.length) model = train(state.samples, FEATURES);
log(`learning: ${labelled} new outcomes, ${state.samples.length} samples, ${Object.keys(state.obs).length} pending, model ${model.ready ? `ready (AUC ${model.testAuc?.toFixed(2)}, blend ${model.blend})` : 'not ready'}`);

// ---- 6. score ----
const scoreAll = (heat) => {
  for (const t of tokens) {
    const tf = heat ? trendFit(t, heat) : null;
    const sc = scoreToken(t, tf);
    const x = features(t, sc, tf);
    t.score = finalise(sc, predict(model, x), model.ready ? model.blend : 0);
    t._x = x;
    if (tf) t.tags = tf.tags;
  }
};
scoreAll(null); // first pass without trends, so narratives can be ranked by token quality
const trends = detectTrends(tokens, state.trendHist);
// Market-wide narratives nudge heat for matching buckets (dog, cat, ai ...).
for (const m of metas) {
  const h = trends.heat[m.slug] || trends.heat[`${m.slug}s`];
  if (h && m.chgH24 > 0) h.heat = Math.min(1, h.heat + 0.1);
}
trends.narratives.sort((a, b) => b.heat - a.heat);
scoreAll(trends.heat);

// ---- 7. sell-route probe for the best candidates, then re-score those ----
const probeList = tokens
  .filter((t) => t.score.total >= 55 && t.ageMin >= 20 && !t.score.gates.length && (!state.tracked[t.mint].probe || t0 - state.tracked[t.mint].probe.at > 2 * 3600e3))
  .sort((a, b) => b.score.total - a.score.total)
  .slice(0, SELL_PROBE_CAP);
for (const t of probeList) {
  const r = await sellProbe(t.mint, t.decimals, t.price);
  if (!r) continue;
  state.tracked[t.mint].probe = { ...r, at: t0 };
  Object.assign(t.safety, { sellable: r.sellable, impactPct: r.impactPct });
  const tf = trendFit(t, trends.heat);
  const sc = scoreToken(t, tf);
  t.score = finalise(sc, predict(model, t._x), model.ready ? model.blend : 0);
}
log(`sell probes: ${probeList.length}`);

// ---- 8. remember what we scored, so we can grade ourselves later ----
for (const t of tokens) {
  if (state.obs[t.mint] || state.tracked[t.mint].observed || t.ageMin < 5) continue;
  state.tracked[t.mint].observed = true;
  state.obs[t.mint] = { t0, price0: t.price, liq0: Math.round(t.liq || 0), x: t._x.map((v) => +(+v).toFixed(4)), score: t.score.total, checks: {} };
}
// Bound the queue: if runs were skipped for a long time, drop the stalest pending rows.
const obsKeys = Object.keys(state.obs);
if (obsKeys.length > 4000) for (const k of obsKeys.sort((a, b) => state.obs[a].t0 - state.obs[b].t0).slice(0, obsKeys.length - 4000)) delete state.obs[k];

// ---- 9. paper bot ----
const lookup = new Map();
for (const p of paper?.open || []) { const v = priceOf(p.mint); if (v) lookup.set(p.mint, v); }
if (feedsUp) paper = stepPaper(paper, tokens, lookup, t0);

// ---- 10. publish ----
tokens.sort((a, b) => b.score.total - a.score.total);
const pub = tokens.map(({ _tags, _x, decimals, src, traders, holderChg, ...t }) => {
  t.ageMin = Math.round(t.ageMin);
  // Team paid DEX Screener for a profile, boost or takeover listing (a filter on the site, not a quality signal).
  t.promo = t.boosts > 0 || (src || []).some((s) => s.startsWith('ds:'));
  for (const k of ['price', 'liq', 'mcap']) if (t[k] != null) t[k] = +(+t[k]).toPrecision(6);
  for (const k of Object.keys(t.vol)) t.vol[k] = Math.round(t.vol[k] || 0);
  for (const k of Object.keys(t.chg)) if (t.chg[k] != null) t.chg[k] = +(+t.chg[k]).toFixed(1);
  for (const k of ['top10', 'devPct', 'maxHolderPct', 'organic']) if (t[k] != null) t[k] = +(+t[k]).toFixed(1);
  for (const k of ['sniperPct', 'insiderPct', 'bundlePct', 'botHolderPct', 'impactPct', 'lpLocked']) if (t.safety[k] != null) t.safety[k] = +(+t.safety[k]).toFixed(1);
  return t;
});
const flagged = pub.filter((t) => t.score.gates.length).length;
state.trendHist.push({ t: t0, shares: trends.shares });
if (state.trendHist.length > 48) state.trendHist = state.trendHist.slice(-48);

// Keep the tracking set bounded: least interesting, oldest first.
const keep = new Set(tokens.map((t) => t.mint));
const overflow = Object.keys(state.tracked).length - TRACK_CAP;
if (overflow > 0) {
  const victims = Object.entries(state.tracked).filter(([m]) => !keep.has(m)).sort((a, b) => a[1].firstSeen - b[1].firstSeen).slice(0, overflow);
  for (const [m] of victims) delete state.tracked[m];
}
for (const k of Object.keys(state.socialSeen)) if (!state.socialSeen[k].length) delete state.socialSeen[k];
const seenKeys = Object.keys(state.socialSeen);
if (seenKeys.length > 6000) for (const k of seenKeys.slice(0, seenKeys.length - 6000)) delete state.socialSeen[k];

const { weights, bias, mean, std, ...publicModel } = model;
// If every market feed was down, keep the previously published token list rather than blanking the site.
const publishTokens = feedsUp || !(await readJson(join(DATA, 'tokens.json'), null));
await Promise.all([
  publishTokens && writeJson(join(DATA, 'tokens.json'), {
    generatedAt: t0,
    runMs: now() - t0,
    repo: process.env.GITHUB_REPOSITORY || null,
    counts: { discovered: found.size, tracked: Object.keys(state.tracked).length, scored: pub.length, flagged },
    sources: httpStats(),
    tokens: pub,
  }),
  writeJson(join(DATA, 'trends.json'), { generatedAt: t0, narratives: trends.narratives, market: metas }),
  writeJson(join(DATA, 'model.json'), { ...publicModel, minSamples: MIN_SAMPLES_TO_TRAIN, pending: Object.keys(state.obs).length, calibration: calibration(state.samples) }),
  writeJson(join(DATA, 'model-internal.json'), model),
  writeJson(join(DATA, 'paper.json'), paper),
  writeJson(join(DATA, 'state.json'), state),
]);

const top = pub.filter((t) => !t.score.gates.length).slice(0, 5).map((t) => `${t.symbol}:${t.score.total}`).join('  ');
log(`published ${pub.length} tokens (${flagged} flagged). Top: ${top || 'none'}`);
log('http', JSON.stringify(httpStats()));
if (!feedsUp) console.error('All market data sources failed this run - previous data kept.');
