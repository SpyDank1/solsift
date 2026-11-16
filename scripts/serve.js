// Tiny static server for local preview: serves ./site with ./data mounted at /data.
// Usage: node scripts/serve.js [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';

const port = Number(process.argv[2] || process.env.PORT || 4173);
const root = resolve('.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`SolSift preview on http://localhost:${port}`));
