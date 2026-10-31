(function () {
  'use strict';
  var video = document.getElementById('v');
  var statusEl = document.getElementById('status');
  var picker = document.getElementById('picker');
  var panel = document.getElementById('panel');
  var q = document.getElementById('q');
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');

  var channels = [];
  var shown = [];
  var sel = 0;
  var currentId = null;
  var hls = null;
  var retryTimer = null;
  var statusTimer = null;
  var LAST_KEY = 'tv_last_channel';

  function say(msg, sticky) {
    statusEl.textContent = msg;
    statusEl.classList.add('show');
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { statusEl.classList.remove('show'); }, 3500);
  }
  function hideSay() { clearTimeout(statusTimer); statusEl.classList.remove('show'); }

  // ---- playback ----
  function teardown() {
    clearTimeout(retryTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.load();
  }

  function play(ch) {
    currentId = ch.id;
    try { localStorage.setItem(LAST_KEY, ch.id); } catch (e) {}
    pushRecent(ch.id);
    teardown();
    say('Tuning ' + ch.name + '…', true);
    var src = '/s/' + ch.id;

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        maxBufferLength: 600,
        maxMaxBufferLength: 600,
        maxBufferSize: 300 * 1000 * 1000,
        backBufferLength: 90,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
        xhrSetup: function (xhr) { xhr.withCredentials = true; }
      });
      var mediaRecoveries = 0;
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      });
      hls.on(Hls.Events.FRAG_BUFFERED, function () { if (currentId === ch.id) hideSay(); });
      hls.on(Hls.Events.ERROR, function (_e, d) {
        if (!d.fatal) return;
        if (d.response && d.response.code === 401) { location.href = '/login'; return; }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
          mediaRecoveries++; hls.recoverMediaError(); return;
        }
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details !== 'manifestLoadError') {
          say('Reconnecting…', true);
          retryTimer = setTimeout(function () { if (hls) hls.startLoad(); }, 2000);
          return;
        }
        say('“' + ch.name + '” is offline. Right-click to pick another channel.', true);
        teardown();
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS native HLS
      video.src = src;
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        var p = video.play(); if (p && p.catch) p.catch(function () {});
      });
      video.onerror = function () {
        say('“' + ch.name + '” is offline. Right-click to pick another channel.', true);
      };
      video.addEventListener('playing', function onPlaying() {
        video.removeEventListener('playing', onPlaying); hideSay();
      });
    } else {
      say('This browser cannot play live streams.', true);
    }
    renderList();
  }

  // (one-shot unmute handler removed: volume controls below manage mute/unmute)

  // ---- picker ----
  var RECENT_KEY = 'tv_recent_channels';
  function getRecent() {
    try { var a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function pushRecent(id) {
    try {
      var a = getRecent().filter(function (x) { return x !== id; });
      a.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 15)));
    } catch (e) {}
  }
  function recentChannels() {
    var out = [];
    getRecent().forEach(function (id) {
      var c = channels.find(function (x) { return x.id === id; });
      if (c) out.push(c);
    });
    return out;
  }
  function renderList() {
    var term = q.value.trim().toLowerCase();
    shown = !term ? recentChannels() : channels.filter(function (c) {
      return c.name.toLowerCase().indexOf(term) !== -1 || c.group.toLowerCase().indexOf(term) !== -1;
    });
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.textContent = '';
    shown.forEach(function (c, i) {
      var li = document.createElement('li');
      if (i === sel) li.className = 'sel';
      if (c.id === currentId) li.className += ' cur';
      li.dataset.i = i;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = c.name;
      var g = document.createElement('span'); g.className = 'g'; g.textContent = c.group.split(';')[0];
      li.appendChild(n); li.appendChild(g);
      list.appendChild(li);
    });
    empty.textContent = term ? 'No matching channels' : 'Nothing watched yet. Search by name or use the Guide.';
    empty.style.display = shown.length ? 'none' : 'block';
  }
  function scrollSel() {
    var el = list.children[sel];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  function setSel(i) {
    if (!shown.length) return;
    sel = Math.max(0, Math.min(shown.length - 1, i));
    for (var k = 0; k < list.children.length; k++) list.children[k].classList.toggle('sel', k === sel);
    scrollSel();
  }
  function openPicker(x, y) {
    var w = Math.min(380, window.innerWidth - 24);
    var h = Math.min(560, window.innerHeight - 24);
    var left = Math.max(12, Math.min(x, window.innerWidth - w - 12));
    var top = Math.max(12, Math.min(y, window.innerHeight - h - 12));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    q.value = '';
    sel = 0;
    renderList();
    picker.classList.add('open');
    picker.setAttribute('aria-hidden', 'false');
    q.focus();
    scrollSel();
  }
  function closePicker() {
    picker.classList.remove('open');
    picker.setAttribute('aria-hidden', 'true');
  }
  function choose(i) {
    var c = shown[i];
    if (!c) return;
    closePicker();
    play(c);
  }

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (picker.classList.contains('open')) { closePicker(); return; }
    openPicker(e.clientX, e.clientY);
  });
  picker.addEventListener('mousedown', function (e) {
    if (e.target === picker) closePicker();
  });
  list.addEventListener('click', function (e) {
    var li = e.target.closest('li');
    if (li) choose(parseInt(li.dataset.i, 10));
  });
  q.addEventListener('input', function () { sel = 0; renderList(); });
  document.addEventListener('keydown', function (e) {
    if (!picker.classList.contains('open')) return;
    if (e.key === 'Escape') { closePicker(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { setSel(sel + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setSel(sel - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(sel); e.preventDefault(); }
  });

  // Touch devices have no right-click: long-press opens the picker.
  var pressTimer = null, px = 0, py = 0;
  document.addEventListener('touchstart', function (e) {
    if (picker.classList.contains('open') || e.touches.length !== 1) return;
    px = e.touches[0].clientX; py = e.touches[0].clientY;
    pressTimer = setTimeout(function () { openPicker(px, py); }, 600);
  }, { passive: true });
  ['touchend', 'touchcancel', 'touchmove'].forEach(function (t) {
    document.addEventListener(t, function () { clearTimeout(pressTimer); }, { passive: true });
  });

  window.tvTune = function (id) { var c = channels.find(function (x) { return x.id === id; }); if (c) { closePicker(); play(c); } };
  window.tvCurrent = function () { return currentId; };
  window.tvHls = function () { return hls; };
  // ---- boot ----
  fetch('/api/channels', { credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
      return r.json();
    })
    .then(function (data) {
      channels = data;
      if (!channels.length) { say('No channels in the playlist.', true); return; }
      var last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
      var start = channels.find(function (c) { return c.id === last; }) || channels[0];
      play(start);
    })
    .catch(function (e) { if (e.message !== 'auth') say('Could not load channels.', true); });
})();

/* ---- volume / mute overlay ---- */
(function () {
  'use strict';
  var video = document.getElementById('v');
  var picker = document.getElementById('picker');
  if (!video) return;

  var VOL_KEY = 'tv_volume', MUTE_KEY = 'tv_muted';
  var vol = 1, userMuted = false, activated = false, hideTimer = null;

  try {
    var sv = parseFloat(localStorage.getItem(VOL_KEY));
    if (!isNaN(sv)) vol = Math.max(0, Math.min(1, sv));
    userMuted = localStorage.getItem(MUTE_KEY) === '1';
  } catch (e) {}

  function save() {
    try { localStorage.setItem(VOL_KEY, String(vol)); localStorage.setItem(MUTE_KEY, userMuted ? '1' : '0'); } catch (e) {}
  }
  function hasActivation() {
    return activated || (navigator.userActivation && navigator.userActivation.hasBeenActive);
  }
  function pickerOpen() { return picker && picker.classList.contains('open'); }
  // True only when the bare video is what the viewer is looking at (no guide/picker on top).
  function videoOnTop() {
    var el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el === video;
  }

  // ---- UI ----
  var css = document.createElement('style');
  css.textContent =
    '#vol{position:fixed;left:16px;bottom:16px;z-index:5;display:flex;align-items:center;gap:10px;' +
    'padding:8px 12px;border-radius:12px;background:rgba(10,11,14,.78);color:#e8e8ea;' +
    'font:500 13px/1 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;opacity:0;transition:opacity .25s;' +
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none}' +
    '#vol.show,#vol:hover,#vol.hint{opacity:1}' +
    '#vol button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px}' +
    '#vol button:hover{background:#262a3a}#vol button:focus-visible{outline:2px solid #6d8cff}' +
    '#vol svg{width:20px;height:20px;fill:none;stroke:#e8e8ea;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#vol input{width:110px;accent-color:#6d8cff;cursor:pointer}' +
    '#vol .lbl{min-width:34px;text-align:right;color:#a9acb8;font-variant-numeric:tabular-nums}' +
    '#vol .tip{display:none;color:#fff}#vol.hint .tip{display:inline}#vol.hint input,#vol.hint .lbl{display:none}' +
    '@media(max-width:520px){#vol input{width:80px}}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.id = 'vol';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Volume');
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Mute');
  var tip = document.createElement('span'); tip.className = 'tip'; tip.textContent = 'Click for sound';
  var range = document.createElement('input');
  range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
  range.setAttribute('aria-label', 'Volume');
  var lbl = document.createElement('span'); lbl.className = 'lbl';
  box.appendChild(btn); box.appendChild(tip); box.appendChild(range); box.appendChild(lbl);
  document.body.appendChild(box);

  var ICON_ON = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  var ICON_OFF = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';

  function render() {
    var silent = userMuted || vol === 0 || (!hasActivation());
    btn.innerHTML = silent ? ICON_OFF : ICON_ON;
    btn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    range.value = String(Math.round((userMuted ? 0 : vol) * 100));
    lbl.textContent = Math.round((userMuted ? 0 : vol) * 100) + '%';
    box.classList.toggle('hint', !hasActivation());
  }
  function apply() {
    try { video.volume = vol; } catch (e) {}
    video.muted = userMuted || !hasActivation();
    render();
  }
  function reveal() {
    box.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (hasActivation()) box.classList.remove('show'); }, 3000);
  }
  function setVol(v) {
    vol = Math.max(0, Math.min(1, v));
    if (vol > 0) userMuted = false;
    activated = true; apply(); save(); reveal();
    var p = video.play(); if (p && p.catch) p.catch(function () {});
  }
  function toggleMute() {
    activated = true;
    userMuted = !userMuted;
    if (!userMuted && vol === 0) vol = 0.5;
    apply(); save(); reveal();
    var p = video.play(); if (p && p.catch) p.catch(function () {});
  }
  function toggleFullscreen() {
    var d = document;
    if (d.fullscreenElement) { d.exitFullscreen && d.exitFullscreen(); }
    else if (d.documentElement.requestFullscreen) { d.documentElement.requestFullscreen().catch(function () {}); }
  }

  btn.addEventListener('click', toggleMute);
  range.addEventListener('input', function () { setVol(parseInt(range.value, 10) / 100); });

  // Any real user gesture lifts the browser's autoplay block.
  function onGesture(e) {
    if (activated) return;
    if (e.type === 'keydown' && (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta')) return;
    activated = true;
    apply();
    var p = video.play(); if (p && p.catch) p.catch(function () {});
    reveal();
  }
  ['pointerdown', 'pointerup', 'mousedown', 'click', 'touchend', 'keydown'].forEach(function (t) {
    window.addEventListener(t, onGesture, true);
  });

  // Keep state correct across channel changes (teardown() reloads the element).
  ['loadedmetadata', 'loadeddata', 'playing'].forEach(function (t) {
    video.addEventListener(t, function () { if (hasActivation()) { video.volume = vol; video.muted = userMuted; } render(); });
  });
  // If something else flips muted/volume, mirror it so the UI never lies.
  video.addEventListener('volumechange', function () {
    if (hasActivation()) {
      if (!video.muted && video.volume !== vol) { vol = video.volume; save(); }
      if (video.muted !== userMuted && activated) { userMuted = video.muted; save(); }
    }
    render();
  });

  // Show on movement; keyboard + wheel shortcuts.
  ['mousemove', 'touchstart'].forEach(function (t) { document.addEventListener(t, reveal, { passive: true }); });
  document.addEventListener('wheel', function (e) {
    if (pickerOpen() || !videoOnTop()) return;
    setVol(vol + (e.deltaY < 0 ? 0.05 : -0.05));
  }, { passive: true });
  document.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (pickerOpen() || tag === 'INPUT' && t !== range || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') { toggleMute(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && videoOnTop()) { setVol(vol + 0.05); e.preventDefault(); }
    else if (e.key === 'ArrowDown' && videoOnTop()) { setVol(vol - 0.05); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); e.preventDefault(); }
  });
  video.addEventListener('dblclick', toggleFullscreen);

  apply();
  reveal();
})();

/* ---- PUNKSM4CK network nav (auto-hides over the video) ---- */
;(function () {
  'use strict';
  var AUTOHIDE = true;   // true on the player (full-screen video), false on the login page
  var NAV_H = 50, NAV_H_SM = 44, EDGE = 64;

  var TABS = [
    { label: "PUNKSM4CK.COM",    href: "https://punksm4ck.com/",        hosts: ["punksm4ck.com", "www.punksm4ck.com"] },
    { label: "PUNKSM4CK.ORG",    href: "https://punksm4ck.org/",        hosts: ["punksm4ck.org", "www.punksm4ck.org"] },
    { label: "PUNKSM4CK.STORE",  href: "https://punksm4ck.store/",      hosts: ["punksm4ck.store", "www.punksm4ck.store"] },
    { label: "PUNKSM4CK.ONLINE", href: "https://punksm4ck.online/",     hosts: ["punksm4ck.online", "www.punksm4ck.online", "users.punksm4ck.online"] },
    { label: "PUNKSM4CK TV",     href: "https://tv.punksm4ck.com/",     hosts: ["tv.punksm4ck.com"] },
    { label: "HEROES",           href: "https://punksm4ck.com/heroes/", hosts: [] }
  ];
  var host = location.hostname.toLowerCase();

  var CSS = [
    "#punks-nav{position:fixed!important;top:0!important;left:0!important;right:0!important;",
    "height:" + NAV_H + "px!important;z-index:2147483000!important;display:flex!important;align-items:stretch;",
    "background:#0d0f13!important;border-bottom:1px solid #1e222b;",
    "font-family:'Space Mono','JetBrains Mono',ui-monospace,Consolas,monospace;",
    "font-size:13px;letter-spacing:.14em;user-select:none;-webkit-user-select:none;overflow-x:auto;overflow-y:hidden;",
    "-webkit-overflow-scrolling:touch;scrollbar-width:none;box-shadow:0 4px 12px rgba(0,0,0,.5)}",
    "#punks-nav::-webkit-scrollbar{display:none}",
    "#punks-nav a{flex:1 0 auto;display:flex;align-items:center;justify-content:center;",
    "height:100%;padding:0 22px;color:#8a90a0;text-decoration:none;white-space:nowrap;",
    "border-bottom:2px solid transparent;transition:color .15s ease,background .15s ease,border-color .15s ease}",
    "#punks-nav a:hover{color:#d6dae3;background:#141821}",
    "#punks-nav a:focus-visible{outline:2px solid #4da3ff;outline-offset:-2px}",
    "#punks-nav a.pn-active{color:#4da3ff;background:#12161f;border-bottom-color:#4da3ff}",
    AUTOHIDE
      ? "#punks-nav{transform:translateY(-110%);transition:transform .22s ease}#punks-nav.pn-show{transform:translateY(0)}"
      : "body{padding-top:" + NAV_H + "px!important}",
    "@media (max-width:640px){#punks-nav{height:" + NAV_H_SM + "px!important}#punks-nav a{padding:0 14px;font-size:11px;letter-spacing:.1em}",
    AUTOHIDE ? "" : "body{padding-top:" + NAV_H_SM + "px!important}",
    "}"
  ].join("");

  function build() {
    if (document.getElementById('punks-nav')) return;
    var st = document.createElement('style'); st.id = 'punks-nav-style'; st.textContent = CSS; document.head.appendChild(st);
    var nav = document.createElement('nav'); nav.id = 'punks-nav'; nav.setAttribute('aria-label', 'PUNKSM4CK network');
    TABS.forEach(function (t) {
      var a = document.createElement('a'); a.href = t.href; a.textContent = t.label;
      if (t.hosts.indexOf(host) !== -1) { a.className = 'pn-active'; a.setAttribute('aria-current', 'page'); }
      nav.appendChild(a);
    });
    document.body.insertBefore(nav, document.body.firstChild);
    if (!AUTOHIDE) return;

    var hideTimer = null, hovering = false;
    function show() { nav.classList.add('pn-show'); clearTimeout(hideTimer); }
    function hideSoon(ms) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!hovering && !nav.contains(document.activeElement)) nav.classList.remove('pn-show'); }, ms || 1200);
    }
    nav.addEventListener('mouseenter', function () { hovering = true; show(); });
    nav.addEventListener('mouseleave', function () { hovering = false; hideSoon(900); });
    nav.addEventListener('focusin', show);
    nav.addEventListener('focusout', function () { hideSoon(900); });
    document.addEventListener('mousemove', function (e) {
      if (e.clientY <= EDGE) { show(); } else if (nav.classList.contains('pn-show')) { hideSoon(900); }
    }, { passive: true });
    document.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (t && t.clientY <= EDGE) { show(); hideSoon(3500); }
    }, { passive: true });
    document.addEventListener('mouseleave', function () { hideSoon(300); });
    // brief peek on load so people discover it
    show(); hideSoon(2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();

/* ---- timeshift: pause / rewind / GO LIVE (client-side HLS buffer) ---- */
(function () {
  'use strict';
  var video = document.getElementById('v');
  var picker = document.getElementById('picker');
  var statusEl = document.getElementById('status');
  if (!video) return;

  var SKIP = 10;            // seconds for left/right
  var SLACK = 10;           // buffer may trail the live edge by this much and still resume seamlessly
  var userPaused = false, pausedAt = 0, lastEnd = 0, lastGrowth = 0;
  var activeUntil = 0, tick = null;

  // Other overlays (volume, gestures, tuning) call video.play(); while the viewer has
  // paused on purpose those calls must not silently un-pause the picture.
  var nativePlay = video.play.bind(video);
  video.play = function () { return userPaused ? Promise.resolve() : nativePlay(); };
  function startPlayback() { var p = nativePlay(); if (p && p.catch) p.catch(function () {}); }

  function note(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.add('show');
    setTimeout(function () { statusEl.classList.remove('show'); }, 3500);
  }
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function seekEnd() {
    try { return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : NaN; } catch (e) { return NaN; }
  }
  function bufRange() {
    var t = video.currentTime, b = video.buffered;
    for (var i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.25 && t <= b.end(i) + 0.25) return [b.start(i), b.end(i)];
    }
    return [t, t];
  }
  // Where "live" is for this viewer: hls.js live sync point, else the seekable edge (Safari native).
  function liveTarget() {
    var h = window.tvHls && window.tvHls();
    if (h && typeof h.liveSyncPosition === 'number' && isFinite(h.liveSyncPosition)) return h.liveSyncPosition;
    return seekEnd();
  }
  function modalOpen() {
    return (picker && picker.classList.contains('open')) || !!document.getElementById('g-ov');
  }

  // ---- UI ----
  var css = document.createElement('style');
  css.textContent =
    '#ts{position:fixed;right:16px;bottom:16px;z-index:5;display:flex;align-items:center;gap:10px;' +
    'padding:8px 12px;border-radius:12px;background:rgba(10,11,14,.78);color:#e8e8ea;' +
    'font:500 13px/1 ui-monospace,"SF Mono",Consolas,monospace;opacity:0;pointer-events:none;transition:opacity .25s;' +
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none}' +
    '#ts.show{opacity:1;pointer-events:auto}' +
    '#ts button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:30px;height:30px;' +
    'padding:0 8px;box-sizing:border-box;border-radius:8px;color:#e8e8ea}' +
    '#ts button:hover{background:#262a3a}#ts button:focus-visible{outline:2px solid #6d8cff}' +
    '#ts svg{width:18px;height:18px;fill:#e8e8ea;stroke:none}' +
    '#ts .txt{white-space:nowrap;color:#a9acb8;letter-spacing:.04em}' +
    '#ts.paused .txt{color:#ffd166}#ts.behind .txt{color:#6d8cff}' +
    '#ts .live{font-weight:700;letter-spacing:.08em;color:#ff5d5d}#ts .live[hidden]{display:none}' +
    '#ts .skip{font-weight:700;letter-spacing:.04em;color:#a9d1ff}#ts .skip[hidden]{display:none}' +
    '@media(max-width:700px){#ts{right:auto;left:16px;bottom:64px;max-width:calc(100vw - 32px)}#ts .txt{white-space:normal}}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.id = 'ts';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Timeshift');
  var ppBtn = document.createElement('button');
  ppBtn.type = 'button';
  var txt = document.createElement('span'); txt.className = 'txt';
  var liveBtn = document.createElement('button');
  liveBtn.type = 'button'; liveBtn.className = 'live'; liveBtn.textContent = 'GO LIVE';
  liveBtn.setAttribute('aria-label', 'Go live');
  var skipBtn = document.createElement('button');
  skipBtn.type = 'button'; skipBtn.className = 'skip'; skipBtn.textContent = '+30s';
  skipBtn.setAttribute('aria-label', 'Skip ahead 30 seconds');
  box.appendChild(ppBtn); box.appendChild(txt); box.appendChild(skipBtn); box.appendChild(liveBtn);
  document.body.appendChild(box);

  var ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

  function render() {
    var ct = video.currentTime || 0;
    var lt = liveTarget();
    var behind = isFinite(lt) ? Math.max(0, lt - ct) : 0;
    var r = bufRange();
    var ahead = Math.max(0, r[1] - ct);
    var label;
    if (userPaused) {
      if (r[1] > lastEnd + 0.5) { lastEnd = r[1]; lastGrowth = Date.now(); }
      var elapsed = (Date.now() - pausedAt) / 1000;
      var saturated = Date.now() - lastGrowth > 15000;
      label = 'PAUSED ' + fmt(elapsed) + '   BUF ' + fmt(ahead);
      if (saturated && isFinite(lt)) {
        var left = r[1] - lt + SLACK;
        label += left > 0 ? '   LEFT ' + fmt(left) : '   BUFFER FULL - RESUME JUMPS TO LIVE';
      }
    } else if (behind > 4) {
      label = 'BEHIND LIVE -' + fmt(behind) + '   BUF ' + fmt(ahead);
    } else {
      label = 'LIVE';
    }
    txt.textContent = label;
    ppBtn.innerHTML = userPaused ? ICON_PLAY : ICON_PAUSE;
    ppBtn.setAttribute('aria-label', userPaused ? 'Resume' : 'Pause');
    liveBtn.hidden = !userPaused && behind <= 4;
    skipBtn.hidden = !userPaused && behind <= 4;
    box.classList.toggle('paused', userPaused);
    box.classList.toggle('behind', !userPaused && behind > 4);
    box.classList.toggle('show', userPaused || behind > 4 || Date.now() < activeUntil);
  }
  function reveal() { activeUntil = Date.now() + 3000; render(); }

  // ---- actions ----
  function goLive() {
    var t = liveTarget();
    userPaused = false;
    if (isFinite(t)) { try { video.currentTime = t; } catch (e) {} }
    startPlayback();
    reveal();
  }
  function pause() {
    if (userPaused || video.readyState < 2) return;
    userPaused = true;
    pausedAt = Date.now();
    lastEnd = bufRange()[1];
    lastGrowth = Date.now();
    video.pause();
    reveal();
  }
  function resume() {
    if (!userPaused) return;
    var lt = liveTarget(), end = bufRange()[1];
    userPaused = false;
    if (isFinite(lt) && lt - end > SLACK) {
      note('Pause buffer limit reached - jumped to live.');
      goLive();
      return;
    }
    startPlayback();
    reveal();
  }
  function toggle() { if (userPaused) resume(); else pause(); }
  function skip(d) {
    if (video.readyState < 2) return;
    var r = bufRange();
    var hi = r[1] - 1;
    if (hi <= r[0]) return;
    var t = Math.min(Math.max(video.currentTime + d, r[0] + 0.1), hi);
    try { video.currentTime = t; } catch (e) {}
    reveal();
  }

  // Skip ahead by sec seconds. Never past live: within reach of live it just goes live.
  function skipAhead(sec) {
    if (video.readyState < 2) return;
    var ct = video.currentTime, lt = liveTarget();
    if (isFinite(lt) && lt - ct <= sec + 1) {
      if (!userPaused && lt - ct <= 4) { note('Already live.'); reveal(); return; }
      goLive();
      return;
    }
    var hi = bufRange()[1] - 1;
    if (hi <= ct + 0.5) { note('Nothing buffered ahead yet.'); reveal(); return; }
    var t = Math.min(ct + sec, hi);
    try { video.currentTime = t; } catch (e) {}
    if (t < ct + sec - 0.5) note('Skipped ' + Math.round(t - ct) + 's (all that is buffered).');
    reveal();
  }

  ppBtn.addEventListener('click', toggle);
  skipBtn.addEventListener('click', function () { skipAhead(30); });
  liveBtn.addEventListener('click', goLive);

  // New channel / teardown: forget any pause.
  video.addEventListener('emptied', function () { userPaused = false; render(); });

  document.addEventListener('keydown', function (e) {
    if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === ' ' || e.code === 'Space') {
      if (tag === 'BUTTON') return;
      toggle(); e.preventDefault();
    } else if (e.key === 'ArrowLeft') { skip(-SKIP); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { if (e.shiftKey) skipAhead(30); else skip(SKIP); e.preventDefault(); }
    else if (e.key === 's' || e.key === 'S') { skipAhead(30); e.preventDefault(); }
    else if (e.key === 'l' || e.key === 'L' || e.key === 'End') { goLive(); e.preventDefault(); }
  });
  ['mousemove', 'touchstart'].forEach(function (t) { document.addEventListener(t, reveal, { passive: true }); });

  tick = setInterval(render, 500);
  render();
  window.tvTimeshift = { pause: pause, resume: resume, goLive: goLive, skip: skip, skipAhead: skipAhead, toggle: toggle };
  window.tvSkip = function (sec) { skipAhead(sec || 30); };
})();
