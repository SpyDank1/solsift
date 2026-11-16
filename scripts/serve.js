// SolSift local launcher.
//
//   node scripts/serve.js [--open] [--no-scan] [--port 4173]
//
// - Serves the site at http://localhost:4173 (this PC only).
// - Runs the full scanner every 5 minutes, so the scored feed stays fresh
//   without depending on GitHub's scheduler.
// - If a Jupiter API key is present in the .env file next to package.json
//   (JUPITER_API_KEY=jup_...), requests to Jupiter go through /jup/* here and
//   the key is attached on this side. The key never reaches the browser, the
//   public site, or the repository (.env is git-ignored).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { join, normalize, extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.indexOf('--port');
const port = Number((portArg >= 0 && args[portArg + 1]) || (/^\d+$/.test(args[0] || '') ? args[0] : '') || process.env.PORT || 4173);
const SCAN_EVERY_MS = 5 * 60e3;

// ---- .env (KEY=value lines; no dependency needed)
function loadEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const KEY = /^jup_[A-Za-z0-9]{20,}$/.test(process.env.JUPITER_API_KEY || '') ? process.env.JUPITER_API_KEY : '';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const scan = { running: false, last: 0, lastOk: null, runs: 0 };

// Only this page, on this machine, may use the local API (guards against other sites and DNS rebinding).
const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const trusted = (req) => hosts.has(String(req.headers.host || '').toLowerCase()) && (!req.headers.origin || origins.has(req.headers.origin));

const JUP_ALLOWED = /^\/(tokens\/v2|swap\/v2|price\/v3)\//;
async function proxyJupiter(req, res, path, search) {
  if (!KEY) return json(res, 503, { error: 'No API key configured' });
  if (!JUP_ALLOWED.test(path) || !['GET', 'POST'].includes(req.method)) return json(res, 403, { error: 'Not allowed' });
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 64 * 1024) return json(res, 413, { error: 'Too large' }); chunks.push(c); }
    body = Buffer.concat(chunks);
  }
  try {
    const up = await fetch(`https://api.jup.ag${path}${search}`, {
      method: req.method,
      headers: { 'x-api-key': KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(25000),
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' }).end(buf);
  } catch {
    json(res, 502, { error: 'Could not reach Jupiter' });
  }
}
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  let path = decodeURIComponent(url.pathname);

  if (path === '/local/info' || path.startsWith('/jup/')) {
    if (!trusted(req)) return json(res, 403, { error: 'Forbidden' });
    if (path === '/local/info') return json(res, 200, { local: true, keyed: !!KEY, scanning: scan.running, lastScan: scan.last, lastScanOk: scan.lastOk, scanEveryMs: flag('--no-scan') ? 0 : SCAN_EVERY_MS });
    return proxyJupiter(req, res, path.slice(4), url.search);
  }

  if (path.endsWith('/')) path += 'index.html';
  // The live feed scores tokens in the browser with the scanner's own rules: /lib/* is scanner/*.
  const lib = path.match(/^\/lib\/(math|normalize|score)\.js$/);
  const base = path.startsWith('/data/') ? root : join(root, 'site');
  const file = lib ? join(root, 'scanner', `${lib[1]}.js`) : normalize(join(base, path));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

function runScan() {
  if (scan.running) return;
  scan.running = true;
  scan.runs++;
  const t0 = Date.now();
  console.log(`[scan ${scan.runs}] started ${new Date().toLocaleTimeString()}`);
  const child = spawn(process.execPath, [join(root, 'scanner', 'index.js')], { cwd: root, env: { ...process.env, DATA_DIR: join(root, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (d) => { tail = (tail + d).slice(-600); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('close', (code) => {
    scan.running = false;
    scan.last = Date.now();
    scan.lastOk = code === 0;
    const line = tail.split('\n').filter((l) => l.includes('published')).pop() || tail.trim().split('\n').pop() || '';
    console.log(`[scan ${scan.runs}] ${code === 0 ? 'done' : 'FAILED'} in ${Math.round((Date.now() - t0) / 1000)}s  ${line.replace(/^\[[^\]]*\]\s*/, '')}`);
  });
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. SolSift may already be running: open http://localhost:${port}` : e.message);
  if (e.code === 'EADDRINUSE' && flag('--open')) openBrowser();
  process.exitCode = 1;
});
function openBrowser() {
  const u = `http://localhost:${port}`;
  exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`, () => {});
}
server.listen(port, '127.0.0.1', () => {
  console.log(`SolSift is running at http://localhost:${port}   (close this window to stop it)`);
  console.log(KEY ? 'Jupiter API key: loaded from .env (kept on this PC)' : 'Jupiter API key: none. Add JUPITER_API_KEY=... to the .env file for higher limits.');
  if (!flag('--no-scan')) {
    console.log('Scanner: a full scan runs now and then every 5 minutes.');
    runScan();
    setInterval(runScan, SCAN_EVERY_MS);
  }
  if (flag('--open')) openBrowser();
});
