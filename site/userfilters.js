// Your own filters: the same measurements the score uses, with limits you set.
// A token that breaks any active limit is simply not shown. Settings are kept
// in this browser (a few hundred bytes of localStorage).

const KEY = 'solsift.filters.v1';
const maxOf = (...v) => { const n = v.filter((x) => x != null); return n.length ? Math.max(...n) : null; };

/** kind: 'max' = value must be <= limit, 'min' = value must be >= limit. scoredOnly = data only exists after a full scan. */
export const LIMITS = [
  { id: 'top10Max', group: 'Holders', label: 'Top 10 holders own at most', unit: '%', kind: 'max', get: (t) => t.top10 },
  { id: 'devMax', group: 'Holders', label: 'Developer holds at most', unit: '%', kind: 'max', get: (t) => t.devPct },
  { id: 'sniperMax', group: 'Holders', label: 'Snipers hold at most', unit: '%', kind: 'max', get: (t) => t.safety?.sniperPct },
  { id: 'insiderMax', group: 'Holders', label: 'Insiders and bundles hold at most', unit: '%', kind: 'max', get: (t) => maxOf(t.safety?.insiderPct, t.safety?.bundlePct) },
  { id: 'holdersMin', group: 'Holders', label: 'Holders at least', unit: '', kind: 'min', get: (t) => t.holders },
  { id: 'devMintsMax', group: 'Holders', label: 'Creator launched at most', unit: 'tokens', kind: 'max', get: (t) => t.safety?.devMints },

  { id: 'liqMin', group: 'Market', label: 'Liquidity at least', unit: '$', kind: 'min', get: (t) => t.liq },
  { id: 'mcapMin', group: 'Market', label: 'Market cap at least', unit: '$', kind: 'min', get: (t) => t.mcap },
  { id: 'mcapMax', group: 'Market', label: 'Market cap at most', unit: '$', kind: 'max', get: (t) => t.mcap },
  { id: 'volMin', group: 'Market', label: 'Volume last hour at least', unit: '$', kind: 'min', get: (t) => t.vol?.h1 },
  { id: 'txMin', group: 'Market', label: 'Trades last hour at least', unit: '', kind: 'min', get: (t) => (t.tx?.h1 ? t.tx.h1[0] + t.tx.h1[1] : null) },
  { id: 'buyShareMin', group: 'Market', label: 'Buys are at least this share of trades', unit: '%', kind: 'min', get: (t) => { const x = t.tx?.h1; return x && x[0] + x[1] >= 5 ? (100 * x[0]) / (x[0] + x[1]) : null; } },
  { id: 'ageMin', group: 'Market', label: 'Age at least', unit: 'min', kind: 'min', get: (t) => (t.createdAt ? (Date.now() - t.createdAt) / 60000 : null) },
  { id: 'organicMin', group: 'Market', label: 'Organic activity score at least', unit: '/100', kind: 'min', get: (t) => t.organic },

  { id: 'lpMin', group: 'Safety and social', label: 'LP locked or burned at least', unit: '%', kind: 'min', scoredOnly: true, get: (t) => (t.onCurve ? 100 : t.safety?.lpLocked) },
  { id: 'xAgeMin', group: 'Safety and social', label: 'X account age at least', unit: 'days', kind: 'min', scoredOnly: true, get: (t) => t.social?.x?.ageDays },
  { id: 'xFollowersMin', group: 'Safety and social', label: 'X followers at least', unit: '', kind: 'min', get: (t) => t.social?.x?.followers },
  { id: 'tgMin', group: 'Safety and social', label: 'Telegram members at least', unit: '', kind: 'min', scoredOnly: true, get: (t) => t.social?.tg?.members },
];

export const SWITCHES = [
  { id: 'mintOff', label: 'Mint authority revoked', test: (t) => t.safety?.mintRevoked === true },
  { id: 'freezeOff', label: 'Freeze authority revoked', test: (t) => t.safety?.freezeRevoked === true },
  { id: 'hasX', label: 'Has an X account', test: (t) => !!t.social?.x && !t.social.x.missing },
  { id: 'hasTg', label: 'Has a Telegram', test: (t) => !!t.social?.tg },
  { id: 'hasWeb', label: 'Has a website', test: (t) => !!t.social?.web },
  { id: 'noFlags', label: 'No red flags raised', test: (t) => !(t.score?.flags?.length) },
  { id: 'notSus', label: 'Not marked suspicious by Jupiter', test: (t) => !t.safety?.sus },
  { id: 'iconOriginal', label: 'Token image is not reused', test: (t) => !t.safety?.iconReused },
];

const defaults = () => ({ limits: {}, switches: {}, strict: true });

export function loadFilters() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (j && typeof j === 'object') return { limits: { ...(j.limits || {}) }, switches: { ...(j.switches || {}) }, strict: j.strict !== false };
  } catch { /* corrupted or blocked storage */ }
  return defaults();
}
export function saveFilters(f) {
  try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* ignore */ }
}
export const resetFilters = () => { const f = defaults(); saveFilters(f); return f; };

export function activeCount(f) {
  return LIMITS.filter((l) => Number.isFinite(f.limits[l.id])).length + SWITCHES.filter((s) => f.switches[s.id]).length;
}

/**
 * Does token `t` satisfy every active filter?
 * `live` = the token comes from the live feed, where scan-only measurements do not exist yet
 * (those limits are skipped there rather than hiding everything).
 */
export function passes(t, f, live = false) {
  for (const l of LIMITS) {
    const limit = f.limits[l.id];
    if (!Number.isFinite(limit)) continue;
    if (live && l.scoredOnly) continue;
    const v = l.get(t);
    if (v == null || !Number.isFinite(v)) { if (f.strict) return false; continue; }
    if (l.kind === 'max' ? v > limit : v < limit) return false;
  }
  for (const s of SWITCHES) if (f.switches[s.id] && !s.test(t)) return false;
  return true;
}
