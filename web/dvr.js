'use strict';
// Web DVR for tv.punksm4ck.com - admin-only, runs ffmpeg on the host.
// Env: ADMIN_USERS (comma list of usernames allowed to record), AEGIS_DVR_DIR, FFMPEG (path), DVR_MAX_CONCURRENT (3)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PRE = 60, POST = 120;                 // same padding as the desktop DVR
const MAX_SECONDS = 6 * 3600;
const MAX_CONCURRENT = parseInt(process.env.DVR_MAX_CONCURRENT || '3', 10);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const UA = 'VLC/3.0.20 LibVLC/3.0.20';
const ADMINS = new Set((process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

function pickDir() {
  const home = os.homedir();
  for (const d of [process.env.AEGIS_DVR_DIR, path.join(home, 'Videos', 'AegisDVR'), path.join(home, 'AegisDVR')]) {
    if (!d) continue;
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch (e) { console.log('[dvr] dir unusable', d, e.message); }
  }
  throw new Error('no writable DVR folder');
}
const isAdmin = (user) => !!user && ADMINS.has(String(user).toLowerCase());
const safe = (n) => String(n || '').replace(/[^\w\- ]+/g, '').trim().replace(/ /g, '_').slice(0, 60) || 'rec';
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; }

function mount(app, { requireAuth, jsonOnly, getPlaylist, dataDir, publicDir }) {
  const DIR = pickDir();
  const SCHED = path.join(dataDir, 'dvr_web_jobs.json');   // separate from the desktop app's schedule
  const active = new Map();                                  // id -> { child, tries }
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(SCHED, 'utf8')); } catch (_) {}
  const now0 = Date.now() / 1000;
  for (const j of jobs) if (j.status === 'recording') j.status = now0 < j.end + POST ? 'scheduled' : 'done';

  const save = () => { const t = SCHED + '.tmp'; fs.writeFileSync(t, JSON.stringify(jobs, null, 1)); fs.renameSync(t, SCHED); };

  function requireAdmin(req, res, next) {
    if (isAdmin(req.user)) return next();
    res.status(403).json({ error: 'admin only' });
  }
  const guard = [requireAuth, requireAdmin];

  function uniquePath(j) {
    const base = `${safe(j.title)}_${stamp()}`;
    let p = path.join(DIR, base + '.ts'), n = 1;
    while (fs.existsSync(p)) p = path.join(DIR, `${base}_${++n}.ts`);
    return p;
  }

  function launch(j) {
    const ch = getPlaylist().byId.get(j.channelId);
    if (!ch) { j.status = 'failed'; return false; }
    const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', ch.ua || UA].concat(ch.ref ? ['-referer', ch.ref] : [], [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', ch.url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', '-y', j.path]);
    const a = active.get(j.id) || { tries: 0 };
    let child;
    try { child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }); }
    catch (e) { console.log('[dvr] spawn failed', e.message); j.status = 'failed'; return false; }
    a.child = child; a.startedAt = Date.now();
    active.set(j.id, a);
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { console.log('[dvr] ffmpeg error', e.message); });
    child.on('exit', () => {
      const cur = active.get(j.id);
      if (!cur || cur.child !== child) return;
      if (cur.stopping) return;                                   // finish() handles it
      if (Date.now() / 1000 < j.end + POST && cur.tries < 8) {   // stream dropped: retry into a new part file
        cur.tries++;
        j.parts = (j.parts || [j.path]); j.path = uniquePath(j); j.parts.push(j.path);
        save();
        setTimeout(() => { if (active.get(j.id) === cur) launch(j); }, 3000);
      } else { finish(j.id); }
    });
    return true;
  }

  function start(j) {
    if (active.has(j.id)) return;
    if (active.size >= MAX_CONCURRENT) return;
    j.path = uniquePath(j); j.parts = (j.parts || []).concat(j.path); j.status = 'recording';
    if (!launch(j)) active.delete(j.id);
    save();
  }

  function watch(j, now) {   // restart ffmpeg if its part file stops growing (silent reconnect loops never exit)
    const a = active.get(j.id);
    if (!a || a.stopping || !a.child) return;
    let size = -1; try { size = fs.statSync(j.path).size; } catch (_) {}
    if (a.wsize === undefined || size !== a.wsize || a.wpath !== j.path) { a.wsize = size; a.wpath = j.path; a.wat = now; return; }
    if (now - a.wat > 180) { console.log('[dvr] no data for 180s, restarting ffmpeg:', j.title); a.wat = now; try { a.child.kill(); } catch (_) {} }
  }

  function finish(jid) {
    const a = active.get(jid);
    const j = jobs.find((x) => x.id === jid);
    if (a) {
      a.stopping = true;
      try { a.child.stdin.write('q'); } catch (_) {}
      setTimeout(() => { try { a.child.kill(); } catch (_) {} }, 5000);
      active.delete(jid);
    }
    if (j) {
      const ok = (j.parts || [j.path]).some((p) => { try { return p && fs.statSync(p).size > 200000; } catch (_) { return false; } });
      j.status = ok ? 'done' : 'failed';
    }
    save();
  }

  setInterval(() => {
    const now = Date.now() / 1000;
    let dirty = false;
    for (const j of jobs) {
      if (j.status === 'scheduled') {
        if (now >= j.end + POST) { j.status = 'missed'; dirty = true; }
        else if (now >= j.start - PRE) start(j);
      } else if (j.status === 'recording' && now >= j.end + POST) finish(j.id);
      else if (j.status === 'recording') watch(j, now);
    }
    if (dirty) save();
  }, 5000).unref();

  const view = (j, user) => ({ id: j.id, channelId: j.channelId, channel: j.channel, title: j.title, start: j.start, end: j.end,
    status: j.status, file: j.path ? path.basename(j.path) : '', playable: canPlay(j), pos: progOf(user, j.id).pos || 0, dur: progOf(user, j.id).dur || 0, watched: !!progOf(user, j.id).watched,
    mb: (j.parts || []).reduce((s, p) => { try { return s + fs.statSync(p).size; } catch (_) { return s; } }, 0) / 1048576 });

  // ---- recording library: remux a finished recording to seekable HLS (stream copy) + per-user resume ----
  const PROG = path.join(dataDir, 'dvr_web_progress.json');
  let prog = {};
  try { prog = JSON.parse(fs.readFileSync(PROG, 'utf8')); } catch (_) {}
  const saveProg = () => { const t = PROG + '.tmp'; fs.writeFileSync(t, JSON.stringify(prog)); fs.renameSync(t, PROG); };
  const progOf = (user, id) => ((user && prog[String(user).toLowerCase()]) || {})[id] || {};
  const VOD = path.join(DIR, '.vod');
  const vodDir = (id) => path.join(VOD, id);
  const goodParts = (j) => (j.parts || [j.path]).filter((p) => { try { return p && fs.statSync(p).size > 200000; } catch (_) { return false; } });
  const canPlay = (j) => (j.status === 'done' || j.status === 'failed') && goodParts(j).length > 0;
  const vodReady = (id) => { try { return /#EXT-X-ENDLIST/.test(fs.readFileSync(path.join(vodDir(id), 'index.m3u8'), 'utf8')); } catch (_) { return false; } };
  const building = new Map();
  function buildVod(j) {
    if (building.has(j.id)) return;
    const dir = vodDir(j.id);
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.log('[dvr] vod dir', e.message); return; }
    const ps = goodParts(j);
    const input = ps.length > 1 ? 'concat:' + ps.join('|') : ps[0];
    const args = ['-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), path.join(dir, 'index.m3u8')];
    let child, err = '';
    try { child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
    catch (e) { console.log('[dvr] vod spawn failed', e.message); return; }
    building.set(j.id, child);
    child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    child.on('error', (e) => { console.log('[dvr] vod ffmpeg error', e.message); building.delete(j.id); });
    child.on('exit', () => { building.delete(j.id); if (err) console.log('[dvr] vod build', j.id, err.trim()); });
  }
  function pruneVod(keep) {   // keep the 5 most recently prepared copies; they duplicate the recording's bytes
    let dirs = [];
    try { dirs = fs.readdirSync(VOD).filter((d) => d !== keep && !building.has(d)); } catch (_) { return; }
    dirs = dirs.map((d) => { let t = 0; try { t = fs.statSync(path.join(VOD, d)).mtimeMs; } catch (_) {} return { d, t }; }).sort((a, b) => b.t - a.t);
    for (const x of dirs.slice(4)) { try { fs.rmSync(path.join(VOD, x.d), { recursive: true, force: true }); } catch (_) {} }
  }
  function dropVod(id) {
    const c = building.get(id); if (c) { try { c.kill(); } catch (_) {} building.delete(id); }
    try { fs.rmSync(vodDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch (_) {}
    let ch = false; for (const u of Object.keys(prog)) if (prog[u][id]) { delete prog[u][id]; ch = true; }
    if (ch) saveProg();
  }
  const isId = (s) => /^[a-f0-9]{8}$/.test(String(s));

  app.get('/dvr-watch.js', ...guard, (_req, res) => res.sendFile(path.join(publicDir, 'dvr-watch.js')));
  app.get('/dvr/watch/:id', ...guard, (req, res) => {
    if (!isId(req.params.id) || !jobs.some((x) => x.id === req.params.id)) return res.status(404).type('text/plain').send('not found');
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Recording</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><style>[hidden]{display:none!important}html,body{margin:0;height:100%;background:#000;color:#e8e8e8;font:15px system-ui}` +
      `#v{width:100%;height:100%;background:#000}#msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}</style></head>` +
      `<body><div id="msg">Loading...</div><video id="v" controls playsinline hidden></video><script src="/hls.min.js"></script><script src="/dvr-watch.js"></script></body></html>`);
  });
  app.post('/api/dvr/prepare', ...guard, jsonOnly, (req, res) => {
    const j = jobs.find((x) => x.id === String((req.body || {}).id || ''));
    if (!j || !canPlay(j)) return res.status(404).json({ error: 'not playable' });
    if (vodReady(j.id)) { try { const n = new Date(); fs.utimesSync(vodDir(j.id), n, n); } catch (_) {} }
    else buildVod(j);
    pruneVod(j.id);
    res.json({ state: vodReady(j.id) ? 'ready' : 'preparing' });
  });
  app.get('/api/dvr/vod-status/:id', ...guard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const id = req.params.id;
    res.json({ state: vodReady(id) ? 'ready' : building.has(id) ? 'preparing' : 'failed' });
  });
  app.get('/api/dvr/vod/:id/:file', ...guard, (req, res) => {
    const id = req.params.id, f = req.params.file;
    if (!isId(id) || !/^(index\.m3u8|seg_\d{5}\.ts)$/.test(f) || (f === 'index.m3u8' && !vodReady(id))) return res.status(404).type('text/plain').send('not ready');
    res.type(f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.sendFile(f, { root: vodDir(id) }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.post('/api/dvr/progress', ...guard, jsonOnly, (req, res) => {
    const b = req.body || {}, id = String(b.id || '');
    if (!jobs.some((x) => x.id === id)) return res.status(404).json({ error: 'not found' });
    const pos = Math.max(0, Number(b.pos) || 0), dur = Math.max(0, Number(b.dur) || 0);
    const u = String(req.user).toLowerCase();
    const prev = (prog[u] || {})[id] || {};
    (prog[u] = prog[u] || {})[id] = { pos: Math.floor(pos), dur: Math.floor(dur), watched: !!prev.watched || (dur > 0 && pos >= dur * 0.9), t: Date.now() };
    saveProg();
    res.json({ ok: true });
  });

  // anyone logged in may ask "am I admin?" so the UI knows whether to show buttons; nothing else is exposed
  app.get('/api/dvr/me', requireAuth, (req, res) => res.json({ admin: isAdmin(req.user) }));
  app.get('/dvr-ui.js', ...guard, (_req, res) => res.sendFile(path.join(publicDir, 'dvr-ui.js')));
  app.get('/api/dvr/jobs', ...guard, (req, res) => { res.set('Cache-Control', 'no-store'); res.json(jobs.map((j) => view(j, req.user))); });

  app.post('/api/dvr/record', ...guard, jsonOnly, (req, res) => {
    const b = req.body || {};
    const ch = getPlaylist().byId.get(String(b.channelId || ''));
    if (!ch) return res.status(404).json({ error: 'no such channel' });
    const now = Math.floor(Date.now() / 1000);
    let start = Number(b.start), end = Number(b.end);
    const recordNow = !Number.isFinite(start);
    if (recordNow) { start = now; end = now + Math.round(Math.max(1, Math.min(Number(b.minutes) || 60, MAX_SECONDS / 60)) * 60); }
    if (!Number.isFinite(end) || end <= start) return res.status(400).json({ error: 'bad times' });
    if (start > 1e11) start /= 1000; if (end > 1e11) end /= 1000;
    if (end - start > MAX_SECONDS) return res.status(400).json({ error: 'too long (max 6h)' });
    if (end + POST < now) return res.status(400).json({ error: 'already over' });
    const title = String(b.title || ch.name).slice(0, 120);
    const j = { id: crypto.randomBytes(4).toString('hex'), channelId: ch.id, channel: ch.name, title, start, end, status: 'scheduled', path: '', owner: req.user };
    jobs.push(j);
    if (recordNow) start_(j); else save();
    res.json(view(j));
  });
  const start_ = (j) => { start(j); };
  app.post('/api/dvr/stop', ...guard, jsonOnly, (req, res) => {
    const id = String((req.body || {}).id || '');
    const j = jobs.find((x) => x.id === id);
    if (!j) return res.status(404).json({ error: 'not found' });
    if (active.has(id)) finish(id);
    else if (j.status === 'scheduled' || j.status === 'missed') { jobs = jobs.filter((x) => x.id !== id); save(); }
    res.json({ ok: true });
  });
  app.post('/api/dvr/delete', ...guard, jsonOnly, (req, res) => {
    const id = String((req.body || {}).id || '');
    const j = jobs.find((x) => x.id === id);
    if (!j) return res.status(404).json({ error: 'not found' });
    if (active.has(id)) finish(id);
    for (const p of (j.parts || [j.path])) {
      // only ever delete inside the DVR folder
      if (p && path.dirname(path.resolve(p)) === path.resolve(DIR)) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    dropVod(id);
    jobs = jobs.filter((x) => x.id !== id); save();
    res.json({ ok: true });
  });
  console.log(`[dvr] enabled; admins: ${ADMINS.size ? [...ADMINS].join(',') : '(none - set ADMIN_USERS)'}; dir ${DIR}`);
  return { isAdmin };
}
module.exports = { mount, isAdmin };
