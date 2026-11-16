// Live launches history.
//
// The live feeds only ever show the newest ~30 tokens, so anything worth a
// second look has to be remembered here. To keep that cheap:
//   - one compact record per token (about 1 KB), never the raw API responses;
//   - "keepers" (tokens that pass your filters, or score reasonably) are held
//     for up to 12 hours and refreshed in the background;
//   - everything else is forgotten 20 minutes after it scrolls out of the feed;
//   - at most 5,000 tokens in memory (a few MB of RAM) and at most 800 keepers
//     / 1.2 MB in the browser's localStorage, so a reload restores the list.
import { buildToken } from './lib/normalize.js';
import { scoreToken, finalise } from './lib/score.js';

const KEY = 'solsift.live.v2';
export const CAPS = { memory: 5000, persist: 800, persistBytes: 1_200_000, keepMs: 12 * 3600e3, idleMs: 20 * 60e3 };

const MARKET = ['price', 'liq', 'mcap', 'holders', 'organic', 'top10', 'devPct', 'traders', 'holderChg'];
const DAT_ONLY_SAFETY = ['sniperPct', 'insiderPct', 'bundlePct', 'botHolderPct'];
const rescore = (t) => { t.score = finalise(scoreToken(t, null), null, 0); return t; };
const hasStats = (t) => (t.vol?.h24 || 0) > 0 || (t.tx?.h24 ? t.tx.h24[0] + t.tx.h24[1] : 0) > 0;

export function createLiveStore({ isKeeper }) {
  const map = new Map(); // mint -> { t, first, upd, full, keep }
  let added = 0;
  let savedBytes = 0;

  /**
   * source 'dat' = Jupiter's rich feed (snipers, insiders, curve progress): replaces the record.
   * source 'jup' = the lighter documented API: updates market numbers, and only rebuilds the
   *                record when no rich data has arrived for two minutes.
   */
  function upsert(mint, source, raw, quiet = false) {
    const now = Date.now();
    let fresh;
    try { fresh = buildToken(mint, source === 'dat' ? { dat: raw, meta: {} } : { jup: raw, meta: {} }, now); } catch { return; }
    if (!fresh || fresh.ageMin == null) return;
    const rec = map.get(mint);
    let t = fresh;
    let full = rec ? rec.full : 0;
    if (source === 'dat') full = now;
    else if (rec && now - rec.full < 120000) {
      t = rec.t;
      for (const k of MARKET) if (fresh[k] != null) t[k] = fresh[k];
      if (hasStats(fresh)) { t.vol = fresh.vol; t.tx = fresh.tx; t.chg = fresh.chg; }
      t.ageMin = fresh.ageMin;
    } else if (rec) {
      // Rebuilt from the lighter feed: keep what only the rich feed knows.
      for (const k of DAT_ONLY_SAFETY) if (fresh.safety[k] == null && rec.t.safety?.[k] != null) fresh.safety[k] = rec.t.safety[k];
      if (rec.t.safety?.iconReused) fresh.safety.iconReused = true;
      if (fresh.curvePct == null) fresh.curvePct = rec.t.curvePct;
      if (fresh.social?.x && rec.t.social?.x?.followers != null && fresh.social.x.followers == null) fresh.social.x.followers = rec.t.social.x.followers;
    }
    rescore(t);
    const first = rec ? rec.first : quiet ? now - 60000 : now;
    Object.assign(t, { live: true, seen: first, tags: [] });
    if (!rec && !quiet) added++;
    map.set(mint, { t, first, upd: now, full, keep: rec ? rec.keep : false });
  }

  function prune() {
    const now = Date.now();
    for (const [m, r] of map) {
      const age = now - r.first;
      r.keep = !!isKeeper(r.t);
      const txH1 = r.t.tx?.h1 ? r.t.tx.h1[0] + r.t.tx.h1[1] : 0;
      const dead = age > 45 * 60e3 && ((r.t.liq != null && r.t.liq < 500) || (txH1 === 0 && r.t.score.total < 45));
      if (r.keep ? age > CAPS.keepMs || dead : now - r.upd > CAPS.idleMs) map.delete(m);
    }
    if (map.size > CAPS.memory) {
      const order = [...map.entries()].sort((a, b) => (a[1].keep ? 1 : 0) - (b[1].keep ? 1 : 0) || a[1].first - b[1].first);
      for (const [m] of order.slice(0, map.size - CAPS.memory)) map.delete(m);
    }
  }

  /** Keepers that have gone longest without fresh data. */
  function refreshTargets(n) {
    return [...map.entries()].filter(([, r]) => r.keep).sort((a, b) => a[1].upd - b[1].upd).slice(0, n).map(([m]) => m);
  }

  function save() {
    let rows = [...map.values()].filter((r) => r.keep).sort((a, b) => b.first - a.first).slice(0, CAPS.persist).map((r) => {
      const { score, live, seen, tags, desc, src, ...t } = r.t; // the score is recomputed on load
      return [r.first, r.upd, r.full, t];
    });
    let json = JSON.stringify(rows);
    while (json.length > CAPS.persistBytes && rows.length > 50) { rows = rows.slice(0, Math.floor(rows.length * 0.8)); json = JSON.stringify(rows); }
    try { localStorage.setItem(KEY, json); savedBytes = json.length; } catch {
      try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
      savedBytes = 0;
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return 0;
      savedBytes = raw.length;
      const now = Date.now();
      let n = 0;
      for (const row of JSON.parse(raw)) {
        const [first, upd, full, t] = row;
        if (!t || typeof t.mint !== 'string' || now - first > CAPS.keepMs || map.has(t.mint)) continue;
        t.ageMin = t.createdAt ? (now - t.createdAt) / 60000 : t.ageMin;
        rescore(t);
        Object.assign(t, { live: true, seen: first, tags: [] });
        map.set(t.mint, { t, first, upd, full: full || 0, keep: true });
        n++;
      }
      return n;
    } catch {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      return 0;
    }
  }

  function clear() {
    map.clear();
    added = 0;
    savedBytes = 0;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  return {
    upsert, prune, refreshTargets, save, load, clear,
    get: (mint) => map.get(mint)?.t,
    list: () => [...map.values()].map((r) => r.t),
    stats: () => ({ total: map.size, keepers: [...map.values()].filter((r) => r.keep).length, added, savedBytes }),
  };
}
