// Single shared-password login with an HMAC-signed, HttpOnly cookie.
// Fine for a small internal team; swap for Google SSO if more people need access.
const crypto = require('crypto');

const COOKIE = 'pc_session';
const MAX_AGE_DAYS = Number(process.env.SESSION_DAYS || 30);
const SECRET = process.env.SESSION_SECRET;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!SECRET || SECRET.length < 32) throw new Error('SESSION_SECRET must be set (32+ random characters)');
if (!PASSWORD || PASSWORD.length < 12) throw new Error('DASHBOARD_PASSWORD must be set (12+ characters)');

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function sessionCookie(req) {
  const exp = String(Date.now() + MAX_AGE_DAYS * 864e5);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Brute-force brake: 10 failed attempts per IP per 15 minutes.
const attempts = new Map();
const WINDOW = 15 * 60e3;
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  return !!a && Date.now() - a.first < WINDOW && a.count >= 10;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
}
const clearFailures = (ip) => attempts.delete(ip);

const checkPassword = (given) => crypto.timingSafeEqual(sha(given || ''), sha(PASSWORD));

module.exports = { isAuthed, sessionCookie, clearCookie, checkPassword, tooManyAttempts, recordFailure, clearFailures, clientIp };
