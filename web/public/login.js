(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  // ---------- sign in ----------
  var f = $('f'), u = $('u'), p = $('p'), err = $('err'), go = $('go');

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; });
    });
  }

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    go.disabled = true;
    postJson('/api/login', { username: u.value.trim(), password: p.value }).then(function (res) {
      if (res.ok) { location.href = '/'; return; }
      err.textContent = res.body.error || 'Something went wrong.';
      go.disabled = false;
    }).catch(function () {
      err.textContent = 'Network error. Try again.';
      go.disabled = false;
    });
  });

  // ---------- create user dialog ----------
  var openBtn = $('open'), dlg = $('dlg'), cf = $('cf');
  var cu = $('cu'), cp = $('cp'), cc = $('cc'), ci = $('ci');
  var uHint = $('uHint'), pHint = $('pHint'), cHint = $('cHint'), cerr = $('cerr');
  var createBtn = $('create'), cancel = $('cancel'), codeWrap = $('codeWrap');
  var codeRequired = false;
  var USER_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    if (!c.signup) return;
    codeRequired = !!c.codeRequired;
    codeWrap.style.display = codeRequired ? 'grid' : 'none';
    ci.required = codeRequired;
    openBtn.style.display = 'block';
  }).catch(function () {});

  function setHint(el, text, cls) { el.textContent = text; el.className = 'hint' + (cls ? ' ' + cls : ''); }

  function validate(showEmpty) {
    var good = true;
    if (cu.value && !USER_RE.test(cu.value)) { setHint(uHint, '3-32 letters, numbers, . _ -', 'bad'); good = false; }
    else if (cu.value) setHint(uHint, 'Looks good', 'ok');
    else { setHint(uHint, '3-32 letters, numbers, . _ -'); if (showEmpty) good = false; }

    if (cp.value && cp.value.length < 10) { setHint(pHint, 'At least 10 characters (' + cp.value.length + ' so far)', 'bad'); good = false; }
    else if (cp.value) setHint(pHint, 'Looks good', 'ok');
    else { setHint(pHint, 'At least 10 characters'); if (showEmpty) good = false; }

    if (cc.value && cc.value !== cp.value) { setHint(cHint, 'Passwords do not match', 'bad'); good = false; }
    else if (cc.value) setHint(cHint, 'Passwords match', 'ok');
    else { setHint(cHint, ''); if (showEmpty) good = false; }

    if (showEmpty && codeRequired && !ci.value.trim()) good = false;
    return good;
  }

  openBtn.addEventListener('click', function () {
    cf.reset();
    cerr.textContent = '';
    validate(false);
    createBtn.disabled = false;
    dlg.showModal();
    cu.focus();
  });
  cancel.addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); }); // click on backdrop
  [cu, cp, cc, ci].forEach(function (el) { el.addEventListener('input', function () { cerr.textContent = ''; validate(false); }); });

  cf.addEventListener('submit', function (e) {
    e.preventDefault();
    cerr.textContent = '';
    if (!validate(true)) { cerr.textContent = 'Fix the highlighted fields first.'; return; }
    createBtn.disabled = true;
    postJson('/api/register', { username: cu.value.trim(), password: cp.value, code: ci.value.trim() }).then(function (res) {
      if (res.ok) { location.href = '/'; return; }
      cerr.textContent = res.body.error || 'Could not create the account.';
      createBtn.disabled = false;
    }).catch(function () {
      cerr.textContent = 'Network error. Try again.';
      createBtn.disabled = false;
    });
  });
})();

/* PUNKSM4CK network nav */
;(function () {
  'use strict';
  var AUTOHIDE = false;   // true on the player (full-screen video), false on the login page
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