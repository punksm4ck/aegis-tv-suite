'use strict';
// tv.punksm4ck.com - login-gated live TV player with a built-in HLS relay.
// Env: PORT (4070), HOST (0.0.0.0), PLAYLIST_PATH (./playlist.m3u), JWT_SECRET,
//      ALLOW_SIGNUP (1 = open registration), COOKIE_SECURE (auto|1|0)

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PORT = parseInt(process.env.PORT || '4070', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PLAYLIST_PATH = process.env.PLAYLIST_PATH || path.join(ROOT, 'playlist.m3u');
const ALL_PLAYLIST_PATH = process.env.PLAYLIST_ALL_PATH || path.join(ROOT, 'playlist_all.m3u');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === '1';
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';           // optional invite code required to create an account
const MAX_USERS = parseInt(process.env.MAX_USERS || '500', 10); // stops signup floods from filling the disk
const COOKIE_NAME = 'tv_session';
const UPSTREAM_UA = 'VLC/3.0.20 LibVLC/3.0.20';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secrets & users ----------
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) { /* create */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// ---------- playlist ----------
let playlistCache = { mtime: 0, channels: [], byId: new Map() };

function parseM3U(text) {
  const out = [];
  let cur = null;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const colon = line.indexOf(':');
      const rest = colon >= 0 ? line.slice(colon + 1) : '';
      const lastQuote = rest.lastIndexOf('"');
      const comma = rest.indexOf(',', lastQuote + 1);
      const name = comma >= 0 ? rest.slice(comma + 1).trim() : '';
      const g = rest.match(/group-title="([^"]*)"/);
      const tn = rest.match(/tvg-name="([^"]*)"/);
      const ti = rest.match(/tvg-id="([^"]*)"/);
      const hr = rest.match(/http-referrer="([^"]*)"/), hu = rest.match(/http-user-agent="([^"]*)"/);
      cur = { name: name || (tn && tn[1]) || 'Unknown', group: (g && g[1]) || 'Uncategorized', tvgId: ti ? ti[1] : '', ref: hr ? hr[1] : '', ua: hu ? hu[1] : '' };
    } else if (/^#EXTVLCOPT:/i.test(line)) {
      const m = line.match(/^#EXTVLCOPT:\s*http-(referrer|referer|user-agent)\s*=\s*(.*)$/i);
      if (m && cur) { if (/user-agent/i.test(m[1])) cur.ua = m[2].trim(); else cur.ref = m[2].trim(); }
    } else if (!line.startsWith('#')) {
      if (/^https?:\/\//i.test(line)) {
        const c = cur || { name: 'Unknown', group: 'Uncategorized' };
        c.url = line;
        c.id = crypto.createHash('sha1').update(line).digest('hex').slice(0, 10);
        out.push(c);
      }
      cur = null;
    }
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

function getPlaylist() {
  let st;
  try { st = fs.statSync(PLAYLIST_PATH); } catch (_) { return playlistCache; }
  let st2 = null;
  try { st2 = fs.statSync(ALL_PLAYLIST_PATH); } catch (_) {}
  const stamp = st.mtimeMs + ':' + (st2 ? st2.mtimeMs : 0);
  if (stamp !== playlistCache.mtime) {
    const favs = parseM3U(fs.readFileSync(PLAYLIST_PATH, 'utf8'));
    favs.forEach((c) => { c.fav = true; });
    let extra = [];
    if (st2) { try { extra = parseM3U(fs.readFileSync(ALL_PLAYLIST_PATH, 'utf8')); } catch (_) {} }
    const have = new Set(favs.map((c) => c.id));
    const channels = favs.concat(extra.filter((c) => !have.has(c.id)));
    playlistCache = { mtime: stamp, channels, byId: new Map(channels.map((c) => [c.id, c])) };
    console.log(`[tv] playlist loaded: ${channels.length} channels (${favs.length} favorites)`);
  }
  return playlistCache;
}

// ---------- SSRF guard + signed proxy tokens ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
}
async function assertPublicHost(urlStr) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  if (process.env.ALLOW_PRIVATE_UPSTREAM === '1') return; // local testing only; never set in production
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('private address'); return; }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);
function makeToken(url, h) { const p = b64u(h && (h.ref || h.ua) ? JSON.stringify({ u: url, r: h.ref || '', a: h.ua || '' }) : url); return `${p}.${sign(p)}`; }
function readToken(tok) {
  const i = tok.lastIndexOf('.');
  if (i < 1) return null;
  const p = tok.slice(0, i), sig = tok.slice(i + 1);
  const want = sign(p);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const raw = Buffer.from(p, 'base64url').toString('utf8');
  if (raw[0] !== '{') return { url: raw, h: null };
  try { const j = JSON.parse(raw); return { url: j.u, h: { ref: j.r || '', ua: j.a || '' } }; } catch (_) { return null; }
}
const proxyPath = (url, h) => `/p/${makeToken(url, h)}`;

function rewriteManifest(text, baseUrl, h) {
  const abs = (ref) => { try { return proxyPath(new URL(ref, baseUrl).href, h); } catch (_) { return ref; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    return abs(t);
  }).join('\n');
}

async function upstreamFetch(url, req, { manifestHint, h }) {
  await assertPublicHost(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), manifestHint ? 12000 : 20000);
  req.on('close', () => ac.abort());
  const headers = { 'User-Agent': (h && h.ua) || UPSTREAM_UA, Accept: '*/*' };
  if (h && h.ref) headers.Referer = h.ref;
  if (req.headers.range) headers.Range = req.headers.range;
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
  } finally { clearTimeout(timer); }
  if (res.url && res.url !== url) await assertPublicHost(res.url); // redirects must stay public
  return res;
}

const upLogAt = new Map();
function logUp(url, what) {   // logs the upstream host only (playlist URLs can carry tokens), at most once per 30s per message
  let host = '?'; try { host = new URL(url).host; } catch (_) {}
  const k = host + '|' + what, t = Date.now();
  if (t - (upLogAt.get(k) || 0) < 30000) return;
  upLogAt.set(k, t);
  console.log('[tv] upstream ' + host + ': ' + what);
}

async function relay(url, req, res, manifestHint, h) {
  let up;
  try { up = await upstreamFetch(url, req, { manifestHint, h }); }
  catch (e) { logUp(url, 'fetch failed: ' + ((e && e.name) || '') + ' ' + ((e && e.message) || '')); return res.status(502).type('text/plain').send('upstream unavailable'); }
  if (!up.ok && up.status !== 206) { logUp(url, 'HTTP ' + up.status); return res.status(up.status === 404 ? 404 : 502).type('text/plain').send('upstream error ' + up.status); }

  const ctype = (up.headers.get('content-type') || '').toLowerCase();
  const looksManifest = manifestHint || /mpegurl/.test(ctype) || /\.m3u8(\?|$)/i.test(url);
  res.set('Cache-Control', 'no-store');
  if (looksManifest) {
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length < 2 * 1024 * 1024 && buf.slice(0, 7).toString() === '#EXTM3U') {
      res.type('application/vnd.apple.mpegurl').send(rewriteManifest(buf.toString('utf8'), up.url || url, h));
    } else {
      res.type(ctype || 'application/octet-stream').send(buf); // wasn't really a manifest
    }
    return;
  }
  res.status(up.status);
  res.set('Content-Type', /^(video|audio|image)\/|octet-stream/.test(ctype) ? ctype : 'video/mp2t');
  // fetch() decompresses gzip/br bodies, so a forwarded Content-Length would be wrong (Cloudflare reports that as a 520)
  const len = up.headers.get('content-length'); if (len && !up.headers.get('content-encoding')) res.set('Content-Length', len);
  const cr = up.headers.get('content-range'); if (cr) res.set('Content-Range', cr);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on('error', (e) => { logUp(url, 'stream error: ' + ((e && e.message) || '')); res.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(cookieParser());
app.use(express.json({ limit: '4kb' }));

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.ip;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: clientIp, validate: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }),
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
  keyGenerator: clientIp, validate: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many sign-ups from this network. Try again later.' }),
});

function currentUser(req) {
  const tok = req.cookies[COOKIE_NAME];
  if (!tok) return null;
  try {
    const p = jwt.verify(tok, SECRET, { algorithms: ['HS256'] });
    const users = readUsers();
    return users[p.sub] ? p.sub : null; // deleting a user revokes access immediately
  } catch (_) { return null; }
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (u) { req.user = u; return next(); }
  if (req.method === 'GET' && req.path === '/') return res.redirect('/login');
  res.status(401).json({ error: 'auth required' });
}
function setSession(req, res, username) {
  const token = jwt.sign({ sub: username }, SECRET, { algorithm: 'HS256', expiresIn: '30d' });
  const secure = process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE !== '0' && (req.secure || req.headers['x-forwarded-proto'] === 'https'));
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: 30 * 24 * 3600 * 1000, path: '/' });
}
const jsonOnly = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'json required' }));

// public: login page, config, auth endpoints
app.get('/login', (req, res) => (currentUser(req) ? res.redirect('/') : res.sendFile(path.join(PUBLIC_DIR, 'login.html'))));
app.get('/api/config', (_req, res) => res.json({ signup: ALLOW_SIGNUP, codeRequired: ALLOW_SIGNUP && !!SIGNUP_CODE }));
app.get('/hls.min.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'hls.min.js')));
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#15181d"/><rect x="5" y="8" width="22" height="14" rx="2" fill="none" stroke="#6c7cff" stroke-width="2.5"/><path d="M12 26h8M16 22v4" stroke="#6c7cff" stroke-width="2.5" stroke-linecap="round"/></svg>';
app.get(['/favicon.ico', '/favicon.svg'], (_req, res) => res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(FAVICON));
app.get('/login.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.js')));

app.post('/api/login', authLimiter, jsonOnly, async (req, res) => {
  const { username, password } = req.body || {};
  const users = readUsers();
  const rec = typeof username === 'string' ? users[username.toLowerCase()] : null;
  // constant-ish time: always run a compare
  const ok = await bcrypt.compare(String(password || ''), rec ? rec.hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
  if (!rec || !ok) return res.status(401).json({ error: 'Invalid username or password.' });
  setSession(req, res, username.toLowerCase());
  res.json({ ok: true });
});
app.post('/api/register', signupLimiter, jsonOnly, async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'Registration is closed.' });
  const { username, password, code } = req.body || {};
  if (SIGNUP_CODE) {
    const a = Buffer.from(String(code || '')), b = Buffer.from(SIGNUP_CODE);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'That invite code is not valid.' });
  }
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3-32 letters, numbers, . _ -' });
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Password must be 10+ characters.' });
  const users = readUsers();
  const key = username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'That username is taken.' });
  if (Object.keys(users).length >= MAX_USERS) return res.status(403).json({ error: 'Registration is full.' });
  users[key] = { hash: await bcrypt.hash(password, 11), created: new Date().toISOString() };
  writeUsers(users);
  setSession(req, res, key);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE_NAME, { path: '/' }); res.json({ ok: true }); });

let dvr; // assigned below, before listen
// everything below needs a session
app.get('/video-click.js', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'video-click.js')));
app.get('/', requireAuth, (req, res) => {
  fs.readFile(path.join(PUBLIC_DIR, 'player.html'), 'utf8', (e, html) => {
    if (e) return res.status(500).type('text/plain').send('server error');
    // everyone gets click-to-resume; only admins also get the DVR UI
    const tags = '<script src="/video-click.js"></script>' + (dvr.isAdmin(req.user) ? '<script src="/dvr-ui.js"></script>' : '');
    res.set('Cache-Control', 'no-store').type('html').send(html.replace('</body>', tags + '</body>'));
  });
});
app.get('/player.js', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.js')));

app.get('/api/channels', requireAuth, (req, res) => {
  const { channels } = getPlaylist();
  res.set('Cache-Control', 'no-store');
  res.json((req.query.all === '1' ? channels : channels.filter((c) => c.fav)).map(({ id, name, group, fav }) => ({ id, name, group, fav: !!fav })));
});
// Channel entry point: manifest of the channel, rewritten through the relay.
app.get('/s/:id', requireAuth, async (req, res) => {
  const ch = getPlaylist().byId.get(req.params.id);
  if (!ch) return res.status(404).type('text/plain').send('no such channel');
  await relay(ch.url, req, res, true, { ref: ch.ref, ua: ch.ua });
});
// Signed relay for variant playlists, segments, keys.
app.get('/p/:token', requireAuth, async (req, res) => {
  const tk = readToken(req.params.token);
  if (!tk || !tk.url) return res.status(400).type('text/plain').send('bad token');
  await relay(tk.url, req, res, false, tk.h);
});

// ---------- DVR (admin only) ----------
dvr = require('./dvr').mount(app, { requireAuth, jsonOnly, getPlaylist, dataDir: DATA_DIR, publicDir: PUBLIC_DIR });

// ---------- guide (EPG) ----------
const GUIDE_PATH = path.join(ROOT, 'guide.json');
let guideCache = { mtime: 0, data: null };
const gnorm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(pluto|hd|channel)\b/g, ' ').replace(/[^a-z0-9]/g, '');
function getGuide() {
  try {
    const st = fs.statSync(GUIDE_PATH);
    if (st.mtimeMs !== guideCache.mtime) guideCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(GUIDE_PATH, 'utf8')) };
  } catch (_) {}
  return guideCache.data;
}
const GUIDE_ALL_PATH = path.join(ROOT, 'guide_all.json');
let guideAllCache = { mtime: 0, data: null };
function getGuideAll() {
  try {
    const st = fs.statSync(GUIDE_ALL_PATH);
    if (st.mtimeMs !== guideAllCache.mtime) guideAllCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(GUIDE_ALL_PATH, 'utf8')) };
  } catch (_) {}
  return guideAllCache.data;
}
app.get('/guide.js', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guide.js')));
app.get('/guide.css', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'guide.css')));
app.get('/api/guide', requireAuth, (req, res) => {
  const g = getGuide();
  const out = { generated: g ? g.generated : 0, hours: g ? g.hours : 0, channels: {} };
  const ga = req.query.all === '1' ? getGuideAll() : null;
  const grp = typeof req.query.group === 'string' ? req.query.group : '';
  for (const c of getPlaylist().channels) {
    if (grp && c.group !== grp) continue;
    const e = c.fav ? (g && g.channels[gnorm(c.name)]) : (ga && ga.channels[c.tvgId || 'n:' + gnorm(c.name)]);
    if (e) out.channels[c.id] = e.programmes;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});
app.use((_req, res) => res.status(404).type('text/plain').send('not found'));
app.use((err, _req, res, _next) => { console.error('[tv] error', err && err.message); res.status(500).type('text/plain').send('server error'); });

if (require.main === module) {
  getPlaylist();
  app.listen(PORT, HOST, () => console.log(`[tv] listening on ${HOST}:${PORT} (signup ${ALLOW_SIGNUP ? 'open' : 'closed'})`));
}
module.exports = { app, parseM3U, rewriteManifest, readUsers, writeUsers, USERNAME_RE };
