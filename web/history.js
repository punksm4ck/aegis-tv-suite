'use strict';
// Rolling watch history: the last N tuned channels keep recording as a 15-minute HLS ring on the host,
// so any of them can be rewound even after you switch away.
// Env: HISTORY_DISABLED=1, HISTORY_CHANNELS (5), HISTORY_MINUTES (15), HISTORY_IDLE_MIN (0 = never), AEGIS_HISTORY_DIR, FFMPEG
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const UA = 'VLC/3.0.20 LibVLC/3.0.20';
const MAX_CH = Math.max(1, parseInt(process.env.HISTORY_CHANNELS || '5', 10));
const MINUTES = Math.max(1, parseInt(process.env.HISTORY_MINUTES || '15', 10));
const IDLE_MS = Math.max(0, parseInt(process.env.HISTORY_IDLE_MIN || '0', 10)) * 60000;
const SEG = 6;
const LIST = Math.ceil((MINUTES * 60) / SEG);

function mount(app, { requireAuth, getPlaylist, dataDir }) {
  if (process.env.HISTORY_DISABLED === '1') { console.log('[history] disabled'); return null; }
  const ROOT = process.env.AEGIS_HISTORY_DIR || path.join(dataDir, 'history');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); }
  catch (e) { console.log('[history] dir unusable', e.message); return null; }
  const rings = new Map();   // channel id -> { id, dir, last, child, startedAt, fails, retry, stopping }
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

  function again(e) {
    if (rings.get(e.id) !== e || e.stopping || e.retry) return;
    e.fails = Date.now() - e.startedAt > 60000 ? 0 : e.fails + 1;
    e.retry = setTimeout(() => { e.retry = null; if (rings.get(e.id) === e && !e.stopping) launch(e); },
      Math.min(30000, 3000 * (e.fails + 1)));
  }

  function launch(e) {
    const ch = getPlaylist().byId.get(e.id);
    if (!ch) { drop(e.id); return; }
    const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', ch.ua || UA].concat(ch.ref ? ['-referer', ch.ref] : [], [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', ch.url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'hls',
      '-hls_time', String(SEG), '-hls_list_size', String(LIST), '-hls_delete_threshold', '3',
      '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
      '-hls_segment_filename', path.join(e.dir, 'seg_%d.ts'), path.join(e.dir, 'index.m3u8')]);
    e.startedAt = Date.now();
    let child, err = '';
    try { child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
    catch (x) { console.log('[history] spawn failed', x.message); again(e); return; }
    e.child = child;
    child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    child.on('error', (x) => { console.log('[history] ffmpeg error', x.message); again(e); });
    child.on('exit', () => { if (err && !e.stopping) console.log('[history] ffmpeg exited', e.id, err.trim()); again(e); });
  }

  function drop(id) {
    const e = rings.get(id);
    if (!e) return;
    e.stopping = true; clearTimeout(e.retry);
    try { e.child && e.child.kill(); } catch (_) {}
    rings.delete(id);
    setTimeout(() => { if (!rings.has(id)) { try { rm(e.dir); } catch (x) { console.log('[history] cleanup', x.message); } } }, 2000);
  }

  // Called whenever a channel is tuned.
  function touch(ch) {
    if (!ch || !/^[\w-]+$/.test(String(ch.id))) return;
    let e = rings.get(ch.id);
    if (e) { e.last = Date.now(); return; }
    while (rings.size >= MAX_CH) {
      let oldest = null;
      for (const x of rings.values()) if (!oldest || x.last < oldest.last) oldest = x;
      console.log('[history] evicting', oldest.id);
      drop(oldest.id);
    }
    const dir = path.join(ROOT, ch.id);
    try { rm(dir); fs.mkdirSync(dir, { recursive: true }); } catch (x) { console.log('[history] mkdir failed', x.message); return; }
    e = { id: ch.id, dir, last: Date.now(), child: null, startedAt: 0, fails: 0, retry: null, stopping: false };
    rings.set(ch.id, e);
    console.log('[history] recording', ch.id, '(' + rings.size + '/' + MAX_CH + ')');
    launch(e);
  }

  function seconds(e) {
    try {
      const t = fs.readFileSync(path.join(e.dir, 'index.m3u8'), 'utf8');
      let s = 0; for (const m of t.matchAll(/#EXTINF:([\d.]+)/g)) s += parseFloat(m[1]);
      return Math.round(s);
    } catch (_) { return 0; }
  }

  setInterval(() => {
    const now = Date.now();
    for (const e of [...rings.values()]) {
      if (IDLE_MS && now - e.last > IDLE_MS) { console.log('[history] idle, dropping', e.id); drop(e.id); continue; }
      if (!e.child || e.retry || now - e.startedAt < 90000) continue;
      let m = 0; try { m = fs.statSync(path.join(e.dir, 'index.m3u8')).mtimeMs; } catch (_) {}
      if (now - Math.max(m, e.startedAt) > 90000) { console.log('[history] stalled, restarting', e.id); try { e.child.kill(); } catch (_) {} }
    }
  }, 15000).unref();

  process.on('exit', () => { for (const e of rings.values()) { e.stopping = true; try { e.child && e.child.kill(); } catch (_) {} } });

  app.get('/api/history', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ minutes: MINUTES, channels: [...rings.values()].sort((a, b) => b.last - a.last)
      .map((e) => ({ id: e.id, seconds: seconds(e), restarting: !!e.retry })) });
  });
  app.get('/h/:id/:file', requireAuth, (req, res) => {
    const e = rings.get(req.params.id), f = req.params.file;
    if (!e || !/^(index\.m3u8|seg_\d+\.ts)$/.test(f)) return res.status(404).type('text/plain').send('no history');
    res.set('Cache-Control', 'no-store');
    res.type(f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.sendFile(f, { root: e.dir }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  console.log('[history] ready: last ' + MAX_CH + ' channels x ' + MINUTES + ' min in ' + ROOT);
  return { touch };
}
module.exports = { mount };
