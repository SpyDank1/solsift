// Your paper bot: simulated money, rules you set.
//
// It runs in this browser tab (so only while the page is open), looks at the
// same tokens you see, and "buys" and "sells" according to the rules below.
// Nothing here can sign a transaction or touch a wallet. Its purpose is to
// let you see, in numbers, what a set of rules would have done before you
// risk real funds on them.
//
// Buy rules reuse the exact measurements from "My filters" (userfilters.js),
// plus a minimum score. Sell rules are the usual exits: take profit, stop
// loss, trailing stop, time limit, a rug flag appearing, the score falling,
// or liquidity draining.
import { LIMITS, SWITCHES, passes } from './userfilters.js';

const KEY = 'solsift.bot.v1';

export const BOT_DEFAULTS = {
  enabled: true,
  feed: 'both', // 'scored' | 'live' | 'both'
  entry: { minScore: 65, allowFlagged: false, limits: { liqMin: 10000, ageMin: 10 }, switches: {}, strict: true },
  exit: { takeProfit: 100, stopLoss: 35, trailing: null, maxHoldMin: 1440, onRugFlag: true, scoreBelow: null, liqDrop: 60 },
  size: { startUsd: 1000, stakeUsd: 25, maxOpen: 10, costPct: 1.5 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const numOrNull = (v) => (Number.isFinite(v) ? v : null);
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);
const fmtVal = (v, unit) => (unit === '$' ? usd(v) : unit === '%' ? `${(+v).toFixed(1)}%` : unit === 'min' ? `${Math.round(v)} min` : `${Math.round(v)}${unit && unit !== '/100' ? ' ' + unit : ''}`);

export function newPortfolio(rules, now = Date.now()) {
  return { cash: rules.size.startUsd, start: rules.size.startUsd, startedAt: now, open: [], closed: [], curve: [[now, rules.size.startUsd]], lastStep: 0 };
}

export function loadBot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* corrupted or blocked */ }
  const rules = clone(BOT_DEFAULTS);
  if (saved && saved.rules) {
    const r = saved.rules;
    rules.enabled = r.enabled !== false;
    if (['scored', 'live', 'both'].includes(r.feed)) rules.feed = r.feed;
    Object.assign(rules.entry, { ...(r.entry || {}), limits: { ...((r.entry || {}).limits || {}) }, switches: { ...((r.entry || {}).switches || {}) } });
    Object.assign(rules.exit, r.exit || {});
    Object.assign(rules.size, r.size || {});
  }
  const pf = saved && saved.pf && Array.isArray(saved.pf.open) ? saved.pf : newPortfolio(rules);
  return { rules, pf };
}
export function saveBot(bot) {
  try { localStorage.setItem(KEY, JSON.stringify(bot)); } catch { /* ignore */ }
}
export function resetRules() { return clone(BOT_DEFAULTS); }

/** Does token `t` satisfy the buy rules? Returns { ok, why: [facts that were checked and passed] }. */
export function entryCheck(t, rules, live = false) {
  const e = rules.entry;
  const why = [];
  if (!t || !t.score || !(t.price > 0)) return { ok: false, why };
  if (t.score.total < e.minScore) return { ok: false, why };
  why.push(`score ${t.score.total} (needs ${e.minScore}+)`);
  if (!e.allowFlagged && (t.score.gates || []).length) return { ok: false, why };
  if (!e.allowFlagged) why.push('no hard red flags');
  if (!passes(t, e, live)) return { ok: false, why };
  for (const l of LIMITS) {
    const lim = e.limits[l.id];
    if (!Number.isFinite(lim) || (live && l.scoredOnly)) continue;
    const v = l.get(t);
    if (v != null && Number.isFinite(v)) why.push(`${l.label.toLowerCase()} ${fmtVal(lim, l.unit)}: ${fmtVal(v, l.unit)}`);
  }
  for (const s of SWITCHES) if (e.switches[s.id]) why.push(s.label.toLowerCase());
  return { ok: true, why };
}

/** Plain-language description of the rules, for the page. */
export function describeRules(rules) {
  const e = rules.entry;
  const x = rules.exit;
  const s = rules.size;
  const feed = rules.feed === 'both' ? 'the scored feed or the live launches' : rules.feed === 'live' ? 'the live launches' : 'the scored feed';
  const buys = [`It is in ${feed}.`, `Its score is ${e.minScore} or higher.`];
  buys.push(e.allowFlagged ? 'Tokens with hard red flags are allowed (risky).' : 'It has no hard red flags (a token flagged high risk or likely rug is never bought).');
  for (const l of LIMITS) if (Number.isFinite(e.limits[l.id])) buys.push(`${l.label} ${fmtVal(e.limits[l.id], l.unit)}${l.scoredOnly ? ' (checked on scored-feed tokens only)' : ''}.`);
  for (const sw of SWITCHES) if (e.switches[sw.id]) buys.push(`${sw.label}.`);
  buys.push(`It has not been traded by the bot before, fewer than ${s.maxOpen} positions are open, and there is at least ${usd(s.stakeUsd)} of paper cash.`);
  const sells = [];
  if (numOrNull(x.takeProfit) != null) sells.push(`Take profit: the position is up ${x.takeProfit}% or more after costs.`);
  if (numOrNull(x.stopLoss) != null) sells.push(`Stop loss: the position is down ${x.stopLoss}% or more after costs.`);
  if (numOrNull(x.trailing) != null) sells.push(`Trailing stop: after being in profit, the price falls ${x.trailing}% from its highest point.`);
  if (x.onRugFlag) sells.push('A hard red flag appears on the token after buying.');
  if (numOrNull(x.scoreBelow) != null) sells.push(`The score drops below ${x.scoreBelow}.`);
  if (numOrNull(x.liqDrop) != null) sells.push(`Liquidity falls ${x.liqDrop}% or more from what it was at the buy.`);
  if (numOrNull(x.maxHoldMin) != null) sells.push(`Time limit: it has been held for ${x.maxHoldMin >= 120 ? (x.maxHoldMin / 60).toFixed(x.maxHoldMin % 60 ? 1 : 0) + ' hours' : x.maxHoldMin + ' minutes'}.`);
  sells.push('No price can be found for 15 minutes: counted as a total loss.');
  return { buys, sells, sizing: `Each buy is ${usd(s.stakeUsd)} of paper money from a ${usd(s.startUsd)} starting balance. ${s.costPct}% is charged on every buy and sell for fees and slippage.` };
}

/**
 * One decision round.
 * @param pf          portfolio (mutated)
 * @param rules       bot rules
 * @param candidates  [{ t, live }] tokens currently visible to the bot
 * @param quoteOf     (mint) => { price, liq, at, gated, score } | null   freshest known price
 * @returns { events: [{ type:'buy'|'sell', ... }], needQuote: [mints wanting a fresh price before a buy] }
 */
export function stepBot(pf, rules, candidates, quoteOf, now = Date.now()) {
  const x = rules.exit;
  const s = rules.size;
  const cost = Math.max(0, s.costPct) / 100;
  const events = [];
  const stillOpen = [];

  for (const pos of pf.open) {
    const q = quoteOf(pos.mint);
    let reason = null;
    let price = q && q.price > 0 && now - q.at < 10 * 60e3 ? q.price : null;
    if (price == null) {
      if (now - pos.lastAt > 15 * 60e3) { reason = 'no price for 15 minutes (pool gone)'; price = 0; }
    } else {
      pos.last = price;
      pos.lastAt = q.at;
      pos.peak = Math.max(pos.peak || 0, price);
      // Profit and loss are judged after costs: what you would actually walk away with.
      const ret = ((pos.units * price * (1 - cost)) / pos.stake - 1) * 100;
      if (numOrNull(x.takeProfit) != null && ret >= x.takeProfit) reason = `take profit (+${x.takeProfit}%)`;
      else if (numOrNull(x.stopLoss) != null && ret <= -x.stopLoss) reason = `stop loss (-${x.stopLoss}%)`;
      else if (numOrNull(x.trailing) != null && pos.peak > pos.buyPrice && price <= pos.peak * (1 - x.trailing / 100)) reason = `trailing stop (${x.trailing}% off the high)`;
      else if (x.onRugFlag && q.gated) reason = 'hard red flag appeared';
      else if (numOrNull(x.scoreBelow) != null && q.score != null && q.score < x.scoreBelow) reason = `score fell to ${q.score}`;
      else if (numOrNull(x.liqDrop) != null && q.liq != null && pos.liq0 > 0 && q.liq < pos.liq0 * (1 - x.liqDrop / 100)) reason = `liquidity down ${Math.round((1 - q.liq / pos.liq0) * 100)}%`;
      else if (numOrNull(x.maxHoldMin) != null && now - pos.t0 >= x.maxHoldMin * 60e3) reason = 'time limit';
    }
    const mark = price != null ? price : pos.last;
    pos.pct = +(((pos.units * mark * (1 - cost)) / pos.stake - 1) * 100).toFixed(1);
    if (reason) {
      const proceeds = pos.units * (price || 0) * (1 - cost);
      pf.cash += proceeds;
      const done = { mint: pos.mint, symbol: pos.symbol, t0: pos.t0, t1: now, score: pos.score, pct: +((proceeds / pos.stake - 1) * 100).toFixed(1), pnl: +(proceeds - pos.stake).toFixed(2), reason, why: pos.why };
      pf.closed.push(done);
      events.push({ type: 'sell', ...done });
    } else stillOpen.push(pos);
  }
  pf.open = stillOpen;

  const needQuote = [];
  if (rules.enabled) {
    const held = new Set(pf.open.map((p) => p.mint));
    const traded = new Set(pf.closed.slice(-300).map((p) => p.mint));
    const picks = [];
    for (const c of candidates) {
      if (!c || !c.t || held.has(c.t.mint) || traded.has(c.t.mint)) continue;
      if (rules.feed !== 'both' && (rules.feed === 'live') !== !!c.live) continue;
      const chk = entryCheck(c.t, rules, !!c.live);
      if (chk.ok) picks.push({ ...c, why: chk.why });
    }
    picks.sort((a, b) => b.t.score.total - a.t.score.total);
    const seen = new Set();
    for (const p of picks) {
      if (seen.has(p.t.mint)) continue;
      seen.add(p.t.mint);
      if (pf.open.length >= s.maxOpen || pf.cash < s.stakeUsd) break;
      const q = quoteOf(p.t.mint);
      // Never "buy" at a stale price: ask for a fresh one and decide next round.
      if (!q || !(q.price > 0) || now - q.at > 90e3) { if (needQuote.length < 15) needQuote.push(p.t.mint); continue; }
      const buyPrice = q.price * (1 + cost);
      pf.cash -= s.stakeUsd;
      const pos = { mint: p.t.mint, symbol: p.t.symbol, name: p.t.name, icon: p.t.icon, t0: now, stake: s.stakeUsd, buyPrice, units: s.stakeUsd / buyPrice, liq0: q.liq ?? p.t.liq ?? 0, peak: q.price, last: q.price, lastAt: q.at, score: p.t.score.total, live: !!p.live, why: p.why, pct: +(((1 - cost) / (1 + cost) - 1) * 100).toFixed(1) };
      pf.open.push(pos);
      events.push({ type: 'buy', mint: pos.mint, symbol: pos.symbol, score: pos.score, why: pos.why, t0: now, live: pos.live });
    }
  }

  const openValue = pf.open.reduce((sum, p) => sum + p.units * (p.last || 0) * (1 - cost), 0);
  pf.equity = +(pf.cash + openValue).toFixed(2);
  if (now - (pf.curve.at(-1)?.[0] || 0) > 60e3 || events.length) pf.curve.push([now, pf.equity]);
  if (pf.curve.length > 500) pf.curve = pf.curve.filter((_, i) => i % 2 === 0 || i > pf.curve.length - 150);
  if (pf.closed.length > 300) pf.closed = pf.closed.slice(-300);
  pf.lastStep = now;
  return { events, needQuote };
}

export function botStats(pf) {
  const n = pf.closed.length;
  const wins = pf.closed.filter((c) => c.pct > 0).length;
  const byReason = {};
  for (const c of pf.closed) { const k = c.reason.replace(/\s*\(.*$/, '').replace(/ to \d+$/, '').replace(/ down \d+%$/, ' down'); (byReason[k] ||= { n: 0, pnl: 0 }); byReason[k].n++; byReason[k].pnl += c.pnl; }
  return {
    equity: pf.equity ?? pf.cash,
    returnPct: (((pf.equity ?? pf.cash) - pf.start) / pf.start) * 100,
    closed: n,
    wins,
    avgPct: n ? pf.closed.reduce((a, c) => a + c.pct, 0) / n : null,
    best: n ? Math.max(...pf.closed.map((c) => c.pct)) : null,
    worst: n ? Math.min(...pf.closed.map((c) => c.pct)) : null,
    byReason,
  };
}
