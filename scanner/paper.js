// Paper-trading bot: simulated money only. It never signs or sends anything.
//
// Purpose: an honest scoreboard. If buying the bot's high scores with simple
// exit rules loses money on paper, nobody should do it with real funds.
//
// Entry : score >= ENTRY_SCORE, no hard gates, liquidity >= MIN_LIQ, pair older
//         than MIN_AGE_MIN (past the typical rug window), free slot available.
// Exit  : take-profit, stop-loss, a hard gate appearing after entry, liquidity
//         draining, the token vanishing from the data feed (-100%), or 24h.
// Costs : COST_PCT is charged on each side for fees, slippage and price impact.
//         Prices are sampled once per scan, so real fills would be worse.

export const RULES = {
  START_USD: 1000,
  STAKE_USD: 50,
  MAX_OPEN: 10,
  ENTRY_SCORE: 70,
  MIN_LIQ: 20000,
  MIN_AGE_MIN: 45,
  TAKE_PROFIT: 1.0, // +100%
  STOP_LOSS: -0.35,
  MAX_HOLD_MS: 24 * 60 * 60e3,
  COST_PCT: 0.015,
};

export function newPaper(t = Date.now()) {
  return { start: RULES.START_USD, cash: RULES.START_USD, equity: RULES.START_USD, startedAt: t, open: [], closed: [], curve: [[t, RULES.START_USD]], stats: { closed: 0, wins: 0, avgPct: 0 }, rules: RULES };
}

/**
 * @param paper   previous state (or null)
 * @param tokens  this run's scored tokens
 * @param lookup  Map mint -> { price, liq } for open positions that fell out of the feed
 */
export function stepPaper(paper, tokens, lookup, t = Date.now()) {
  const p = paper && paper.open ? paper : newPaper(t);
  p.rules = RULES;
  const byMint = new Map(tokens.map((x) => [x.mint, x]));
  const stillOpen = [];

  for (const pos of p.open) {
    const tok = byMint.get(pos.mint);
    const live = tok ? { price: tok.price, liq: tok.liq } : lookup.get(pos.mint);
    let reason = null;
    let price = live?.price;
    if (!live || !(price > 0)) {
      // Missing for several scans in a row = pool gone. Count it as a total loss.
      pos.missing = (pos.missing || 0) + 1;
      if (pos.missing >= 3) { reason = 'vanished from feed'; price = 0; }
    } else {
      pos.missing = 0;
      pos.last = price;
      const raw = price / pos.entry - 1;
      if (raw >= RULES.TAKE_PROFIT) reason = 'take profit';
      else if (raw <= RULES.STOP_LOSS) reason = 'stop loss';
      else if (tok && tok.score.gates.length) reason = 'rug flag appeared';
      else if (live.liq != null && live.liq < 0.4 * pos.liq0) reason = 'liquidity drained';
      else if (t - pos.t0 >= RULES.MAX_HOLD_MS) reason = '24h time limit';
    }
    const mark = price > 0 ? price : pos.last || 0;
    pos.pct = +(((mark / pos.entry) * (1 - RULES.COST_PCT) - 1) * 100).toFixed(1);
    if (reason) {
      const proceeds = price > 0 ? pos.units * price * (1 - RULES.COST_PCT) : 0;
      p.cash += proceeds;
      const pct = +((proceeds / RULES.STAKE_USD - 1) * 100).toFixed(1);
      p.closed.push({ mint: pos.mint, symbol: pos.symbol, score: pos.score, t0: pos.t0, t1: t, pct, reason });
    } else stillOpen.push(pos);
  }
  p.open = stillOpen;

  const held = new Set(p.open.map((x) => x.mint));
  const traded = new Set(p.closed.slice(-300).map((x) => x.mint)); // never re-enter the same token
  const candidates = tokens
    .filter((x) => x.score.total >= RULES.ENTRY_SCORE && !x.score.gates.length && x.price > 0 && (x.liq || 0) >= RULES.MIN_LIQ && (x.ageMin || 0) >= RULES.MIN_AGE_MIN && !held.has(x.mint) && !traded.has(x.mint))
    .sort((a, b) => b.score.total - a.score.total);
  for (const c of candidates) {
    if (p.open.length >= RULES.MAX_OPEN || p.cash < RULES.STAKE_USD) break;
    const entry = c.price * (1 + RULES.COST_PCT);
    p.cash -= RULES.STAKE_USD;
    p.open.push({ mint: c.mint, symbol: c.symbol, score: c.score.total, t0: t, entry, units: RULES.STAKE_USD / entry, liq0: c.liq, last: c.price, pct: +(-2 * RULES.COST_PCT * 100).toFixed(1) });
  }

  const openValue = p.open.reduce((s, x) => s + x.units * (x.last || 0) * (1 - RULES.COST_PCT), 0);
  p.equity = +(p.cash + openValue).toFixed(2);
  p.cash = +p.cash.toFixed(2);
  p.curve.push([t, p.equity]);
  if (p.curve.length > 700) p.curve = p.curve.filter((_, i) => i % 2 === 0 || i > p.curve.length - 200);
  if (p.closed.length > 400) p.closed = p.closed.slice(-400);
  const n = p.closed.length;
  p.stats = { closed: n, wins: p.closed.filter((x) => x.pct > 0).length, avgPct: n ? +(p.closed.reduce((s, x) => s + x.pct, 0) / n).toFixed(1) : 0 };
  return p;
}
