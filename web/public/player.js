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

  var tsbActive = false, tsbBad = {};
  function tsbSkip(id) { var t = tsbBad[id]; return !!t && Date.now() - t < 5 * 60 * 1000; }
  window.tvTsb = function () { return tsbActive; };
  function play(ch) {
    if (window.tvTsLeave) { try { window.tvTsLeave(); } catch (e) {} }
    currentId = ch.id;
    try { localStorage.setItem(LAST_KEY, ch.id); } catch (e) {}
    pushRecent(ch.id);
    teardown();
    say('Tuning ' + ch.name + '…', true);
    var useTsb = !!(window.Hls && Hls.isSupported()) && !tsbSkip(ch.id);
    tsbActive = useTsb;
    var src = useTsb ? '/tsb/' + ch.id + '/live.m3u8' : '/s/' + ch.id;

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        maxBufferLength: useTsb ? 60 : 600,
        maxMaxBufferLength: useTsb ? 90 : 600,
        maxBufferSize: (useTsb ? 120 : 300) * 1000 * 1000,
        backBufferLength: useTsb ? 120 : 600,
        liveBackBufferLength: useTsb ? 120 : 600,
        manifestLoadingMaxRetry: useTsb ? 0 : 2,
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
      if (useTsb) hls.once(Hls.Events.LEVEL_LOADED, function (_e, data) { if (window.tvTsArrive) window.tvTsArrive(ch.id, data && data.details); });
      hls.on(Hls.Events.ERROR, function (_e, d) {
        if (d.fatal || /buffer|append|quota|parsing|discontinuity/i.test(d.details || '')) console.warn('[tv] hls', d.fatal ? 'FATAL' : 'warn', d.type, d.details);
        if (!d.fatal) return;
        if (d.response && d.response.code === 401) { location.href = '/login'; return; }
        if (useTsb && d.type === Hls.ErrorTypes.NETWORK_ERROR && /manifestLoad|levelLoad/.test(d.details || '')) {
          tsbBad[ch.id] = Date.now(); console.warn('[tv] server buffer unavailable (' + d.details + '), using the direct stream'); play(ch); return;
        }
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

  // ---- starred channels (normalized names; same keys as the Mac app) ----
  var STAR_KEY = 'tv_starred', starRaw = null, starMap = {};
  function normName(s) {
    s = String(s || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
    return s.replace(/\b(pluto|hd|channel)\b/g, ' ').replace(/[^a-z0-9]/g, '');
  }
  function starSet() {
    var raw = '';
    try { raw = localStorage.getItem(STAR_KEY) || ''; } catch (e) {}
    if (raw !== starRaw) {
      starRaw = raw; starMap = {};
      try {
        var a = JSON.parse(raw || '[]');
        if (Array.isArray(a)) a.forEach(function (k) { if (typeof k === 'string') starMap[k] = 1; });
      } catch (e) {}
    }
    return starMap;
  }
  function isStar(c) { return !!starSet()[normName(c.name)]; }
  function toggleStar(c) {
    var k = normName(c.name), m = starSet();
    if (!k) return false;
    var on = !m[k], keys = Object.keys(m);
    if (on) keys.push(k); else keys = keys.filter(function (x) { return x !== k; });
    try { localStorage.setItem(STAR_KEY, JSON.stringify(keys)); } catch (e) {} pushStars(keys);
    try { window.dispatchEvent(new CustomEvent('tv-starred')); } catch (e) {}
    return on;
  }
  window.tvIsStar = isStar;
  window.tvToggleStar = toggleStar;

  // ---- star sync with the server (server list is the source of truth after first sync) ----
  var starPushT = null, starDirty = false;
  function pushStars(keys) {
    starDirty = true;
    clearTimeout(starPushT);
    starPushT = setTimeout(function () {
      try {
        fetch('/api/stars', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: keys }) })
          .then(function () { starDirty = false; }, function () { starDirty = false; });
      } catch (e) { starDirty = false; }
    }, 400);
  }
  function pullStars() {
    if (starDirty) return;
    fetch('/api/stars', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || starDirty) return;
        var cur = Object.keys(starSet());
        if (!d.exists) { if (cur.length) pushStars(cur); return; }
        var a1 = JSON.stringify(cur.slice().sort()), a2 = JSON.stringify((d.keys || []).slice().sort());
        if (a1 === a2) return;
        try { localStorage.setItem(STAR_KEY, JSON.stringify(d.keys || [])); } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('tv-starred')); } catch (e) {}
      })
      .catch(function () {});
  }
  pullStars();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pullStars(); });

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
    if (!term) {
      var ss = starSet();
      var rec = recentChannels().filter(function (c) { return !ss[normName(c.name)]; });
      shown = channels.filter(function (c) { return ss[normName(c.name)]; }).concat(rec);
    } else {
      shown = channels.filter(function (c) {
        return c.name.toLowerCase().indexOf(term) !== -1 || c.group.toLowerCase().indexOf(term) !== -1;
      });
    }
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.textContent = '';
    shown.forEach(function (c, i) {
      var li = document.createElement('li');
      if (i === sel) li.className = 'sel';
      if (c.id === currentId) li.className += ' cur';
      li.dataset.i = i;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = (isStar(c) ? '★ ' : '') + c.name;
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
    if (picker.classList.contains('open')) {
      var li = e.target.closest ? e.target.closest('#list li') : null;
      if (li) {
        var sc = shown[parseInt(li.dataset.i, 10)];
        if (sc) { toggleStar(sc); renderList(); }
        return;
      }
      closePicker();
      return;
    }
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
  window.tvCurrentChan = function () { return channels.find(function (x) { return x.id === currentId; }) || null; };
  window.tvSay = say;
  window.tvOpenPicker = function () { openPicker(Math.max(12, window.innerWidth / 2 - 190), 80); };
  window.tvHls = function () { return hls; };
  window.tvPlay = function (ch) { return play(ch); };
  // ---- boot ----
  fetch('/api/channels?all=1', { credentials: 'same-origin' })
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
    '#vol svg.on{fill:#6d8cff;stroke:#6d8cff}#vol.hint .star{display:none}' +
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
  var starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = 'star';
  box.appendChild(starBtn);
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
    renderStar();
  }
  function apply() {
    try { video.volume = vol; } catch (e) {}
    video.muted = userMuted || !hasActivation();
    render();
  }
  function reveal() {
    box.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (hasActivation()) box.classList.remove('show'); }, 4000);
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

  var STAR_PATH = '<polygon points="12 2 15.1 8.6 22 9.6 17 14.5 18.2 21.5 12 18.2 5.8 21.5 7 14.5 2 9.6 8.9 8.6"/>';
  var starShown = null;
  function renderStar() {
    if (!starBtn) return;
    var c = window.tvCurrentChan && window.tvCurrentChan();
    var on = !!(c && window.tvIsStar && window.tvIsStar(c));
    if (starShown === on) return;
    starShown = on;
    starBtn.innerHTML = '<svg viewBox="0 0 24 24"' + (on ? ' class="on"' : '') + '>' + STAR_PATH + '</svg>';
    starBtn.setAttribute('aria-label', on ? 'Unstar channel' : 'Star channel');
    starBtn.title = on ? 'Unstar (B)' : 'Star channel (B)';
  }
  function starCurrent() {
    var c = window.tvCurrentChan && window.tvCurrentChan();
    if (!c || !window.tvToggleStar) return;
    var on = window.tvToggleStar(c);
    if (window.tvSay) window.tvSay((on ? 'Starred: ' : 'Unstarred: ') + c.name);
    renderStar(); reveal();
  }
  function togglePiP() {
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(function () {});
    } catch (e) {}
  }
  starBtn.addEventListener('click', starCurrent);
  window.addEventListener('tv-starred', renderStar);
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
    else if ((e.key === 'b' || e.key === 'B') && videoOnTop()) { starCurrent(); e.preventDefault(); }
    else if ((e.key === 'p' || e.key === 'P') && videoOnTop()) { togglePiP(); e.preventDefault(); }
    else if ((e.key === 'c' || e.key === 'C') && videoOnTop()) { if (window.tvOpenPicker) window.tvOpenPicker(); e.preventDefault(); }
    else if (e.key === '?' && videoOnTop()) { if (window.tvSay) window.tvSay('M mute · F fullscreen · Space pause · S +30s · L live · B star · P pip · C channels · G guide'); e.preventDefault(); }
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
    AUTOHIDE ? (":root{--pn-h:" + (NAV_H + 1) + "px}@media (max-width:640px){:root{--pn-h:" + (NAV_H_SM + 1) + "px}}" +
      "#g-ov,#ops-ov,#picker,video:not([style*='z-index']){transition:top .22s ease,height .22s ease}" +
      "html.pn-open #g-ov,html.pn-open #ops-ov,html.pn-open #picker{position:fixed!important;top:var(--pn-h)!important;right:0!important;bottom:0!important;left:0!important;height:auto!important;min-height:0!important;max-height:none!important}" +
      "html.pn-open video:not([style*='z-index']){top:var(--pn-h)!important;height:calc(100% - var(--pn-h))!important}") : "",
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
    function show() { nav.classList.add('pn-show'); document.documentElement.classList.add('pn-open'); clearTimeout(hideTimer); }
    function hideSoon(ms) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!hovering && !nav.contains(document.activeElement)) { nav.classList.remove('pn-show'); document.documentElement.classList.remove('pn-open'); } }, ms || 1200);
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
  var LIVE_TOL = 8;         // playing within this many seconds of live counts as LIVE (live sync jitters by about a segment)
  var SLACK = 10;           // buffer may trail the live edge by this much and still resume seamlessly
  var userPaused = false, pausedAt = 0, lastEnd = 0, lastGrowth = 0;
  var activeUntil = 0, tick = null, tsHover = false, SKIP_FWD = 30;

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
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    if (h) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
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

  // ---- server-side buffer: hls.js plays /tsb/<id>/live.m3u8, so the whole recorded window is seekable ----
  var tsbSaved = {};
  function dvrFrags(details) {
    if (details && details.fragments && details.fragments.length) return details.fragments;
    var h = window.tvHls && window.tvHls();
    if (!h || !(window.tvTsb && window.tvTsb())) return null;
    var i = h.currentLevel >= 0 ? h.currentLevel : (h.loadLevel >= 0 ? h.loadLevel : 0);
    var lv = h.levels && h.levels[i], d = lv && lv.details;
    return d && d.fragments && d.fragments.length ? d.fragments : null;
  }
  function dvrWin() {   // [oldest, newest] in media time, or null when not playing from the server buffer
    if (!(window.tvTsb && window.tvTsb())) return null;
    var f = dvrFrags(), l = f && f[f.length - 1];
    return f ? [f[0].start, l.start + l.duration] : null;
  }
  function fragAt(t) {
    var f = dvrFrags();
    if (!f) return null;
    for (var i = f.length - 1; i >= 0; i--) if (t >= f[i].start - 0.05) return f[i];
    return f[0];
  }
  // Leaving a channel while paused or rewound: remember the spot (last 5 channels).
  window.tvTsLeave = function () {
    var id = window.tvCurrent && window.tvCurrent();
    if (!id || !dvrWin()) return;
    var lt = liveTarget(), ct = video.currentTime || 0;
    if (!userPaused && !(isFinite(lt) && lt - ct > 15)) { delete tsbSaved[id]; return; }   // was watching live: come back live
    var fr = fragAt(ct);
    if (!fr) return;
    tsbSaved[id] = { sn: fr.sn, off: Math.max(0, ct - fr.start), paused: userPaused, at: Date.now() };
    Object.keys(tsbSaved).sort(function (a, b) { return tsbSaved[b].at - tsbSaved[a].at; }).slice(5).forEach(function (k) { delete tsbSaved[k]; });
  };
  // Back on a channel: return to the saved spot if it is still inside the recorded window.
  window.tvTsArrive = function (id, details) {
    var s = tsbSaved[id]; delete tsbSaved[id];
    if (!s) return;
    var f = dvrFrags(details), fr = null;
    if (f) for (var i = 0; i < f.length; i++) { if (f[i].sn === s.sn) { fr = f[i]; break; } }
    if (!fr) { note('Your place on this channel aged out of the buffer. Playing live.'); return; }
    try { video.currentTime = fr.start + s.off; } catch (e) {}
    if (s.paused) { userPaused = true; pausedAt = Date.now(); lastEnd = 0; lastGrowth = Date.now(); try { video.pause(); } catch (e) {} }
    note(s.paused ? 'Back where you paused.' : 'Back where you left off.');
    reveal();
  };

  // ---- UI ----
  var css = document.createElement('style');
  css.textContent =
    '#ts{position:fixed;right:16px;bottom:16px;z-index:5;display:flex;align-items:center;gap:10px;' +
    'padding:8px 12px;border-radius:12px;background:rgba(10,11,14,.78);color:#e8e8ea;' +
    'font:500 13px/1 ui-monospace,"SF Mono",Consolas,monospace;opacity:0;pointer-events:none;transition:opacity .25s;' +
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none}' +
    '#ts.show{opacity:1;pointer-events:auto}' +
    '#ts button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:40px;height:40px;' +
    'padding:0 12px;box-sizing:border-box;border-radius:8px;color:#e8e8ea}#ts button *{pointer-events:none}' +
    '#ts button:hover{background:#262a3a}#ts button:focus-visible{outline:2px solid #6d8cff}' +
    '#ts svg{width:18px;height:18px;fill:#e8e8ea;stroke:none}' +
    '#ts .txt{white-space:nowrap;min-width:30ch;color:#a9acb8;letter-spacing:.04em}#ts .dim{opacity:.4}' +
    '#ts.paused .txt{color:#ffd166}#ts.behind .txt{color:#6d8cff}' +
    '#ts .live{font-weight:700;letter-spacing:.08em;color:#ff5d5d}#ts .live[hidden]{display:none}' +
    '#ts .skip{font-weight:700;letter-spacing:.04em;color:#a9d1ff}#ts .skip[hidden]{display:none}' +
    '#ts .back{font-weight:700;letter-spacing:.04em;color:#a9d1ff}' +
    '#tsbar{position:fixed;left:16px;right:16px;bottom:84px;z-index:5;display:flex;align-items:center;gap:12px;' +
    'padding:10px 14px;border-radius:12px;background:rgba(10,11,14,.78);color:#a9acb8;' +
    'font:500 12px/1 ui-monospace,"SF Mono",Consolas,monospace;opacity:0;pointer-events:none;transition:opacity .25s;' +
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none;touch-action:none;cursor:pointer}' +
    '#tsbar.show{opacity:1;pointer-events:auto}' +
    '#tsbar *{pointer-events:none}' +
    '#tsbar .trk{position:relative;flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.14)}' +
    '#tsbar .bufs{position:absolute;top:0;right:0;bottom:0;left:0;border-radius:4px;overflow:hidden}' +
    '#tsbar .bufs i{position:absolute;top:0;bottom:0;background:rgba(255,255,255,.3)}' +
    '#tsbar .played{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:4px;background:#6d8cff}' +
    '#tsbar .thumb{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
    'background:#fff;box-shadow:0 0 0 3px rgba(109,140,255,.45);transition:transform .1s}' +
    '#tsbar.drag .thumb{transform:scale(1.4)}' +
    '#tsbar .tip{display:none;position:absolute;bottom:20px;transform:translateX(-50%);padding:5px 9px;border-radius:6px;' +
    'background:#16171b;border:1px solid #2b2d34;color:#fff;white-space:nowrap}' +
    '#tsbar.drag .tip{display:block}' +
    '#tsbar .hi{color:#ff5d5d;font-weight:700;letter-spacing:.08em}' +
    '@media(max-width:700px){#tsbar{bottom:128px}}' +
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
  skipBtn.setAttribute('aria-label', 'Skip ahead 1 minute');
  var backBtn = document.createElement('button');
  backBtn.type = 'button'; backBtn.className = 'back'; backBtn.textContent = '-30s';
  backBtn.setAttribute('aria-label', 'Rewind 30 seconds');
  box.appendChild(backBtn); box.appendChild(ppBtn); box.appendChild(txt); box.appendChild(skipBtn); box.appendChild(liveBtn);
  document.body.appendChild(box);

  var ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

  function render() {
    var ct = video.currentTime || 0;
    var lt = liveTarget();
    var behind = isFinite(lt) ? Math.max(0, lt - ct) : 0;
    if (behind <= LIVE_TOL && !userPaused) behind = 0;
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
    } else if (behind > 4 || inHist()) {
      label = (inHist() ? 'HISTORY -' : 'BEHIND LIVE -') + fmt(behind) + '   BUF ' + fmt(ahead);
    } else {
      label = 'LIVE';
    }
    var dw = dvrWin();
    if (dw) {
      var back = Math.max(0, ct - dw[0]);
      if (userPaused) label = 'PAUSED ' + fmt((Date.now() - pausedAt) / 1000) + '   BEHIND -' + fmt(behind) + '   REWIND ' + fmt(back);
      else if (behind > 4) label = 'BEHIND LIVE -' + fmt(behind) + '   REWIND ' + fmt(back);
      else label = 'LIVE   REWIND ' + fmt(back);
    }
    if (txt.textContent !== label) txt.textContent = label;
    var ppKey = userPaused ? 'play' : 'pause';
    if (ppKey !== ppShown) {
      ppShown = ppKey;
      ppBtn.innerHTML = userPaused ? ICON_PLAY : ICON_PAUSE;
      ppBtn.setAttribute('aria-label', userPaused ? 'Resume' : 'Pause');
    }
    var atLive = !userPaused && behind <= 4 && !inHist();
    liveBtn.classList.toggle('dim', atLive);
    skipBtn.classList.toggle('dim', atLive);
    box.classList.toggle('paused', userPaused);
    box.classList.toggle('behind', !userPaused && behind > 4);
    var showIt = Date.now() < activeUntil || dragging || tsHover;
    box.classList.toggle('show', showIt);
    renderBar(showIt);
  }
  function reveal() { activeUntil = Date.now() + 4000; render(); }

  // ---- actions ----
  function goLive() {
    if (inHist()) { exitHistory(); return; }
    var t = liveTarget();
    userPaused = false;
    if (isFinite(t) && dvrWin()) {
      try { video.currentTime = t; } catch (e) {}
      activeUntil = Date.now() + 6000;
      startPlayback();
      reveal();
      return;
    }
    if (isFinite(t)) {
      var before = bufSnapshot(), end = bufRange()[1];
      if (t > end - 1 && t - end <= GAP_OK) {
        // Live point is just past the buffered video: stay inside the buffer and let hls.js load up to live,
        // instead of jumping across a gap (jumping across a gap is when the player can drop what is buffered).
        try { video.currentTime = Math.max(video.currentTime, end - 1.5); } catch (e) {}
        chasePos = video.currentTime; chaseStart = Date.now();
        chaseLive(60);
      } else {
        try { video.currentTime = t; } catch (e) {}
      }
      setTimeout(function () { console.log('[tv] go live. buffered before:', before, ' after:', bufSnapshot()); }, 1500);
    }
    activeUntil = Date.now() + 6000;
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
    var dw = dvrWin();
    if (dw) {
      userPaused = false;
      if ((video.currentTime || 0) < dw[0] + 1) {
        note('Paused spot aged out of the buffer. Resumed from the oldest available.');
        try { video.currentTime = dw[0] + 2; } catch (e) {}
      }
      startPlayback(); reveal(); return;
    }
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
    var dw = dvrWin();
    if (dw) {
      var lt0 = liveTarget(), hi0 = isFinite(lt0) ? Math.max(lt0, dw[0] + 1) : dw[1];
      try { video.currentTime = Math.min(Math.max((video.currentTime || 0) + d, dw[0] + 0.5), hi0); } catch (e) {}
      reveal(); return;
    }
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
    var hi = dvrWin() && isFinite(lt) ? lt : bufRange()[1] - 1;
    if (hi <= ct + 0.5) { note('Nothing buffered ahead yet.'); reveal(); return; }
    var t = Math.min(ct + sec, hi);
    try { video.currentTime = t; } catch (e) {}
    if (t < ct + sec - 0.5) note('Skipped ' + Math.round(t - ct) + 's (all that is buffered).');
    reveal();
  }

  ppBtn.addEventListener('click', toggle);
  skipBtn.addEventListener('click', function () { skipAhead(SKIP_FWD); });
  liveBtn.addEventListener('click', goLive);
  backBtn.addEventListener('click', function () { skipBack(30); });

  // ---- go-live helpers ----
  var GAP_OK = 30, chaseTimer = null, chasePos = 0, chaseStart = 0, ppShown = null;
  function bufSnapshot() {
    var b = video.buffered, o = [];
    for (var i = 0; i < b.length; i++) o.push(b.start(i).toFixed(0) + '-' + b.end(i).toFixed(0));
    return '[' + o.join(' ') + '] at ' + (video.currentTime || 0).toFixed(0);
  }
  // Follow the live edge without jumping over a gap: wait until the buffer reaches live, then step to it.
  function chaseLive(tries) {
    clearTimeout(chaseTimer);
    if (userPaused || dragging || tries <= 0) return;
    var cur = video.currentTime, elapsed = (Date.now() - chaseStart) / 1000;
    if (cur < chasePos - 1.5 || cur > chasePos + elapsed + 3) return;   // viewer moved the playhead: stop chasing
    var lt = liveTarget();
    if (!isFinite(lt)) return;
    if (lt <= bufRange()[1] - 1) { try { video.currentTime = lt; } catch (e) {} return; }
    chaseTimer = setTimeout(function () { chaseLive(tries - 1); }, 500);
  }
  window.tvBuf = bufSnapshot;

  // Rewind by sec seconds, never before the start of what is buffered.
  function skipBack(sec) {
    if (video.readyState < 2) return;
    var ct = video.currentTime, dw = dvrWin(), lo = (dw ? dw[0] : bufRange()[0]) + 0.1;
    if (ct - lo <= 0.5) { note('At the start of the buffer.'); reveal(); return; }
    var t = Math.max(ct - sec, lo);
    try { video.currentTime = t; } catch (e) {}
    if (t > ct - sec + 0.5) note('Rewound ' + Math.round(ct - t) + 's (start of buffer).');
    reveal();
  }

  // ---- timeline: drag back through the buffered recording ----
  var dragging = false, dragT = 0, dragWasPlaying = false, lastSeekAt = 0;
  var bar = document.createElement('div');
  bar.id = 'tsbar';
  bar.setAttribute('aria-label', 'Timeshift timeline');
  bar.innerHTML = '<span class="lo"></span><div class="trk"><div class="bufs"></div><div class="played"></div><div class="thumb"></div><div class="tip"></div></div><span class="hi">LIVE</span>';
  document.body.appendChild(bar);
  var trk = bar.querySelector('.trk'), bufsEl = bar.querySelector('.bufs'), playedEl = bar.querySelector('.played'),
      thumbEl = bar.querySelector('.thumb'), tipEl = bar.querySelector('.tip'), loEl = bar.querySelector('.lo');

  // Window shown on the bar: oldest buffered second .. live edge.
  function barWindow() {
    var dw = dvrWin();
    if (dw) { var lt0 = liveTarget(), e0 = isFinite(lt0) ? lt0 : dw[1]; return e0 - dw[0] > 2 ? [dw[0], e0] : null; }
    var b = video.buffered, n = b.length;
    if (!n) return null;
    var s = b.start(0), e = b.end(n - 1), lt = liveTarget();
    if (isFinite(lt)) e = lt;   // right edge = what the player calls live, not the end of the buffer
    return e - s > 2 ? [s, e] : null;
  }
  function clampBuffered(t) {
    var dw = dvrWin();
    if (dw) { var hi0 = liveTarget(); return Math.max(dw[0] + 0.1, Math.min(t, isFinite(hi0) ? hi0 : dw[1])); }
    var b = video.buffered, best = t, bd = Infinity;
    for (var i = 0; i < b.length; i++) {
      var a = b.start(i) + 0.1, z = b.end(i) - 1;
      if (z < a) continue;
      if (t >= a && t <= z) return t;
      var d = Math.min(Math.abs(t - a), Math.abs(t - z));
      if (d < bd) { bd = d; best = t < a ? a : z; }
    }
    return best;
  }
  function timeAt(clientX) {
    var w = barWindow();
    if (!w) return null;
    var r = trk.getBoundingClientRect();
    var f = r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    return w[0] + f * (w[1] - w[0]);
  }
  function renderBar(show) {
    var w = barWindow();
    bar.classList.toggle('show', !!show && !!w);
    if (!show || !w) return;
    var s = w[0], e = w[1], span = e - s, b = video.buffered, html = '';
    for (var i = 0; i < b.length; i++) {
      html += '<i style="left:' + (100 * (b.start(i) - s) / span) + '%;width:' + (100 * (b.end(i) - b.start(i)) / span) + '%"></i>';
    }
    if (dvrWin()) html = '<i style="left:0;width:100%"></i>';   // whole window is on the server
    bufsEl.innerHTML = html;
    var t = dragging ? dragT : video.currentTime;
    if (!dragging && !userPaused && e - t <= LIVE_TOL) t = e;   // playing at live: pin to the right end
    var f = Math.max(0, Math.min(1, (t - s) / span)) * 100;
    playedEl.style.width = f + '%';
    thumbEl.style.left = f + '%';
    tipEl.style.left = f + '%';
    tipEl.textContent = (e - t < 4) ? 'LIVE' : '-' + fmt(e - t);
    loEl.textContent = '-' + fmt(span);
  }
  function seekTo(t, force) {
    var now = Date.now();
    if (!force && now - lastSeekAt < 120) return;
    lastSeekAt = now;
    try { video.currentTime = clampBuffered(t); } catch (e) {}
  }
  bar.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var t = timeAt(e.clientX);
    if (t === null) return;
    dragging = true; dragT = t;
    dragWasPlaying = !userPaused && !video.paused;
    if (dragWasPlaying) video.pause();
    try { bar.setPointerCapture(e.pointerId); } catch (x) {}
    bar.classList.add('drag');
    seekTo(t, true);
    render();
    e.preventDefault();
  });
  bar.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var t = timeAt(e.clientX);
    if (t === null) return;
    dragT = t;
    seekTo(t, false);
    renderBar(true);
  });
  function endDrag(e, cancel) {
    if (!dragging) return;
    var t = cancel ? dragT : timeAt(e.clientX);
    if (t === null) t = dragT;
    var w = barWindow();
    dragging = false;
    bar.classList.remove('drag');
    seekTo(t, true);
    if (dragWasPlaying) { if (w && t >= w[1] - 3) goLive(); else startPlayback(); }
    reveal();
  }
  bar.addEventListener('pointerup', function (e) { endDrag(e, false); });
  bar.addEventListener('pointercancel', function (e) { endDrag(e, true); });
  bar.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
  ['timeupdate', 'progress', 'seeked'].forEach(function (t) {
    video.addEventListener(t, function () { if (!dragging) render(); });
  });

  // New channel / teardown: forget any pause.
  video.addEventListener('emptied', function () { userPaused = false; clearTimeout(chaseTimer); render(); });

  document.addEventListener('keydown', function (e) {
    if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    var isRange = tag === 'INPUT' && e.target.type === 'range';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (!(isRange && (e.key === ' ' || e.code === 'Space'))) return; }
    if (e.key === ' ' || e.code === 'Space') {
      if (tag === 'BUTTON' || isRange) { try { e.target.blur(); } catch (_) {} }
      toggle(); e.preventDefault();
    } else if (e.key === 'ArrowLeft') { if (e.shiftKey) skipBack(30); else skip(-SKIP); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { if (e.shiftKey) skipAhead(SKIP_FWD); else skip(SKIP); e.preventDefault(); }
    else if (e.key === 's' || e.key === 'S') { skipAhead(SKIP_FWD); e.preventDefault(); }
    else if (e.key === 'l' || e.key === 'L' || e.key === 'End') { goLive(); e.preventDefault(); }
  });
  ['mousemove', 'touchstart'].forEach(function (t) { document.addEventListener(t, reveal, { passive: true }); });

  // ---- watch history: rewind up to 15 min on this channel from the server-side ring ----
  function inHist() {
    var h = window.tvHls && window.tvHls();
    return !!(h && /\/h\/[\w-]+\/index\.m3u8/.test(h.url || ''));
  }
  function exitHistory() {
    var ch = window.tvCurrentChan && window.tvCurrentChan();
    if (ch && window.tvPlay) window.tvPlay(ch); else note('Reload the page to return to live.');
  }
  var histBtn = document.createElement('button');
  histBtn.type = 'button'; histBtn.className = 'hist'; histBtn.textContent = 'HISTORY';
  histBtn.setAttribute('aria-label', 'Rewind through up to 15 minutes of recorded history');
  box.insertBefore(histBtn, backBtn);
  css.textContent += '#ts .hist{font-weight:700;letter-spacing:.04em;color:#ffd166}';
  function enterHistory() {
    var id = window.tvCurrent && window.tvCurrent();
    var h = window.tvHls && window.tvHls();
    if (!id || !h) return;
    if (inHist()) { note('Already in history. GO LIVE returns.'); reveal(); return; }
    fetch('/api/history', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var c = d && d.channels && d.channels.filter(function (x) { return x.id === id; })[0];
        if (!c || c.seconds < 20) { note('No history recorded for this channel yet.'); reveal(); return; }
        userPaused = false;
        h.config.startPosition = 0;
        h.loadSource('/h/' + id + '/index.m3u8');
        note('History: ' + fmt(c.seconds) + ' recorded. GO LIVE returns.');
        reveal();
      })
      .catch(function () { note('History unavailable.'); reveal(); });
  }
  histBtn.addEventListener('click', enterHistory);
  [box, bar].forEach(function (el) {
    el.addEventListener('mouseenter', function () { tsHover = true; render(); });
    el.addEventListener('mouseleave', function () { tsHover = false; activeUntil = Date.now() + 1500; render(); });
  });
  tick = setInterval(render, 500);
  render();
  window.tvTimeshift = { pause: pause, resume: resume, goLive: goLive, skip: skip, skipAhead: skipAhead, toggle: toggle };
  window.tvSkip = function (sec) { if (sec < 0) skipBack(-sec); else skipAhead(sec || 30); };
})();
