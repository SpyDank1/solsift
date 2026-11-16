/* SolSift front end. Plain JS, no build step.
   Everything rendered here originates from token creators (names, tickers,
   links, images), so every string goes through esc() and every URL through
   safeUrl() before it touches the DOM. */
(() => {
  'use strict';
  const SOL = 'So11111111111111111111111111111111111111112';
  const $ = (id) => document.getElementById(id);
  const state = { data: null, trends: null, model: null, paper: null, sort: 'score', open: null };

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
  const ago = (ms) => {
    if (!ms) return '?';
    const m = Math.max(0, (Date.now() - ms) / 60000);
    if (m < 60) return Math.round(m) + 'm';
    if (m < 1440) return (m / 60).toFixed(m < 600 ? 1 : 0) + 'h';
    return (m / 1440).toFixed(1) + 'd';
  };
  const days = (d) => (d == null ? '?' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d >= 30 ? Math.round(d / 30) + 'mo' : Math.round(d) + 'd');
  const scoreColor = (s, gated) => (gated ? 'var(--bad)' : s >= 75 ? 'var(--good)' : s >= 60 ? 'var(--ok)' : s >= 45 ? 'var(--warn)' : 'var(--bad)');
  const verdictClass = (v) => ({ Strong: 'good', Promising: 'ok', Speculative: 'warn', Weak: 'dim', Avoid: 'bad', 'High risk': 'bad', 'Likely rug': 'bad' }[v] || 'dim');
  const gated = (t) => (t.score?.gates?.length || 0) > 0;
  const ring = (t, big) => `<div class="score${big ? ' big' : ''}" style="--p:${t.score.total};--c:${scoreColor(t.score.total, gated(t))}"><span>${t.score.total}</span></div>`;
  const icon = (t, cls = '') => {
    const u = safeUrl(t.icon);
    const ph = `<div class="ph ${cls}">${esc((t.symbol || '?').slice(0, 2).toUpperCase())}</div>`;
    return u ? `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=this.dataset.ph" data-ph="${esc(ph)}">` : ph;
  };
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
      else out.push(`<span class="chip dim">X ${x.kind === 'profile' ? '?' : esc(x.kind || 'link')}</span>`);
    }
    if (so.tg) out.push(`<span class="chip dim">TG${so.tg.members != null ? ' ' + fmtNum(so.tg.members) : ''}</span>`);
    if (so.web) out.push(`<span class="chip ${so.web.ageDays == null ? 'dim' : so.web.ageDays >= 365 ? 'good' : so.web.ageDays >= 30 ? 'warn' : 'bad'}">Web${so.web.ageDays != null ? ' ' + days(so.web.ageDays) : ''}</span>`);
    if (!out.length) out.push('<span class="chip bad">None</span>');
    return `<div class="chips">${out.join('')}</div>`;
  }

  // ---------- token list ----------
  function filtered() {
    const all = state.data?.tokens || [];
    const q = $('q').value.trim().toLowerCase();
    const min = +$('min').value;
    const maxAge = +$('age').value;
    const hide = $('hide').checked;
    let hidden = 0;
    const list = all.filter((t) => {
      if (hide && gated(t)) { hidden++; return false; }
      if (t.score.total < min) return false;
      if (maxAge && (Date.now() - t.createdAt) / 60000 > maxAge) return false;
      if (q) {
        const hay = `${t.name} ${t.symbol} ${t.mint} ${(t.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const key = { score: (t) => t.score.total, new: (t) => t.createdAt, vol: (t) => t.vol?.h1 || 0, liq: (t) => t.liq || 0, chg: (t) => t.chg?.h1 ?? -1e9, mcap: (t) => t.mcap || 0 }[state.sort];
    list.sort((a, b) => key(b) - key(a));
    return { list, hidden, total: all.length };
  }

  function renderRows() {
    const { list, hidden, total } = filtered();
    $('count').textContent = `${list.length} of ${total} shown${hidden ? ` · ${hidden} hidden as likely rugs` : ''}`;
    $('empty').hidden = list.length > 0;
    document.querySelectorAll('th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort));
    $('rows').innerHTML = list.slice(0, 250).map((t) => `
      <tr data-mint="${esc(t.mint)}" class="${gated(t) ? 'flagged' : ''}">
        <td><div class="tok">${icon(t)}<div><div class="nm">${esc(t.name || t.symbol)}</div>
          <div class="sub"><b>$${esc(t.symbol)}</b><span>${ago(t.createdAt)} old</span><span>${esc(t.dex || '')}</span></div></div></div></td>
        <td>${ring(t)}</td>
        <td class="l"><span class="chip ${verdictClass(t.score.verdict)}">${esc(t.score.verdict)}</span></td>
        <td>${fmtPrice(t.price)}</td>
        <td>${fmtPct(t.chg?.h1)}</td>
        <td>${fmtUsd(t.mcap)}</td>
        <td>${fmtUsd(t.liq)}</td>
        <td>${fmtUsd(t.vol?.h1)}</td>
        <td class="l">${safetyChips(t)}</td>
        <td class="l">${socialChips(t)}</td>
        <td><button class="btn buy sm${gated(t) ? ' danger' : ''}" data-buy="${esc(t.mint)}">Buy</button></td>
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
    $('scanStatus').textContent = `Last scan ${ago(d.generatedAt)} ago${ageMin > 45 ? ' (scheduled runs can be delayed by GitHub)' : ''}`;
  }

  // ---------- drawer ----------
  function openDrawer(mint) {
    const t = (state.data?.tokens || []).find((x) => x.mint === mint);
    if (!t) return;
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
    const chart = isMint(t.pair) ? `<iframe class="chart" loading="lazy" title="Price chart" src="https://dexscreener.com/solana/${esc(t.pair)}?embed=1&theme=dark&info=0&trades=0"></iframe>` : '';
    $('drawer').innerHTML = `
      <button class="close" aria-label="Close" data-close>&times;</button>
      <div class="dhead">${icon(t)}<div><h2>${esc(t.name || t.symbol)} <span class="muted">$${esc(t.symbol)}</span></h2>
        <div class="mint" data-copy="${esc(t.mint)}" title="Click to copy">${esc(t.mint)}</div></div></div>
      <div style="display:flex;gap:16px;align-items:center">${ring(t, true)}
        <div><span class="chip ${verdictClass(t.score.verdict)}">${esc(t.score.verdict)}</span>
          <div class="muted" style="margin-top:6px;font-size:12.5px">Rules: ${t.score.rule}${t.score.ml != null ? ` · Model: ${Math.round(t.score.ml * 100)}% chance of holding up` : ' · Model: not enough data yet'}</div>
          <div class="chips" style="margin-top:6px">${(t.tags || []).map((g) => `<span class="chip dim">${esc(g)}</span>`).join('')}</div></div></div>
      ${t.desc ? `<p class="muted" style="font-size:13px">${esc(t.desc)}</p>` : ''}
      <div class="sec"><h3>Score breakdown</h3><div class="bars">${bars}</div></div>
      <div class="sec"><h3>Why</h3><ul class="reasons">${reasons || '<li class="muted">No notable signals.</li>'}</ul></div>
      <div class="sec"><h3>Market</h3><div class="kv">
        ${kv('Price', fmtPrice(t.price))}${kv('Market cap', fmtUsd(t.mcap))}${kv('Liquidity', fmtUsd(t.liq))}
        ${kv('Vol 1h', fmtUsd(t.vol?.h1))}${kv('Vol 24h', fmtUsd(t.vol?.h24))}${kv('Buys / sells 1h', `${tx[0]} / ${tx[1]}`)}
        ${kv('5m', fmtPct(t.chg?.m5))}${kv('1h', fmtPct(t.chg?.h1))}${kv('24h', fmtPct(t.chg?.h24))}
        ${kv('Age', ago(t.createdAt))}${kv('Holders', fmtNum(t.holders))}${kv('Top 10 hold', t.top10 != null ? t.top10.toFixed(1) + '%' : '-')}
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
      <div class="buyrow">
        <button class="btn buy${gated(t) ? ' danger' : ''}" data-buy="${esc(t.mint)}">Buy $${esc(t.symbol)} with your wallet</button>
        <a class="btn" href="https://jup.ag/swap?sell=${SOL}&buy=${esc(t.mint)}" target="_blank" rel="noopener noreferrer">Open on jup.ag</a>
      </div>
      <div class="muted" style="font-size:11.5px">Swap by Jupiter Ultra · Powered by Jupiter. You approve every transaction in your own wallet.</div>`;
    $('drawer').classList.add('on');
    $('overlay').classList.add('on');
    $('drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    state.open = null;
    $('drawer').classList.remove('on');
    $('overlay').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawer').innerHTML = '';
  }

  // ---------- buy ----------
  function buy(mint) {
    if (!isMint(mint)) return;
    const t = (state.data?.tokens || []).find((x) => x.mint === mint);
    if (t && gated(t)) {
      const why = t.score.gates.slice(0, 3).map((g) => '• ' + g).join('\n');
      if (!confirm(`SolSift flagged $${t.symbol} as ${t.score.verdict.toLowerCase()}:\n\n${why}\n\nYou could lose everything you put in. Open the swap anyway?`)) return;
    }
    const fallback = () => window.open(`https://jup.ag/swap?sell=${SOL}&buy=${mint}`, '_blank', 'noopener');
    if (!window.Jupiter || typeof window.Jupiter.init !== 'function') return fallback();
    closeDrawer(); // the swap modal would otherwise open underneath the detail panel
    try {
      // Re-initialising replaces any previous instance, so each click targets the right mint.
      window.Jupiter.init({
        displayMode: 'modal',
        formProps: { initialInputMint: SOL, initialOutputMint: mint, fixedMint: mint, swapMode: 'ExactIn', initialAmount: '' },
        branding: { name: 'SolSift' },
        onSuccess: ({ txid }) => toast('Swap sent: ' + String(txid).slice(0, 8) + '...'),
        onSwapError: () => toast('Swap failed or was rejected'),
      });
    } catch { fallback(); }
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

  // ---------- data ----------
  async function getJson(name) {
    try {
      const r = await fetch(`data/${name}.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  async function load() {
    const [d, tr, m, p] = await Promise.all([getJson('tokens'), getJson('trends'), getJson('model'), getJson('paper')]);
    if (!d) {
      if (!state.data) $('scanStatus').textContent = 'No scan data yet. The first scheduled scan publishes it.';
      return;
    }
    Object.assign(state, { data: d, trends: tr, model: m, paper: p });
    renderTiles(); renderRows(); renderTrends(); renderPerf();
    if (d.repo && /^[\w.-]+\/[\w.-]+$/.test(d.repo)) $('repoLink').innerHTML = `<a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener">Source on GitHub</a>`;
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-buy]');
    if (b) { e.stopPropagation(); return buy(b.dataset.buy); }
    if (e.target.closest('[data-close]') || e.target.id === 'overlay') return closeDrawer();
    const c = e.target.closest('[data-copy]');
    if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Mint address copied')); return; }
    const tab = e.target.closest('.tab');
    if (tab) {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === tab));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + tab.dataset.view));
      return;
    }
    const th = e.target.closest('th[data-sort]');
    if (th) { state.sort = th.dataset.sort; if ([...$('sort').options].some((o) => o.value === state.sort)) $('sort').value = state.sort; return renderRows(); }
    const nar = e.target.closest('.nar');
    if (nar) { $('q').value = nar.dataset.tag; document.querySelector('.tab[data-view=tokens]').click(); return renderRows(); }
    const tr = e.target.closest('tr[data-mint]');
    if (tr && !e.target.closest('a')) openDrawer(tr.dataset.mint);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  ['q', 'age', 'hide'].forEach((id) => $(id).addEventListener('input', renderRows));
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderRows(); });
  $('min').addEventListener('input', (e) => { $('minv').textContent = e.target.value; renderRows(); });

  load();
  setInterval(load, 60000);
  setInterval(() => { if (state.data) renderTiles(); }, 30000);
})();
