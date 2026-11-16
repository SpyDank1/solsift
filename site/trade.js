// Wallet connection and swaps.
//
// Non-custodial by construction: this file never sees a private key. It
//   1. discovers browser wallets through the Wallet Standard (Phantom,
//      Solflare, Backpack and any other compliant wallet),
//   2. asks Jupiter's Swap API V2 (/order, "Jupiter Ultra") for a quote plus an
//      unsigned transaction,
//   3. hands the transaction bytes to the wallet, which shows the user what it
//      does and signs it only if they approve,
//   4. posts the signed transaction back to Jupiter (/execute) to land it.
// Jupiter builds the transaction; nothing here constructs or edits one.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1_000_000_000;
const CHAIN = 'solana:mainnet';

// ------------------------------------------------------------- wallets
const wallets = new Map(); // name -> Wallet Standard wallet
const listeners = new Set();
let session = null; // { wallet, account, address }

const usable = (w) => !!(w && w.features && w.features['standard:connect'] && w.features['solana:signTransaction'] && (w.chains || []).some((c) => String(c).startsWith('solana:')));
const emit = () => { for (const fn of listeners) { try { fn(); } catch { /* listener errors are not ours */ } } };

function register(...list) {
  for (const w of list) if (usable(w)) wallets.set(w.name, w);
  emit();
  return () => {};
}
const api = Object.freeze({ register });

// Wallet Standard handshake: tell already-loaded wallets we are ready, and listen for late ones.
class AppReadyEvent extends Event {
  #detail;
  constructor(detail) { super('wallet-standard:app-ready', { bubbles: false, cancelable: false, composed: false }); this.#detail = detail; }
  get detail() { return this.#detail; }
}
if (typeof window !== 'undefined') {
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(api); } catch { /* malformed wallet */ } });
  try { window.dispatchEvent(new AppReadyEvent(api)); } catch { /* very old browser */ }
}

export const onWalletChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const listWallets = () => [...wallets.values()].map((w) => ({ name: w.name, icon: typeof w.icon === 'string' && w.icon.startsWith('data:image/') ? w.icon : null }));
export const currentWallet = () => (session ? { name: session.wallet.name, address: session.address } : null);

export async function connectWallet(name, { silent = false } = {}) {
  const w = wallets.get(name);
  if (!w) throw new Error(`${name} wallet not found`);
  const res = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
  const accounts = (res && res.accounts && res.accounts.length ? res.accounts : w.accounts) || [];
  const account = accounts.find((a) => (a.chains || []).some((c) => String(c).startsWith('solana:'))) || accounts[0];
  if (!account) throw new Error('The wallet did not share an account');
  session = { wallet: w, account, address: account.address };
  try { localStorage.setItem('solsift.wallet', name); } catch { /* private mode */ }
  // Follow account switches and disconnects made inside the wallet.
  try {
    w.features['standard:events']?.on('change', ({ accounts: next }) => {
      if (!session || session.wallet !== w || !next) return;
      const a = next.find((x) => (x.chains || []).some((c) => String(c).startsWith('solana:')));
      session = a ? { wallet: w, account: a, address: a.address } : null;
      emit();
    });
  } catch { /* events are optional */ }
  emit();
  return currentWallet();
}

export async function disconnectWallet() {
  const s = session;
  session = null;
  try { localStorage.removeItem('solsift.wallet'); } catch { /* ignore */ }
  try { await s?.wallet.features['standard:disconnect']?.disconnect(); } catch { /* wallet may not support it */ }
  emit();
}

/** Reconnect quietly to the wallet used last time, if it still trusts this site. */
export async function restoreWallet() {
  let name = null;
  try { name = localStorage.getItem('solsift.wallet'); } catch { /* ignore */ }
  if (!name || session) return null;
  for (let i = 0; i < 20 && !wallets.has(name); i++) await new Promise((r) => setTimeout(r, 150)); // wallets inject asynchronously
  if (!wallets.has(name)) return null;
  try { return await connectWallet(name, { silent: true }); } catch { return null; }
}

// ------------------------------------------------------------- bytes
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------- Jupiter
export class TradeError extends Error {
  constructor(message, { stage, code } = {}) { super(message); this.stage = stage; this.code = code; }
}

/**
 * @param apiBase  'https://api.jup.ag' on the public site (keyless), or '/jup' when the local
 *                 launcher proxies requests and attaches the API key on the server side.
 */
export function createTrader(apiBase) {
  const base = String(apiBase).replace(/\/$/, '');
  async function call(path, init) {
    let res;
    try { res = await fetch(base + path, { cache: 'no-store', signal: AbortSignal.timeout(20000), ...init }); } catch (e) {
      throw new TradeError(e && e.name === 'TimeoutError' ? 'Jupiter took too long to answer. Try again.' : 'Could not reach Jupiter. Check your connection.', { stage: 'network' });
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (res.status === 429) throw new TradeError('Jupiter rate limit reached. Wait a few seconds and try again.', { stage: 'rate', code: 429 });
    if (!res.ok) throw new TradeError((body && (body.error || body.message)) || `Jupiter returned an error (${res.status})`, { stage: 'api', code: res.status });
    return body;
  }

  /** SOL and token balances for an address: { sol, lamports, tokens: Map(mint -> { raw: bigint, ui, decimals }) } */
  async function holdings(address) {
    const j = await call(`/swap/v2/holdings/${address}`);
    const tokens = new Map();
    for (const [mint, accounts] of Object.entries((j && j.tokens) || {})) {
      const list = (Array.isArray(accounts) ? accounts : [accounts]).filter((a) => a && !a.isFrozen);
      // /order spends from the associated token account, so prefer it when present.
      const pick = list.filter((a) => a.isAssociatedTokenAccount);
      const use = pick.length ? pick : list;
      let raw = 0n;
      let ui = 0;
      let decimals = null;
      for (const a of use) {
        try { raw += BigInt(a.amount); } catch { continue; }
        ui += Number(a.uiAmount) || 0;
        if (Number.isInteger(a.decimals)) decimals = a.decimals;
      }
      if (raw > 0n) tokens.set(mint, { raw, ui, decimals });
    }
    const lamports = BigInt((j && j.amount) || '0');
    return { lamports, sol: Number(lamports) / LAMPORTS, tokens };
  }

  /** Quote only (no wallet needed). */
  function quote({ inputMint, outputMint, amount, slippageBps }) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount) });
    if (Number.isFinite(slippageBps)) q.set('slippageBps', String(Math.round(slippageBps)));
    return call(`/swap/v2/order?${q}`);
  }

  /**
   * Full swap. `onStage` is called with 'quote' | 'sign' | 'send' so the UI can narrate.
   * `confirmQuote(order)` may return false to stop before the wallet is asked to sign.
   */
  async function swap({ inputMint, outputMint, amount, slippageBps, priorityFeeLamports, onStage = () => {}, confirmQuote }) {
    if (!session) throw new TradeError('Connect a wallet first.', { stage: 'wallet' });
    const { wallet, account, address } = session;
    let raw;
    try { raw = BigInt(amount); } catch { raw = 0n; }
    if (raw <= 0n) throw new TradeError('Amount must be greater than zero.', { stage: 'input' });

    onStage('quote');
    const q = new URLSearchParams({ inputMint, outputMint, amount: raw.toString(), taker: address });
    if (Number.isFinite(slippageBps)) q.set('slippageBps', String(Math.min(10000, Math.max(0, Math.round(slippageBps)))));
    if (Number.isFinite(priorityFeeLamports) && priorityFeeLamports > 0) q.set('priorityFeeLamports', String(Math.round(priorityFeeLamports)));
    const order = await call(`/swap/v2/order?${q}`);
    if (!order || !order.transaction) {
      const msg = (order && (order.errorMessage || order.error)) || 'Jupiter could not build this swap.';
      throw new TradeError(msg, { stage: 'order', code: order && order.errorCode });
    }
    // Never sign for anything other than what was asked.
    let quotedIn = -1n;
    try { quotedIn = BigInt(order.inAmount); } catch { /* handled below */ }
    if (order.inputMint !== inputMint || order.outputMint !== outputMint || quotedIn <= 0n || quotedIn > raw) {
      throw new TradeError('Jupiter returned a different swap than requested. Nothing was signed.', { stage: 'order' });
    }
    if (confirmQuote && (await confirmQuote(order)) === false) throw new TradeError('Cancelled.', { stage: 'cancelled' });

    onStage('sign');
    let signed;
    try {
      const out = await wallet.features['solana:signTransaction'].signTransaction({ account, transaction: b64ToBytes(order.transaction), chain: CHAIN });
      signed = out && out[0] && out[0].signedTransaction;
    } catch (e) {
      throw new TradeError(/reject|denied|cancel/i.test(String(e && e.message)) ? 'You rejected the transaction in your wallet.' : `Wallet could not sign: ${String((e && e.message) || e).slice(0, 120)}`, { stage: 'sign' });
    }
    if (!signed || !signed.length) throw new TradeError('The wallet returned no signature.', { stage: 'sign' });

    onStage('send');
    const result = await call('/swap/v2/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: bytesToB64(signed), requestId: order.requestId }),
    });
    if (!result || result.status !== 'Success') {
      throw new TradeError((result && result.error) || 'The swap did not go through.', { stage: 'execute', code: result && result.code });
    }
    return { order, result, signature: result.signature };
  }

  return { holdings, quote, swap };
}

export const solToLamports = (sol) => BigInt(Math.round(Number(sol) * LAMPORTS));
/** percent (0-100] of a raw bigint balance, rounded down; 100 returns the full balance exactly. */
export function pctOf(raw, pct) {
  const p = Math.min(100, Math.max(0, Number(pct)));
  return p >= 100 ? raw : (raw * BigInt(Math.round(p * 100))) / 10000n;
}
