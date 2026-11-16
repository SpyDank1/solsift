/* SolSift front end. Plain JS modules, no build step, no third-party scripts.
   Everything rendered here originates from token creators (names, tickers,
   links, images), so every string goes through esc() and every URL through
   safeUrl() before it touches the DOM. The page's Content-Security-Policy
   forbids inline and remote scripts as a second line of defence, because this
   page asks wallets to sign transactions. */
import { SOL_MINT, createTrader, listWallets, onWalletChange, currentWallet, connectWallet, disconnectWallet, restoreWallet, solToLamports, pctOf } from './trade.js';
import { LIMITS, SWITCHES, loadFilters, saveFilters, resetFilters, activeCount, passes } from './userfilters.js';
import { createLiveStore, CAPS } from './livestore.js';
import { loadBot, saveBot, resetRules, newPortfolio, stepBot, describeRules, botStats } from './paperbot.js';

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const SETTINGS_KEY = 'solsift.settings.v1';
const DEFAULTS = { slippage: 'auto', priorityFee: 'auto', buyPresets: [0.1, 0.3, 0.5, 1], quickBuy: 0.1, sellPresets: [25, 50, 75, 100], maxImpact: 15, warnFlagged: true };
function loadSettings() {
  try {
    const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || {};
    const s = { ...DEFAULTS, ...j };
    s.buyPresets = (Array.isArray(s.buyPresets) ? s.buyPresets : DEFAULTS.buyPresets).map(Number).filter((n) => n > 0 && n <= 100).slice(0, 4);
    if (s.buyPresets.length !== 4) s.buyPresets = [...DEFAULTS.buyPresets];
    s.sellPresets = [...DEFAULTS.sellPresets];
    if (!(Number(s.quickBuy) > 0)) s.quickBuy = s.buyPresets[0];
    return s;
  } catch { return { ...DEFAULTS, buyPresets: [...DEFAULTS.buyPresets], sellPresets: [...DEFAULTS.sellPresets] }; }
}
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
let settings = loadSettings();
let filters = loadFilters();
const bot = loadBot(); // { rules, pf } for your paper bot
const botQuotes = new Map(); // mint -> { price, liq, at } fresh prices fetched for the bot

// ---------- state ----------
const state = { data: null, trends: null, model: null, paper: null, sort: 'score', open: null, mode: 'scored', liveStat: { last: 0, err: null, polls: 0 }, hold: null, holdAt: 0, meta: new Map(), local: null };
// A live token is worth remembering if it passes your filters, or if it scores reasonably on its own.
const live = createLiveStore({ isKeeper: (t) => (activeCount(filters) > 0 && passes(t, filters, true)) || t.score.total >= 45 });
let API = 'https://api.jup.ag'; // replaced by the local launcher's keyed proxy when available
let trader = createTrader(API);

const currentAll = () => (state.mode === 'live' ? live.list() : state.data?.tokens || []);
const findToken = (mint) => (state.mode === 'live' ? live.get(mint) : null) || (state.data?.tokens || []).find((x) => x.mint === mint) || live.get(mint) || state.meta.get(mint) || null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
const fmtUsd = (x) => {
  if (x == null || !isFinite(x)) return '-';
  const a = Math.abs(x);
  if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'k';
  return '$' + x.toFixed(a >= 10 ? 0 : 2);
};
const fmtPrice = (x) => {
  if (x == null || !isFinite(x) || x <= 0) return '-';
  if (x >= 1) return '$' + x.toFixed(2);
  if (x >= 0.01) return '$' + x.toFixed(4);
  const zeros = Math.max(0, -Math.floor(Math.log10(x)) - 1);
  return zeros >= 4 ? `$0.0<sub>${zeros}</sub>${String(Math.round(x * 10 ** (zeros + 4))).padStart(4, '0')}` : '$' + x.toPrecision(3);
};
const fmtPct = (x) => (x == null || !isFinite(x) ? '<span class="muted">-</span>' : `<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '+' : ''}${Math.abs(x) >= 1000 ? Math.round(x) : x.toFixed(1)}%</span>`);
const fmtNum = (x) => (x == null ? '-' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(Math.round(x)));
const fmtAmt = (x) => (x == null || !isFinite(x) ? '-' : x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
const ago = (ms) => {
  if (!ms) return '?';
  const m = Math.max(0, (Date.now() - ms) / 60000);
  if (m < 1.5) return Math.round(m * 60) + 's';
  if (m < 60) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(m < 600 ? 1 : 0) + 'h';
  return (m / 1440).toFixed(1) + 'd';
};
const days = (d) => (d == null ? '?' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d >= 30 ? Math.round(d / 30) + 'mo' : Math.round(d) + 'd');
const shortAddr = (a) => (a ? `${a.slice(0, 4)}...${a.slice(-4)}` : '');
const scoreColor = (s, isGated) => (isGated ? 'var(--bad)' : s >= 75 ? 'var(--good)' : s >= 60 ? 'var(--ok)' : s >= 45 ? 'var(--warn)' : 'var(--bad)');
const verdictClass = (v) => ({ Strong: 'good', Promising: 'ok', Speculative: 'warn', Weak: 'dim', Avoid: 'bad', 'High risk': 'bad', 'Likely rug': 'bad' }[v] || 'dim');
const gated = (t) => (t.score?.gates?.length || 0) > 0;
const ring = (t, big) => `<div class="score${big ? ' big' : ''}" style="--p:${t.score.total};--c:${scoreColor(t.score.total, gated(t))}"><span>${t.score.total}</span></div>`;
const icon = (t, cls = '') => {
  const u = safeUrl(t.icon);
  const ph = `<div class="ph ${cls}">${esc((t.symbol || '?').slice(0, 2).toUpperCase())}</div>`;
  return u ? `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(ph)}">` : ph;
};
// Broken token images fall back to initials (no inline handlers: the CSP forbids them).
document.addEventListener('error', (e) => { const el = e.target; if (el && el.tagName === 'IMG' && el.dataset.ph) el.outerHTML = el.dataset.ph; }, true);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('on'), 1800);
}

// ---------- chips ----------
function safetyChips(t) {
  const s = t.safety || {};
  const out = [];
  const tri = (v, okTxt, badTxt, unkTxt) => (v === true ? `<span class="chip good">${okTxt}</span>` : v === false ? `<span class="chip bad">${badTxt}</span>` : `<span class="chip dim">${unkTxt}</span>`);
  out.push(tri(s.mintRevoked, 'Mint off', 'Mint live', 'Mint ?'));
  out.push(tri(s.freezeRevoked, 'Freeze off', 'Freeze live', 'Freeze ?'));
  if (t.onCurve) out.push('<span class="chip dim">On curve</span>');
  else if (s.lpLocked != null) out.push(`<span class="chip ${s.lpLocked >= 90 ? 'good' : s.lpLocked >= 50 ? 'warn' : 'bad'}">LP ${Math.round(s.lpLocked)}%</span>`);
  if (t.top10 != null) out.push(`<span class="chip ${t.top10 <= 25 ? 'good' : t.top10 <= 40 ? 'warn' : 'bad'}">Top10 ${Math.round(t.top10)}%</span>`);
  return `<div class="chips">${out.join('')}</div>`;
}
function socialChips(t) {
  const so = t.social || {};
  const out = [];
  if (so.x) {
    const x = so.x;
    if (x.missing) out.push('<span class="chip bad">X not found</span>');
    else if (x.kind === 'profile' && x.ageDays != null) out.push(`<span class="chip ${x.ageDays >= 365 ? 'good' : x.ageDays >= 60 ? 'warn' : 'bad'}" title="X account age${x.followers != null ? ', followers' : ''}">X ${days(x.ageDays)}${x.followers != null ? ' · ' + fmtNum(x.followers) : ''}</span>`);
    else out.push(`<span class="chip dim">X ${x.kind === 'profile' ? (x.followers != null ? fmtNum(x.followers) : '?') : esc(x.kind || 'link')}</span>`);
  }
  if (so.tg) out.push(`<span class="chip dim">TG${so.tg.members != null ? ' ' + fmtNum(so.tg.members) : ''}</span>`);
  if (so.web) out.push(`<span class="chip ${so.web.ageDays == null ? 'dim' : so.web.ageDays >= 365 ? 'good' : so.web.ageDays >= 30 ? 'warn' : 'bad'}">Web${so.web.ageDays != null ? ' ' + days(so.web.ageDays) : ''}</span>`);
  if (!out.length) out.push('<span class="chip bad">None</span>');
  return `<div class="chips">${out.join('')}</div>`;
}

// ---------- platforms ----------
function platformOf(t) {
  const s = `${t.launchpad || ''} ${t.dex || ''}`.toLowerCase();
  if (s.includes('pump')) return 'pump.fun';
  if (s.includes('bonk')) return 'LetsBonk';
  if (s.includes('raydium') || s.includes('launchlab')) return 'Raydium';
  if (s.includes('met-dbc') || s.includes('meteora')) return 'Meteora';
  if (s.includes('moonshot')) return 'Moonshot';
  if (s.includes('orca')) return 'Orca';
  return String(t.launchpad || t.dex || 'Other').slice(0, 24);
}
const isPromo = (t) => t.promo ?? t.boosts > 0;
let platSig = '';
function syncPlatforms(all) {
  const sel = $('plat');
  if (document.activeElement === sel) return; // don't rebuild the menu while it is open
  const counts = new Map();
  let promo = 0;
  for (const t of all) {
    const p = platformOf(t);
    counts.set(p, (counts.get(p) || 0) + 1);
    if (isPromo(t)) promo++;
  }
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  const sig = entries.map((e) => e.join(':')).join(',') + '|' + promo;
  if (sig === platSig) return;
  platSig = sig;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All platforms</option>' + entries.map(([p, n]) => `<option value="${esc(p)}">${esc(p)} (${n})</option>`).join('') + (promo ? `<option value="__promo">Promoted on DEX Screener (${promo})</option>` : '');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

// ---------- token list ----------
function filtered() {
  const all = currentAll();
  syncPlatforms(all);
  const plat = $('plat').value;
  const stage = $('stage').value;
  const q = $('q').value.trim().toLowerCase();
  const min = +$('min').value;
  const maxAge = +$('age').value;
  const hide = $('hide').checked;
  const isLive = state.mode === 'live';
  const useMine = activeCount(filters) > 0;
  let hidden = 0;
  let mine = 0;
  const list = all.filter((t) => {
    if (hide && gated(t)) { hidden++; return false; }
    if (t.score.total < min) return false;
    if (plat === '__promo' ? !isPromo(t) : plat && platformOf(t) !== plat) return false;
    if (stage === 'curve' && !t.onCurve) return false;
    if (stage === 'grad' && t.onCurve) return false;
    if (maxAge && (Date.now() - t.createdAt) / 60000 > maxAge) return false;
    if (q) {
      const hay = `${t.name} ${t.symbol} ${t.mint} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (useMine && !passes(t, filters, isLive)) { mine++; return false; }
    return true;
  });
  const key = { score: (t) => t.score.total, new: (t) => t.createdAt, vol: (t) => t.vol?.h1 || 0, liq: (t) => t.liq || 0, chg: (t) => t.chg?.h1 ?? -1e9, mcap: (t) => t.mcap || 0 }[state.sort];
  // Ties (common among capped scores) fall back to the uncapped rule score, then to recency.
  list.sort((a, b) => key(b) - key(a) || (b.score.rule || 0) - (a.score.rule || 0) || (b.createdAt || 0) - (a.createdAt || 0));
  return { list, hidden, mine, total: all.length };
}

function renderRows() {
  const { list, hidden, mine, total } = filtered();
  const bits = [`${list.length} of ${total} ${state.mode === 'live' ? 'live launches' : 'shown'}`];
  if (hidden) bits.push(`${hidden} hidden as likely rugs`);
  if (mine) bits.push(`${mine} hidden by your filters`);
  $('count').textContent = bits.join(' · ');
  $('empty').textContent = state.mode === 'live' && !total ? 'Waiting for the live feed...' : 'No tokens match these filters.';
  const freshCut = Date.now() - 6500;
  $('empty').hidden = list.length > 0;
  document.querySelectorAll('th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort));
  const quick = settings.quickBuy;
  $('rows').innerHTML = list.slice(0, 300).map((t) => `
    <tr data-mint="${esc(t.mint)}" class="${gated(t) ? 'flagged' : ''}${t.live && t.seen > freshCut ? ' fresh' : ''}">
      <td><div class="tok">${icon(t)}<div><div class="nm">${esc(t.name || t.symbol)}</div>
        <div class="sub"><b>$${esc(t.symbol)}</b><span>${ago(t.createdAt)} old</span><span>${esc(platformOf(t))}</span>${t.onCurve ? `<span class="chip dim">curve${t.curvePct != null ? ' ' + Math.round(t.curvePct) + '%' : ''}</span>` : ''}${t.live ? '<span class="chip live">LIVE</span>' : ''}</div></div></div></td>
      <td>${ring(t)}</td>
      <td class="l"><span class="chip ${verdictClass(t.score.verdict)}">${esc(t.score.verdict)}</span></td>
      <td>${fmtPrice(t.price)}</td>
      <td>${fmtPct(t.chg?.h1)}</td>
      <td>${fmtUsd(t.mcap)}</td>
      <td>${fmtUsd(t.liq)}</td>
      <td>${fmtUsd(t.vol?.h1)}</td>
      <td class="l">${safetyChips(t)}</td>
      <td class="l">${socialChips(t)}</td>
      <td><button class="btn buy sm${gated(t) ? ' danger' : ''}" data-buysol="${quick}" data-mint="${esc(t.mint)}" title="Buy with ${quick} SOL">Buy ${quick}</button></td>
    </tr>`).join('');
}

function renderTiles() {
  const d = state.data;
  if (!d) return;
  const toks = d.tokens || [];
  const clean = toks.filter((t) => !gated(t));
  const top = clean.reduce((a, t) => (t.score.total > (a?.score.total ?? -1) ? t : a), null);
  const m = state.model || {};
  const tiles = [
    ['Tokens tracked', toks.length, `${d.counts?.discovered ?? toks.length} discovered this scan`],
    ['Flagged as likely rugs', toks.length - clean.length, toks.length ? `${Math.round((100 * (toks.length - clean.length)) / toks.length)}% of the feed` : ''],
    ['Scoring 60+', clean.filter((t) => t.score.total >= 60).length, 'promising or better'],
    ['Top score', top ? top.score.total : '-', top ? '$' + top.symbol : ''],
    ['Outcomes learned from', m.nSamples ?? 0, m.ready ? `model drives ${Math.round((m.blend || 0) * 100)}% of the score` : 'rules only until enough data'],
  ];
  $('tiles').innerHTML = tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
  const ageMin = (Date.now() - d.generatedAt) / 60000;
  $('dot').classList.toggle('stale', ageMin > 45);
  $('scanStatus').textContent = `Last full scan ${ago(d.generatedAt)} ago${ageMin > 45 ? (state.local ? ' (local scanner will catch up)' : ' (scheduled runs can be delayed by GitHub)') : ''}`;
}

// ---------- your filters ----------
function renderFilterPanel() {
  const groups = [...new Set(LIMITS.map((l) => l.group))];
  const limitInput = (l) => `<label class="flim"><span>${esc(l.label)}${l.scoredOnly ? ' <i title="Only measured in the full scan, so it is ignored in Live launches">scan only</i>' : ''}</span>
    <span class="fbox"><input type="number" min="0" step="any" inputmode="decimal" data-limit="${l.id}" value="${Number.isFinite(filters.limits[l.id]) ? filters.limits[l.id] : ''}" placeholder="off"><em>${esc(l.unit)}</em></span></label>`;
  $('filterPanel').innerHTML = `
    <div class="fgrid">${groups.map((g) => `<div class="fcol"><h4>${esc(g)}</h4>${LIMITS.filter((l) => l.group === g).map(limitInput).join('')}</div>`).join('')}
      <div class="fcol"><h4>Must be true</h4>${SWITCHES.map((s) => `<label class="fsw"><input type="checkbox" data-switch="${s.id}"${filters.switches[s.id] ? ' checked' : ''}> ${esc(s.label)}</label>`).join('')}</div>
    </div>
    <div class="ffoot">
      <label class="fsw"><input type="checkbox" id="fstrict"${filters.strict ? ' checked' : ''}> Also hide tokens where a filtered value is unknown</label>
      <span class="muted">Leave a box empty to switch that filter off. Saved in this browser.</span>
      <button class="btn sm" data-filter-reset>Clear all</button>
    </div>`;
  renderFilterButton();
}
function renderFilterButton() {
  const n = activeCount(filters);
  $('filterBtn').textContent = n ? `My filters (${n})` : 'My filters';
  $('filterBtn').classList.toggle('active', n > 0);
}
function onFilterInput(e) {
  const el = e.target;
  if (el.dataset.limit) {
    const v = el.value.trim() === '' ? NaN : Number(el.value);
    if (Number.isFinite(v) && v >= 0) filters.limits[el.dataset.limit] = v; else delete filters.limits[el.dataset.limit];
  } else if (el.dataset.switch) {
    if (el.checked) filters.switches[el.dataset.switch] = true; else delete filters.switches[el.dataset.switch];
  } else if (el.id === 'fstrict') filters.strict = el.checked;
  else return;
  saveFilters(filters);
  renderFilterButton();
  live.prune(); // keeper status depends on your filters
  renderRows();
}

// ---------- drawer ----------
function holdingOf(mint) { return state.hold?.tokens.get(mint) || null; }
function holdLine(t) {
  const w = currentWallet();
  if (!w) return 'Connect a wallet to see your balance.';
  if (!state.hold) return 'Loading your balance...';
  const h = holdingOf(t.mint);
  if (!h) return `You hold none of this token. Wallet: ${state.hold.sol.toFixed(3)} SOL.`;
  return `You hold ${fmtAmt(h.ui)} $${t.symbol}${t.price ? ` (about ${fmtUsd(h.ui * t.price)})` : ''}. Wallet: ${state.hold.sol.toFixed(3)} SOL.`;
}
const slipText = () => (settings.slippage === 'auto' ? 'Auto' : `${settings.slippage}%`);
const feeText = () => (settings.priorityFee === 'auto' ? 'Auto' : `${settings.priorityFee} SOL`);
function tradeBox(t) {
  const m = esc(t.mint);
  const danger = gated(t) ? ' danger' : '';
  return `<div class="trade">
    <div class="trow"><span class="tl">Buy</span>${settings.buyPresets.map((p) => `<button class="btn buy sm${danger}" data-buysol="${p}" data-mint="${m}">${p} SOL</button>`).join('')}
      <span class="tcustom"><input type="number" min="0" step="0.01" inputmode="decimal" id="buyCustom" placeholder="SOL" aria-label="Custom SOL amount"><button class="btn sm" data-buycustom="${m}">Buy</button></span></div>
    <div class="trow"><span class="tl">Sell</span>${settings.sellPresets.map((p) => `<button class="btn sell sm" data-sellpct="${p}" data-mint="${m}">${p}%</button>`).join('')}</div>
    <div class="tnote" id="holdInfo">${esc(holdLine(t))}</div>
    <div class="tnote">Slippage: <b>${esc(slipText())}</b> · Priority fee: <b>${esc(feeText())}</b> · <a href="#" data-settings>Change</a> · <a href="https://jup.ag/swap?sell=${SOL_MINT}&buy=${m}" target="_blank" rel="noopener noreferrer">Open on jup.ag</a></div>
  </div>`;
}

function openDrawer(mint) {
  const t = findToken(mint);
  if (!t || !t.score) return;
  state.open = mint;
  const s = t.safety || {};
  const so = t.social || {};
  const comp = t.score.comp || {};
  const bars = [['Safety', comp.safety], ['Market', comp.market], ['Momentum', comp.momentum], ['Social', comp.social], ['Trend fit', comp.trend]]
    .map(([k, v]) => `<div class="bar"><span>${k}</span><div class="track"><div class="fill" style="width:${v || 0}%;background:${scoreColor(v || 0)}"></div></div><b>${v ?? '-'}</b></div>`).join('');
  const reasons = [
    ...(t.score.gates || []).map((r) => `<li class="con"><b>${esc(r)}</b></li>`),
    ...(t.score.flags || []).map((r) => `<li class="flag">${esc(r)}</li>`),
    ...(t.score.cons || []).map((r) => `<li class="con">${esc(r)}</li>`),
    ...(t.score.pros || []).map((r) => `<li class="pro">${esc(r)}</li>`),
  ].join('');
  const risks = (s.risks || []).map((r) => `<li class="${r.l === 'danger' ? 'con' : 'flag'}">${esc(r.n)}${r.d ? ` <span class="muted">- ${esc(r.d)}</span>` : ''}</li>`).join('');
  const link = (u, label) => { const h = safeUrl(u); return h ? `<a class="btn sm" href="${esc(h)}" target="_blank" rel="noopener noreferrer nofollow">${esc(label)}</a>` : ''; };
  const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const tx = t.tx?.h1 || [0, 0];
  const pctOrDash = (v) => (v != null ? (+v).toFixed(1) + '%' : '-');
  const chart = isMint(t.pair) ? `<iframe class="chart" loading="lazy" title="Price chart" src="https://dexscreener.com/solana/${esc(t.pair)}?embed=1&theme=dark&info=0&trades=0"></iframe>` : '';
  $('drawer').innerHTML = `
    <button class="close" aria-label="Close" data-close>&times;</button>
    <div class="dhead">${icon(t)}<div><h2>${esc(t.name || t.symbol)} <span class="muted">$${esc(t.symbol)}</span></h2>
      <div class="mint" data-copy="${esc(t.mint)}" title="Click to copy">${esc(t.mint)}</div></div></div>
    <div style="display:flex;gap:16px;align-items:center">${ring(t, true)}
      <div><span class="chip ${verdictClass(t.score.verdict)}">${esc(t.score.verdict)}</span>
        <div class="muted" style="margin-top:6px;font-size:12.5px">Rules: ${t.score.rule}${t.score.ml != null ? ` · Model: ${Math.round(t.score.ml * 100)}% chance of holding up` : ' · Model: not enough data yet'}</div>
        <div class="chips" style="margin-top:6px">${(t.tags || []).map((g) => `<span class="chip dim">${esc(g)}</span>`).join('')}</div></div></div>
    ${tradeBox(t)}
    ${t.desc ? `<p class="muted" style="font-size:13px">${esc(t.desc)}</p>` : ''}
    ${t.live ? '<div class="disclaimer" style="margin-top:12px"><b>Live estimate.</b> Scored in your browser from Jupiter data that is seconds old. The on-chain risk report, LP lock, sell-route probe and social-account age are only checked in the next full scan, so treat this number as a first impression.</div>' : ''}
    <div class="sec"><h3>Score breakdown</h3><div class="bars">${bars}</div></div>
    <div class="sec"><h3>Why</h3><ul class="reasons">${reasons || '<li class="muted">No notable signals.</li>'}</ul></div>
    <div class="sec"><h3>Market</h3><div class="kv">
      ${kv('Price', fmtPrice(t.price))}${kv('Market cap', fmtUsd(t.mcap))}${kv('Liquidity', fmtUsd(t.liq))}
      ${kv('Vol 1h', fmtUsd(t.vol?.h1))}${kv('Vol 24h', fmtUsd(t.vol?.h24))}${kv('Buys / sells 1h', `${tx[0]} / ${tx[1]}`)}
      ${kv('5m', fmtPct(t.chg?.m5))}${kv('1h', fmtPct(t.chg?.h1))}${kv('24h', fmtPct(t.chg?.h24))}
      ${kv('Age', ago(t.createdAt))}${kv('Holders', fmtNum(t.holders))}${kv('Top 10 hold', pctOrDash(t.top10))}
      ${kv('Dev holds', pctOrDash(t.devPct))}${kv('Snipers', pctOrDash(s.sniperPct))}${kv('Insiders', pctOrDash(s.insiderPct))}
    </div></div>
    ${chart ? `<div class="sec"><h3>Chart</h3>${chart}</div>` : ''}
    <div class="sec"><h3>Safety</h3>${safetyChips(t)}${risks ? `<ul class="reasons" style="margin-top:10px">${risks}</ul>` : ''}</div>
    <div class="sec"><h3>Social</h3>${socialChips(t)}
      <div class="links" style="margin-top:10px">${link(so.x?.url, so.x?.handle ? '@' + so.x.handle : 'X')}${link(so.tg?.url, 'Telegram')}${link(so.web?.url, 'Website')}</div></div>
    <div class="sec"><h3>Verify it yourself</h3><div class="links">
      ${link(`https://dexscreener.com/solana/${t.pair || t.mint}`, 'DEX Screener')}
      ${link(`https://rugcheck.xyz/tokens/${t.mint}`, 'RugCheck')}
      ${link(`https://solscan.io/token/${t.mint}`, 'Solscan')}
      ${link(`https://jup.ag/tokens/${t.mint}`, 'Jupiter')}
      ${link(`https://gmgn.ai/sol/token/${t.mint}`, 'GMGN')}
    </div></div>
    <div class="muted" style="font-size:11.5px;margin-top:16px">Swaps by Jupiter Ultra · Powered by Jupiter. Jupiter charges its own fee on each swap. You approve every transaction in your own wallet.</div>`;
  $('drawer').classList.add('on');
  $('overlay').classList.add('on');
  $('drawer').setAttribute('aria-hidden', 'false');
  if (currentWallet() && Date.now() - state.holdAt > 20000) refreshHoldings();
}
function closeDrawer() {
  state.open = null;
  $('drawer').classList.remove('on');
  $('overlay').classList.remove('on');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('drawer').innerHTML = '';
}

// ---------- wallet ----------
function renderWallet() {
  const w = currentWallet();
  const btn = $('walletBtn');
  btn.classList.toggle('connected', !!w);
  btn.textContent = w ? `${shortAddr(w.address)}${state.hold ? ` · ${state.hold.sol.toFixed(3)} SOL` : ''}` : 'Connect wallet';
  const t = state.open && findToken(state.open);
  if (t && $('holdInfo')) $('holdInfo').textContent = holdLine(t);
  if (document.querySelector('.tab.on')?.dataset.view === 'wallet') renderHoldings();
}
function renderWalletMenu() {
  const w = currentWallet();
  const list = listWallets();
  const menu = $('walletMenu');
  if (w) {
    menu.innerHTML = `<div class="wm-title">${esc(w.name)}</div><div class="mint" data-copy="${esc(w.address)}" title="Click to copy">${esc(w.address)}</div>
      <button class="btn sm" data-wallet-refresh>Refresh balance</button><button class="btn sm" data-wallet-disconnect>Disconnect</button>`;
  } else if (list.length) {
    menu.innerHTML = `<div class="wm-title">Choose a wallet</div>${list.map((x) => `<button class="btn wm-item" data-wallet="${esc(x.name)}">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : ''}${esc(x.name)}</button>`).join('')}
      <div class="muted wm-note">SolSift never sees your keys. Your wallet shows every transaction for approval.</div>`;
  } else {
    menu.innerHTML = `<div class="wm-title">No Solana wallet found</div><div class="muted wm-note">Install a wallet extension, then reload this page.</div>
      <a class="btn sm" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">Get Phantom</a>
      <a class="btn sm" href="https://solflare.com/download" target="_blank" rel="noopener noreferrer">Get Solflare</a>`;
  }
}
function toggleWalletMenu(show) {
  const menu = $('walletMenu');
  const on = show ?? !menu.classList.contains('on');
  if (on) renderWalletMenu();
  menu.classList.toggle('on', on);
}
async function refreshHoldings() {
  const w = currentWallet();
  if (!w) { state.hold = null; renderWallet(); return; }
  try {
    state.hold = await trader.holdings(w.address);
    state.holdAt = Date.now();
  } catch (e) {
    if (!state.hold) tradeStatus('err', `Could not load your balances: ${e.message}`);
  }
  renderWallet();
}
onWalletChange(() => {
  if (!currentWallet()) state.hold = null;
  renderWallet();
  if ($('walletMenu').classList.contains('on')) renderWalletMenu();
});

// ---------- trading ----------
let busy = false;
function tradeStatus(kind, text, link) {
  const el = $('tradeStatus');
  el.className = `tstatus on ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">View transaction</a>` : ''}<button aria-label="Dismiss" data-status-close>&times;</button>`;
  clearTimeout(tradeStatus.t);
  if (kind !== 'work') tradeStatus.t = setTimeout(() => el.classList.remove('on'), kind === 'ok' ? 15000 : 9000);
}
async function doTrade({ side, mint, sol, pct }) {
  if (!isMint(mint)) return;
  if (busy) return toast('A trade is already in progress');
  if (!currentWallet()) { toggleWalletMenu(true); return tradeStatus('err', 'Connect a wallet first.'); }
  const t = findToken(mint);
  const sym = t?.symbol ? `$${t.symbol}` : shortAddr(mint);
  if (side === 'buy') {
    if (!(sol > 0)) return tradeStatus('err', 'Enter a SOL amount greater than zero.');
    if (t && gated(t) && settings.warnFlagged) {
      const why = t.score.gates.slice(0, 3).map((g) => '• ' + g).join('\n');
      if (!confirm(`SolSift flagged ${sym} as ${t.score.verdict.toLowerCase()}:\n\n${why}\n\nYou could lose everything you put in. Buy anyway?`)) return;
    }
    if (sol > 5 && !confirm(`Buy ${sym} with ${sol} SOL? That is a large amount for a new token.`)) return;
  }
  busy = true;
  // Without an API key the feed and the trade share one small Jupiter quota: give the trade all of it.
  if (!state.local?.keyed) jupCooldown = Date.now() + 20000;
  document.body.classList.add('trading');
  try {
    let amount;
    let inputMint = SOL_MINT;
    let outputMint = mint;
    if (side === 'buy') amount = solToLamports(sol);
    else {
      tradeStatus('work', `Checking your ${sym} balance...`);
      state.hold = await trader.holdings(currentWallet().address);
      state.holdAt = Date.now();
      const h = state.hold.tokens.get(mint);
      if (!h) throw new Error(`You hold no ${sym} to sell.`);
      amount = pctOf(h.raw, pct);
      inputMint = mint;
      outputMint = SOL_MINT;
    }
    const label = side === 'buy' ? `Buying ${sym} with ${sol} SOL` : `Selling ${pct}% of your ${sym}`;
    const { order, signature } = await trader.swap({
      inputMint,
      outputMint,
      amount,
      slippageBps: settings.slippage === 'auto' ? undefined : Number(settings.slippage) * 100,
      priorityFeeLamports: settings.priorityFee === 'auto' ? undefined : Number(settings.priorityFee) * 1e9,
      onStage: (s) => tradeStatus('work', s === 'quote' ? `${label}: getting the best route...` : s === 'sign' ? `${label}: approve it in your wallet.` : `${label}: sending...`),
      confirmQuote: (o) => {
        const impact = Math.abs(Number(o.priceImpact) || 0);
        return impact <= settings.maxImpact || confirm(`This trade moves the price by ${impact.toFixed(1)}% (your limit is ${settings.maxImpact}%). You would receive about ${fmtUsd(o.outUsdValue)} for ${fmtUsd(o.inUsdValue)}. Continue?`);
      },
    });
    tradeStatus('ok', side === 'buy' ? `Bought ${sym} with ${sol} SOL (about ${fmtUsd(order.inUsdValue)}).` : `Sold ${pct}% of ${sym} for about ${fmtUsd(order.outUsdValue)}.`, `https://solscan.io/tx/${signature}`);
    setTimeout(refreshHoldings, 2500);
  } catch (e) {
    tradeStatus(e.stage === 'cancelled' ? 'info' : 'err', e.message || 'The trade failed.');
  } finally {
    busy = false;
    document.body.classList.remove('trading');
  }
}

// ---------- my tokens ----------
async function lookupMeta(mints) {
  const need = mints.filter((m) => !findToken(m)).slice(0, 100);
  if (!need.length) return;
  const keep = (list) => { for (const j of Array.isArray(list) ? list : []) if (isMint(j?.id)) state.meta.set(j.id, { mint: j.id, symbol: String(j.symbol || '?').slice(0, 16), name: String(j.name || '').slice(0, 48), icon: j.icon, price: Number(j.usdPrice) || null }); };
  try {
    // Names and prices come from the unmetered feed first, so the trading quota is left alone.
    for (let i = 0; i < need.length; i += 50) {
      const r = await fetch(`${DAT}/v1/assets/search?query=${need.slice(i, i + 50).join(',')}`);
      if (r.ok) keep(await r.json());
    }
    const missing = need.filter((m) => !state.meta.has(m));
    if (missing.length && state.local?.keyed) {
      const r = await fetch(`${API}/tokens/v2/search?query=${missing.join(',')}`, { cache: 'no-store' });
      if (r.ok) keep(await r.json());
    }
  } catch { /* names are a nicety */ }
}
async function renderHoldings() {
  const el = $('holdings');
  const w = currentWallet();
  if (!w) { el.innerHTML = '<div class="empty">Connect a wallet to see and sell the tokens you hold.</div>'; return; }
  if (!state.hold) { el.innerHTML = '<div class="empty">Loading your balances...</div>'; return; }
  const mints = [...state.hold.tokens.keys()].filter((m) => m !== SOL_MINT);
  if (mints.some((m) => !findToken(m))) { await lookupMeta(mints); }
  const rows = mints.map((m) => {
    const h = state.hold.tokens.get(m);
    const t = findToken(m) || { mint: m, symbol: shortAddr(m), name: '' };
    return { m, h, t, value: t.price ? h.ui * t.price : null };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)).slice(0, 80);
  el.innerHTML = `<p class="sub">Wallet ${esc(shortAddr(w.address))} · ${state.hold.sol.toFixed(4)} SOL · ${mints.length} tokens</p>` + (rows.length
    ? `<div class="tablewrap"><table class="mini hold"><thead><tr><th>Token</th><th>Balance</th><th>Value</th><th class="l">Sell</th></tr></thead><tbody>${rows.map(({ m, h, t, value }) => `
      <tr data-mint="${esc(m)}"><td><div class="tok">${icon(t)}<div><div class="nm">${esc(t.name || t.symbol)}</div><div class="sub"><b>$${esc(t.symbol)}</b></div></div></div></td>
      <td>${fmtAmt(h.ui)}</td><td>${value == null ? '-' : fmtUsd(value)}</td>
      <td class="l">${settings.sellPresets.map((p) => `<button class="btn sell sm" data-sellpct="${p}" data-mint="${esc(m)}">${p}%</button>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">No tokens in this wallet.</div>');
}

// ---------- settings ----------
function openSettings() {
  const st = live.stats();
  const slipOpts = ['auto', 0.5, 1, 3, 5, 10, 20];
  const custom = !slipOpts.includes(settings.slippage);
  $('modalBody').innerHTML = `
    <h2>Trading settings</h2>
    <div class="set"><h4>Slippage</h4>
      <div class="opts">${slipOpts.map((v) => `<button class="btn sm${settings.slippage === v ? ' on' : ''}" data-slip="${v}">${v === 'auto' ? 'Auto' : v + '%'}</button>`).join('')}
        <span class="fbox"><input type="number" min="0.1" max="50" step="0.1" id="slipCustom" placeholder="custom" value="${custom ? esc(settings.slippage) : ''}"><em>%</em></span></div>
      <p class="muted">Auto lets Jupiter pick a value per trade. A higher fixed value makes new, fast-moving tokens less likely to fail, at the cost of a worse worst-case price.</p></div>
    <div class="set"><h4>Priority fee</h4>
      <div class="opts"><button class="btn sm${settings.priorityFee === 'auto' ? ' on' : ''}" data-fee="auto">Auto</button>
        <span class="fbox"><input type="number" min="0" max="0.05" step="0.0001" id="feeCustom" placeholder="custom" value="${settings.priorityFee === 'auto' ? '' : esc(settings.priorityFee)}"><em>SOL</em></span></div>
      <p class="muted">Extra paid to validators to land faster. Capped at 0.05 SOL here to guard against typos.</p></div>
    <div class="set"><h4>Buy buttons (SOL)</h4>
      <div class="opts">${settings.buyPresets.map((p, i) => `<span class="fbox"><input type="number" min="0.001" max="100" step="0.01" data-preset="${i}" value="${p}"><em>SOL</em></span>`).join('')}</div>
      <label class="fsw" style="margin-top:8px">Row "Buy" button uses <span class="fbox"><input type="number" min="0.001" max="100" step="0.01" id="quickBuy" value="${settings.quickBuy}"><em>SOL</em></span></label></div>
    <div class="set"><h4>Safety checks</h4>
      <label class="fsw">Ask before a trade that moves the price more than <span class="fbox"><input type="number" min="1" max="100" step="1" id="maxImpact" value="${settings.maxImpact}"><em>%</em></span></label>
      <label class="fsw"><input type="checkbox" id="warnFlagged"${settings.warnFlagged ? ' checked' : ''}> Ask before buying a token flagged as high risk or likely rug</label></div>
    <div class="set"><h4>Storage on this device</h4>
      <p class="muted" id="storeInfo">Live history: ${st.total} tokens in memory, ${st.keepers} remembered across reloads using ${(st.savedBytes / 1024).toFixed(0)} KB (cap ${(CAPS.persistBytes / 1024).toFixed(0)} KB, ${CAPS.persist} tokens, ${CAPS.keepMs / 3600e3} hours). Filters and settings use under 2 KB.</p>
      <button class="btn sm" data-clear-live>Clear live history</button></div>
    <div class="set"><h4>Connection</h4><p class="muted">${state.local ? (state.local.keyed ? 'Running locally with your Jupiter API key (kept on this PC, added by the local server, never sent to the browser).' : 'Running locally without an API key. Add JUPITER_API_KEY to the .env file in the SolSift folder for higher limits.') : 'Public site: uses Jupiter without an API key, which is rate limited. The local launcher uses your key privately.'}</p></div>
    <div class="ffoot"><button class="btn buy" data-modal-close>Done</button></div>`;
  $('modal').classList.add('on');
}
function onSettingsInput(e) {
  const el = e.target;
  const n = Number(el.value);
  if (el.id === 'slipCustom') { if (n >= 0.1 && n <= 50) settings.slippage = n; }
  else if (el.id === 'feeCustom') settings.priorityFee = n > 0 ? Math.min(0.05, n) : 'auto';
  else if (el.dataset.preset != null) { if (n > 0 && n <= 100) settings.buyPresets[+el.dataset.preset] = n; }
  else if (el.id === 'quickBuy') { if (n > 0 && n <= 100) settings.quickBuy = n; }
  else if (el.id === 'maxImpact') { if (n >= 1 && n <= 100) settings.maxImpact = n; }
  else if (el.id === 'warnFlagged') settings.warnFlagged = el.checked;
  else return;
  saveSettings();
  renderRows();
}

// ---------- your paper bot ----------
const botField = (label, path, unit, hint = '') => {
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), bot.rules);
  return `<label class="flim"><span>${esc(label)}${hint ? ` <i>${esc(hint)}</i>` : ''}</span><span class="fbox"><input type="number" min="0" step="any" inputmode="decimal" data-bot="${path}" value="${Number.isFinite(v) ? v : ''}" placeholder="off"><em>${esc(unit)}</em></span></label>`;
};
function renderBotForms() {
  const r = bot.rules;
  const groups = [...new Set(LIMITS.map((l) => l.group))];
  $('botEntryForm').innerHTML = `
    <div class="fgrid" style="margin-top:12px">
      <div class="fcol"><h4>Basics</h4>
        <label class="flim"><span>Tokens it looks at</span><select data-bot="feed"><option value="both"${r.feed === 'both' ? ' selected' : ''}>Scored feed + live launches</option><option value="scored"${r.feed === 'scored' ? ' selected' : ''}>Scored feed only</option><option value="live"${r.feed === 'live' ? ' selected' : ''}>Live launches only</option></select></label>
        ${botField('Score at least', 'entry.minScore', '/100')}
        <label class="fsw"><input type="checkbox" data-bot="entry.allowFlagged"${r.entry.allowFlagged ? ' checked' : ''}> Allow tokens with hard red flags</label>
        <label class="fsw"><input type="checkbox" data-bot="entry.strict"${r.entry.strict ? ' checked' : ''}> Skip tokens where a checked value is unknown</label>
      </div>
      ${groups.map((g) => `<div class="fcol"><h4>${esc(g)}</h4>${LIMITS.filter((l) => l.group === g).map((l) => `<label class="flim"><span>${esc(l.label)}${l.scoredOnly ? ' <i title="Only measured in the full scan">scan only</i>' : ''}</span><span class="fbox"><input type="number" min="0" step="any" inputmode="decimal" data-blimit="${l.id}" value="${Number.isFinite(r.entry.limits[l.id]) ? r.entry.limits[l.id] : ''}" placeholder="off"><em>${esc(l.unit)}</em></span></label>`).join('')}</div>`).join('')}
      <div class="fcol"><h4>Must be true</h4>${SWITCHES.map((s) => `<label class="fsw"><input type="checkbox" data-bswitch="${s.id}"${r.entry.switches[s.id] ? ' checked' : ''}> ${esc(s.label)}</label>`).join('')}</div>
    </div>`;
  $('botExitForm').innerHTML = `
    <div class="fgrid" style="margin-top:12px">
      <div class="fcol"><h4>Exits</h4>
        ${botField('Take profit at', 'exit.takeProfit', '% up')}
        ${botField('Stop loss at', 'exit.stopLoss', '% down')}
        ${botField('Trailing stop', 'exit.trailing', '% off high')}
        ${botField('Sell after', 'exit.maxHoldMin', 'min')}
        ${botField('Sell if score falls below', 'exit.scoreBelow', '/100')}
        ${botField('Sell if liquidity drops by', 'exit.liqDrop', '%')}
        <label class="fsw"><input type="checkbox" data-bot="exit.onRugFlag"${r.exit.onRugFlag ? ' checked' : ''}> Sell when a hard red flag appears</label>
      </div>
      <div class="fcol"><h4>Position size</h4>
        ${botField('Paper money per buy', 'size.stakeUsd', '$')}
        ${botField('Most positions at once', 'size.maxOpen', '')}
        ${botField('Cost charged per side', 'size.costPct', '%')}
        ${botField('Starting balance', 'size.startUsd', '$', 'used on reset')}
      </div>
    </div>`;
}
function renderBotSummary() {
  const d = describeRules(bot.rules);
  $('botBuys').innerHTML = d.buys.map((s) => `<li class="pro">${esc(s)}</li>`).join('');
  $('botSells').innerHTML = d.sells.map((s) => `<li class="flag">${esc(s)}</li>`).join('') + `<li class="muted" style="padding-left:0;margin-top:6px">${esc(d.sizing)}</li>`;
}
function onBotInput(e) {
  const el = e.target;
  const r = bot.rules;
  const numOrOff = () => { const v = el.value.trim() === '' ? NaN : Number(el.value); return Number.isFinite(v) && v >= 0 ? v : null; };
  if (el.dataset.blimit) { const v = numOrOff(); if (v == null) delete r.entry.limits[el.dataset.blimit]; else r.entry.limits[el.dataset.blimit] = v; }
  else if (el.dataset.bswitch) { if (el.checked) r.entry.switches[el.dataset.bswitch] = true; else delete r.entry.switches[el.dataset.bswitch]; }
  else if (el.dataset.bot === 'feed') r.feed = el.value;
  else if (el.dataset.bot) {
    const [sec, key] = el.dataset.bot.split('.');
    if (el.type === 'checkbox') r[sec][key] = el.checked;
    else {
      const v = numOrOff();
      // These cannot be switched off, only changed.
      const required = { 'entry.minScore': 0, 'size.stakeUsd': 1, 'size.maxOpen': 1, 'size.costPct': 0, 'size.startUsd': 10 };
      if (el.dataset.bot in required) { if (v != null && v >= required[el.dataset.bot]) r[sec][key] = key === 'maxOpen' ? Math.min(50, Math.round(v)) : v; }
      else r[sec][key] = v;
    }
  } else return;
  saveBot(bot);
  renderBotSummary();
}
function renderBotState() {
  const pf = bot.pf;
  const st = botStats(pf);
  $('botToggle').textContent = bot.rules.enabled ? 'Pause buying' : 'Resume buying';
  $('botToggle').classList.toggle('active', !bot.rules.enabled);
  const tile = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $('botStats').innerHTML = `<div class="kv botkv">${tile('Equity', fmtUsd(st.equity))}${tile('Return', fmtPct(st.returnPct))}${tile('Paper cash', fmtUsd(pf.cash))}${tile('Open', pf.open.length)}${tile('Closed', st.closed)}${tile('Win rate', st.closed ? Math.round((100 * st.wins) / st.closed) + '%' : '-')}${tile('Avg trade', st.closed ? fmtPct(st.avgPct) : '-')}${tile('Best / worst', st.closed ? `${fmtPct(st.best)} / ${fmtPct(st.worst)}` : '-')}</div>
    <p class="sub" style="margin-top:10px">${bot.rules.enabled ? 'Running' : 'Paused (existing positions are still managed)'} since ${ago(pf.startedAt)} ago. Last check ${pf.lastStep ? ago(pf.lastStep) + ' ago' : 'pending'}.${Object.keys(st.byReason).length ? ' Exits so far: ' + Object.entries(st.byReason).map(([k, v]) => `${esc(k)} x${v.n} (${v.pnl >= 0 ? '+' : '-'}$${Math.abs(v.pnl).toFixed(0)})`).join(', ') + '.' : ''}</p>`;
  const svg = $('botEquity');
  const curve = pf.curve || [];
  if (curve.length > 1) {
    const vs = curve.map((c) => c[1]);
    const lo = Math.min(...vs, pf.start);
    const hi = Math.max(...vs, pf.start);
    const y = (v) => 112 - ((v - lo) / Math.max(1e-9, hi - lo)) * 104;
    const pts = curve.map((c, i) => `${((i / (curve.length - 1)) * 600).toFixed(1)},${y(c[1]).toFixed(1)}`).join(' ');
    svg.innerHTML = `<line x1="0" x2="600" y1="${y(pf.start)}" y2="${y(pf.start)}" stroke="#2c3750" stroke-dasharray="4 4"/><polyline fill="none" stroke="${vs.at(-1) >= pf.start ? '#19d3a2' : '#ff5d6c'}" stroke-width="2" points="${pts}"/>`;
  } else svg.innerHTML = '';
  const why = (w) => `<div class="muted botwhy">${esc((w || []).join(' · '))}</div>`;
  $('botOpen').innerHTML = pf.open.length
    ? `<table class="mini"><thead><tr><th>Token</th><th>P&amp;L</th><th>Held</th><th class="l">Act</th></tr></thead><tbody>${pf.open.map((p) => `
      <tr data-mint="${esc(p.mint)}"><td class="l"><b>$${esc(p.symbol)}</b>${p.live ? ' <span class="chip live">LIVE</span>' : ''}${why(p.why)}</td>
      <td>${fmtPct(p.pct)}</td><td>${ago(p.t0)}</td>
      <td class="l"><button class="btn sm" data-bot-close="${esc(p.mint)}" title="Close this paper position now">Close</button> <button class="btn buy sm" data-buysol="${settings.quickBuy}" data-mint="${esc(p.mint)}" title="Buy for real with ${settings.quickBuy} SOL (your wallet asks you to approve)">Buy ${settings.quickBuy}</button></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No open positions. ${bot.rules.enabled ? 'The bot buys when a token meets every buy rule.' : 'Buying is paused.'}</div>`;
  const closed = pf.closed.slice(-25).reverse();
  $('botClosed').innerHTML = closed.length
    ? `<table class="mini"><thead><tr><th>Token</th><th>P&amp;L</th><th>Held</th><th class="l">Sold because</th></tr></thead><tbody>${closed.map((c) => `
      <tr data-mint="${esc(c.mint)}"><td class="l"><b>$${esc(c.symbol)}</b> <span class="muted">score ${c.score}</span></td><td>${fmtPct(c.pct)}</td><td>${Math.max(1, Math.round((c.t1 - c.t0) / 60000))}m</td><td class="l">${esc(c.reason)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No closed trades yet.</div>';
  const sr = state.paper?.rules;
  $('botRef').innerHTML = `<ul class="reasons">
    <li class="flag"><b>The scanner's bot</b> is a separate, fixed-rule paper bot that runs inside every scan (results are on the Bot performance tab). ${sr ? `It buys $${sr.STAKE_USD} of a token scoring ${sr.ENTRY_SCORE}+ with no hard red flags, at least ${fmtUsd(sr.MIN_LIQ)} liquidity and at least ${sr.MIN_AGE_MIN} minutes old, holding up to ${sr.MAX_OPEN}. It sells at +${Math.round(sr.TAKE_PROFIT * 100)}%, at ${Math.round(sr.STOP_LOSS * 100)}%, when a red flag appears, when liquidity drains, or after ${Math.round(sr.MAX_HOLD_MS / 3600e3)} hours.` : ''} Its rules are set in <code>scanner/paper.js</code>.</li>
    <li class="flag"><b>Real money:</b> no bot here trades real funds. That would need a private key stored in the app, which this project does not do. To act on a paper buy yourself, use the Buy button beside the position: your wallet shows the transaction and you approve it.</li>
    <li class="flag"><b>Limits of the simulation:</b> prices are sampled about every 10 seconds, fills are assumed at the sampled price plus the cost you set, and there is no price impact. Real results on thin pools will be worse.</li></ul>`;
}
function closePaper(mint) {
  const i = bot.pf.open.findIndex((p) => p.mint === mint);
  if (i < 0) return;
  const p = bot.pf.open[i];
  const cost = bot.rules.size.costPct / 100;
  const proceeds = p.units * (p.last || 0) * (1 - cost);
  bot.pf.cash += proceeds;
  bot.pf.open.splice(i, 1);
  bot.pf.closed.push({ mint: p.mint, symbol: p.symbol, t0: p.t0, t1: Date.now(), score: p.score, pct: +((proceeds / p.stake - 1) * 100).toFixed(1), pnl: +(proceeds - p.stake).toFixed(2), reason: 'closed by you', why: p.why });
  saveBot(bot);
  renderBotState();
}
async function runBot() {
  const now = Date.now();
  const scored = new Map((state.data?.tokens || []).map((t) => [t.mint, t]));
  const cands = [];
  if (bot.rules.feed !== 'live') for (const t of scored.values()) cands.push({ t, live: false });
  if (bot.rules.feed !== 'scored') for (const t of live.list()) cands.push({ t, live: true });
  const quoteOf = (mint) => {
    const lt = live.get(mint);
    const ref = scored.get(mint) || lt; // the fully checked version decides flags and score when there is one
    let best = botQuotes.get(mint) || null;
    if (lt && lt.price > 0 && (!best || (lt.upd || 0) > best.at)) best = { price: lt.price, liq: lt.liq, at: lt.upd || 0 };
    return best ? { ...best, gated: ref ? gated(ref) : false, score: ref?.score?.total ?? null } : null;
  };
  let out = stepBot(bot.pf, bot.rules, cands, quoteOf, now);
  // Fresh prices for what the bot holds and what it is about to buy (unmetered feed, at most one call).
  const want = [...new Set([...bot.pf.open.map((p) => p.mint), ...out.needQuote])].filter((m) => now - (botQuotes.get(m)?.at || 0) > 8000).slice(0, 50);
  let events = out.events;
  if (want.length) {
    try {
      const r = await fetch(`${DAT}/v1/assets/search?query=${want.join(',')}`);
      if (r.ok) for (const j of await r.json()) if (isMint(j?.id) && Number(j.usdPrice) > 0) botQuotes.set(j.id, { price: Number(j.usdPrice), liq: Number(j.liquidity) || null, at: Date.now() });
    } catch { /* next round */ }
    if (out.needQuote.length) { out = stepBot(bot.pf, bot.rules, cands, quoteOf, Date.now()); events = events.concat(out.events); }
  }
  for (const [m, q] of botQuotes) if (now - q.at > 30 * 60e3) botQuotes.delete(m);
  if (events.length || now - (runBot.saved || 0) > 30000) { saveBot(bot); runBot.saved = now; }
  for (const ev of events) toast(ev.type === 'buy' ? `Paper bot bought $${ev.symbol} (score ${ev.score})` : `Paper bot sold $${ev.symbol}: ${ev.reason} (${ev.pct >= 0 ? '+' : ''}${ev.pct}%)`);
  if (document.querySelector('.tab.on')?.dataset.view === 'bot' && !document.hidden) renderBotState();
}

// ---------- trends ----------
function renderTrends() {
  const all = state.trends?.narratives || [];
  const row = (n) => `<div class="nar" data-tag="${esc(n.tag)}"><div class="tag">${esc(n.tag)}${n.copycat ? ' <span class="chip bad">copycats</span>' : ''}</div>
    <div class="heat"><i style="width:${Math.round(n.heat * 100)}%"></i></div>
    <div class="meta">${n.count} tokens · ${fmtUsd(n.volH1)}/h${n.growth != null ? ` · ${n.growth >= 0 ? '+' : ''}${Math.round(n.growth * 100)}%` : ''}</div></div>`;
  const nar = all.filter((n) => n.kind === 'narrative');
  const kw = all.filter((n) => n.kind === 'keyword');
  $('narratives').innerHTML = nar.map(row).join('') || '<div class="empty">No narratives detected yet.</div>';
  $('keywords').innerHTML = kw.slice(0, 18).map(row).join('') || '<div class="empty">No recurring keywords in this scan.</div>';
}

// ---------- performance ----------
function renderPerf() {
  const m = state.model || {};
  const cal = m.calibration || [];
  const have = cal.some((c) => c.n > 0);
  $('calib').innerHTML = have
    ? `<table class="mini"><thead><tr><th>Score</th><th>Tokens</th><th>Held up after 24h</th><th>Avg 24h return</th></tr></thead><tbody>${cal.map((c) => `<tr><td class="l">${esc(c.range)}</td><td>${c.n}</td><td>${c.goodRate == null ? '-' : Math.round(c.goodRate * 100) + '%'}</td><td>${c.avgReturn == null ? '-' : fmtPct(c.avgReturn * 100)}</td></tr>`).join('')}</tbody></table>
       <p class="sub" style="margin-top:10px">Overall, ${m.baseRate == null ? '-' : Math.round(m.baseRate * 100) + '%'} of ${m.nSamples} tracked tokens held up. If higher score rows do not show higher rates, the scores are not adding value.</p>`
    : `<div class="empty">No 24-hour outcomes yet. The first results appear a day after the first scan${m.pending ? ` (${m.pending} tokens being tracked)` : ''}.</div>`;
  $('modelSub').textContent = m.ready
    ? `Trained on ${m.nSamples} outcomes. Out-of-sample AUC ${m.testAuc == null ? 'n/a' : m.testAuc.toFixed(2)} (0.50 is a coin flip). It currently drives ${Math.round((m.blend || 0) * 100)}% of each score.`
    : `Needs at least ${m.minSamples || 150} labelled outcomes with enough winners and losers before it is trusted. Have ${m.nSamples || 0}. Scores are rule-based until then.`;
  const imp = (m.importance || []).slice(0, 12);
  const max = Math.max(0.001, ...imp.map((i) => Math.abs(i.weight)));
  $('importance').innerHTML = imp.length
    ? `<div class="bars">${imp.map((i) => `<div class="bar" style="grid-template-columns:150px 1fr 48px"><span>${esc(i.name.replace(/_/g, ' '))}</span><div class="track"><div class="fill" style="width:${(100 * Math.abs(i.weight)) / max}%;background:${i.weight >= 0 ? 'var(--good)' : 'var(--bad)'}"></div></div><b>${i.weight > 0 ? '+' : ''}${i.weight.toFixed(2)}</b></div>`).join('')}</div><p class="sub" style="margin-top:10px">Green pushes toward "held up", red toward "failed".</p>`
    : '<div class="empty">Nothing learned yet.</div>';

  const p = state.paper;
  if (!p) { $('paperStats').innerHTML = '<div class="empty">Paper bot has not run yet.</div>'; return; }
  const st = p.stats || {};
  $('paperStats').innerHTML = `<div class="kv">
    <div><div class="k">Equity</div><div class="v">${fmtUsd(p.equity)}</div></div>
    <div><div class="k">Return</div><div class="v">${fmtPct(((p.equity - p.start) / p.start) * 100)}</div></div>
    <div><div class="k">Closed trades</div><div class="v">${st.closed ?? 0}</div></div>
    <div><div class="k">Win rate</div><div class="v">${st.closed ? Math.round((100 * st.wins) / st.closed) + '%' : '-'}</div></div>
    <div><div class="k">Avg trade</div><div class="v">${st.closed ? fmtPct(st.avgPct) : '-'}</div></div>
    <div><div class="k">Open</div><div class="v">${(p.open || []).length}</div></div></div>`;
  const curve = p.curve || [];
  const svg = $('equity');
  if (curve.length > 1) {
    const vs = curve.map((c) => c[1]);
    const lo = Math.min(...vs, p.start);
    const hi = Math.max(...vs, p.start);
    const y = (v) => 112 - ((v - lo) / Math.max(1e-9, hi - lo)) * 104;
    const pts = curve.map((c, i) => `${((i / (curve.length - 1)) * 600).toFixed(1)},${y(c[1]).toFixed(1)}`).join(' ');
    const up = vs[vs.length - 1] >= p.start;
    svg.innerHTML = `<line x1="0" x2="600" y1="${y(p.start)}" y2="${y(p.start)}" stroke="#2c3750" stroke-dasharray="4 4"/><polyline fill="none" stroke="${up ? '#19d3a2' : '#ff5d6c'}" stroke-width="2" points="${pts}"/>`;
  } else svg.innerHTML = '';
  const posRow = (x, open) => `<tr data-mint="${esc(x.mint)}"><td class="l">$${esc(x.symbol)}</td><td>${x.score}</td><td>${fmtPct(x.pct)}</td><td class="l">${open ? 'open ' + ago(x.t0) : esc(x.reason || '')}</td></tr>`;
  const rows = [...(p.open || []).map((x) => posRow(x, true)), ...(p.closed || []).slice(-12).reverse().map((x) => posRow(x, false))].join('');
  $('paperPos').innerHTML = rows ? `<table class="mini"><thead><tr><th>Token</th><th>Score at entry</th><th>P&amp;L</th><th class="l">Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No positions yet. The bot only enters tokens scoring 70+ with real liquidity, which is rare.</div>';
}

// ---------- scanned data ----------
async function getJson(name) {
  try {
    const r = await fetch(`data/${name}.json?t=${Math.floor(Date.now() / 20000)}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function load() {
  const [d, tr, m, p] = await Promise.all([getJson('tokens'), getJson('trends'), getJson('model'), getJson('paper')]);
  if (!d) {
    if (!state.data) $('scanStatus').textContent = state.local ? 'First local scan is running (about two minutes)...' : 'No scan data yet. The first scheduled scan publishes it.';
    return;
  }
  const changed = !state.data || state.data.generatedAt !== d.generatedAt;
  Object.assign(state, { data: d, trends: tr, model: m, paper: p });
  renderTiles();
  if (changed) { if (state.mode === 'scored') renderRows(); renderTrends(); renderPerf(); }
  if (d.repo && /^[\w.-]+\/[\w.-]+$/.test(d.repo)) $('repoLink').innerHTML = `<a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener">Source on GitHub</a>`;
}

// ---------- live feed (every 5 seconds) ----------
const DAT = 'https://datapi.jup.ag';
let jupCooldown = 0; // rest Jupiter's rate-limited API until this time after a 429
const seeded = { gems: false, recent: false };
async function pollGems() {
  // New, about-to-graduate and just-graduated launchpad pools, with snipers, insiders and curve progress.
  const r = await fetch(`${DAT}/v1/pools/gems`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recent: {}, graduated: {}, aboutToGraduate: {} }) });
  if (!r.ok) return false;
  const j = await r.json();
  const quiet = !seeded.gems; seeded.gems = true; // the first batch is the backlog, not new launches
  for (const b of ['recent', 'aboutToGraduate', 'graduated']) for (const p of j?.[b]?.pools || []) if (isMint(p?.baseAsset?.id)) live.upsert(p.baseAsset.id, 'dat', p.baseAsset, quiet);
  return true;
}
async function pollRecent() {
  const r = await fetch(`${API}/tokens/v2/recent`, { cache: 'no-store' });
  if (r.status === 429) { jupCooldown = Date.now() + 30000; return false; }
  if (!r.ok) return false;
  const quiet = !seeded.recent; seeded.recent = true;
  for (const j of await r.json()) if (isMint(j?.id)) live.upsert(j.id, 'jup', j, quiet);
  return true;
}
async function refreshKeepers() {
  // Keep numbers moving for remembered tokens that have scrolled out of the feeds.
  const mints = live.refreshTargets(50);
  if (!mints.length) return;
  try {
    const r = await fetch(`${DAT}/v1/assets/search?query=${mints.join(',')}`);
    if (r.ok) { for (const j of await r.json()) if (isMint(j?.id)) live.upsert(j.id, 'dat', j, true); return; }
  } catch { /* fall through to the documented API */ }
  // Only with an API key: the free quota is reserved for trading.
  if (!state.local?.keyed || Date.now() < jupCooldown) return;
  const r = await fetch(`${API}/tokens/v2/search?query=${mints.join(',')}`, { cache: 'no-store' });
  if (r.status === 429) jupCooldown = Date.now() + 30000;
  if (r.ok) for (const j of await r.json()) if (isMint(j?.id)) live.upsert(j.id, 'jup', j, true);
}
function renderLiveStatus() {
  const s = state.liveStat;
  const el = $('liveInfo');
  el.classList.toggle('err', !!s.err);
  const st = live.stats();
  el.textContent = s.err ? s.err : s.last ? `updated ${Math.max(0, Math.round((Date.now() - s.last) / 1000))}s ago · ${st.added} new this session · ${st.keepers} remembered` : 'connecting...';
}
let liveTimer = null;
async function pollLive() {
  clearTimeout(liveTimer);
  if (document.hidden && bot.pf.open.length) await runBot().catch(() => {}); // keep managing exits in a background tab
  if (!document.hidden) {
    const s = state.liveStat;
    s.polls++;
    const keyed = !!state.local?.keyed;
    // The launchpad feed drives the live list. Jupiter's documented API has a small free quota
    // (about 30 requests a minute per connection) that buying, selling and balance checks need, so
    // without an API key the feed leaves it alone, and only falls back to it (at most every 30s)
    // if the launchpad feed itself is down.
    let ok = await pollGems().catch(() => false);
    if (Date.now() >= jupCooldown && (keyed || !ok)) {
      if (!keyed) jupCooldown = Date.now() + 30000;
      ok = (await pollRecent().catch(() => false)) || ok;
    }
    if (s.polls % 2 === 0) await refreshKeepers().catch(() => {});
    if (ok) { s.last = Date.now(); s.err = null; }
    else s.err = 'Live feed unreachable, retrying';
    live.prune();
    if (s.polls % 2 === 1) await runBot().catch(() => {});
    if (s.polls % 6 === 0) live.save();
    renderLiveStatus();
    if (state.mode === 'live' && !busy) renderRows();
  }
  liveTimer = setTimeout(pollLive, 5000);
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  // Brand-new launches are all thin and unproven, so the live view shows everything, newest first.
  state.sort = mode === 'live' ? 'new' : 'score';
  $('sort').value = state.sort;
  $('hide').checked = mode !== 'live';
  platSig = '';
  renderRows();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target;
  const bs = el.closest('[data-buysol]');
  if (bs) { e.stopPropagation(); return doTrade({ side: 'buy', mint: bs.dataset.mint, sol: Number(bs.dataset.buysol) }); }
  const bc = el.closest('[data-buycustom]');
  if (bc) return doTrade({ side: 'buy', mint: bc.dataset.buycustom, sol: Number($('buyCustom')?.value) });
  const sp = el.closest('[data-sellpct]');
  if (sp) { e.stopPropagation(); return doTrade({ side: 'sell', mint: sp.dataset.mint, pct: Number(sp.dataset.sellpct) }); }
  if (el.closest('[data-status-close]')) return $('tradeStatus').classList.remove('on');

  if (el.closest('#walletBtn')) return toggleWalletMenu();
  const wb = el.closest('[data-wallet]');
  if (wb) {
    toggleWalletMenu(false);
    return connectWallet(wb.dataset.wallet).then(() => { tradeStatus('info', `${wb.dataset.wallet} connected.`); refreshHoldings(); }).catch((err) => tradeStatus('err', /reject|denied|cancel/i.test(String(err?.message)) ? 'Connection was rejected in the wallet.' : `Could not connect: ${String(err?.message || err).slice(0, 100)}`));
  }
  if (el.closest('[data-wallet-disconnect]')) { toggleWalletMenu(false); return disconnectWallet(); }
  if (el.closest('[data-wallet-refresh]')) { toggleWalletMenu(false); return refreshHoldings(); }
  if (!el.closest('#walletMenu')) toggleWalletMenu(false);

  if (el.closest('[data-settings]') || el.closest('#settingsBtn')) { e.preventDefault(); return openSettings(); }
  if (el.closest('[data-modal-close]') || el.id === 'modal') { $('modal').classList.remove('on'); if (state.open) openDrawer(state.open); return; }
  const slip = el.closest('[data-slip]');
  if (slip) { settings.slippage = slip.dataset.slip === 'auto' ? 'auto' : Number(slip.dataset.slip); saveSettings(); return openSettings(); }
  if (el.closest('[data-fee]')) { settings.priorityFee = 'auto'; saveSettings(); return openSettings(); }
  if (el.closest('[data-clear-live]')) { live.clear(); renderLiveStatus(); if (state.mode === 'live') renderRows(); return openSettings(); }

  if (el.closest('#botToggle')) { bot.rules.enabled = !bot.rules.enabled; saveBot(bot); return renderBotState(); }
  if (el.closest('[data-bot-reset-pf]')) { if (confirm('Reset the paper portfolio? Open and closed paper trades are cleared. Your rules stay.')) { bot.pf = newPortfolio(bot.rules); saveBot(bot); renderBotState(); } return; }
  if (el.closest('[data-bot-reset-rules]')) { bot.rules = resetRules(); saveBot(bot); renderBotForms(); renderBotSummary(); return renderBotState(); }
  const bcl = el.closest('[data-bot-close]');
  if (bcl) { e.stopPropagation(); return closePaper(bcl.dataset.botClose); }
  if (el.closest('#filterBtn')) { const p = $('filterPanel'); p.hidden = !p.hidden; return; }
  if (el.closest('[data-filter-reset]')) { filters = resetFilters(); renderFilterPanel(); live.prune(); return renderRows(); }

  if (el.closest('[data-close]') || el.id === 'overlay') return closeDrawer();
  const c = el.closest('[data-copy]');
  if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Address copied')); return; }
  const seg = el.closest('.seg button');
  if (seg) return setMode(seg.dataset.mode);
  const tab = el.closest('.tab');
  if (tab) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + tab.dataset.view));
    if (tab.dataset.view === 'wallet') { renderHoldings(); if (currentWallet()) refreshHoldings(); }
    if (tab.dataset.view === 'bot') { renderBotForms(); renderBotSummary(); renderBotState(); }
    return;
  }
  const th = el.closest('th[data-sort]');
  if (th) { state.sort = th.dataset.sort; if ([...$('sort').options].some((o) => o.value === state.sort)) $('sort').value = state.sort; return renderRows(); }
  const nar = el.closest('.nar');
  if (nar) { $('q').value = nar.dataset.tag; document.querySelector('.tab[data-view=tokens]').click(); return renderRows(); }
  const tr = el.closest('tr[data-mint]');
  if (tr && !el.closest('a') && !el.closest('button')) openDrawer(tr.dataset.mint);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('modal').classList.contains('on')) $('modal').classList.remove('on'); else closeDrawer(); toggleWalletMenu(false); }
  if (e.key === 'Enter' && e.target.id === 'buyCustom' && state.open) doTrade({ side: 'buy', mint: state.open, sol: Number(e.target.value) });
});
['q', 'age', 'hide', 'plat', 'stage'].forEach((id) => $(id).addEventListener('input', renderRows));
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderRows(); });
$('min').addEventListener('input', (e) => { $('minv').textContent = e.target.value; renderRows(); });
$('filterPanel').addEventListener('input', onFilterInput);
$('view-bot').addEventListener('input', onBotInput);
$('modal').addEventListener('input', onSettingsInput);
window.addEventListener('pagehide', () => live.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) live.save(); else pollLive(); });

// ---------- start ----------
async function detectLocal() {
  // The desktop launcher serves this same page and exposes a small local API. On the public site this 404s.
  try {
    const r = await fetch('local/info', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return;
    state.local = await r.json();
    if (state.local.keyed) { API = `${location.origin}/jup`; trader = createTrader(API); }
    $('localBadge').hidden = false;
    $('localBadge').textContent = state.local.keyed ? 'Local · API key active' : 'Local · NO API KEY (see Settings)';
    $('localBadge').classList.toggle('warn', !state.local.keyed);
    $('localBadge').classList.toggle('dim', !!state.local.keyed);
  } catch { /* public site */ }
}
(async () => {
  renderFilterPanel();
  renderWallet();
  await detectLocal();
  const restored = live.load();
  if (restored) renderLiveStatus();
  load();
  setInterval(load, 20000);
  pollLive();
  setInterval(renderLiveStatus, 1000);
  setInterval(() => { if (state.data) renderTiles(); }, 30000);
  restoreWallet().then((w) => { if (w) refreshHoldings(); });
})();
