// Click the video while it is paused to resume playback. Loaded for every logged-in user.
// Uses the player's own resume() so its paused/time-shift state stays in sync.
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO' || !v.paused) return;   // only clicks on the video itself, only while paused
    var ts = window.tvTimeshift;
    if (ts && typeof ts.resume === 'function') ts.resume();
  });
})();
