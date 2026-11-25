// ============================================================
//  flyqa-ios — Isolated Static & Config Dev Server (Port 3457)
// ============================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3457;
const WWW_DIR = path.join(__dirname, 'www');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (urlPath === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      supabaseUrl: 'https://oafzlggcpswffuzmzxcy.supabase.co',
      supabaseAnonKey: 'sb_publishable_pyoPUoTMUvvPqq4fZ_5OwA_BZg-k5BI'
    }));
    return;
  }

  if (urlPath === '/api/playlists') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('[]');
    return;
  }

  if (urlPath === '/api/proxy-json') {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const target = u.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":"invalid url"}');
      return;
    }
    const fetchJsonWithRedirects = (urlStr, depth = 0) => {
      if (depth > 5) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"error":"redirects"}');
        return;
      }
      const mod = urlStr.startsWith('https://') ? https : http;
      const proxyReq = mod.get(urlStr, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 7000 }, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          const nextUrl = new URL(upstream.headers.location, urlStr).toString();
          upstream.resume();
          fetchJsonWithRedirects(nextUrl, depth + 1);
          return;
        }
        res.writeHead(upstream.statusCode || 200, {
          'Content-Type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        upstream.pipe(res);
      });
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"timeout"}');
        }
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"error":"proxy"}');
        }
      });
    };
    fetchJsonWithRedirects(target);
    return;
  }

  if (urlPath === '/api/proxy-audio') {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const target = u.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid url');
      return;
    }
    const fetchWithRedirects = (urlStr, depth = 0) => {
      if (depth > 5) {
        res.writeHead(502);
        res.end('Too many redirects');
        return;
      }
      const mod = urlStr.startsWith('https://') ? https : http;
      mod.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          const nextUrl = new URL(upstream.headers.location, urlStr).toString();
          upstream.resume();
          fetchWithRedirects(nextUrl, depth + 1);
          return;
        }
        const headers = {
          'Content-Type': upstream.headers['content-type'] || 'audio/mp4',
          'Access-Control-Allow-Origin': '*'
        };
        if (upstream.headers['content-length']) {
          headers['Content-Length'] = upstream.headers['content-length'];
        }
        res.writeHead(upstream.statusCode || 200, headers);
        upstream.pipe(res);
      }).on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Proxy error');
        }
      });
    };
    fetchWithRedirects(target);
    return;
  }

  const safeRel = path.normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const filePath = path.join(WWW_DIR, safeRel);
  if (!filePath.startsWith(WWW_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`flyqa-ios dev server running on http://localhost:${PORT}`);
});
