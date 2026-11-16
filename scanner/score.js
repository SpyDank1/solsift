// Scoring: 0-100 per token.
//
// Two layers, on purpose:
//   1. HARD GATES - structural rug mechanics (live freeze/mint authority,
//      dangerous Token-2022 extensions, pullable LP, dust liquidity, one wallet
//      owning the supply). A gated token is capped low no matter how good the
//      rest looks, and the learned model is never allowed to override a gate.
//   2. WEIGHTED COMPONENTS - safety/distribution 35, market health 20, organic
//      momentum 25, social credibility 10, trend fit 10. These priors come from
//      published research (see README); the learning loop then shifts the final
//      number toward what has actually worked.
//
// Unknown is never treated as good: a missing data point scores below neutral.
import { clamp, log10p, num } from './math.js';

export const WEIGHTS = { safety: 35, market: 20, momentum: 25, social: 10, trend: 10 };

const lerp = (x, x0, x1, y0, y1) => y0 + clamp((x - x0) / (x1 - x0)) * (y1 - y0);
/** Piecewise-linear lookup: pts = [[x, y], ...] ascending in x. */
function curve(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) return lerp(x, pts[i - 1][0], pts[i][0], pts[i - 1][1], pts[i][1]);
  return pts[pts.length - 1][1];
}
const pct = (x) => `${(+x).toFixed(x < 10 ? 1 : 0)}%`;
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);

/** Weighted mean of [score, weight] parts, ignoring nulls. */
function blend(parts) {
  let s = 0;
  let w = 0;
  for (const [v, wt] of parts) if (v != null) { s += v * wt; w += wt; }
  return w ? s / w : 0;
}

const DANGEROUS_EXT = ['permanentdelegate', 'transferhook', 'nontransferable', 'defaultaccountstate', 'pausable'];

function gates(t) {
  const s = t.safety || {};
  const g = [];
  const add = (cap, msg) => g.push({ cap, msg });
  if (s.rugged) add(5, 'Marked as already rugged');
  if (s.freezeRevoked === false) add(12, 'Freeze authority is active - holders can be frozen (honeypot mechanic)');
  if (s.mintRevoked === false) add(15, 'Mint authority is active - supply can be inflated at will');
  for (const e of s.ext || []) {
    const k = String(e.name || e).toLowerCase().replace(/[^a-z]/g, '');
    if (DANGEROUS_EXT.some((d) => k.includes(d))) add(12, `Token-2022 extension "${e.name || e}" lets the issuer control holder balances or block sells`);
    if (k.includes('transferfee') && num(e.feePct, 0) > 5) add(15, `Token-2022 transfer fee of ${pct(e.feePct)}`);
  }
  if (s.sellable === false) add(30, 'Jupiter found no route to sell this token back to SOL');
  if (t.liq != null && t.liq < 1000) add(15, `Liquidity is only ${usd(t.liq)} - effectively untradeable`);
  else if (t.liq != null && t.liq < 5000) add(32, `Very thin liquidity (${usd(t.liq)})`);
  if (s.lpUnlockedRisk) add(22, 'Risk engine reports a large share of LP is unlocked - liquidity can be pulled');
  else if (!t.onCurve && s.lpLocked != null && s.lpLocked < 50 && (t.liq || 0) < 250000) add(22, `Only ${pct(s.lpLocked)} of LP is locked or burned - liquidity can be pulled`);
  // Raw top-holder lists include curve and vault accounts, so only gate when the risk engine agrees.
  if (num(t.maxHolderPct, 0) > 30 && s.singleHolderRisk) add(15, `A single wallet holds ${pct(t.maxHolderPct)} of supply`);
  if (num(s.devMints, 0) >= 100 && s.devMigrations === 0) add(30, `Serial deployer: creator launched ${s.devMints} tokens and none graduated`);
  if (num(s.bundlePct, 0) > 50 || num(s.insiderPct, 0) > 50) add(15, 'Over half the supply sits in bundled or insider wallets');
  if (s.creatorRugRisk) add(15, 'Risk engine reports the creator has a history of rugged tokens');
  if (num(t.top10, 0) > 70) add(25, `Top 10 holders own ${pct(t.top10)} of supply`);
  return g;
}

function safety(t, pros, cons) {
  const s = t.safety || {};
  const parts = [];
  // Authorities
  if (s.mintRevoked === true && s.freezeRevoked === true) { parts.push([100, 2]); pros.push('Mint and freeze authority revoked'); }
  else if (s.mintRevoked == null && s.freezeRevoked == null) parts.push([40, 2]);
  else parts.push([s.mintRevoked === false || s.freezeRevoked === false ? 0 : 70, 2]);
  // Holder concentration (thresholds: Solana Tracker / Mobula / MadeOnSol risk tables)
  if (t.top10 != null) {
    const v = curve(t.top10, [[10, 100], [15, 92], [25, 72], [40, 42], [60, 15], [80, 0]]);
    parts.push([v, 3]);
    if (t.top10 <= 20) pros.push(`Well distributed: top 10 hold ${pct(t.top10)}`);
    else if (t.top10 > 40) cons.push(`Concentrated: top 10 hold ${pct(t.top10)}`);
  } else parts.push([40, 3]);
  if (t.devPct != null) {
    parts.push([curve(t.devPct, [[0, 100], [3, 90], [5, 65], [10, 30], [20, 5]]), 1.5]);
    if (t.devPct > 10) cons.push(`Developer still holds ${pct(t.devPct)}`);
  }
  // Liquidity lock
  if (t.onCurve) parts.push([75, 2]); // bonding curve: no LP token to pull, but pre-graduation
  else if (s.lpLocked != null) {
    parts.push([curve(s.lpLocked, [[0, 5], [50, 35], [90, 80], [99, 100]]), 2]);
    if (s.lpLocked >= 95) pros.push(`${pct(s.lpLocked)} of LP locked or burned`);
  } else parts.push([40, 2]);
  // Bundles / insiders / snipers (>5 warn, >15 danger, >30 severe)
  const bundle = Math.max(num(s.bundlePct, -1), num(s.insiderPct, -1), num(s.sniperPct, -1));
  if (bundle >= 0) {
    parts.push([curve(bundle, [[0, 100], [5, 80], [15, 45], [30, 15], [50, 0]]), 2.5]);
    if (bundle > 15) cons.push(`${pct(bundle)} of supply held by bundled/insider/sniper wallets`);
    else if (bundle <= 5) pros.push('No meaningful bundle or insider cluster detected');
  }
  // Third-party risk engine (0 = clean, 100 = worst after normalisation)
  if (s.riskNorm != null) {
    parts.push([100 - clamp(s.riskNorm, 0, 100), 2.5]);
    if (s.riskNorm >= 50) cons.push('Risk engine reports a high-risk profile');
  } else parts.push([35, 2.5]);
  const danger = (s.risks || []).filter((r) => r.l === 'danger').length;
  const warn = (s.risks || []).filter((r) => r.l === 'warn').length;
  if (danger || warn) parts.push([clamp(100 - danger * 35 - warn * 12, 0, 100), 1.5]);
  if (s.verified) { parts.push([100, 1]); pros.push('Verified token on Jupiter'); }
  if (s.devMints >= 20) {
    const rate = num(s.devMigrations, 0) / s.devMints;
    parts.push([curve(rate, [[0, 5], [0.03, 30], [0.15, 70], [0.4, 95]]), 1.5]);
    if (rate < 0.03) cons.push(`Creator has launched ${s.devMints} tokens; only ${s.devMigrations || 0} graduated`);
  }
  if (s.sus) { parts.push([10, 1.5]); cons.push('Jupiter marks this token as suspicious'); }
  if (num(s.botHolderPct, 0) > 40) { parts.push([15, 1]); cons.push(`${pct(s.botHolderPct)} of holders look like bots`); }
  if (num(t.maxHolderPct, 0) > 30 && !s.singleHolderRisk) cons.push(`Largest non-pool account holds ${pct(t.maxHolderPct)} (may be a vault - verify)`);
  if (!s.checked) cons.push('Not yet covered by the on-chain risk report');
  return blend(parts);
}

function market(t, pros, cons) {
  const parts = [];
  if (t.liq != null) {
    // <$1k dead (Solidus), comfort grows on a log scale up to ~$200k.
    parts.push([curve(Math.log10(Math.max(t.liq, 1)), [[3, 0], [3.7, 22], [4, 40], [4.4, 58], [4.7, 72], [5, 85], [5.3, 96]]), 4]);
    if (t.liq >= 50000) pros.push(`Deep liquidity (${usd(t.liq)})`);
    else if (t.liq < 10000) cons.push(`Thin liquidity (${usd(t.liq)})`);
  } else parts.push([15, 4]);
  if (t.liq && t.mcap) {
    const r = t.liq / t.mcap;
    // No validated band exists; only punish extremes (paper-thin float, or mcap that is nearly all pool).
    parts.push([curve(r, [[0.005, 10], [0.03, 55], [0.08, 90], [0.4, 90], [0.9, 55]]), 1.5]);
    if (r < 0.02) cons.push(`Liquidity is only ${pct(r * 100)} of market cap - exits will move price hard`);
  }
  if (t.ageMin != null) {
    // Median time-to-rug is ~35 minutes: surviving longer is real information.
    parts.push([curve(t.ageMin, [[0, 15], [35, 35], [120, 60], [720, 82], [2880, 95]]), 2]);
    if (t.ageMin < 35) cons.push('Under 35 minutes old - inside the typical rug window');
  }
  if (t.mcap != null) parts.push([curve(Math.log10(Math.max(t.mcap, 1)), [[3.5, 10], [4.5, 45], [5.5, 80], [7, 90], [8.5, 70]]), 1]);
  return blend(parts);
}

function momentum(t, pros, cons, flags) {
  const parts = [];
  const tx = t.tx?.h1 || [0, 0];
  const n1 = tx[0] + tx[1];
  const v1 = t.vol?.h1 || 0;
  parts.push([curve(Math.log10(n1 + 1), [[0.5, 0], [1.5, 30], [2.3, 62], [3, 85], [3.7, 95]]), 2.5]);
  if (n1 >= 20) {
    const buyShare = tx[0] / n1;
    parts.push([curve(buyShare, [[0.25, 5], [0.42, 45], [0.52, 90], [0.7, 90], [0.88, 45], [0.98, 10]]), 2]);
    if (buyShare < 0.38) cons.push(`Sell pressure: only ${pct(buyShare * 100)} of trades are buys`);
    if (buyShare > 0.92) { flags.push('Almost no sells - check the token can actually be sold'); }
    // Wash-trade tells: tiny uniform trades, or turnover far beyond what the pool can support.
    const avgTrade = v1 / n1;
    parts.push([curve(avgTrade, [[5, 5], [20, 35], [60, 75], [300, 95]]), 1.5]);
    if (avgTrade < 15 && n1 > 200) flags.push(`Average trade is ${usd(avgTrade)} across ${n1} trades - looks like volume botting`);
    if (t.traders > 0) {
      const perTrader = n1 / t.traders;
      parts.push([curve(perTrader, [[1.5, 95], [4, 70], [8, 35], [15, 5]]), 1.5]);
      if (perTrader > 8 && n1 > 100) flags.push(`${n1} trades from only ${t.traders} wallets in the last hour - likely wash trading`);
    }
  }
  if (t.liq > 0 && v1 > 0) {
    const turn = v1 / t.liq;
    parts.push([curve(turn, [[0.02, 15], [0.2, 65], [1, 92], [5, 80], [15, 35], [40, 5]]), 1.5]);
    if (turn > 15) flags.push(`Hourly volume is ${turn.toFixed(0)}x liquidity - implausible without wash trading`);
  }
  // Volume persistence after the first burst (only meaningful once the pair is a few hours old).
  if (t.ageMin > 180 && t.vol?.h6 > 0) {
    const persist = v1 / (t.vol.h6 / 6);
    parts.push([curve(persist, [[0.05, 5], [0.4, 45], [0.9, 80], [2, 95]]), 2]);
    if (persist < 0.2) cons.push('Volume has collapsed versus the last 6 hours');
    else if (persist > 1.2) pros.push('Volume is accelerating, not fading');
  }
  const c1 = t.chg?.h1;
  if (c1 != null) {
    parts.push([curve(c1, [[-70, 0], [-30, 30], [0, 62], [40, 88], [200, 78], [1000, 55]]), 1.5]);
    if (c1 <= -50) cons.push(`Price down ${pct(-c1)} in the last hour`);
  }
  if (t.holders != null) {
    parts.push([curve(Math.log10(t.holders + 1), [[1, 0], [2, 35], [2.7, 62], [3.3, 85], [4, 97]]), 2]);
    if (t.holders >= 1000) pros.push(`${t.holders.toLocaleString('en-US')} holders`);
    else if (t.holders < 60) cons.push(`Only ${t.holders} holders`);
  }
  if (t.organic != null) {
    // Jupiter organic score filters bot wallets out of volume/holder activity.
    parts.push([clamp(t.organic, 0, 100), 3]);
    if (t.organic >= 60) pros.push(`High organic activity score (${Math.round(t.organic)})`);
    else if (t.organic < 15 && n1 > 100) cons.push('Activity looks mostly non-organic');
  }
  return blend(parts);
}

/** Social credibility 0-100. Also exported for the social module's tests. */
export function social(t, pros = [], cons = [], flags = []) {
  const so = t.social || {};
  const parts = [];
  const x = so.x;
  if (!x && !so.tg && !so.web) { cons.push('No social links at all'); return 8; }
  if (x) {
    if (x.missing) { parts.push([8, 4]); cons.push('Linked X account was not found (suspended, renamed or deleted)'); }
    else if (x.kind === 'profile' && x.ageDays != null) {
      const age = curve(x.ageDays, [[0, 0], [14, 12], [60, 35], [180, 60], [365, 80], [1095, 100]]);
      parts.push([age, 4]);
      if (x.ageDays >= 365) pros.push(`X account is ${(x.ageDays / 365).toFixed(1)} years old`);
      else if (x.ageDays < 30) cons.push(`X account is only ${Math.round(x.ageDays)} days old`);
      if (x.followers != null) {
        parts.push([curve(Math.log10(x.followers + 1), [[1.5, 0], [2.5, 30], [3.3, 60], [4, 80], [5, 100]]), 3]);
        // Bought audiences show up as huge follower counts on very young accounts.
        const perDay = x.followers / Math.max(x.ageDays, 1);
        if (x.ageDays < 60 && perDay > 400) { parts.push([10, 3]); flags.push(`X account gained ~${Math.round(perDay)} followers/day since creation - likely purchased`); }
        if (x.followers >= 5000 && x.ageDays >= 180) pros.push(`${x.followers.toLocaleString('en-US')} X followers on an established account`);
      }
      if (x.tweets != null && x.ageDays > 30 && x.tweets < 10) { parts.push([20, 1.5]); cons.push('X account has almost no posts'); }
      if (x.mentionsToken === true) { parts.push([100, 2]); pros.push('X profile references this token'); }
      // An old, large account that never mentions the token is the classic "borrowed credibility" trick.
      else if (x.mentionsToken === false && x.followers > 20000) { parts.push([10, 3]); flags.push('Linked X account is large but does not mention this token - may be unrelated'); }
    } else if (x.kind === 'profile') parts.push([30, 4]); // has a profile link, lookup failed: unknown, not good
    else parts.push([22, 4]); // a tweet, search or community link instead of an account
  } else cons.push('No X account');
  if (so.tg) {
    if (so.tg.members != null) parts.push([curve(Math.log10(so.tg.members + 1), [[1, 5], [2, 35], [3, 70], [4, 95]]), 2]);
    else parts.push([35, 1.5]);
  }
  if (so.web) {
    if (so.web.related === false && (so.web.ageDays == null || so.web.ageDays > 180)) {
      parts.push([25, 2]);
      cons.push('Website domain does not match the token - may be an unrelated site');
    } else if (so.web.ageDays != null) {
      parts.push([curve(so.web.ageDays, [[0, 5], [7, 20], [90, 55], [365, 85], [1095, 100]]), 2]);
      if (so.web.ageDays >= 365) pros.push(`Website domain registered ${(so.web.ageDays / 365).toFixed(1)} years ago`);
      else if (so.web.ageDays < 7) cons.push('Website domain registered within the last week');
    } else parts.push([so.web.alive === false ? 5 : 40, 1.5]);
    if (so.web.alive === false) cons.push('Website link is dead');
  }
  if (num(so.reuse, 0) >= 3) { parts.push([0, 5]); flags.push(`Same social links were used by ${so.reuse} other tokens`); }
  return blend(parts);
}

export function verdictFor(total, gated) {
  if (gated) return total <= 15 ? 'Likely rug' : 'High risk';
  if (total >= 75) return 'Strong';
  if (total >= 60) return 'Promising';
  if (total >= 45) return 'Speculative';
  if (total >= 25) return 'Weak';
  return 'Avoid';
}

/**
 * Rule-based score. `trend` is { fit: 0..1, copycat } from trends.js (optional
 * on the first pass, before narratives for this run are known).
 */
export function scoreToken(t, trend = null) {
  const pros = [];
  const cons = [];
  const flags = [];
  const comp = {
    safety: safety(t, pros, cons),
    market: market(t, pros, cons),
    momentum: momentum(t, pros, cons, flags),
    social: social(t, pros, cons, flags),
    trend: trend ? clamp(20 + 80 * trend.fit, 0, 100) : 35,
  };
  if (t.safety?.iconReused) flags.push('Token image is reused from another token');
  if (t.safety?.copycatRisk) flags.push('Risk engine reports this as a copycat of another token');
  else if (t.dupTicker) flags.push('Shares its ticker with a larger token in this scan - possible copycat');
  if (t.safety?.impactPct > 15) flags.push(`Selling $100 would move the price ${pct(t.safety.impactPct)}`);
  if (trend?.copycat) { comp.trend = Math.min(comp.trend, 15); flags.push('Name matches a cluster of low-volume copycat launches'); }
  else if (trend && trend.fit >= 0.55) pros.push('Fits a narrative that is attracting volume right now');
  let rule = 0;
  for (const k of Object.keys(WEIGHTS)) rule += (WEIGHTS[k] * comp[k]) / 100;
  // Each unresolved red flag costs points even when no hard gate fires.
  rule -= Math.min(15, flags.length * 5);
  const g = gates(t);
  const cap = g.length ? Math.min(...g.map((x) => x.cap)) : 100;
  for (const k of Object.keys(comp)) comp[k] = Math.round(comp[k]);
  return { rule: clamp(rule, 0, 100), cap, gates: g.map((x) => x.msg), comp, pros: pros.slice(0, 8), cons: cons.slice(0, 8), flags };
}

/** Combine the rule score with the learned model's probability. */
export function finalise(sc, pGood, modelBlend) {
  let total = sc.rule;
  if (pGood != null && modelBlend > 0) total = (1 - modelBlend) * sc.rule + modelBlend * 100 * pGood;
  total = Math.round(clamp(Math.min(total, sc.cap), 0, 100));
  return {
    total,
    rule: Math.round(sc.rule),
    ml: pGood == null ? null : +pGood.toFixed(3),
    verdict: verdictFor(total, sc.gates.length > 0),
    comp: sc.comp,
    gates: sc.gates,
    flags: sc.flags,
    pros: sc.pros,
    cons: sc.cons,
  };
}

// ---- Feature vector for the learning loop (fixed order; append only) ----
export const FEATURES = [
  'log_liquidity', 'liq_to_mcap', 'log_vol_h1', 'vol_h1_to_liq', 'buy_share_h1', 'log_txns_h1', 'avg_trade_usd_log',
  'price_chg_h1', 'log_age_min', 'top10_pct', 'top10_known', 'log_holders', 'risk_norm', 'lp_locked', 'authorities_revoked',
  'organic_score', 'has_x', 'log_x_followers', 'log_x_age_days', 'has_telegram', 'has_website', 'boosted', 'trend_fit',
  'on_curve', 'flag_count', 'safety_c', 'market_c', 'momentum_c', 'social_c',
];

export function features(t, sc, trend) {
  const tx = t.tx?.h1 || [0, 0];
  const n1 = tx[0] + tx[1];
  const v1 = t.vol?.h1 || 0;
  const s = t.safety || {};
  const x = t.social?.x;
  return [
    log10p(t.liq),
    t.liq && t.mcap ? clamp(t.liq / t.mcap, 0, 1) : 0,
    log10p(v1),
    t.liq > 0 ? clamp(v1 / t.liq, 0, 40) : 0,
    n1 ? tx[0] / n1 : 0.5,
    log10p(n1),
    n1 ? log10p(v1 / n1) : 0,
    clamp(num(t.chg?.h1, 0), -100, 500) / 100,
    log10p(t.ageMin),
    t.top10 != null ? clamp(t.top10, 0, 100) / 100 : 0.4,
    t.top10 != null ? 1 : 0,
    log10p(t.holders),
    s.riskNorm != null ? clamp(s.riskNorm, 0, 100) / 100 : 0.5,
    t.onCurve ? 1 : s.lpLocked != null ? clamp(s.lpLocked, 0, 100) / 100 : 0.4,
    s.mintRevoked === true && s.freezeRevoked === true ? 1 : 0,
    t.organic != null ? clamp(t.organic, 0, 100) / 100 : 0,
    x ? 1 : 0,
    log10p(x?.followers),
    log10p(x?.ageDays),
    t.social?.tg ? 1 : 0,
    t.social?.web ? 1 : 0,
    num(t.boosts, 0) > 0 ? 1 : 0,
    trend?.fit ?? 0,
    t.onCurve ? 1 : 0,
    Math.min(4, sc.flags.length + sc.gates.length),
    sc.comp.safety / 100,
    sc.comp.market / 100,
    sc.comp.momentum / 100,
    sc.comp.social / 100,
  ];
}
