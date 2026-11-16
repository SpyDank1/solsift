// Turning raw API objects into one sanitised token record.
// Pure code with no Node APIs: the scanner uses it, and so does the website's live feed.
//
// Everything a token creator controls (names, descriptions, links, images) is
// treated as hostile input: trimmed, stripped of control characters, and URLs
// are kept only when they are plain https.
import { num } from './math.js';

export const SOL = 'So11111111111111111111111111111111111111112';

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
export const ts = (x) => {
  const n = typeof x === 'number' ? x : Date.parse(x);
  return Number.isFinite(n) && n > 1.5e12 ? n : null;
};

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
    curvePct: num(d.bondingCurve), // progress along the launchpad bonding curve, 0-100
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
