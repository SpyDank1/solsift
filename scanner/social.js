// Social credibility lookups - free, keyless, and all optional.
//
//   X / Twitter : api.fxtwitter.com/{handle}  -> account creation date, followers, bio
//   Telegram    : public t.me/{name} preview  -> member / subscriber count
//   Website     : rdap.org/domain/{domain}    -> domain registration date
//
// Every lookup can fail (rate limits, datacenter IP blocks, TLDs without RDAP).
// A failed lookup leaves the field unknown; the scorer treats unknown as
// "below neutral", never as good. Results are cached in state so each account
// or domain is fetched at most once every 12 hours.
import { get, mapLimit, num } from './util.js';

const TTL = 12 * 3600e3;
const X_CAP = 60; // new X lookups per run
const TG_CAP = 40;
const WEB_CAP = 30;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
/** Registrable domain, good enough for common TLDs (a.b.example.com -> example.com, x.co.uk -> x.co.uk). */
function baseDomain(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const two = p.slice(-2).join('.');
  return /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
}
// Shared hosting: the "domain age" belongs to the platform, not the project.
const SHARED_HOSTS = /(^|\.)(vercel\.app|netlify\.app|github\.io|pages\.dev|web\.app|carrd\.co|wixsite\.com|framer\.website|framer\.app|notion\.site|gitbook\.io|medium\.com|substack\.com|webflow\.io|godaddysites\.com|my\.canva\.site|canva\.site|replit\.app|lovable\.app|bolt\.new|surge\.sh|fly\.dev|onrender\.com|herokuapp\.com|blogspot\.com|wordpress\.com|site\.google\.com|sites\.google\.com)$/;

/** Keys identifying a token's social links, used to spot the same links on many tokens. */
export function socialKeys(t) {
  const keys = [];
  const x = t.social?.x;
  if (x?.kind === 'profile' && x.handle) keys.push(`x:${x.handle.toLowerCase()}`);
  const tg = t.social?.tg?.url?.match(/^https:\/\/(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_+-]{3,})/);
  if (tg) keys.push(`tg:${tg[1].toLowerCase()}`);
  const h = t.social?.web && hostOf(t.social.web.url);
  if (h && !SHARED_HOSTS.test(h)) keys.push(`web:${baseDomain(h)}`);
  return keys;
}

const MISSING = { missing: true };

async function lookupX(handle) {
  // FxTwitter answers a false "User not found" for roughly a third of valid handles,
  // so a 404 only counts after several consecutive misses.
  let r = MISSING;
  for (let i = 0; i < 5 && r === MISSING; i++) r = await get(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, { gapMs: 300, retries: 1, timeoutMs: 9000, notFound: MISSING });
  if (r === MISSING) return MISSING;
  const u = r?.user;
  if (!u) return null;
  // Fall back to the creation time encoded in the account's snowflake id.
  let created = Date.parse(u.joined || u.created_at || '');
  if (!Number.isFinite(created) && /^\d{15,20}$/.test(String(u.id))) created = Number((BigInt(u.id) >> 22n) + 1288834974657n);
  if (!Number.isFinite(created)) return null;
  return {
    created,
    followers: num(u.followers),
    following: num(u.following),
    tweets: num(u.tweets) ?? num(u.statuses),
    verified: u.verification?.verified === true || u.verified === true,
    bio: String(u.description || '').slice(0, 400),
    site: String(u.website?.url || '').slice(0, 200),
  };
}

async function lookupTelegram(name) {
  const html = await get(`https://t.me/${name}`, { text: true, gapMs: 500, retries: 1, timeoutMs: 9000 });
  if (typeof html !== 'string') return null;
  const m = html.match(/tgme_page_extra">([^<]{1,80})</);
  if (!m) return { members: null };
  const n = m[1].match(/([\d\s.,]+)\s*(members|subscribers)/i);
  return { members: n ? parseInt(n[1].replace(/[^\d]/g, ''), 10) || null : null };
}

async function lookupDomain(domain) {
  const r = await get(`https://rdap.org/domain/${domain}`, { gapMs: 1100, retries: 2, timeoutMs: 10000, headers: { accept: 'application/rdap+json, application/json' }, notFound: MISSING });
  if (r === MISSING) return MISSING; // TLD has no RDAP service
  const ev = (r?.events || []).find((e) => /registration/i.test(e.eventAction || ''));
  const created = ev ? Date.parse(ev.eventDate) : NaN;
  return Number.isFinite(created) ? { created } : null;
}

/**
 * Fill state.tracked[mint].soc for the given tokens (mutates state, not tokens).
 * Highest-volume tokens are looked up first when the per-run caps bite.
 */
export async function enrichSocial(tokens, state, t = Date.now()) {
  const cache = (state.xCache ||= {});
  const fresh = (c) => c && t - c.at < TTL;
  const order = [...tokens].sort((a, b) => (b.vol?.h1 || 0) - (a.vol?.h1 || 0));

  // X accounts
  const handles = [...new Set(order.filter((x) => x.social?.x?.kind === 'profile').map((x) => x.social.x.handle.toLowerCase()))].filter((h) => !fresh(cache[`x:${h}`])).slice(0, X_CAP);
  let xFail = 0;
  await mapLimit(handles, 2, async (h) => {
    if (xFail >= 8) return; // endpoint is blocking us this run; stop hammering it
    const r = await lookupX(h);
    if (r === MISSING) cache[`x:${h}`] = { at: t - TTL + 2 * 3600e3, missing: true }; // re-check in two hours
    else if (r) cache[`x:${h}`] = { at: t, ...r };
    else { xFail++; cache[`x:${h}`] = { at: t - TTL + 3600e3, failed: true }; } // retry in an hour
  });

  // Telegram
  const tgName = (x) => x.social?.tg?.url.match(/^https:\/\/(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{4,40})\/?$/)?.[1]?.toLowerCase();
  const tgs = [...new Set(order.map(tgName).filter(Boolean))].filter((n) => !fresh(cache[`tg:${n}`])).slice(0, TG_CAP);
  await mapLimit(tgs, 2, async (n) => {
    const r = await lookupTelegram(n);
    cache[`tg:${n}`] = r ? { at: t, ...r } : { at: t - TTL + 3600e3, failed: true };
  });

  // Websites
  const domOf = (x) => { const h = x.social?.web && hostOf(x.social.web.url); return h && !SHARED_HOSTS.test(h) ? baseDomain(h) : null; };
  const doms = [...new Set(order.map(domOf).filter(Boolean))].filter((d) => !fresh(cache[`web:${d}`])).slice(0, WEB_CAP);
  await mapLimit(doms, 1, async (d) => {
    const r = await lookupDomain(d);
    if (r === MISSING) cache[`web:${d}`] = { at: t, failed: true }; // no RDAP for this TLD; don't retry all day
    else cache[`web:${d}`] = r ? { at: t, ...r } : { at: t - TTL + 3600e3, failed: true };
  });

  for (const tok of tokens) {
    const soc = {};
    const x = tok.social?.x;
    if (x?.kind === 'profile') {
      const c = cache[`x:${x.handle.toLowerCase()}`];
      if (c?.missing) soc.x = { missing: true };
      else if (c && !c.failed) {
        const hay = `${c.bio} ${c.site}`.toLowerCase();
        const sym = String(tok.symbol || '').toLowerCase();
        const nameWord = String(tok.name || '').toLowerCase();
        soc.x = {
          ageDays: Math.max(0, Math.round((t - c.created) / 864e5)),
          followers: c.followers ?? x.followers ?? null,
          following: c.following,
          tweets: c.tweets,
          verified: c.verified,
          // Does the account itself point at this token? (mint address, $TICKER, or the name in its handle/bio)
          mentionsToken: hay.includes(tok.mint.toLowerCase()) || (sym.length >= 3 && (hay.includes(`$${sym}`) || x.handle.toLowerCase().includes(sym))) || (nameWord.length >= 4 && hay.includes(nameWord)),
        };
      }
    }
    const n = tgName(tok);
    if (n && cache[`tg:${n}`] && !cache[`tg:${n}`].failed) soc.tg = { members: cache[`tg:${n}`].members };
    const d = domOf(tok);
    if (d) {
      // Linking a famous, unrelated site (a game studio, a dictionary) borrows its domain age. Only credit
      // a domain that names the token, or that the token's own X account points to.
      const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const dn = flat(d.split('.')[0]);
      const xc = x?.kind === 'profile' ? cache[`x:${x.handle.toLowerCase()}`] : null;
      const sym = flat(tok.symbol);
      const nm = flat(tok.name);
      const related = (sym.length >= 3 && dn.includes(sym)) || (nm.length >= 4 && (dn.includes(nm) || (dn.length >= 4 && nm.includes(dn)))) || (x?.handle && dn.length >= 4 && flat(x.handle).includes(dn)) || (xc?.site && flat(xc.site).includes(flat(d)));
      soc.web = { related: !!related };
      const wc = cache[`web:${d}`];
      if (wc && !wc.failed) soc.web.ageDays = Math.max(0, Math.round((t - wc.created) / 864e5));
    }
    if (state.tracked[tok.mint]) state.tracked[tok.mint].soc = soc;
  }

  // Bound the cache.
  const keys = Object.keys(cache);
  if (keys.length > 5000) for (const k of keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 5000)) delete cache[k];
  return { x: handles.length, xFail, tg: tgs.length, web: doms.length };
}
