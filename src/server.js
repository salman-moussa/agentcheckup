// Local-only server for the report page. Bound to 127.0.0.1 and guarded by a one-time token.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { hasBackups, redactHistory } from './fix.js';
import { renderReport } from './report.js';
import { scan } from './scan.js';
import { TOOLS } from './sources.js';

/**
 * @param {object} first result of the first scan
 * @param {object} scanOpts options to re-run the scan after a fix
 * @returns {Promise<{url:string, server:http.Server}>}
 */
export function serve(first, scanOpts = {}) {
  const token = randomBytes(16).toString('hex');
  let data = first;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    // Token stops other local pages; the Host check stops DNS rebinding.
    if (!['127.0.0.1', 'localhost'].includes(host) || url.searchParams.get('t') !== token) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderReport(data, { live: true, token, hasBackups: hasBackups(data.internal.roots) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/fix') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e4) req.destroy();
      });
      req.on('end', async () => {
        res.setHeader('content-type', 'application/json');
        try {
          const tool = JSON.parse(body || '{}').tool;
          if (!Object.hasOwn(TOOLS, tool)) throw new Error('unknown tool');
          const out = redactHistory(data.internal.roots, data.internal.dirty.filter((f) => f.tool === tool));
          data = await scan(scanOpts);
          res.end(JSON.stringify({ redacted: out.redacted, files: out.files.length, skipped: out.skipped.length }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/?t=${token}`, server }));
  });
}
