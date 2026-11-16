// Narrative / trend detection.
//
// Each run sees a few hundred fresh tokens. We tokenise their names, tickers
// and descriptions, map words onto known narrative buckets (AI, dogs, cats,
// politics ...) and also keep raw recurring words so brand-new metas that no
// bucket anticipates still surface. A narrative is "hot" when many separate
// launches share it AND real volume is flowing into them AND it is growing
// versus the rolling history kept from previous runs.
import { clamp } from './util.js';

const BUCKETS = {
  ai: ['ai', 'agent', 'agents', 'gpt', 'llm', 'neural', 'bot', 'agi', 'claude', 'grok', 'openai', 'deepseek', 'robot', 'compute', 'terminal'],
  dogs: ['dog', 'doge', 'shib', 'inu', 'wif', 'bonk', 'pup', 'puppy', 'doggo', 'floki', 'husky', 'corgi'],
  cats: ['cat', 'kitty', 'kitten', 'meow', 'popcat', 'mew', 'neko', 'purr'],
  frogs: ['pepe', 'frog', 'kek', 'toad', 'apu', 'wojak', 'brett'],
  animals: ['monkey', 'ape', 'bear', 'bull', 'penguin', 'hippo', 'pnut', 'squirrel', 'capybara', 'goat', 'fish', 'whale', 'bird', 'duck', 'pig', 'horse', 'owl'],
  politics: ['trump', 'maga', 'biden', 'elon', 'musk', 'president', 'vote', 'election', 'vance', 'kamala', 'putin', 'melania', 'barron', 'doge', 'senate', 'congress'],
  celebrity: ['kanye', 'ye', 'drake', 'taylor', 'swift', 'tate', 'mrbeast', 'ansem', 'hawk', 'jenner', 'iggy'],
  gaming: ['game', 'gaming', 'play', 'quest', 'pixel', 'arcade', 'nft', 'metaverse', 'guild'],
  defi: ['swap', 'yield', 'stake', 'staking', 'lend', 'vault', 'dao', 'perp', 'dex', 'liquid', 'restake'],
  depin_rwa: ['depin', 'rwa', 'gpu', 'node', 'network', 'energy', 'gold', 'stock', 'tokenized', 'treasury'],
  culture: ['meme', 'based', 'chad', 'gm', 'wagmi', 'rizz', 'sigma', 'skibidi', 'brainrot', 'aura', 'cope', 'moon', 'pump', 'gigachad', 'npc'],
  tech_events: ['x402', 'quantum', 'space', 'spacex', 'mars', 'tesla', 'nvidia', 'apple', 'chatgpt', 'robotaxi', 'optimus'],
  streamer_social: ['stream', 'streamer', 'live', 'kick', 'twitch', 'tiktok', 'viral', 'creator'],
  holidays: ['santa', 'xmas', 'christmas', 'halloween', 'turkey', 'thanksgiving', 'pumpkin', 'elf', 'snow', 'newyear'],
};

const STOP = new Set(
  ('the a an of on in to for and or is it this that with by from at as be are was coin token solana sol official ' +
    'new first best real just your my our we you its not no yes one two get got all out up now will can has have ' +
    'pumpfun pump fun community cto project crypto launch launched fair buy sell hold holder holders http https www com ' +
    'io xyz inu finance protocol money cash dollar usd usdc million billion world time day life love like more most').split(' '),
);

const WORD_TO_BUCKET = new Map();
for (const [bucket, words] of Object.entries(BUCKETS)) for (const w of words) if (!WORD_TO_BUCKET.has(w)) WORD_TO_BUCKET.set(w, bucket);

export function words(text) {
  return (text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // split camelCase tickers
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && w.length <= 18 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Tags for one token: narrative buckets plus its own distinctive words. */
export function tagToken(t) {
  const strong = new Set(words(`${t.name} ${t.symbol}`));
  const weak = new Set(words((t.desc || '').slice(0, 300)));
  const buckets = new Set();
  for (const w of strong) if (WORD_TO_BUCKET.has(w)) buckets.add(WORD_TO_BUCKET.get(w));
  for (const w of weak) if (WORD_TO_BUCKET.has(w)) buckets.add(WORD_TO_BUCKET.get(w));
  return { buckets: [...buckets], keywords: [...strong].filter((w) => w.length >= 3) };
}

/**
 * Aggregate tags across this run and compare with history.
 * Returns { narratives, heat } where heat maps tag -> 0..1 for scoring.
 */
export function detectTrends(tokens, prevHistory = []) {
  const agg = new Map();
  const bump = (key, kind, t) => {
    const a = agg.get(key) || { tag: key, kind, count: 0, volH1: 0, liq: 0, scoreSum: 0, mints: [] };
    a.count++;
    a.volH1 += t.vol?.h1 || 0;
    a.liq += t.liq || 0;
    a.scoreSum += t.score?.rule ?? 0;
    if (a.mints.length < 12) a.mints.push(t.mint);
    agg.set(key, a);
  };
  for (const t of tokens) {
    const { buckets, keywords } = t._tags || tagToken(t);
    for (const b of buckets) bump(b, 'narrative', t);
    for (const k of keywords) if (!WORD_TO_BUCKET.has(k)) bump(`#${k}`, 'keyword', t);
  }

  // Rolling baseline: average share of launches per tag over previous runs.
  const baseline = new Map();
  for (const h of prevHistory) for (const [tag, share] of Object.entries(h.shares || {})) baseline.set(tag, (baseline.get(tag) || 0) + share / prevHistory.length);

  const total = Math.max(1, tokens.length);
  const list = [];
  for (const a of agg.values()) {
    if (a.kind === 'keyword' && a.count < 3) continue; // a word must recur across launches to be a meta
    const share = a.count / total;
    const base = baseline.get(a.tag);
    const growth = base == null ? null : (share - base) / Math.max(base, 0.01);
    // Heat: breadth (how many launches), money (volume), and acceleration.
    const breadth = clamp(a.count / (a.kind === 'keyword' ? 10 : 25));
    const money = clamp(Math.log10(a.volH1 + 1) / 6.5);
    const accel = growth == null ? 0.3 : clamp(0.3 + growth / 3);
    const heat = +(0.35 * breadth + 0.4 * money + 0.25 * accel).toFixed(3);
    list.push({
      tag: a.tag,
      kind: a.kind,
      count: a.count,
      share: +share.toFixed(4),
      volH1: Math.round(a.volH1),
      avgScore: +(a.scoreSum / a.count).toFixed(1),
      growth: growth == null ? null : +growth.toFixed(2),
      heat,
      // Many launches sharing one exact word with no volume = copycat spam, not a trend.
      copycat: a.kind === 'keyword' && a.count >= 4 && a.volH1 / a.count < 2000,
      mints: a.mints,
    });
  }
  list.sort((x, y) => y.heat - x.heat);
  const heat = Object.fromEntries(list.map((n) => [n.tag, n]));
  const shares = Object.fromEntries(list.map((n) => [n.tag, n.share]));
  return { narratives: list.slice(0, 40), heat, shares };
}

/** 0..1 trend fit for one token given this run's heat map. */
export function trendFit(t, heat) {
  const { buckets, keywords } = t._tags || tagToken(t);
  let best = 0;
  let copycat = false;
  for (const b of buckets) if (heat[b]) best = Math.max(best, heat[b].heat);
  for (const k of keywords) {
    const h = heat[`#${k}`];
    if (!h) continue;
    if (h.copycat) copycat = true;
    else best = Math.max(best, h.heat);
  }
  return { fit: best, copycat, tags: [...buckets, ...keywords.filter((k) => heat[`#${k}`]).map((k) => `#${k}`)].slice(0, 5) };
}
