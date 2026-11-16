import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_DEFAULTS, newPortfolio, entryCheck, describeRules, stepBot, botStats, resetRules } from '../site/paperbot.js';
import { passes, activeCount, LIMITS, SWITCHES } from '../site/userfilters.js';

const tok = (mint, over = {}) => ({
  mint, symbol: mint, name: mint, price: 1, liq: 50000, mcap: 400000, createdAt: Date.now() - 60 * 60e3, top10: 20, devPct: 1, holders: 900, organic: 60,
  vol: { h1: 20000 }, tx: { h1: [120, 100] }, safety: { mintRevoked: true, freezeRevoked: true, sniperPct: 2, insiderPct: 1 }, social: { x: { kind: 'profile', followers: 4000 } },
  score: { total: 72, gates: [], flags: [] }, ...over,
});
const rules = () => resetRules();
const quotes = (map) => (mint) => map[mint] || null;

test('your filters: limits, switches, unknown values and scan-only measurements', () => {
  const f = { limits: { top10Max: 15 }, switches: {}, strict: true };
  assert.equal(activeCount(f), 1);
  assert.equal(passes(tok('A', { top10: 14 }), f), true);
  assert.equal(passes(tok('A', { top10: 15.1 }), f), false);
  assert.equal(passes(tok('A', { top10: null }), f), false, 'unknown fails when strict');
  assert.equal(passes(tok('A', { top10: null }), { ...f, strict: false }), true);
  const lp = { limits: { lpMin: 90 }, switches: {}, strict: true };
  assert.equal(passes(tok('A'), lp, false), false, 'no LP data on a scored token fails');
  assert.equal(passes(tok('A'), lp, true), true, 'scan-only limits are skipped in the live feed');
  assert.equal(passes(tok('A', { safety: { mintRevoked: false } }), { limits: {}, switches: { mintOff: true }, strict: true }), false);
  assert.ok(LIMITS.every((l) => typeof l.get === 'function' && ['min', 'max'].includes(l.kind)));
  assert.ok(SWITCHES.every((s) => typeof s.test === 'function'));
});

test('entry rules: score, hard flags, limits, and the reasons recorded', () => {
  const r = rules();
  assert.equal(entryCheck(tok('A'), r).ok, true);
  assert.equal(entryCheck(tok('A', { score: { total: 64, gates: [] } }), r).ok, false, 'below min score');
  assert.equal(entryCheck(tok('A', { score: { total: 90, gates: ['Freeze authority is active'] } }), r).ok, false, 'hard flag blocks by default');
  assert.equal(entryCheck(tok('A', { liq: 9000 }), r).ok, false, 'default min liquidity');
  assert.equal(entryCheck(tok('A', { createdAt: Date.now() - 5 * 60e3 }), r).ok, false, 'default min age');
  r.entry.limits.top10Max = 15;
  assert.equal(entryCheck(tok('A'), r).ok, false);
  const ok = entryCheck(tok('A', { top10: 9 }), r);
  assert.equal(ok.ok, true);
  assert.ok(ok.why.some((w) => /score 72/.test(w)) && ok.why.some((w) => /top 10/.test(w)));
  r.entry.allowFlagged = true;
  assert.equal(entryCheck(tok('A', { top10: 9, score: { total: 90, gates: ['x'] } }), r).ok, true);
});

test('bot buys only with a fresh price, then exits on each rule', () => {
  const now = 1_000_000_000_000;
  const r = rules();
  r.size = { startUsd: 1000, stakeUsd: 100, maxOpen: 3, costPct: 1 };
  const pf = newPortfolio(r, now);
  const cands = ['TP', 'SL', 'RUG', 'EXTRA'].map((m) => ({ t: tok(m), live: false }));

  // stale prices: nothing is bought, fresh quotes are requested
  let out = stepBot(pf, r, cands, quotes({ TP: { price: 1, liq: 50000, at: now - 10 * 60e3 } }), now);
  assert.equal(pf.open.length, 0);
  assert.deepEqual(out.needQuote.sort(), ['EXTRA', 'RUG', 'SL', 'TP']);

  const fresh = (p, extra = {}) => ({ price: p, liq: 50000, at: now, score: 72, gated: false, ...extra });
  out = stepBot(pf, r, cands, quotes({ TP: fresh(1), SL: fresh(1), RUG: fresh(1), EXTRA: fresh(1) }), now);
  assert.equal(pf.open.length, 3, 'max open positions respected');
  assert.equal(pf.cash, 700);
  assert.equal(out.events.filter((e) => e.type === 'buy').length, 3);
  assert.ok(pf.equity < 1000, 'costs are charged on entry');
  const held = pf.open.map((p) => p.mint);

  const t1 = now + 60e3;
  const q = {};
  for (const m of held) q[m] = { price: 1, liq: 50000, at: t1, score: 72, gated: false };
  q[held[0]].price = 2.2; // take profit
  q[held[1]].price = 0.6; // stop loss
  q[held[2]].gated = true; // rug flag
  out = stepBot(pf, r, [], quotes(q), t1);
  const reasons = Object.fromEntries(out.events.map((e) => [e.mint, e.reason]));
  assert.match(reasons[held[0]], /take profit/);
  assert.match(reasons[held[1]], /stop loss/);
  assert.match(reasons[held[2]], /red flag/);
  assert.equal(pf.open.length, 0);
  const st = botStats(pf);
  assert.equal(st.closed, 3);
  assert.equal(st.wins, 1);
  assert.ok(pf.closed.find((c) => c.mint === held[0]).pct > 100);

  // never re-enters something it already traded
  out = stepBot(pf, r, [{ t: tok(held[0]), live: false }], quotes({ [held[0]]: { price: 1, liq: 50000, at: t1 + 1, score: 72 } }), t1 + 1);
  assert.equal(pf.open.length, 0);
});

test('trailing stop, time limit, liquidity drain, score drop and vanished pools', () => {
  const now = 2_000_000_000_000;
  const mk = (exit) => { const r = rules(); r.exit = { takeProfit: null, stopLoss: null, trailing: null, maxHoldMin: null, onRugFlag: false, scoreBelow: null, liqDrop: null, ...exit }; r.size.costPct = 0; return r; };
  const run = (r, steps) => {
    const pf = newPortfolio(r, now);
    stepBot(pf, r, [{ t: tok('A'), live: true }], quotes({ A: { price: 1, liq: 50000, at: now, score: 72 } }), now);
    assert.equal(pf.open.length, 1);
    let last;
    for (const [dt, quote] of steps) last = stepBot(pf, r, [], quotes(quote ? { A: { liq: 50000, score: 72, at: now + dt, ...quote } } : {}), now + dt);
    return { pf, last };
  };
  let res = run(mk({ trailing: 30 }), [[60e3, { price: 2 }], [120e3, { price: 1.5 }], [180e3, { price: 1.39 }]]);
  assert.match(res.pf.closed[0].reason, /trailing/);
  assert.ok(res.pf.closed[0].pct > 30, 'trailing stop locked in profit');
  res = run(mk({ trailing: 30 }), [[60e3, { price: 0.5 }]]);
  assert.equal(res.pf.open.length, 1, 'trailing stop only arms after the position has been in profit');
  res = run(mk({ maxHoldMin: 30 }), [[29 * 60e3, { price: 1.1 }], [31 * 60e3, { price: 1.1 }]]);
  assert.equal(res.pf.closed[0].reason, 'time limit');
  res = run(mk({ liqDrop: 60 }), [[60e3, { price: 1, liq: 19000 }]]);
  assert.match(res.pf.closed[0].reason, /liquidity down/);
  res = run(mk({ scoreBelow: 40 }), [[60e3, { price: 1, score: 35 }]]);
  assert.match(res.pf.closed[0].reason, /score fell/);
  res = run(mk({}), [[5 * 60e3, null], [16 * 60e3, null]]);
  assert.match(res.pf.closed[0].reason, /no price/);
  assert.equal(res.pf.closed[0].pct, -100);
});

test('paused bot keeps managing exits but opens nothing; feed choice is honoured', () => {
  const now = 3_000_000_000_000;
  const r = rules();
  r.enabled = false;
  const pf = newPortfolio(r, now);
  stepBot(pf, r, [{ t: tok('A'), live: false }], quotes({ A: { price: 1, liq: 50000, at: now } }), now);
  assert.equal(pf.open.length, 0);
  r.enabled = true;
  r.feed = 'live';
  stepBot(pf, r, [{ t: tok('A'), live: false }, { t: tok('B'), live: true }], quotes({ A: { price: 1, liq: 50000, at: now }, B: { price: 1, liq: 50000, at: now } }), now);
  assert.deepEqual(pf.open.map((p) => p.mint), ['B']);
});

test('rules are described in plain language', () => {
  const d = describeRules(BOT_DEFAULTS);
  assert.ok(d.buys.some((s) => /score is 65/.test(s)));
  assert.ok(d.buys.some((s) => /Liquidity at least \$10\.0k/.test(s)));
  assert.ok(d.sells.some((s) => /up 100%/.test(s)) && d.sells.some((s) => /down 35%/.test(s)));
  assert.match(d.sizing, /\$25/);
});
