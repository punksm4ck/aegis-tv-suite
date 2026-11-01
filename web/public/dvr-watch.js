(function () {
  'use strict';
  var id = location.pathname.split('/').pop();
  var v = document.getElementById('v'), msg = document.getElementById('msg');
  var resumeAt = -1, hls = null, lastSent = 0;
  function say(t) { msg.hidden = false; msg.textContent = t; v.hidden = true; }
  function api(path, body) {
    return fetch(path, body === undefined ? { cache: 'no-store', credentials: 'same-origin' } :
      { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function send(force) {
    var d = v.duration, t = v.currentTime;
    if (!isFinite(d) || !(t > 0)) return;
    var now = Date.now();
    if (!force && now - lastSent < 9000) return;
    lastSent = now;
    try { fetch('/api/dvr/progress', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, pos: t, dur: d }) }); } catch (e) {}
  }
  function start() {
    var src = '/api/dvr/vod/' + id + '/index.m3u8';
    msg.hidden = true; v.hidden = false;
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ startPosition: resumeAt, xhrSetup: function (x) { x.withCredentials = true; } });
      hls.on(Hls.Events.ERROR, function (_e, d) { if (d.fatal) say('Playback error: ' + d.details); });
      hls.loadSource(src); hls.attachMedia(v);
    } else {
      v.src = src;
      if (resumeAt > 0) v.addEventListener('loadedmetadata', function () { v.currentTime = resumeAt; }, { once: true });
    }
    var p = v.play(); if (p && p.catch) p.catch(function () {});
  }
  function poll() {
    api('/api/dvr/vod-status/' + id).then(function (r) {
      if (r.state === 'ready') start();
      else if (r.state === 'failed') say('Could not prepare this recording for playback.');
      else setTimeout(poll, 1500);
    }).catch(function (e) { say('Error: ' + e.message); });
  }
  v.addEventListener('timeupdate', function () { send(false); });
  v.addEventListener('pause', function () { send(true); });
  v.addEventListener('ended', function () { send(true); });
  window.addEventListener('pagehide', function () { send(true); });
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || v.hidden) return;
    if (e.key === ' ') { if (v.paused) v.play(); else v.pause(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 60 : 10)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { v.currentTime = v.currentTime + (e.shiftKey ? 60 : 10); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen(); e.preventDefault(); }
  });
  api('/api/dvr/jobs').then(function (jobs) {
    var j = jobs.filter(function (x) { return x.id === id; })[0];
    if (!j) { say('Recording not found.'); return; }
    document.title = j.title;
    if (j.pos > 10 && (!j.dur || j.dur - j.pos > 30)) resumeAt = j.pos;
    return api('/api/dvr/prepare', { id: id }).then(function (r) {
      if (r.state === 'ready') start(); else { say('Preparing recording...'); setTimeout(poll, 1500); }
    });
  }).catch(function (e) { say('Error: ' + e.message); });
})();
