// Admin-only DVR UI. Served only to admins (server-side check); injected into player.html.
(function () {
  'use strict';
  var cur = { id: null }, channels = {};
  // learn the current channel by watching the player's requests to /s/<id>
  var RE = /\/s\/([a-f0-9]{10})(?:[?#]|$)/;
  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { var x = RE.exec(String(u)); if (x) cur.id = x[1]; return xo.apply(this, arguments); };
  var of = window.fetch;
  if (of) window.fetch = function (u) { var x = RE.exec(String((u && u.url) || u)); if (x) cur.id = x[1]; return of.apply(this, arguments); };

  function api(path, body) {
    return fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function el(t, s, txt) { var e = document.createElement(t); if (s) e.style.cssText = s; if (txt) e.textContent = txt; return e; }
  var mmss = function (s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r; };
  var fmt = function (ts) { return new Date(ts * 1000).toLocaleString([], { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

  function init() {
    api('/api/channels').then(function (l) { l.forEach(function (c) { channels[c.id] = c; }); }).catch(function () {});
    var wrap = el('div', 'position:fixed;z-index:9999;touch-action:none;');
    var btn = el('button', 'background:#c0151b;color:#fff;border:0;border-radius:20px;padding:8px 14px;font:600 13px system-ui;cursor:grab;box-shadow:0 2px 8px #0008;touch-action:none;user-select:none;-webkit-user-select:none', '\u25CF REC');
    var panel = el('div', 'display:none;position:absolute;right:0;width:min(380px,94vw);max-height:70vh;overflow:auto;background:#15181d;color:#e8e8e8;border:1px solid #333;border-radius:10px;padding:10px;font:13px system-ui;cursor:default');
    wrap.appendChild(btn); wrap.appendChild(panel); document.body.appendChild(wrap);
    // position: remembered per device, default = right edge, mid-height (clear of the control bars)
    var KEY = 'dvr_btn_pos_v3';
    function clamp() {
      var w = wrap.offsetWidth || 80, h = wrap.offsetHeight || 34;
      var x = Math.min(Math.max(0, wrap.offsetLeft), Math.max(0, window.innerWidth - w));
      var y = Math.min(Math.max(0, wrap.offsetTop), Math.max(0, window.innerHeight - h));
      wrap.style.left = x + 'px'; wrap.style.top = y + 'px';
    }
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (pos && typeof pos.x === 'number') { wrap.style.left = pos.x + 'px'; wrap.style.top = pos.y + 'px'; }
    else { wrap.style.left = Math.max(0, window.innerWidth - (wrap.offsetWidth || 80) - 16) + 'px'; wrap.style.top = (window.innerWidth <= 640 ? 56 : 62) + 'px'; }
    clamp(); window.addEventListener('resize', clamp);
    var gb = document.getElementById('tvGuideBtn'), recHold = null;
    wrap.style.transition = 'opacity .25s';
    function recSet(on) {
      clearTimeout(recHold);
      if (!on && (drag || panel.style.display === 'block' || wrap.matches(':hover'))) { recHold = setTimeout(function () { recSet(gb.classList.contains('show')); }, 1000); return; }
      wrap.style.opacity = on ? '1' : '0'; wrap.style.pointerEvents = on ? 'auto' : 'none';
    }
    if (gb) {
      new MutationObserver(function () { recSet(gb.classList.contains('show')); }).observe(gb, { attributes: true, attributeFilter: ['class'] });
      recSet(gb.classList.contains('show'));
    }
    function placePanel() {
      var below = wrap.offsetTop < window.innerHeight / 2;
      panel.style.top = below ? '100%' : 'auto'; panel.style.bottom = below ? 'auto' : '100%';
      panel.style.marginTop = below ? '6px' : '0'; panel.style.marginBottom = below ? '0' : '6px';
      var left = wrap.offsetLeft + wrap.offsetWidth - panel.offsetWidth;   // keep panel on screen
      panel.style.right = left < 0 ? (left) + 'px' : '0';
    }
    var drag = null;
    btn.addEventListener('pointerdown', function (e) {
      drag = { sx: e.clientX, sy: e.clientY, ox: wrap.offsetLeft, oy: wrap.offsetTop, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch (x) {}
    });
    btn.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true; btn.style.cursor = 'grabbing';
      wrap.style.left = (drag.ox + dx) + 'px'; wrap.style.top = (drag.oy + dy) + 'px'; clamp();
    });
    btn.addEventListener('pointerup', function () {
      if (!drag) return;
      var moved = drag.moved; drag = null; btn.style.cursor = 'grab';
      if (moved) { try { localStorage.setItem(KEY, JSON.stringify({ x: wrap.offsetLeft, y: wrap.offsetTop })); } catch (e) {} return; }
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block') { placePanel(); render(); }
    });
    var list = el('div');
    function render() {
      api('/api/dvr/jobs').then(function (jobs) {
        list.textContent = '';
        if (!jobs.length) list.appendChild(el('div', 'opacity:.6;padding:6px', 'No recordings yet.'));
        jobs.slice().reverse().forEach(function (j) {
          var row = el('div', 'border-top:1px solid #2a2e35;padding:6px 0');
          row.appendChild(el('div', 'font-weight:600', j.title));
          row.appendChild(el('div', 'opacity:.7', j.channel + ' · ' + fmt(j.start) + ' · ' + j.status + (j.mb ? ' · ' + j.mb.toFixed(0) + ' MB' : '')));
          var b = el('div', 'margin-top:4px');
          var mk = function (label, path) { var x = el('button', 'margin-right:6px;background:#2a2e35;color:#eee;border:0;border-radius:6px;padding:3px 8px;cursor:pointer', label);
            x.onclick = function () { if (path === '/api/dvr/delete' && !confirm('Delete this recording and its file?')) return; api(path, { id: j.id }).then(render).catch(function (e) { alert(e.message); }); }; b.appendChild(x); };
          if (j.playable) { var pl = el('button', 'margin-right:6px;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:3px 8px;cursor:pointer', j.watched ? 'Play again' : (j.pos > 10 ? 'Resume ' + mmss(j.pos) : 'Play')); pl.onclick = function () { window.open('/dvr/watch/' + j.id, '_blank'); }; b.appendChild(pl); }
          if (j.status === 'recording') mk('Stop', '/api/dvr/stop');
          else if (j.status === 'scheduled' || j.status === 'missed') mk('Cancel', '/api/dvr/stop');
          if (j.status !== 'scheduled' && j.status !== 'recording') mk('Delete', '/api/dvr/delete');
          row.appendChild(b); list.appendChild(row);
        });
      }).catch(function (e) { list.textContent = 'Error: ' + e.message; });
    }
    var head = el('div', 'display:flex;gap:6px;align-items:center;margin-bottom:6px');
    var mins = el('select', 'background:#2a2e35;color:#eee;border:0;border-radius:6px;padding:4px');
    [30, 60, 90, 120, 180, 360].forEach(function (m) { var o = el('option', '', m + ' min'); o.value = m; if (m === 60) o.selected = true; mins.appendChild(o); });
    var rec = el('button', 'background:#c0151b;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:600', 'Record this channel');
    rec.onclick = function () {
      if (!cur.id) return alert('Start playing a channel first.');
      var c = channels[cur.id];
      api('/api/dvr/record', { channelId: cur.id, title: c ? c.name : 'Recording', minutes: Number(mins.value) }).then(render).catch(function (e) { alert(e.message); });
    };
    head.appendChild(rec); head.appendChild(mins); panel.appendChild(head); panel.appendChild(list);
    setInterval(function () { if (panel.style.display === 'block') render(); }, 10000);
    // for the guide: window.tvDvr.record({channelId, title, start, end}) with unix seconds (or ms)
    window.tvDvr = { record: function (o) { return api('/api/dvr/record', o).then(function (r) { if (panel.style.display === 'block') render(); return r; }); } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
