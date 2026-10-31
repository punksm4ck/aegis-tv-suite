// Click the video while it is paused to resume playback. Loaded for every logged-in user.
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;   // only clicks that land on the video itself
    if (!v.paused) return;                     // playing: leave existing behaviour alone
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
  });
})();
