import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreToken, finalise, features, FEATURES, social } from '../scanner/score.js';
import { train, predict, auc, labelOutcome, calibration } from '../scanner/learn.js';
import { stepPaper, RULES } from '../scanner/paper.js';
import { tagToken, detectTrends, trendFit } from '../scanner/trends.js';
import { buildToken, clean, httpsUrl, isMint } from '../scanner/sources.js';

const healthy = (over = {}) => ({
  mint: 'So11111111111111111111111111111111111111112', symbol: 'GOOD', name: 'Good Dog', ageMin: 600, price: 0.001, liq: 80000, mcap: 600000,
  vol: { m5: 3000, h1: 40000, h6: 200000, h24: 700000 }, tx: { m5: [20, 15], h1: [300, 250], h24: [5000, 4500] }, chg: { m5: 1, h1: 8, h6: 20, h24: 150 },
  traders: 260, holders: 2500, top10: 18, devPct: 1, maxHolderPct: 4, organic: 70, onCurve: false, boosts: 0,
  safety: { mintRevoked: true, freezeRevoked: true, lpLocked: 100, riskNorm: 2, risks: [], ext: [], checked: true, sniperPct: 1, insiderPct: 0, bundlePct: 0 },
  social: { x: { kind: 'profile', handle: 'gooddog', ageDays: 500, followers: 9000, tweets: 400, mentionsToken: true }, tg: { url: 'https://t.me/gooddog', members: 3000 }, web: { url: 'https://gooddog.com/', ageDays: 480, related: true }, reuse: 0 },
  ...over,
});

test('a healthy token scores high with no gates', () => {
  const sc = scoreToken(healthy(), { fit: 0.6, copycat: false });
  const f = finalise(sc, null, 0);
  assert.equal(f.gates.length, 0);
  assert.ok(f.total >= 75, `expected >= 75, got ${f.total}`);
  assert.equal(f.verdict, 'Strong');
});

test('live freeze authority caps the score regardless of everything else', () => {
  const t = healthy();
  t.safety.freezeRevoked = false;
  const f = finalise(scoreToken(t, { fit: 1 }), 0.99, 0.5);
  assert.ok(f.total <= 12);
  assert.equal(f.verdict, 'Likely rug');
});

test('the learned model can never lift a gated token above its cap', () => {
  const t = healthy({ liq: 800 });
  const f = finalise(scoreToken(t), 1, 0.5);
  assert.ok(f.total <= 15);
});

test('dangerous Token-2022 extensions and dust liquidity are gated', () => {
  const a = healthy();
  a.safety.ext = [{ name: 'Permanent delegate' }];
  assert.ok(scoreToken(a).cap <= 12);
  const b = healthy();
  b.safety.ext = [{ name: 'Transfer fee', feePct: 1 }];
  assert.equal(scoreToken(b).cap, 100, 'a small transfer fee alone is not a gate');
});

test('unknown data never scores as good', () => {
  const t = healthy({ top10: null, holders: null, organic: null, social: {} });
  t.safety = { mintRevoked: null, freezeRevoked: null, lpLocked: null, riskNorm: null, risks: [], ext: [], checked: false };
  const known = finalise(scoreToken(healthy()), null, 0).total;
  const unknown = finalise(scoreToken(t), null, 0).total;
  assert.ok(unknown < known - 15, `unknown ${unknown} should be well below known ${known}`);
});

test('social: old established account beats a new one; borrowed big account is flagged', () => {
  const old = social(healthy());
  const fresh = social(healthy({ social: { x: { kind: 'profile', handle: 'x', ageDays: 3, followers: 200 } } }));
  assert.ok(old > 70 && fresh < 30, `old ${old}, fresh ${fresh}`);
  const flags = [];
  social(healthy({ social: { x: { kind: 'profile', handle: 'big', ageDays: 3000, followers: 900000, mentionsToken: false } } }), [], [], flags);
  assert.ok(flags.some((f) => /unrelated/.test(f)));
  const bought = [];
  social(healthy({ social: { x: { kind: 'profile', handle: 'n', ageDays: 10, followers: 50000 } } }), [], [], bought);
  assert.ok(bought.some((f) => /purchased/.test(f)));
  assert.ok(social(healthy({ social: {} })) < 10);
});

test('wash-trading tells raise flags', () => {
  const t = healthy({ vol: { m5: 0, h1: 4000, h6: 9000, h24: 9000 }, tx: { m5: [0, 0], h1: [400, 380], h24: [800, 700] }, traders: 12 });
  const sc = scoreToken(t);
  assert.ok(sc.flags.some((f) => /wash|botting/.test(f)));
});

test('feature vector matches the declared layout and is finite', () => {
  const t = healthy();
  const x = features(t, scoreToken(t), { fit: 0.3 });
  assert.equal(x.length, FEATURES.length);
  assert.ok(x.every(Number.isFinite));
  const sparse = features({ mint: 'x', safety: {}, social: {} }, scoreToken({ mint: 'x', safety: {}, social: {} }), null);
  assert.ok(sparse.every(Number.isFinite));
});

test('logistic regression learns a separable signal and stays untrained on tiny data', () => {
  const names = ['signal', 'noise'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows = Array.from({ length: 400 }, (_, i) => {
    const s = rnd();
    return { t: i, x: [s, rnd()], y: s + (rnd() - 0.5) * 0.3 > 0.6 ? 1 : 0, score: Math.round(s * 100), ret: s - 0.6 };
  });
  const m = train(rows, names);
  assert.ok(m.ready);
  assert.ok(m.testAuc > 0.85, `auc ${m.testAuc}`);
  assert.ok(m.blend > 0 && m.blend <= 0.5);
  assert.equal(m.importance[0].name, 'signal');
  assert.ok(predict(m, [0.95, 0.5]) > predict(m, [0.05, 0.5]));
  assert.equal(train(rows.slice(0, 20), names).ready, false);
  assert.equal(predict({ ready: false }, [1, 1]), null);
  const cal = calibration(rows);
  assert.ok(cal.at(-1).goodRate > cal[0].goodRate);
});

test('auc and outcome labels', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(labelOutcome({ price0: 1, liq0: 50000, checks: {} }), null);
  assert.equal(labelOutcome({ price0: 1, liq0: 50000, checks: { h24: { price: 0.8, liq: 40000 } } }), 1);
  assert.equal(labelOutcome({ price0: 1, liq0: 50000, checks: { h24: { price: 0.3, liq: 40000 } } }), 0);
  assert.equal(labelOutcome({ price0: 1, liq0: 50000, checks: { h24: { price: 1.5, liq: 2000 } } }), 0);
  assert.equal(labelOutcome({ price0: 1, liq0: 50000, checks: { h24: { gone: true } } }), 0);
});

test('paper bot enters, takes profit, stops out and treats vanished tokens as total losses', () => {
  const tok = (mint, price, score = 80, gates = []) => ({ mint, symbol: mint, price, liq: 50000, ageMin: 120, score: { total: score, gates } });
  let p = stepPaper(null, [tok('A', 1), tok('B', 1), tok('C', 1), tok('LOW', 1, 50), tok('RUG', 1, 90, ['x'])], new Map(), 1000);
  assert.deepEqual(p.open.map((x) => x.mint).sort(), ['A', 'B', 'C']);
  assert.equal(p.cash, RULES.START_USD - 3 * RULES.STAKE_USD);
  assert.ok(p.equity < RULES.START_USD, 'entry costs are charged immediately');
  p = stepPaper(p, [tok('A', 2.2), tok('B', 0.5)], new Map(), 2000); // C missing once
  assert.deepEqual(p.closed.map((x) => [x.mint, x.reason]), [['A', 'take profit'], ['B', 'stop loss']]);
  assert.ok(p.closed[0].pct > 100 && p.closed[1].pct < -45);
  p = stepPaper(p, [], new Map(), 3000);
  p = stepPaper(p, [], new Map(), 4000);
  const c = p.closed.find((x) => x.mint === 'C');
  assert.equal(c.reason, 'vanished from feed');
  assert.equal(c.pct, -100);
  p = stepPaper(p, [tok('A', 1)], new Map(), 5000);
  assert.equal(p.open.length, 0, 'never re-enters a token it already traded');
});

test('trend detection: buckets, recurring keywords and copycat spam', () => {
  const mk = (i, name, vol) => ({ mint: `m${i}`, name, symbol: name.split(' ')[0], desc: '', vol: { h1: vol }, liq: 10000, score: { rule: 50 } });
  const toks = [mk(1, 'Doge King', 90000), mk(2, 'Shib Lord', 50000), mk(3, 'Moon Dog', 70000), ...[4, 5, 6, 7, 8].map((i) => mk(i, 'Zorbo Token', 100)), mk(9, 'Lonely', 5)];
  assert.deepEqual(tagToken(toks[0]).buckets, ['dogs']);
  const tr = detectTrends(toks, []);
  assert.ok(tr.heat.dogs.heat > 0.3);
  assert.equal(tr.heat['#zorbo'].copycat, true);
  assert.equal(trendFit(toks[4], tr.heat).copycat, true);
  assert.ok(trendFit(toks[0], tr.heat).fit > trendFit(toks[8], tr.heat).fit);
});

test('hostile metadata is sanitised', () => {
  assert.equal(clean('  a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x202e) + '<script>  ', 50), 'a b <script>');
  assert.equal(httpsUrl('javascript:alert(1)'), null);
  assert.equal(httpsUrl('http://insecure.example.com'), null);
  assert.equal(httpsUrl('https://example.com/a'), 'https://example.com/a');
  assert.ok(isMint('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'));
  assert.ok(!isMint('<img src=x onerror=alert(1)>'));
  const t = buildToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', {
    jup: { id: 'x', symbol: '<b>EVIL</b>'.repeat(9), name: 'n', icon: 'javascript:alert(1)', twitter: 'https://x.com/someone/status/123', website: 'https://pump.fun/coin/abc', usdPrice: 1, createdAt: '2026-11-16T10:00:00Z', audit: {} },
    meta: {},
  }, Date.parse('2026-11-16T11:00:00Z'));
  assert.equal(t.icon, null);
  assert.ok(t.symbol.length <= 16);
  assert.equal(t.social.x.kind, 'tweet');
  assert.equal(t.social.web, undefined, 'a launchpad link is not a website');
  assert.equal(Math.round(t.ageMin), 60);
});
