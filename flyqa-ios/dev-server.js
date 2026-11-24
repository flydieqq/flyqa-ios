// ============================================================
//  flyqa-ios — Isolated Static & Config Dev Server (Port 3457)
// ============================================================
const http = require('http');
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
