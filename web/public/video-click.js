// Click the video: paused -> resume, playing -> pause, with a brief centered icon. Loaded for every logged-in user.
// Uses the player's own pause()/resume() (window.tvTimeshift) so its paused/time-shift state stays in sync.
(function () {
  'use strict';
  var DELAY = 260, SHOW_MS = 2000, FADE_MS = 400;
  var timer = null, hideT = null, icon = null, firstDone = false;
  var SVG = {
    pause: '<svg width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="46" fill="rgba(0,0,0,.45)"/><rect x="32" y="28" width="12" height="40" rx="2" fill="#fff"/><rect x="52" y="28" width="12" height="40" rx="2" fill="#fff"/></svg>',
    play: '<svg width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="46" fill="rgba(0,0,0,.45)"/><polygon points="38,28 38,68 70,48" fill="#fff"/></svg>'
  };

  function show(kind) {
    if (!icon) {
      icon = document.createElement('div');
      icon.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9998;pointer-events:none;opacity:0;';
    }
    // in fullscreen only the fullscreen element's subtree is visible, so attach there
    var fs = document.fullscreenElement;
    var parent = fs && fs.tagName !== 'VIDEO' ? fs : document.body;
    if (icon.parentNode !== parent) parent.appendChild(icon);
    clearTimeout(hideT);
    icon.innerHTML = SVG[kind];
    icon.style.transition = 'none';
    icon.style.opacity = '0.9';
    void icon.offsetWidth;                                   // restart the transition
    hideT = setTimeout(function () {
      icon.style.transition = 'opacity ' + FADE_MS + 'ms ease';
      icon.style.opacity = '0';
    }, SHOW_MS - FADE_MS);
  }

  function act(v) {
    var ts = window.tvTimeshift;
    if (!ts) return;
    if (v.paused) { if (typeof ts.resume === 'function') { ts.resume(); show('play'); } }
    else if (typeof ts.pause === 'function') { ts.pause(); if (v.paused) show('pause'); }
  }

  document.addEventListener('click', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;                 // only clicks that land on the video itself
    if (e.detail > 1) { clearTimeout(timer); timer = null; return; }   // double-click = fullscreen, not pause
    var first = !firstDone; firstDone = true;
    if (first && v.muted) return;                            // first click on a muted page is the "click for sound" click
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; act(v); }, DELAY);
  });
})();
