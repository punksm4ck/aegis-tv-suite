'use strict';
/*
 * timeshift.js - server-side rolling HLS buffer for tv.punksm4ck.com
 *
 * Why: a browser can only hold about 150 MB of video per page (about 6 minutes of this stream), no
 * matter what the player asks for. So the server keeps the rolling copy on disk and the player
 * rewinds through it.
 *
 *   - Each channel you tune gets a background recorder: it follows the upstream live playlist,
 *     saves every segment to disk (data/tsbuf/) and serves it back as ONE long playlist at
 *     /tsb/<id>/live.m3u8. The player seeks anywhere in that playlist.
 *   - The last N channels watched (default 5) keep recording in the background, so you can flip
 *     away and still rewind to what you missed.
 *   - Window per channel: 30 minutes while several channels are being recorded; if only ONE channel
 *     is being recorded it can grow to 150 minutes (2.5 h). Total is capped at 150 channel-minutes.
 *   - It is a rolling buffer, not saved recordings: it is wiped on restart and after the site has
 *     been idle for a while.
 *
 * Needs Node 18+ (global fetch). No other dependencies. Env overrides (all optional):
 *   TSB_DISABLE=1  TSB_MAX_CH=5  TSB_MULTI_MIN=30  TSB_SOLO_MIN=150  TSB_IDLE_MIN=45
 *   TSB_MAX_GB=12  TSB_MAX_KBPS=6000
 *
 * Usage (server.js):
 *   const tsb = require('./timeshift')({ getUrl: (id) => { const c = channels.find(x => x.id === id); return c && c.url; } });
 *   tsb.mount(app, requireAuth);      // before the 404 handler
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const CT = { ts: 'video/mp2t', m4s: 'video/mp4', mp4: 'video/mp4', cmfv: 'video/mp4', m4a: 'audio/mp4', cmfa: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg' };
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function attrs(s) {
  const o = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

function parseMedia(text, base) {
  const out = { target: 6, seq: 0, ended: false, keyed: false, range: false, segs: [] };
  let disc = false, map = null, dur = 0;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line[0] === '#') {
      if (line.startsWith('#EXT-X-TARGETDURATION:')) out.target = parseFloat(line.slice(22)) || 6;
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.seq = parseInt(line.slice(22), 10) || 0;
      else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) { /* counted by us */ }
      else if (line.startsWith('#EXT-X-DISCONTINUITY')) disc = true;
      else if (line.startsWith('#EXT-X-ENDLIST')) out.ended = true;
      else if (line.startsWith('#EXT-X-KEY:')) { const a = attrs(line.slice(11)); if (a.METHOD && a.METHOD !== 'NONE') out.keyed = true; }
      else if (line.startsWith('#EXT-X-MAP:')) { const a = attrs(line.slice(11)); if (a.BYTERANGE) out.range = true; if (a.URI) map = new URL(a.URI, base).href; }
      else if (line.startsWith('#EXT-X-BYTERANGE:')) out.range = true;
      else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || 0;
      continue;
    }
    out.segs.push({ uri: new URL(line, base).href, dur: dur || out.target, disc, map });
    disc = false; dur = 0;
  }
  return out;
}

module.exports = function createTimeshift(options) {
  const o = Object.assign({
    dir: path.join(__dirname, 'data', 'tsbuf'),
    getUrl: () => null,                                   // channel id -> upstream playlist URL (master or media)
    enabled: process.env.TSB_DISABLE !== '1',
    maxChannels: Math.round(envNum('TSB_MAX_CH', 5)),
    multiSec: envNum('TSB_MULTI_MIN', 30) * 60,           // window per channel while several are recorded
    soloSec: envNum('TSB_SOLO_MIN', 150) * 60,            // window when only one channel is recorded
    idleStopSec: envNum('TSB_IDLE_MIN', 45) * 60,         // nobody watching for this long: stop and wipe everything
    maxBytes: envNum('TSB_MAX_GB', 12) * 1024 * 1024 * 1024,
    maxBps: envNum('TSB_MAX_KBPS', 6000) * 1000,          // pick the best variant at or under this bitrate
    graceSec: 90,                                         // keep trimmed segments on disk this long (in-flight requests)
    readyTimeoutMs: 15000,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    log: (...a) => console.log(...a),
  }, options || {});

  const chans = new Map();      // id -> recorder
  let mru = [];                 // recorded channel ids, most recently watched first
  let lastTouch = 0, trash = [], started = false, sweeper = null;

  // ---------------------------------------------------------------- upstream I/O
  async function getBuf(url, ms, max) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': o.userAgent, Accept: '*/*' }, signal: ac.signal, redirect: 'follow' }).catch((e) => { const c = e && e.cause; throw new Error((ac.signal.aborted ? 'timeout ' + ms + 'ms ' + (() => { try { return new URL(url).host; } catch (_) { return ''; } })() + ' ' : '') + e.message + (c ? ' [' + (c.code || c.message) + ']' : '')); });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > max) throw new Error('segment too large');
      return { buf: b, url: r.url || url };
    } finally { clearTimeout(t); }
  }
  async function getText(url) { const r = await getBuf(url, 30000, 5e6); return { text: r.buf.toString('utf8'), url: r.url }; }

  // master -> media playlist URL. Returns { url } or { unsupported: reason }
  function pickMedia(text, url) {
    if (!/#EXT-X-STREAM-INF/.test(text)) return { url };
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const vars = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i].slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j][0] === '#')) j++;
      if (j < lines.length) vars.push({ bw: parseInt(a.BANDWIDTH, 10) || 0, audio: a.AUDIO, uri: new URL(lines[j], url).href });
    }
    if (!vars.length) return { unsupported: 'no variants in master playlist' };
    vars.sort((x, y) => x.bw - y.bw);
    let best = vars[0];
    vars.forEach((v) => { if (v.bw <= o.maxBps) best = v; });
    if (best.audio) {
      const re = new RegExp('#EXT-X-MEDIA:[^\\n]*GROUP-ID="' + best.audio.replace(/[^\w-]/g, '') + '"[^\\n]*URI=', 'i');
      if (re.test(text)) return { unsupported: 'separate audio rendition (not supported)' };
    }
    return { url: best.uri };
  }

  // ---------------------------------------------------------------- recorder
  function newRec(id, url) {
    return {
      id, url, mediaUrl: null, dir: path.join(o.dir, id + '-' + Date.now()), running: false, timer: null, wake: null,
      segs: [], nextSeq: 1, cc: 0, lastUp: -1, forceDisc: false, segFail: new Map(), maps: new Map(), mapN: 0,
      target: 6, bytes: 0, ver: 0, gz: null, fail: 0, lastErr: '', lastOk: 0, unsupported: '', startedAt: Date.now(),
    };
  }
  const limitSec = () => (mru.length <= 1 ? o.soloSec : o.multiSec);
  const extOf = (u) => { const m = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(u).pathname + '?'); const e = m && m[1].toLowerCase(); return e && CT[e] ? e : 'ts'; };
  const trashFile = (rec, file) => trash.push({ p: path.join(rec.dir, file), at: Date.now() });

  async function writeAtomic(rec, name, buf) {
    await fsp.mkdir(rec.dir, { recursive: true });
    const p = path.join(rec.dir, name), tmp = p + '.part';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p);
  }

  function trim(rec) {
    const lim = limitSec();
    let total = rec.segs.reduce((a, s) => a + s.dur, 0);
    while (rec.segs.length > 1 && total - rec.segs[0].dur >= lim) {
      const s = rec.segs.shift();
      total -= s.dur; rec.bytes -= s.bytes; rec.ver++;
      trashFile(rec, s.file);
    }
  }
  function enforceDisk() {
    let sum = 0; chans.forEach((r) => { sum += r.bytes; });
    while (sum > o.maxBytes) {
      let big = null; chans.forEach((r) => { if (r.segs.length > 2 && (!big || r.bytes > big.bytes)) big = r; });
      if (!big) break;
      const s = big.segs.shift(); big.bytes -= s.bytes; sum -= s.bytes; big.ver++; trashFile(big, s.file);
    }
  }

  async function saveSeg(rec, s) {
    let mapFile = null;
    if (s.map) {
      mapFile = rec.maps.get(s.map);
      if (!mapFile) {
        const m = await getBuf(s.map, 15000, 20e6);
        mapFile = 'init' + (rec.mapN++) + '.mp4';
        await writeAtomic(rec, mapFile, m.buf);
        rec.maps.set(s.map, mapFile);
      }
    }
    const g = await getBuf(s.uri, 20000, 80e6);
    if (!rec.running) return;
    const seq = rec.nextSeq++, file = seq + '.' + extOf(s.uri);
    await writeAtomic(rec, file, g.buf);
    if (!rec.running) return;
    if (s.disc || rec.forceDisc) { rec.cc++; rec.forceDisc = false; }
    rec.segs.push({ seq, dur: s.dur, file, cc: rec.cc, map: mapFile, bytes: g.buf.length, at: Date.now() });
    rec.bytes += g.buf.length; rec.lastUp = s.up; rec.ver++;
    enforceSlots(); trim(rec); enforceDisk();
  }

  async function pollOnce(rec) {
    let first = null;
    if (!rec.mediaUrl) {
      const top = await getText(rec.url);
      const pick = pickMedia(top.text, top.url);
      if (pick.unsupported) return stopUnsupported(rec, pick.unsupported);
      rec.mediaUrl = pick.url;
      if (pick.url === top.url) first = top;
    }
    const got = first || await getText(rec.mediaUrl);
    const pl = parseMedia(got.text, got.url);
    if (pl.ended) return stopUnsupported(rec, 'playlist is not live (ENDLIST)');
    if (pl.keyed) return stopUnsupported(rec, 'encrypted stream (not supported)');
    if (pl.range) return stopUnsupported(rec, 'byte-range segments (not supported)');
    rec.target = pl.target;
    const all = pl.segs.map((s, i) => Object.assign(s, { up: pl.seq + i }));
    let fresh;
    if (rec.lastUp < 0) fresh = all;
    else if (all.length && all[all.length - 1].up < rec.lastUp) { fresh = all; rec.forceDisc = true; }   // upstream restarted its numbering
    else {
      fresh = all.filter((s) => s.up > rec.lastUp);
      if (fresh.length && fresh[0].up > rec.lastUp + 1) fresh[0].disc = true;                          // we missed some: mark a break
    }
    for (const s of fresh) {
      if (!rec.running) return;
      try { await saveSeg(rec, s); }
      catch (e) {
        rec.lastErr = String(e && e.message || e);
        const n = (rec.segFail.get(s.up) || 0) + 1;
        rec.segFail.set(s.up, n);
        if (n >= 3 || rec.lastErr === 'HTTP 404') { rec.lastUp = s.up; rec.forceDisc = true; rec.segFail.delete(s.up); continue; }   // give up on this one
        throw e;
      }
    }
  }
  function stopUnsupported(rec, why) {
    rec.unsupported = why; rec.running = false;
    o.log('[tsb]', rec.id, 'not buffered:', why);
  }

  async function runRec(rec) {
    while (rec.running) {
      let wait;
      try {
        await pollOnce(rec);
        rec.fail = 0; rec.lastOk = Date.now();
        wait = Math.max(800, Math.min(rec.target * 400, 3000));
      } catch (e) {
        rec.fail++; rec.lastErr = String(e && e.message || e);
        if (rec.fail === 1 || rec.fail % 20 === 0) o.log('[tsb]', rec.id, 'upstream error:', rec.lastErr);
        if (rec.fail >= 3) rec.mediaUrl = null;           // re-read the master (tokens may have expired)
        wait = Math.min(15000, 1500 * rec.fail);
      }
      if (!rec.running) break;
      await new Promise((res) => { rec.wake = res; rec.timer = setTimeout(res, wait); });
    }
  }
  function startRec(rec) {
    rec.running = true;
    o.log('[tsb]', rec.id, 'recording');
    runRec(rec).catch((e) => o.log('[tsb]', rec.id, 'recorder crashed:', e && e.message));
  }
  function stopRec(rec, wipe) {
    rec.running = false;
    clearTimeout(rec.timer); if (rec.wake) rec.wake();
    if (wipe) setTimeout(() => fsp.rm(rec.dir, { recursive: true, force: true }).catch(() => {}), 2000);
  }
  function enforceSlots() {         // only channels that already have video count against the limit
    const ready = mru.filter((id) => { const r = chans.get(id); return r && r.segs.length; });
    while (ready.length > o.maxChannels) drop(ready.pop());
  }
  function drop(id) {
    const r = chans.get(id);
    if (r) { stopRec(r, true); chans.delete(id); }
    mru = mru.filter((x) => x !== id);
  }

  // ---------------------------------------------------------------- policy
  function touch(id) {
    lastTouch = Date.now();
    let rec = chans.get(id);
    if (!rec) {
      const url = o.getUrl(id);
      if (!url) return null;
      rec = newRec(id, url);
      chans.set(id, rec);
    }
    mru = [id].concat(mru.filter((x) => x !== id));
    if (rec.segs.length) enforceSlots();                  // a new channel only takes a slot once it has video
    chans.forEach(trim);
    if (!rec.running && !rec.unsupported) startRec(rec);
    return rec;
  }

  function boot() {
    if (started) return;
    started = true;
    try { fs.rmSync(o.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(o.dir, { recursive: true });
    sweeper = setInterval(() => {
      const now = Date.now();
      trash = trash.filter((t) => { if (now - t.at < o.graceSec * 1000) return true; fsp.unlink(t.p).catch(() => {}); return false; });
      if (chans.size && now - lastTouch > o.idleStopSec * 1000) {
        o.log('[tsb] idle, clearing buffers');
        Array.from(chans.keys()).forEach(drop);
      }
    }, 5000);
    if (sweeper.unref) sweeper.unref();
  }

  // ---------------------------------------------------------------- playlist + HTTP
  function playlist(rec) {
    const segs = rec.segs, f = segs[0];
    let td = rec.target;
    segs.forEach((s) => { if (s.dur > td) td = s.dur; });
    const L = ['#EXTM3U', '#EXT-X-VERSION:' + (segs.some((s) => s.map) ? 7 : 3), '#EXT-X-TARGETDURATION:' + Math.ceil(td),
      '#EXT-X-MEDIA-SEQUENCE:' + f.seq, '#EXT-X-DISCONTINUITY-SEQUENCE:' + f.cc];
    let prevCc = f.cc, prevMap = null;
    segs.forEach((s, i) => {
      if (i > 0 && s.cc !== prevCc) L.push('#EXT-X-DISCONTINUITY');
      if (s.map && s.map !== prevMap) L.push('#EXT-X-MAP:URI="' + s.map + '"');
      L.push('#EXTINF:' + s.dur.toFixed(3) + ',', s.file);
      prevCc = s.cc; prevMap = s.map;
    });
    return L.join('\n') + '\n';
  }

  async function waitReady(rec) {
    const end = Date.now() + o.readyTimeoutMs;
    while (Date.now() < end && !rec.unsupported && rec.segs.length < 2) await sleepMs(150);
    return rec.segs.length >= 1 && !rec.unsupported;
  }

  function status() {
    const out = { enabled: o.enabled, limitMin: limitSec() / 60, order: mru.slice(), channels: [] };
    mru.forEach((id) => {
      const r = chans.get(id); if (!r) return;
      out.channels.push({ id, seconds: Math.round(r.segs.reduce((a, s) => a + s.dur, 0)), segments: r.segs.length, mb: Math.round(r.bytes / 1048576), live: r.running, lastOkAgoSec: r.lastOk ? Math.round((Date.now() - r.lastOk) / 1000) : null, error: r.unsupported || (r.fail ? r.lastErr : '') });
    });
    return out;
  }

  function mount(app, requireAuth) {
    if (!o.enabled) { o.log('[tsb] disabled'); return; }
    boot();
    const okId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
    app.get('/api/tsb', requireAuth, (_req, res) => res.json(status()));
    app.get('/tsb/:id/live.m3u8', requireAuth, async (req, res) => {
      try {
        if (!okId(req.params.id)) return res.status(400).type('text/plain').send('bad id');
        const rec = touch(req.params.id);
        if (!rec) return res.status(404).type('text/plain').send('unknown channel');
        if (rec.unsupported) return res.status(501).type('text/plain').send(rec.unsupported);
        if (!(await waitReady(rec))) {
          const why = rec.unsupported;
          if (!why && !rec.segs.length) drop(rec.id);            // dead upstream: do not hold one of the recording slots
          return res.status(why ? 501 : 503).type('text/plain').send(why || 'buffer not ready');
        }
        res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.apple.mpegurl', Vary: 'Accept-Encoding' });
        const text = playlist(rec);
        if (text.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          if (!rec.gz || rec.gz.ver !== rec.ver) rec.gz = { ver: rec.ver, buf: zlib.gzipSync(text) };
          res.set('Content-Encoding', 'gzip');
          return res.send(rec.gz.buf);
        }
        res.send(text);
      } catch (e) { o.log('[tsb] playlist error', e && e.message); if (!res.headersSent) res.status(500).type('text/plain').send('error'); }
    });
    app.get('/tsb/:id/:file', requireAuth, (req, res) => {
      const rec = chans.get(req.params.id), f = req.params.file;
      if (!rec || !/^(?:\d{1,9}\.(?:ts|m4s|mp4|cmfv|m4a|cmfa|aac|mp3)|init\d{1,4}\.mp4)$/.test(f)) return res.status(404).type('text/plain').send('not found');
      lastTouch = Date.now();
      res.sendFile(path.join(rec.dir, f), {
        headers: { 'Content-Type': CT[f.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' },
        dotfiles: 'deny',
      }, (err) => { if (err && !res.headersSent) res.status(404).type('text/plain').send('gone'); });
    });
  }

  function stop() { if (sweeper) clearInterval(sweeper); Array.from(chans.keys()).forEach(drop); }

  return { mount, touch, status, stop, _playlist: playlist };
};
