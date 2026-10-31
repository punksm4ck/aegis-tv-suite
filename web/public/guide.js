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
      [chans, guide] = await Promise.all([getJSON('/api/channels'), getJSON('/api/guide').catch(() => ({ channels: {} }))]);
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
    const sel = mk('select'); sel.append(new Option('All groups', ''));
    order.sort(function (x, y) { var i = TV_GUIDE_ORDER.indexOf(x), j = TV_GUIDE_ORDER.indexOf(y); return (i < 0 ? 999 : i) - (j < 0 ? 999 : j); });
    order.forEach(g => sel.append(new Option(g, g)));
    const x = mk('button', '', 'Close'); x.onclick = close;
    bar.append(mk('b', '', 'Guide'), mk('span', 'g-stamp', guide.generated ? 'Updated ' + fmt(guide.generated) : 'No guide data yet'), q, sel, x);
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
      let shown = 0;
      for (const g of order) {
        if (gsel && g !== gsel) continue;
        let header = null;
        groups[g].forEach((c, idx) => {
          const progs = ((guide.channels && guide.channels[c.id]) || []).filter(p => p.e > t0 && p.s < t1);
          if (term && !(c.name.toLowerCase().includes(term) || progs.some(p => p.t.toLowerCase().includes(term)))) return;
          if (!header) { header = mk('div', 'g-grp', g); grid.append(header); }
          const row = mk('div', 'g-row' + (c.id === cur ? ' cur' : '')), lab = mk('div', 'g-lab'), trk = mk('div', 'g-trk');
          lab.append(mk('i', '', c.chno || c.number || c.num || (idx + 1)), mk('span', '', c.name));
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
            b.onclick = () => tune(c); trk.append(b);
          }
          row.append(lab, trk); grid.append(row); shown++;
        });
      }
      const nl = mk('div'); nl.id = 'g-now'; nl.style.left = 190 + (now - t0) / 60 * PX + 'px'; grid.append(nl);
      if (!shown) body.append(mk('div', 'g-grp', 'No matches'));
    }
    q.oninput = render; sel.onchange = render; render();
    const cr = body.querySelector('.cur'); if (cr) cr.scrollIntoView({ block: 'center' });
  }

  function install() {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/guide.css'; document.head.append(l);
    const panel = document.getElementById('panel');
    if (panel) { const b = mk('button', 'g-open', 'Guide (G)'); b.onclick = e => { e.stopPropagation(); openGuide(); }; panel.prepend(b); }
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
