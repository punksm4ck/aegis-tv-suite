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
    }
    if (dirty) save();
  }, 5000).unref();

  const view = (j) => ({ id: j.id, channelId: j.channelId, channel: j.channel, title: j.title, start: j.start, end: j.end,
    status: j.status, file: j.path ? path.basename(j.path) : '',
    mb: (j.parts || []).reduce((s, p) => { try { return s + fs.statSync(p).size; } catch (_) { return s; } }, 0) / 1048576 });

  // anyone logged in may ask "am I admin?" so the UI knows whether to show buttons; nothing else is exposed
  app.get('/api/dvr/me', requireAuth, (req, res) => res.json({ admin: isAdmin(req.user) }));
  app.get('/dvr-ui.js', ...guard, (_req, res) => res.sendFile(path.join(publicDir, 'dvr-ui.js')));
  app.get('/api/dvr/jobs', ...guard, (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(jobs.map(view)); });

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
    const j = { id: crypto.randomBytes(4).toString('hex'), channelId: ch.id, channel: ch.name, title, start, end, status: 'scheduled', path: '' };
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
    jobs = jobs.filter((x) => x.id !== id); save();
    res.json({ ok: true });
  });
  console.log(`[dvr] enabled; admins: ${ADMINS.size ? [...ADMINS].join(',') : '(none - set ADMIN_USERS)'}; dir ${DIR}`);
  return { isAdmin };
}
module.exports = { mount, isAdmin };
