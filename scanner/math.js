// Pure numeric helpers. No Node APIs here: this file is also loaded by the website.
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const num = (x, d = null) => {
  const n = typeof x === 'string' ? parseFloat(x) : x;
  return Number.isFinite(n) ? n : d;
};
export const log10p = (x) => Math.log10(Math.max(0, num(x, 0)) + 1);
