// Shared helpers: polite HTTP with timeouts, retries and per-host pacing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const UA = 'solana-token-scanner/1.0 (+github-actions)';
const lastCall = new Map(); // host -> timestamp of last request
const stats = new Map(); // host -> { ok, fail }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now();
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const num = (x, d = null) => {
  const n = typeof x === 'string' ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : d;
};
export const log10p = (x) => Math.log10(Math.max(0, num(x, 0)) + 1);

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function note(host, ok) {
  const s = stats.get(host) || { ok: 0, fail: 0 };
  ok ? s.ok++ : s.fail++;
  stats.set(host, s);
}
export const httpStats = () => Object.fromEntries(stats);

/**
 * Fetch JSON (or text) with a timeout, retry on 429/5xx, and a minimum gap
 * between calls to the same host so we stay inside free-tier rate limits.
 * Never throws: returns null on failure so one dead API can't kill a run.
 */
export async function get(url, { gapMs = 250, timeoutMs = 12000, retries = 2, text = false, headers = {}, notFound = null } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) || 0) + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, now());
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: text ? 'text/html,*/*' : 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = num(res.headers.get('retry-after'), 0);
        await sleep(Math.min(8000, ra ? ra * 1000 : 1200 * (attempt + 1)));
        continue;
      }
      if (res.status === 404 && notFound !== null) {
        note(host, true);
        return notFound;
      }
      if (!res.ok) {
        note(host, false);
        return null;
      }
      const body = text ? await res.text() : await res.json();
      note(host, true);
      return body;
    } catch {
      await sleep(600 * (attempt + 1));
    }
  }
  note(host, false);
  return null;
}

/** Run async jobs over items with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, data, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, pretty ? 2 : 0));
}
