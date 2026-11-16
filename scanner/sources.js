// Data sources. All free and keyless (verified live 2026-11-16).
//
//   Jupiter Tokens v2   api.jup.ag       documented; 5 requests / 10 s shared bucket
//   Jupiter data API    datapi.jup.ag    undocumented front-end API: used as an optional
//                                        overlay (snipers, insiders, X followers) and never relied on
//   DEX Screener        api.dexscreener.com   pairs, txns, paid profiles/boosts, market metas
//   GeckoTerminal       api.geckoterminal.com ~5 calls / min keyless, so 2 calls per run
//   RugCheck            api.rugcheck.xyz      per-token risk report, ~8 rps sustained
//   Raydium LaunchLab   launch-mint-v1.raydium.io
//
// Everything a token creator controls (names, descriptions, links, images) is
// treated as hostile input: trimmed, stripped of control characters, and URLs
// are kept only when they are plain https.
import { get, chunk, mapLimit, num, sleep } from './util.js';

export const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://api.jup.ag';
const DAT = 'https://datapi.jup.ag';
const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const RC = 'https://api.rugcheck.xyz/v1';
const JUP_KEY = process.env.JUPITER_API_KEY; // optional free key from developers.jup.ag/portal
const jupOpts = { gapMs: JUP_KEY ? 1100 : 2300, headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {} };

export const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const clean = (s, max = 80) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
export function httpsUrl(u) {
  try {
    const url = new URL(String(u).trim());
    return url.protocol === 'https:' && url.hostname.includes('.') && url.href.length < 300 ? url.href : null;
  } catch {
    return null;
  }
}
const ts = (x) => {
  const n = typeof x === 'number' ? x : Date.parse(x);
  return Number.isFinite(n) && n > 1.5e12 ? n : null;
};

// ---------------------------------------------------------------- discovery
/** Returns Map mint -> { src:Set, meta } of candidate tokens from every feed. */
export async function discover() {
  const found = new Map();
  const add = (mint, src, meta = {}) => {
    if (!isMint(mint) || mint === SOL) return;
    const f = found.get(mint) || { src: new Set(), meta: {} };
    f.src.add(src);
    for (const [k, v] of Object.entries(meta)) if (v != null && v !== '' && f.meta[k] == null) f.meta[k] = v;
    found.set(mint, f);
  };
  const linksOf = (links) => {
    const out = {};
    for (const l of Array.isArray(links) ? links : []) {
      const u = httpsUrl(l?.url);
      if (!u) continue;
      const kind = String(l.type || l.label || '').toLowerCase();
      if (kind === 'twitter' || /^https:\/\/(x|twitter)\.com\//.test(u)) out.x ??= u;
      else if (kind === 'telegram' || /^https:\/\/(t\.me|telegram\.me)\//.test(u)) out.tg ??= u;
      else if (kind === 'website' || !l.type) out.web ??= u;
    }
    return out;
  };

  const jobs = [
    // Jupiter: brand-new mints, plus tokens already attracting trading.
    (async () => {
      for (const path of ['recent', 'toptrending/1h?limit=100', 'toporganicscore/1h?limit=100', 'toptraded/1h?limit=100']) {
        const r = await get(`${JUP}/tokens/v2/${path}`, jupOpts);
        for (const t of Array.isArray(r) ? r : []) add(t.id, `jup:${path.split('/')[0]}`, { jup: t });
      }
    })(),
    // Jupiter front-end "gems": new, about-to-graduate and just-graduated launchpad pools.
    (async () => {
      const res = await fetch(`${DAT}/v1/pools/gems`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'solana-token-scanner/1.0' },
        body: JSON.stringify({ recent: {}, graduated: {}, aboutToGraduate: {} }),
        signal: AbortSignal.timeout(12000),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      for (const bucket of ['recent', 'aboutToGraduate', 'graduated']) for (const p of res?.[bucket]?.pools || []) add(p?.baseAsset?.id, `gems:${bucket}`, { dat: p.baseAsset });
    })(),
    // DEX Screener: tokens whose teams paid for a profile or boosts (a neutral signal, but they come with links).
    (async () => {
      for (const path of ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1', 'community-takeovers/latest/v1']) {
        const r = await get(`${DS}/${path}`, { gapMs: 350 });
        for (const p of Array.isArray(r) ? r : []) {
          if (p.chainId !== 'solana') continue;
          add(p.tokenAddress, `ds:${path.split('/')[0]}`, { desc: clean(p.description, 280), links: linksOf(p.links), boost: num(p.totalAmount), cto: path.startsWith('community') || p.cto === true || undefined });
        }
      }
    })(),
    // GeckoTerminal: newest pools and pools trending in the last hour (rate limit is tight: 2 calls).
    (async () => {
      for (const path of ['new_pools?page=1', 'trending_pools?duration=1h']) {
        const r = await get(`${GT}/networks/solana/${path}&include=base_token`, { gapMs: 13000, retries: 0 });
        for (const p of r?.data || []) add(String(p?.relationships?.base_token?.data?.id || '').replace(/^solana_/, ''), `gt:${path.split('?')[0]}`);
      }
    })(),
    // Raydium LaunchLab newest launches.
    (async () => {
      const r = await get('https://launch-mint-v1.raydium.io/get/list?sort=new&size=60&mintType=default&includeNsfw=false');
      for (const row of r?.data?.rows || []) add(row.mint, 'raydium:launchlab', { desc: clean(row.description, 280), links: { x: httpsUrl(row.twitter), web: httpsUrl(row.website), tg: httpsUrl(row.telegram) } });
    })(),
  ];
  await Promise.allSettled(jobs);
  return found;
}

/** Market-wide narratives as DEX Screener sees them (for the Trends tab). */
export async function marketMetas() {
  const r = await get(`${DS}/metas/trending/v1`, { gapMs: 350 });
  return (Array.isArray(r) ? r : []).slice(0, 18).map((m) => ({
    name: clean(m.name, 40),
    slug: clean(m.slug, 40).toLowerCase(),
    volume: num(m.volume, 0),
    tokens: num(m.tokenCount, 0),
    chgH1: num(m.marketCapChange?.h1),
    chgH24: num(m.marketCapChange?.h24),
  }));
}

// --------------------------------------------------------------- enrichment
/** Jupiter batch lookups. Returns { jup: Map, dat: Map } keyed by mint. */
export async function jupiterBatch(mints) {
  const jup = new Map();
  const dat = new Map();
  await Promise.all([
    (async () => {
      for (const part of chunk(mints, 100)) {
        const r = await get(`${JUP}/tokens/v2/search?query=${part.join(',')}`, jupOpts);
        for (const t of Array.isArray(r) ? r : []) if (isMint(t?.id)) jup.set(t.id, t);
      }
    })(),
    (async () => {
      for (const part of chunk(mints, 50)) {
        const r = await get(`${DAT}/v1/assets/search?query=${part.join(',')}`, { gapMs: 700, retries: 1 });
        for (const t of Array.isArray(r) ? r : []) if (isMint(t?.id)) dat.set(t.id, t);
      }
    })(),
  ]);
  return { jup, dat };
}

/** DEX Screener pairs for up to 30 mints per call. Returns Map mint -> best pair (+ earliest pair time). */
export async function dexscreenerBatch(mints) {
  const out = new Map();
  for (const part of chunk(mints, 30)) {
    const r = await get(`${DS}/tokens/v1/solana/${part.join(',')}`, { gapMs: 300 });
    for (const p of Array.isArray(r) ? r : []) {
      const mint = p?.baseToken?.address;
      if (!isMint(mint)) continue;
      const rank = (x) => num(x.liquidity?.usd, 0) * 10 + num(x.volume?.h24, 0);
      const prev = out.get(mint);
      const first = Math.min(prev?._first ?? Infinity, ts(p.pairCreatedAt) ?? Infinity);
      const best = !prev || rank(p) > rank(prev) ? p : prev;
      best._first = first;
      out.set(mint, best);
    }
  }
  return out;
}

const AMM_WITH_LP_TOKEN = /raydium(?!_clmm)|pump_?fun_?amm|pumpswap|meteora(?!_dlmm|_damm_v2|_dbc)|orca(?!_whirl)|cpmm/i;

/** Compact, sanitised view of a RugCheck report. */
function parseRugcheck(r) {
  if (!r || typeof r !== 'object' || !r.mint) return null;
  const risks = (Array.isArray(r.risks) ? r.risks : []).slice(0, 12).map((x) => ({
    n: clean(x.name, 60),
    l: x.level === 'danger' ? 'danger' : x.level === 'warn' ? 'warn' : 'info',
    d: clean(x.value ? `${x.value} - ${x.description || ''}` : x.description, 140),
  }));
  const ext = [];
  const e = r.token_extensions || {};
  if (e.permanentDelegate) ext.push({ name: 'Permanent delegate' });
  if (e.transferHook && JSON.stringify(e.transferHook).length > 30) ext.push({ name: 'Transfer hook' });
  if (e.nonTransferable === true) ext.push({ name: 'Non-transferable' });
  if (e.defaultAccountState && /frozen/i.test(JSON.stringify(e.defaultAccountState))) ext.push({ name: 'Default account state: frozen' });
  if (e.pausableConfig) ext.push({ name: 'Pausable' });
  if (e.transferFeeConfig) ext.push({ name: 'Transfer fee', feePct: num(r.transferFee?.pct, 0) });

  // Deepest market decides the LP-lock figure. Only AMMs with a fungible LP token have one.
  let lpLocked = null;
  let best = -1;
  const poolAccounts = new Set();
  for (const m of Array.isArray(r.markets) ? r.markets : []) {
    for (const k of [m.liquidityA, m.liquidityB, m.pubkey, m.liquidityAAccount?.owner, m.liquidityBAccount?.owner]) if (k) poolAccounts.add(k);
    const depth = num(m.lp?.quoteUSD, 0) + num(m.lp?.baseUSD, 0);
    if (depth > best && AMM_WITH_LP_TOKEN.test(m.marketType || '') && m.lp?.lpLockedPct != null) {
      best = depth;
      lpLocked = num(m.lp.lpLockedPct);
    }
  }
  // Largest holder that is not a pool, curve or locker account.
  const known = r.knownAccounts || {};
  let maxHolder = null;
  for (const h of Array.isArray(r.topHolders) ? r.topHolders : []) {
    if (known[h.address] || known[h.owner] || poolAccounts.has(h.address) || poolAccounts.has(h.owner)) continue;
    maxHolder = Math.max(maxHolder ?? 0, num(h.pct, 0));
  }
  const name = (re) => risks.some((x) => re.test(x.n));
  return {
    at: Date.now(),
    risks,
    ext,
    riskNorm: num(r.score_normalised),
    lpLocked,
    lpUnlockedRisk: risks.some((x) => /lp unlocked/i.test(x.n) && x.l === 'danger'),
    singleHolderRisk: name(/single holder/i),
    creatorRugRisk: name(/creator.*rug|rugged.*creator|history of rug/i),
    copycatRisk: name(/copycat/i),
    rugged: r.rugged === true,
    mintRevoked: r.token ? r.token.mintAuthority == null : null,
    freezeRevoked: r.token ? r.token.freezeAuthority == null : null,
    maxHolder,
    holders: num(r.totalHolders),
    insiders: num(r.graphInsidersDetected, 0),
  };
}

/** RugCheck reports for a list of mints, ~6 requests/second. Returns Map mint -> parsed report. */
export async function rugcheckBatch(mints) {
  const out = new Map();
  await mapLimit(mints, 3, async (mint) => {
    const r = await get(`${RC}/tokens/${mint}/report`, { gapMs: 170, retries: 2, timeoutMs: 15000 });
    const p = parseRugcheck(r);
    if (p) out.set(mint, p);
  });
  return out;
}

/**
 * Sell-route probe: ask Jupiter (Metis) to quote token -> SOL for ~$100 worth.
 * A route existing does NOT prove a sell will succeed (freeze authority and
 * transfer hooks are not simulated) - but no route at all is a strong warning.
 */
export async function sellProbe(mint, decimals, priceUsd) {
  if (!(priceUsd > 0) || !Number.isInteger(decimals)) return null;
  const raw = BigInt(Math.max(1, Math.round((100 / priceUsd) * 10 ** Math.min(decimals, 9)))) * 10n ** BigInt(Math.max(0, decimals - 9));
  try {
    await sleep(350);
    const res = await fetch(`${JUP}/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}&amount=${raw}&slippageBps=300`, {
      headers: { accept: 'application/json', ...(JUP_KEY ? { 'x-api-key': JUP_KEY } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      const code = String(body.errorCode || '');
      if (/NOT_TRADABLE|NO_ROUTES|COULD_NOT_FIND_ANY_ROUTE/i.test(code)) return { sellable: false, code };
      return null;
    }
    if (!res.ok) return null;
    const q = await res.json();
    return { sellable: true, impactPct: num(q.priceImpactPct, 0) * 100 };
  } catch {
    return null;
  }
}

/** Last-known price/liquidity for arbitrary mints (used for outcome checks and paper positions). */
export async function priceLookup(mints) {
  const out = new Map();
  if (!mints.length) return out;
  const [ds, { jup }] = await Promise.all([dexscreenerBatch(mints), jupiterBatch(mints).then((r) => ({ jup: r.jup.size ? r.jup : r.dat }))]);
  for (const m of mints) {
    const j = jup.get(m);
    const d = ds.get(m);
    const price = num(j?.usdPrice) ?? num(d?.priceUsd);
    const liq = num(d?.liquidity?.usd) ?? num(j?.liquidity);
    if (price > 0) out.set(m, { price, liq: liq ?? 0 });
  }
  return out;
}

// ------------------------------------------------------------ normalisation
function parseX(url) {
  const u = httpsUrl(url);
  if (!u) return null;
  const m = u.match(/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^?#]*)/i);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'i' && parts[1] === 'communities') return { url: u, kind: 'community' };
  if (['search', 'hashtag', 'intent', 'home', 'i', 'share'].includes(parts[0].toLowerCase())) return { url: u, kind: 'link' };
  const handle = parts[0].replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { url: u, kind: 'link' };
  return { url: u, handle, kind: parts[1] === 'status' ? 'tweet' : 'profile' };
}

/**
 * Merge every source into one token record (the shape the site and scorer use).
 * `rc` is a parsed RugCheck report or a cached one from a previous run.
 */
export function buildToken(mint, { jup: j0, dat: d0, ds, meta = {}, rc }, t = Date.now()) {
  const j = j0 || meta.jup || d0 || meta.dat || {};
  const d = d0 || meta.dat || {};
  const audit = { ...(j.audit || {}), ...(d.audit || {}) };
  const s1 = j.stats1h || d.stats1h || {};
  const st = (k) => j[k] || d[k] || {};
  const volOf = (s) => (s.buyVolume != null || s.sellVolume != null ? num(s.buyVolume, 0) + num(s.sellVolume, 0) : null);
  const createdAt = ts(j.firstPool?.createdAt) ?? ts(j.createdAt) ?? (ds?._first < Infinity ? ds._first : null) ?? ts(ds?.pairCreatedAt);
  const jv = { m5: volOf(st('stats5m')), h1: volOf(s1), h6: volOf(st('stats6h')), h24: volOf(st('stats24h')) };
  const haveJupStats = jv.h24 != null;
  const txOf = (s, k) => (haveJupStats ? [num(s.numBuys, 0), num(s.numSells, 0)] : [num(ds?.txns?.[k]?.buys, 0), num(ds?.txns?.[k]?.sells, 0)]);
  const launchpad = clean(j.launchpad || d.launchpad, 30) || null;
  const graduated = !!(j.graduatedPool || d.graduatedPool);
  const onCurve = !!launchpad && !graduated && num(d.bondingCurve, 0) < 100;

  const links = { ...(meta.links || {}) };
  for (const s of ds?.info?.socials || []) {
    if (s.type === 'twitter') links.x ??= httpsUrl(s.url);
    if (s.type === 'telegram') links.tg ??= httpsUrl(s.url);
  }
  links.web ??= httpsUrl(ds?.info?.websites?.[0]?.url);
  links.x ??= httpsUrl(j.twitter || d.twitter);
  links.tg ??= httpsUrl(j.telegram || d.telegram);
  links.web ??= httpsUrl(j.website || d.website);
  const social = {};
  const x = parseX(links.x);
  if (x) {
    social.x = x;
    const pt = d.primaryTwitter || j.primaryTwitter;
    if (pt && x.handle && String(pt.handle || '').toLowerCase() === x.handle.toLowerCase()) {
      x.followers = num(pt.followerCount);
      x.following = num(pt.followingCount);
    }
  }
  if (links.tg && /^https:\/\/(t\.me|telegram\.me)\//.test(links.tg)) social.tg = { url: links.tg };
  // A "website" that is just a launchpad, DEX or social page is not a website.
  if (links.web && !/^https:\/\/([\w-]+\.)*(pump\.fun|x\.com|twitter\.com|t\.me|dexscreener\.com|linktr\.ee|bonk\.fun|letsbonk\.fun|raydium\.io|jup\.ag|tiktok\.com|instagram\.com|youtube\.com|discord\.gg|discord\.com)\//i.test(links.web)) social.web = { url: links.web };

  const devMints = num(audit.devMints);
  const devMigrations = num(audit.devMigrations);
  const tok = {
    mint,
    symbol: clean(j.symbol || ds?.baseToken?.symbol, 16) || '?',
    name: clean(j.name || ds?.baseToken?.name, 48) || '?',
    icon: httpsUrl(j.icon) || httpsUrl(ds?.info?.imageUrl) || null,
    desc: meta.desc || '',
    dex: clean(ds?.dexId || launchpad || '', 20),
    launchpad,
    pair: isMint(ds?.pairAddress) ? ds.pairAddress : null,
    decimals: Number.isInteger(j.decimals) ? j.decimals : null,
    createdAt,
    ageMin: createdAt ? Math.max(0, (t - createdAt) / 60000) : null,
    price: num(j.usdPrice) ?? num(ds?.priceUsd),
    liq: num(ds?.liquidity?.usd) ?? num(j.liquidity),
    mcap: num(j.mcap) ?? num(ds?.marketCap) ?? num(ds?.fdv),
    vol: haveJupStats ? jv : { m5: num(ds?.volume?.m5, 0), h1: num(ds?.volume?.h1, 0), h6: num(ds?.volume?.h6, 0), h24: num(ds?.volume?.h24, 0) },
    tx: { m5: txOf(st('stats5m'), 'm5'), h1: txOf(s1, 'h1'), h24: txOf(st('stats24h'), 'h24') },
    chg: {
      m5: num(st('stats5m').priceChange) ?? num(ds?.priceChange?.m5),
      h1: num(s1.priceChange) ?? num(ds?.priceChange?.h1),
      h6: num(st('stats6h').priceChange) ?? num(ds?.priceChange?.h6),
      h24: num(st('stats24h').priceChange) ?? num(ds?.priceChange?.h24),
    },
    traders: num(s1.numTraders),
    holderChg: num(s1.holderChange),
    holders: num(j.holderCount) ?? num(d.holderCount) ?? rc?.holders ?? null,
    top10: num(audit.topHoldersPercentage),
    devPct: num(audit.devBalancePercentage),
    maxHolderPct: rc?.maxHolder ?? null,
    organic: num(j.organicScore),
    onCurve,
    boosts: num(ds?.boosts?.active) ?? meta.boost ?? 0,
    cto: meta.cto || false,
    safety: {
      mintRevoked: audit.mintAuthorityDisabled ?? rc?.mintRevoked ?? null,
      freezeRevoked: audit.freezeAuthorityDisabled ?? rc?.freezeRevoked ?? null,
      lpLocked: rc?.lpLocked ?? null,
      lpUnlockedRisk: rc?.lpUnlockedRisk || false,
      riskNorm: rc?.riskNorm ?? null,
      risks: rc?.risks || [],
      ext: rc?.ext || [],
      rugged: rc?.rugged || false,
      singleHolderRisk: rc?.singleHolderRisk || audit.highSingleOwnership === true,
      creatorRugRisk: rc?.creatorRugRisk || false,
      copycatRisk: rc?.copycatRisk || false,
      sniperPct: num(audit.sniperPct),
      insiderPct: num(audit.insiderPct),
      bundlePct: num(audit.bundlerStats?.holdingPct),
      botHolderPct: num(audit.botHoldersPercentage),
      devMints,
      devMigrations,
      iconReused: audit.iconReused === true,
      sus: audit.isSus === true,
      verified: j.isVerified === true,
      checked: !!rc,
    },
    social,
    src: meta.src || [],
  };
  return tok;
}
