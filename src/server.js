// Zero-dependency server: Node's http + built-in SQLite. Nothing to npm install.
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const { startSync, syncStatus } = require('./sync');
const { overview, monthly, customers } = require('./metrics');
const { scheduleDaily } = require('./scheduler');

const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
const redirect = (res, to, headers = {}) => send(res, 303, '', { Location: to, ...headers });

function serveFile(res, file) {
  const full = path.join(PUB, file);
  if (!full.startsWith(PUB + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = auth.clientIp(req);

  // ---- public
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain' });
  if (p === '/login' && req.method === 'GET') return serveFile(res, 'login.html');
  if (p === '/login' && req.method === 'POST') {
    if (auth.tooManyAttempts(ip)) return redirect(res, '/login?e=locked');
    const form = new URLSearchParams(await readBody(req));
    if (!auth.checkPassword(form.get('password'))) { auth.recordFailure(ip); return redirect(res, '/login?e=1'); }
    auth.clearFailures(ip);
    return redirect(res, '/', { 'Set-Cookie': auth.sessionCookie(req) });
  }
  if (p === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'Set-Cookie': auth.clearCookie() });

  // ---- everything else needs a session
  if (!auth.isAuthed(req)) return p.startsWith('/api/') ? json(res, 401, { error: 'Not signed in' }) : redirect(res, '/login');

  if (p === '/api/overview' && req.method === 'GET') {
    try { return json(res, 200, overview(Object.fromEntries(url.searchParams))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/customers' && req.method === 'GET') {
    try { return json(res, 200, customers(Object.fromEntries(url.searchParams))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/monthly' && req.method === 'GET') return json(res, 200, monthly(Math.min(Number(url.searchParams.get('limit')) || 13, 60)));
  if (p === '/api/status' && req.method === 'GET') return json(res, 200, syncStatus());
  if (p === '/api/sync' && req.method === 'POST') {
    // CSRF guard on top of SameSite=Lax: only our own fetch() sends this header.
    if (req.headers['x-requested-with'] !== 'fetch') return json(res, 403, { error: 'Bad request origin' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
    return json(res, 200, startSync({ full: body.full === true, trigger: 'manual' }));
  }

  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return serveFile(res, 'index.html');
    if (p === '/app.js') return serveFile(res, 'app.js');
  }
  send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); });
});

// ---- nightly sync. Run ONE container only: two replicas would double-sync.
const SYNC_AT = process.env.SYNC_AT_IST || '02:30';
scheduleDaily(SYNC_AT, () => { console.log('[schedule] nightly sync'); startSync({ trigger: 'nightly' }); });

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`PetChef dashboard on :${PORT} · nightly sync ${SYNC_AT} IST`);
  if (syncStatus().orderCount === 0 && !process.env.SKIP_BOOT_SYNC) startSync({ trigger: 'first-boot' });
});
