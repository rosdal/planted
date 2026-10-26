/**
 * `pnpm content:serve`: serves `dist/` the way the CDN does, for local dev and e2e. Point
 * `VITE_CONTENT_URL` at it (http://localhost:5174 by default). Builds first if nothing is built.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DIST_DIR } from './lib/repo';

const { values } = parseArgs({
  options: { port: { type: 'string' }, dir: { type: 'string' } },
});
const port = Number(values.port ?? process.env.CONTENT_PORT ?? 5174);
const root = values.dir ? resolve(values.dir) : DIST_DIR;

if (!existsSync(join(root, 'latest.json'))) {
  console.error(`Nothing built in ${root}; run pnpm content:build first`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = normalize(join(root, path));
  // Never serve anything outside dist/.
  if (!file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Same caching as the CDN, minus immutability: a rebuild reuses names only if bytes match.
      'cache-control': path.endsWith('latest.json') ? 'no-cache' : 'public, max-age=31536000',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
