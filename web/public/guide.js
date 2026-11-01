window.tvStarEl = function (c, cb) { var s = document.createElement('span'); var on = !!(window.tvIsStar && window.tvIsStar(c)); s.className = 'gstar' + (on ? ' on' : ''); s.textContent = on ? '★' : '☆'; s.title = on ? 'Unstar' : 'Star'; s.onmousedown = function (e) { e.stopPropagation(); }; s.onclick = function (e) { e.preventDefault(); e.stopPropagation(); if (window.tvToggleStar) window.tvToggleStar(c); if (cb) cb(); }; return s; };
// Guide category order. Edit this list to reorder; unlisted categories go last.
var TV_GUIDE_ORDER = ['Kids', 'Comedy', 'Other', 'Entertainment', 'Movies', 'Series', 'Documentary', 'Sports', 'News', 'Music'];
(() => {
  'use strict';
  const PX = 4, HOURS = 72;
  const mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const fmt = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = ts => new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const getJSON = async u => {
    const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
    if (!r.ok) throw new Error(u + ' ' + r.status);
    return r.json();
  };
  let overlay = null;
  const close = () => { if (overlay) { overlay.remove(); overlay = null; } };

  async function openGuide() {
    if (overlay) return;
    const pk = document.getElementById('picker'); if (pk) pk.classList.remove('open');
    let chans, guide;
    try {
      var ALLM = !!window.tvAllMode;
      [chans, guide] = await Promise.all([getJSON(ALLM ? '/api/channels?all=1' : '/api/channels'), ALLM ? Promise.resolve({ channels: {}, generated: 0 }) : getJSON('/api/guide').catch(() => ({ channels: {} }))]);
    } catch (e) { return; }
    const order = [], groups = {};
    chans.forEach(c => {
      const g = String(c.group || 'Other').split(';')[0];
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(c);
    });
    const now = Math.floor(Date.now() / 1000), t0 = Math.floor(now / 1800) * 1800, t1 = t0 + HOURS * 3600;
    const cur = window.tvCurrent ? window.tvCurrent() : null;

    overlay = mk('div'); overlay.id = 'g-ov';
    overlay.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    const bar = mk('div'); bar.id = 'g-bar';
    const q = mk('input'); q.placeholder = 'Filter channel or show...';
    const sel = mk('select'); sel.append(new Option('All groups', '')); sel.append(new Option('★ Starred', '__starred__'));
    order.sort(function (x, y) { var i = TV_GUIDE_ORDER.indexOf(x), j = TV_GUIDE_ORDER.indexOf(y); return (i < 0 ? 999 : i) - (j < 0 ? 999 : j); });
    order.forEach(g => sel.append(new Option(g, g)));
    const x = mk('button', '', 'Close'); x.onclick = close;
    const tg = mk('button', '', ALLM ? 'All channels' : 'Favorites');
    tg.onclick = () => { window.tvAllMode = !window.tvAllMode; close(); openGuide(); };
    bar.append(mk('b', '', 'Guide'), mk('span', 'g-stamp', ALLM ? 'All channels (' + chans.length + ')' : (guide.generated ? 'Updated ' + fmt(guide.generated) : 'No guide data yet')), q, sel, tg, x);
    const body = mk('div'); body.id = 'g-body';
    overlay.append(bar, body); document.body.append(overlay);

    const tune = c => { if (window.tvTune) window.tvTune(c.id); close(); };

    function render() {
      body.textContent = '';
      const grid = mk('div', 'g-grid'); body.append(grid);
      const head = mk('div', 'g-row g-head'), hs = mk('div', 'g-trk');
      head.append(mk('div', 'g-lab', ''));
      for (let t = t0, i = 0; t < t1; t += 1800, i++) {
        const d = new Date(t * 1000);
        const k = mk('div', 'g-tick', d.getHours() === 0 && d.getMinutes() === 0 ? fmtDay(t) : fmt(t));
        k.style.left = i * 30 * PX + 'px'; hs.append(k);
      }
      head.append(hs); grid.append(head);
      const term = q.value.trim().toLowerCase(), gsel = sel.value;
      if (ALLM && !gsel) { grid.append(mk('div', 'g-grp', 'Pick a group above')); return; }
      let shown = 0;
      for (const g of order) {
        if (gsel && gsel !== '__starred__' && g !== gsel) continue;
        let header = null;
        groups[g].forEach((c, idx) => {
          const progs = ((guide.channels && guide.channels[c.id]) || []).filter(p => p.e > t0 && p.s < t1);
          if (term && !(c.name.toLowerCase().includes(term) || progs.some(p => p.t.toLowerCase().includes(term)))) return;
          if (gsel === '__starred__' && !(window.tvIsStar && window.tvIsStar(c))) return;
          if (!header) { header = mk('div', 'g-grp', g); grid.append(header); }
          const row = mk('div', 'g-row' + (c.id === cur ? ' cur' : '')), lab = mk('div', 'g-lab'), trk = mk('div', 'g-trk');
          const starOn = !!(window.tvIsStar && window.tvIsStar(c));
          lab.append(mk('i', '', c.chno || c.number || c.num || (idx + 1)), (function () { const n = mk('span', '', ''); n.append(window.tvStarEl(c, function () { render(); }), document.createTextNode(c.name)); return n; })());
          lab.title = 'Right-click to ' + (starOn ? 'unstar' : 'star');
          lab.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (window.tvToggleStar) window.tvToggleStar(c); render(); };
          lab.onclick = () => tune(c);
          if (!progs.length) {
            const p = mk('div', 'g-p none', 'No guide data'); p.style.left = '0'; p.style.width = HOURS * 60 * PX - 2 + 'px'; p.onclick = () => tune(c); trk.append(p);
          }
          for (const p of progs) {
            const s = Math.max(p.s, t0), e = Math.min(p.e, t1);
            const b = mk('div', 'g-p' + (p.s <= now && p.e > now ? ' now' : ''), p.t);
            b.append(mk('small', '', fmt(p.s) + ' - ' + fmt(p.e)));
            b.style.left = (s - t0) / 60 * PX + 'px'; b.style.width = Math.max((e - s) / 60 * PX - 2, 2) + 'px';
            b.title = p.t + '\n' + fmt(p.s) + ' - ' + fmt(p.e) + (p.c ? '  |  ' + p.c : '') + (p.d ? '\n\n' + p.d : '');
            if (window.tvRecCtx) window.tvRecCtx(b, c, p); b.onclick = () => tune(c); trk.append(b);
          }
          row.append(lab, trk); grid.append(row); shown++;
        });
      }
      const nl = mk('div'); nl.id = 'g-now'; nl.style.left = 190 + (now - t0) / 60 * PX + 'px'; grid.append(nl);
      if (!shown) body.append(mk('div', 'g-grp', 'No matches'));
    }
    const loaded = {};
    const need = () => {
      const gs = sel.value; if (!ALLM || !gs || loaded[gs]) return;
      loaded[gs] = 1;
      const raws = [...new Set((gs === '__starred__' ? chans.filter(c => window.tvIsStar && window.tvIsStar(c)) : (groups[gs] || [])).map(c => c.group))];
      Promise.all(raws.map(r => getJSON('/api/guide?all=1&group=' + encodeURIComponent(r)).catch(() => ({ channels: {} })))).then(rs => {
        rs.forEach(r => Object.assign(guide.channels, r.channels || {}));
        if (overlay) render();
      });
    };
    q.oninput = render; sel.onchange = () => { need(); render(); };
    const onStar = () => {
      if (!body.isConnected) { window.removeEventListener('tv-starred', onStar); return; }
      loaded['__starred__'] = 0; need(); render();
    };
    window.addEventListener('tv-starred', onStar);
    if (ALLM && order.length) sel.value = order[0];
    need(); render();
    const cr = body.querySelector('.cur'); if (cr) cr.scrollIntoView({ block: 'center' });
  }

  function install() {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/guide.css'; document.head.append(l);
    const panel = document.getElementById('panel');
    if (panel) { const b = mk('button', 'g-open', 'Guide (G)'); b.onclick = e => { e.stopPropagation(); (window.openOps || openGuide)(); }; panel.prepend(b); }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') return close();
      if (e.target.matches && e.target.matches('input,textarea,select')) return;
      if (e.key === 'g' || e.key === 'G') openGuide();
    });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', install) : install();
  window.openGuide = openGuide;
})();

// ---- top-left Guide button ----
(function () {
  var st = document.createElement('style');
  st.textContent =
    '#tvGuideBtn{position:fixed;top:calc(64px + env(safe-area-inset-top,0px));left:calc(12px + env(safe-area-inset-left,0px));' +
    'z-index:40;min-width:40px;height:40px;padding:0 14px;display:flex;align-items:center;gap:8px;box-sizing:border-box;' +
    'border:0;border-radius:8px;background:rgba(20,22,30,.78);color:#e8e8ea;cursor:pointer;' +
    'font:600 13px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;' +
    'opacity:0;pointer-events:none;transition:opacity .25s}' +
    '#tvGuideBtn.show{opacity:1;pointer-events:auto}' +
    '#tvGuideBtn:hover{background:rgba(40,44,60,.9)}' +
    '#tvGuideBtn *{pointer-events:none}';
  document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.id = 'tvGuideBtn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open guide');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="17" width="18" height="3" rx="1"/></svg><span>GUIDE</span>';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    btn.classList.remove('show');
    if (window.openGuide) window.openGuide();
  });
  document.body.appendChild(btn);

  // Guide counts as open when any of its own elements (class g-*, other than the launcher) is visible.
  function guideOpen() {
    var els = document.querySelectorAll('[class^="g-"]:not(.g-open)');
    for (var i = 0; i < els.length; i++) { if (els[i].offsetWidth > 0 && els[i].offsetHeight > 0) return true; }
    return false;
  }
  var hideT = null;
  function wake() {
    if (guideOpen()) { btn.classList.remove('show'); return; }
    btn.classList.add('show');
    clearTimeout(hideT);
    hideT = setTimeout(function () { btn.classList.remove('show'); }, 4000);
  }
  ['mousemove', 'touchstart', 'pointerdown', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, wake, { passive: true });
  });
  wake();
})();


// ---- AEGIS // TV-OPS style guide (opened from the picker's Guide button) ----
(() => {
  'use strict';
  const PX = 3.6, HOURS = 72, LAB = 200;
  const ORD = typeof TV_GUIDE_ORDER !== 'undefined' ? TV_GUIDE_ORDER : [];
  const mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const fmt = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = ts => new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const gkey = c => String(c.group || 'Other').split(';')[0];
  const getJSON = async u => {
    const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
    if (!r.ok) throw new Error(u + ' ' + r.status);
    return r.json();
  };
  const centerIn = (sc, el) => {
    if (!sc || !el) return;
    const a = sc.getBoundingClientRect(), b = el.getBoundingClientRect();
    sc.scrollTop += (b.top - a.top) - (a.height - b.height) / 2;
  };

  const css = document.createElement('style');
  css.textContent = [
    '#ops-ov{position:fixed;inset:0;z-index:1000;display:flex;background:#0b0c10;color:#e8e8ea;font:13px/1.35 ui-monospace,Menlo,Consolas,monospace;',
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);box-sizing:border-box}',
    '#ops-ov *{box-sizing:border-box}',
    '#ops-ov button,#ops-ov select{background:#16171b;color:#e8e8ea;border:1px solid #2b2d34;border-radius:8px;font:inherit;padding:0 14px;height:40px;cursor:pointer}',
    '#ops-ov button:hover{background:#20222b}',
    '#ops-left{width:clamp(260px,30vw,460px);flex:none;display:flex;flex-direction:column;border-right:1px solid #23252d;min-width:0}',
    '#ops-tools{display:flex;gap:8px;padding:10px;align-items:center;flex:none}',
    '#ops-q{flex:1;min-width:0;height:40px;padding:0 12px;border-radius:8px;border:1px solid #34363f;background:#0e0f12;color:#fff;font:inherit;outline:none}',
    '#ops-q:focus{border-color:#6d8cff}',
    '#ops-lh,.ops-lr{display:grid;grid-template-columns:minmax(0,1.5fr) 82px minmax(0,1fr);gap:8px;padding:0 12px}',
    '#ops-lh{color:#6d8cff;padding-top:8px;padding-bottom:8px;border-bottom:1px solid #23252d;flex:none}',
    '#ops-list{flex:1;min-height:0;overflow:auto}',
    '.ops-lr{height:30px;align-items:center;cursor:pointer}',
    '.ops-lr:hover{background:#1a1c24}',
    '.ops-lr.cur{background:#262a3a}',
    '.ops-lr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ops-lr .g{color:#9a9dab}',
    '.ops-empty{padding:18px;color:#8a8d98}',
    '#ops-right{flex:1;min-width:0;display:flex;flex-direction:column}',
    '#ops-air{display:flex;align-items:center;gap:12px;padding:0 12px;height:52px;flex:none;color:#6d8cff}',
    '#ops-airt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#ops-stage{flex:1;min-height:80px;background:#000;margin:0 12px}',
    '#ops-ctl{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;flex-wrap:wrap}',
    '#ops-vol{width:140px;accent-color:#6d8cff}',
    '#ops-guide{height:40%;min-height:150px;flex:none;border-top:1px solid #23252d;display:flex;flex-direction:column}',
    '#ops-gh{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;color:#6d8cff;flex:none}',
    '#ops-gs{flex:1;min-height:0;overflow:auto;position:relative}',
    '#ops-gi{position:relative}',
    '.ops-row{display:flex;height:44px}',
    '.ops-hrow{position:sticky;top:0;z-index:4;background:#0b0c10;height:32px}',
    '.ops-lab{position:sticky;left:0;z-index:3;width:' + LAB + 'px;flex:none;background:#0b0c10;border-right:1px solid #23252d;display:flex;align-items:center;gap:12px;padding:0 10px;cursor:pointer;overflow:hidden;white-space:nowrap}',
    '.ops-hrow .ops-lab{z-index:5;cursor:default}',
    '.ops-lab i{color:#ff5b5b;font-style:normal;font-weight:700;width:22px;flex:none}',
    '.ops-lab span{overflow:hidden;text-overflow:ellipsis}',
    '.ops-trk{position:relative;flex:none;width:' + (HOURS * 60 * PX) + 'px;height:100%}',
    '.ops-tick{position:absolute;top:0;padding:8px 6px;color:#9a9dab;border-left:1px solid #23252d;white-space:nowrap}',
    '.ops-grp{position:sticky;left:0;width:' + LAB + 'px;height:30px;line-height:30px;padding-left:12px;color:#ff5b5b;font-weight:700}',
    '.ops-p{position:absolute;top:3px;bottom:3px;line-height:36px;padding:0 8px;border-radius:6px;background:#161821;border:1px solid #23252d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
    '.ops-p.now{background:#262a3a}',
    '.ops-p.none{color:#6b6e7a}',
    '.ops-p:hover{background:#2c3043}',
    '.ops-row.cur .ops-lab{background:#262a3a}',
    '#ops-now{position:absolute;top:0;bottom:0;width:2px;background:#ff3b4a;z-index:2;pointer-events:none}',
    '@media (max-width:800px){#ops-left{display:none}}'
  ].join('');
  document.head.appendChild(css);

  let ov = null, cleanup = [];

  function closeOps() {
    if (!ov) return;
    cleanup.forEach(f => { try { f(); } catch (e) {} });
    cleanup = [];
    ov.remove(); ov = null;
  }

  async function openOps() {
    if (ov) return;
    const video = document.getElementById('v');
    if (!video) { if (window.openGuide) window.openGuide(); return; }
    const pk = document.getElementById('picker'); if (pk) pk.classList.remove('open');
    const TS = window.tvTimeshift || {};
    let chans = [], guide = { channels: {} }, order = [], groups = {}, now = 0, t0 = 0, t1 = 0, dt = null;
    let loadedG = {};
    function loadGroup(gs) {
      if (!gs || loadedG[gs]) return; loadedG[gs] = 1;
      const raws = [...new Set((gs === '__starred__' ? chans.filter(c => window.tvIsStar && window.tvIsStar(c)) : (groups[gs] || [])).map(c => c.group))];
      Promise.all(raws.map(r => getJSON('/api/guide?all=1&group=' + encodeURIComponent(r)).catch(() => ({ channels: {} })))).then(rs => {
        if (!ov) return;
        rs.forEach(r => Object.assign(guide.channels, r.channels || {}));
        renderList(); renderGrid(); refreshCur();
      });
    }

    ov = mk('div'); ov.id = 'ops-ov';
    ov.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });

    const left = mk('div'); left.id = 'ops-left';
    const tools = mk('div'); tools.id = 'ops-tools';
    const q = mk('input'); q.id = 'ops-q'; q.type = 'search'; q.placeholder = 'search channels (Ctrl+F)'; q.autocomplete = 'off'; q.spellcheck = false;
    const sel = mk('select');
    const refresh = mk('button', '', 'REFRESH');
    const tgl = mk('button', '', window.tvAllMode ? 'ALL CH' : 'FAVS'); tgl.title = 'Switch between favorites and all channels';
    tgl.onclick = () => { window.tvAllMode = !window.tvAllMode; tgl.textContent = window.tvAllMode ? 'ALL CH' : 'FAVS'; sel.value = ''; refresh.onclick(); };
    tools.append(q, sel, tgl, refresh);
    const lh = mk('div'); lh.id = 'ops-lh'; lh.append(mk('span', '', 'STATION'), mk('span', '', 'GROUP'), mk('span', '', 'NOW'));
    const list = mk('div'); list.id = 'ops-list';
    left.append(tools, lh, list);

    const right = mk('div'); right.id = 'ops-right';
    const air = mk('div'); air.id = 'ops-air';
    const airt = mk('span'); airt.id = 'ops-airt';
    const xb = mk('button', '', 'CLOSE (Esc)'); xb.onclick = closeOps;
    air.append(airt, xb);
    const stage = mk('div'); stage.id = 'ops-stage';
    const ctl = mk('div'); ctl.id = 'ops-ctl';
    const bPause = mk('button', '', 'PAUSE'), bLive = mk('button', '', 'GO LIVE'), bMute = mk('button', '', 'MUTE (F4)'), bFull = mk('button', '', 'FULLSCREEN');
    const vol = mk('input'); vol.id = 'ops-vol'; vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01;
    ctl.append(bPause, bLive, bMute, vol, bFull);
    const gwrap = mk('div'); gwrap.id = 'ops-guide';
    const gh = mk('div'); gh.id = 'ops-gh';
    const bNow = mk('button', '', 'NOW (F3)');
    gh.append(mk('span', '', 'PROGRAM GUIDE // 72H'), bNow);
    const gs = mk('div'); gs.id = 'ops-gs';
    const gi = mk('div'); gi.id = 'ops-gi'; gs.append(gi);
    gwrap.append(gh, gs);
    right.append(air, stage, ctl, gwrap);
    ov.append(left, right); document.body.append(ov);

    // Move the live video into the center pane (same element, so the stream keeps playing).
    const prevStyle = video.getAttribute('style');
    const place = () => {
      const r = stage.getBoundingClientRect(), s = video.style;
      s.position = 'fixed'; s.right = 'auto'; s.bottom = 'auto';
      s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px'; s.zIndex = '1001';
    };
    place();
    const ro = new ResizeObserver(place); ro.observe(stage);
    window.addEventListener('resize', place);
    cleanup.push(() => {
      ro.disconnect(); window.removeEventListener('resize', place);
      if (prevStyle == null) video.removeAttribute('style'); else video.setAttribute('style', prevStyle);
    });
    if (pk) {
      const mo = new MutationObserver(() => { if (pk.classList.contains('open')) pk.classList.remove('open'); });
      mo.observe(pk, { attributes: true, attributeFilter: ['class'] });
      cleanup.push(() => mo.disconnect());
    }

    const progsOf = c => (guide.channels && guide.channels[c.id]) || [];
    const curProg = c => progsOf(c).find(p => p.s <= now && p.e > now);
    const match = c => {
      const term = q.value.trim().toLowerCase();
      if (!term) return true;
      return String(c.name).toLowerCase().includes(term) || progsOf(c).some(p => String(p.t).toLowerCase().includes(term));
    };

    function refreshCur() {
      if (!ov) return;
      const id = window.tvCurrent ? window.tvCurrent() : null;
      ov.querySelectorAll('.cur').forEach(e => e.classList.remove('cur'));
      if (id != null) ov.querySelectorAll('[data-id]').forEach(e => { if (e.dataset.id === String(id)) e.classList.add('cur'); });
      const c = chans.find(x => String(x.id) === String(id));
      const p = c && curProg(c);
      airt.textContent = c ? 'ON AIR: ' + c.name + (p ? '  -  ' + p.t : '') : 'ON AIR: -';
    }
    const tune = c => {
      if (window.tvTune) window.tvTune(c.id);
      setTimeout(refreshCur, 150); setTimeout(refreshCur, 1200);
    };

    function computeGroups() {
      const keep = sel.value;
      order = []; groups = {};
      chans.forEach(c => { const g = gkey(c); if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(c); });
      order.sort((x, y) => { const i = ORD.indexOf(x), j = ORD.indexOf(y); return (i < 0 ? 999 : i) - (j < 0 ? 999 : j); });
      sel.textContent = ''; sel.append(new Option('ALL', '')); sel.append(new Option('★ STARRED', '__starred__'));
      order.forEach(g => sel.append(new Option(g, g)));
      if (keep && (groups[keep] || keep === '__starred__')) sel.value = keep; else if (window.tvAllMode && order.length) sel.value = order[0];
    }

    function renderList() {
      list.textContent = '';
      const gsel = sel.value; let n = 0;
      const frag = document.createDocumentFragment();
      order.forEach(g => {
        if (gsel && gsel !== '__starred__' && g !== gsel) return;
        groups[g].slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(c => {
          if (!match(c)) return;
          if (gsel === '__starred__' && !(window.tvIsStar && window.tvIsStar(c))) return;
          const p = curProg(c);
          const r = mk('div', 'ops-lr'); r.dataset.id = c.id;
          const starOn = !!(window.tvIsStar && window.tvIsStar(c));
          r.append((function () { const n = mk('span', 'n', ''); n.append(window.tvStarEl(c, function () { delete loadedG['__starred__']; rerender(); }), document.createTextNode(c.name)); return n; })(), mk('span', 'g', g), mk('span', 'w', p ? p.t : ''));
          r.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (window.tvToggleStar) window.tvToggleStar(c); delete loadedG['__starred__']; rerender(); };
          r.title = c.name + (p ? '\n' + p.t : '');
          r.onclick = () => tune(c);
          frag.append(r); n++;
        });
      });
      list.append(frag);
      if (!n) list.append(mk('div', 'ops-empty', chans.length ? 'No matching channels' : 'No channels'));
    }

    function renderGrid() {
      gi.textContent = '';
      gi.style.width = (LAB + HOURS * 60 * PX) + 'px';
      const head = mk('div', 'ops-row ops-hrow'), hs = mk('div', 'ops-trk');
      head.append(mk('div', 'ops-lab', ''));
      for (let t = t0, i = 0; t < t1; t += 1800, i++) {
        const d = new Date(t * 1000);
        const k = mk('div', 'ops-tick', d.getHours() === 0 && d.getMinutes() === 0 ? fmtDay(t) : fmt(t));
        k.style.left = (i * 30 * PX) + 'px'; hs.append(k);
      }
      head.append(hs); gi.append(head);
      const gsel = sel.value; let shown = 0;
      if (window.tvAllMode) { if (!gsel) { gi.append(mk('div', 'ops-empty', 'All channels: pick a group to load its guide')); return; } loadGroup(gsel); }
      order.forEach(g => {
        if (gsel && gsel !== '__starred__' && g !== gsel) return;
        const rows = groups[g].filter(c => progsOf(c).some(p => p.e > t0 && p.s < t1) && match(c) && (gsel !== '__starred__' || (window.tvIsStar && window.tvIsStar(c))));
        if (!rows.length) return;
        gi.append(mk('div', 'ops-grp', g.toUpperCase()));
        rows.forEach((c, idx) => {
          const row = mk('div', 'ops-row'), lab = mk('div', 'ops-lab'), trk = mk('div', 'ops-trk');
          row.dataset.id = c.id;
          const starOn = !!(window.tvIsStar && window.tvIsStar(c));
          lab.append(mk('i', '', String(idx + 1)), (function () { const n = mk('span', '', ''); n.append(window.tvStarEl(c, function () { delete loadedG['__starred__']; rerender(); }), document.createTextNode(c.name)); return n; })());
          lab.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); if (window.tvToggleStar) window.tvToggleStar(c); delete loadedG['__starred__']; rerender(); };
          lab.onclick = () => tune(c);
          progsOf(c).filter(p => p.e > t0 && p.s < t1).forEach(p => {
            const s = Math.max(p.s, t0), e = Math.min(p.e, t1);
            const b = mk('div', 'ops-p' + (p.s <= now && p.e > now ? ' now' : ''), p.t);
            b.style.left = ((s - t0) / 60 * PX) + 'px'; b.style.width = Math.max((e - s) / 60 * PX - 2, 2) + 'px';
            b.title = p.t + '\n' + fmt(p.s) + ' - ' + fmt(p.e) + (p.c ? '  |  ' + p.c : '') + (p.d ? '\n\n' + p.d : '');
            if (window.tvRecCtx) window.tvRecCtx(b, c, p); b.onclick = () => tune(c); trk.append(b);
          });
          row.append(lab, trk); gi.append(row); shown++;
        });
      });
      if (!shown) gi.append(mk('div', 'ops-empty', 'No guide data' + (q.value.trim() ? ' for this search' : '')));
      const nl = mk('div'); nl.id = 'ops-now'; nl.style.left = (LAB + (now - t0) / 60 * PX) + 'px'; gi.append(nl);
    }

    const scrollNow = () => {
      const n = Date.now() / 1000;
      gs.scrollLeft = Math.max(0, (n - t0) / 60 * PX - 60);
    };

    async function load() {
      try {
        const r = await Promise.all([getJSON(window.tvAllMode ? '/api/channels?all=1' : '/api/channels'), window.tvAllMode ? Promise.resolve({ channels: {} }) : getJSON('/api/guide').catch(() => ({ channels: {} }))]);
        chans = Array.isArray(r[0]) ? r[0] : [];
        guide = r[1] && r[1].channels ? r[1] : { channels: {} };
        loadedG = {};
      } catch (e) {
        list.textContent = ''; list.append(mk('div', 'ops-empty', 'Could not load channels'));
        return;
      }
      now = Math.floor(Date.now() / 1000); t0 = Math.floor(now / 1800) * 1800; t1 = t0 + HOURS * 3600;
      computeGroups(); renderList(); renderGrid(); refreshCur();
    }

    const rerender = () => { clearTimeout(dt); dt = setTimeout(() => { renderList(); renderGrid(); refreshCur(); }, 120); };
    q.oninput = rerender; sel.onchange = rerender;
    refresh.onclick = () => { refresh.textContent = '...'; load().then(() => { refresh.textContent = 'REFRESH'; }); };
    bNow.onclick = scrollNow;

    const sync = () => {
      bPause.textContent = video.paused ? 'RESUME' : 'PAUSE';
      bMute.textContent = video.muted ? 'UNMUTE (F4)' : 'MUTE (F4)';
      vol.value = video.volume;
    };
    bPause.onclick = () => {
      if (video.paused) { if (TS.resume) TS.resume(); else video.play(); }
      else { if (TS.pause) TS.pause(); else video.pause(); }
      setTimeout(sync, 150);
    };
    bLive.onclick = () => { if (TS.goLive) TS.goLive(); };
    bMute.onclick = () => { video.muted = !video.muted; sync(); };
    vol.oninput = () => { video.volume = +vol.value; if (video.muted && +vol.value > 0) video.muted = false; };
    bFull.onclick = () => {
      const f = document.documentElement.requestFullscreen;
      if (f) { try { f.call(document.documentElement).catch(() => {}); } catch (e) {} }
      closeOps();
    };
    ['play', 'pause', 'volumechange'].forEach(ev => { video.addEventListener(ev, sync); cleanup.push(() => video.removeEventListener(ev, sync)); });
    ['loadstart', 'emptied', 'playing'].forEach(ev => {
      const f = () => setTimeout(refreshCur, 100);
      video.addEventListener(ev, f); cleanup.push(() => video.removeEventListener(ev, f));
    });
    const iv = setInterval(() => {
      const n = Date.now() / 1000, nl = document.getElementById('ops-now');
      if (nl) nl.style.left = (LAB + (n - t0) / 60 * PX) + 'px';
      now = Math.floor(n); refreshCur();
    }, 30000);
    cleanup.push(() => clearInterval(iv));
    cleanup.push(() => clearTimeout(dt));
    const onStar = () => { if (ov) { delete loadedG['__starred__']; rerender(); } };
    window.addEventListener('tv-starred', onStar);
    cleanup.push(() => window.removeEventListener('tv-starred', onStar));

    sync();
    await load();
    if (!ov) return;
    centerIn(list, list.querySelector('.cur'));
    centerIn(gs, gi.querySelector('.ops-row.cur'));
    scrollNow();
    q.focus();
  }

  document.addEventListener('keydown', e => {
    if (!ov) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOps(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); const q = document.getElementById('ops-q'); if (q) { q.focus(); q.select(); } return; }
    if (e.key === 'F3') { e.preventDefault(); const b = document.querySelector('#ops-gh button'); if (b) b.click(); return; }
    if (e.key === 'F4') { e.preventDefault(); const v = document.getElementById('v'); if (v) v.muted = !v.muted; return; }
    const inField = e.target && e.target.matches && e.target.matches('input,textarea,select');
    if (!inField && (e.key === 'g' || e.key === 'G')) e.stopPropagation();
  }, true);

  window.openOps = openOps;
})();

(function () {
  'use strict';
  var adminP = null, menu = null, toast = null, toastT = null;
  function isAdmin() {
    if (!adminP) adminP = fetch('/api/dvr/me', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { admin: false }; }).then(function (j) { return !!j.admin; }).catch(function () { return false; });
    return adminP;
  }
  function host() {
    var fs = document.fullscreenElement;
    return fs && fs.tagName !== 'VIDEO' ? fs : document.body;
  }
  function tm(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function say(msg, bad) {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483002;max-width:80vw;padding:10px 18px;border-radius:10px;color:#fff;font:500 14px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;pointer-events:none;opacity:0;transition:opacity .25s;text-align:center;';
    }
    var h = host();
    if (toast.parentNode !== h) h.appendChild(toast);
    toast.textContent = msg;
    toast.style.background = bad ? 'rgba(160,20,28,.96)' : 'rgba(20,24,34,.96)';
    toast.style.opacity = '1';
    clearTimeout(toastT);
    toastT = setTimeout(function () { toast.style.opacity = '0'; }, 4000);
  }
  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }
  function record(c, p) {
    var now = Math.floor(Date.now() / 1000), body = { channelId: c.id, title: p.t };
    if (p.s <= now) body.minutes = Math.max(1, Math.ceil((p.e - now) / 60));
    else { body.start = p.s; body.end = p.e; }
    fetch('/api/dvr/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function () { say(p.s <= now ? 'Recording now: ' + p.t : 'Scheduled: ' + p.t + ' at ' + tm(p.s)); })
      .catch(function (e) { say('Record failed: ' + e.message, true); });
  }
  function openMenu(x, y, c, p) {
    closeMenu();
    var ended = p.e <= Math.floor(Date.now() / 1000);
    menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;z-index:2147483001;min-width:220px;max-width:320px;background:#16171b;color:#e8e8ea;border:1px solid #2b2d34;border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.6);padding:6px;font:14px/1.35 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;';
    var item = document.createElement('div');
    item.style.cssText = 'padding:8px 10px;border-radius:7px;cursor:' + (ended ? 'default' : 'pointer') + ';opacity:' + (ended ? '.5' : '1') + ';';
    var a = document.createElement('div');
    a.style.cssText = 'font-weight:600;color:' + (ended ? '#8a8d98' : '#ff5a5f') + ';';
    a.textContent = ended ? 'Already ended' : '\u25CF Record this program';
    var b = document.createElement('div');
    b.style.cssText = 'font-size:12px;color:#8a8d98;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    b.textContent = p.t + ' \u00B7 ' + c.name + ' \u00B7 ' + tm(p.s) + ' - ' + tm(p.e);
    item.appendChild(a); item.appendChild(b);
    if (!ended) {
      item.onmouseenter = function () { item.style.background = '#262a3a'; };
      item.onmouseleave = function () { item.style.background = 'transparent'; };
      item.onclick = function (e) { e.stopPropagation(); closeMenu(); record(c, p); };
    }
    menu.appendChild(item);
    host().appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
  }
  document.addEventListener('mousedown', function (e) { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); }, true);
  document.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  window.tvRecCtx = function (el, c, p) {
    el.oncontextmenu = function (e) {
      e.preventDefault(); e.stopPropagation();
      var x = e.clientX, y = e.clientY;
      isAdmin().then(function (ok) { if (ok) openMenu(x, y, c, p); });
    };
  };
})();
