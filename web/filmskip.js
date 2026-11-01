// (web port) Skipping a film: hold Start (a controller's, or Enter) over one of
// the game's films -- the intros, the ones before and after a level -- and it
// ends. The game's half is twotowers/src/tt_filmskip.c (tt_web_film: the film
// playing, as a number the same on both machines; tt_web_film_skip ends it).
//
// Playing together, it is a vote: holding Start says you want to skip, your
// friend sees that on their screen, and once both have held it both games end
// the film. The vote goes to the other page through the match's server
// connection (netplay.js's ttNetSend), for its picture:
//   {type:"film-skip", film}   I want to skip this film
// and into this player's input records (tt_web_film_vote): a film played in
// frames, as the one before a level is, ends on the first frame both records
// say so, the same frame on both machines (tt_netplay.c). Films outside the
// lockstep (the intros) the pages end themselves once both have voted.
//
// While a film can be skipped, Start does not reach the game (it does nothing
// in a film), and after a skip not until it is let go: a Start still held
// would pause the level that follows.
(function () {
  const HOLD_MS = 900;
  const START = 0x0010, VK_RETURN = 13;
  const online = new URLSearchParams(location.search).has('match');

  const el = document.createElement('div');
  el.id = 'filmskip';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="trk" cx="18" cy="18" r="15"/>' +
                 '<circle class="arc" cx="18" cy="18" r="15"/></svg><span class="txt"></span><span class="peer"></span>';
  const css = document.createElement('style');
  css.textContent = `
  #filmskip { position: absolute; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px;
              padding: 8px 14px 8px 9px; border-radius: 999px; pointer-events: none; max-width: calc(100% - 36px);
              background: rgba(7,8,12,.72); border: 1px solid rgba(231,199,122,.28); backdrop-filter: blur(4px);
              font: 600 13px/1.25 system-ui, sans-serif; color: #e9e3d4; letter-spacing: .02em;
              opacity: 0; transform: translateY(6px); transition: opacity .3s ease, transform .3s ease; }
  #filmskip.on { opacity: 1; transform: none; }
  #filmskip svg { width: 26px; height: 26px; flex: none; transform: rotate(-90deg); }
  #filmskip circle { fill: none; stroke-width: 3.5; }
  #filmskip .trk { stroke: rgba(255,255,255,.14); }
  #filmskip .arc { stroke: #e7c77a; stroke-linecap: round; stroke-dasharray: 94.25; stroke-dashoffset: 94.25; }
  #filmskip kbd { font: 700 11px/1 system-ui, sans-serif; color: #07080c; background: #e7c77a; border-radius: 4px;
                  padding: 3px 5px; letter-spacing: .06em; }
  #filmskip .peer { display: none; padding-left: 10px; border-left: 1px solid rgba(231,199,122,.28); color: #a49d8c; }
  #filmskip .peer.yes { color: #fff3d1; }
  #filmskip.voted .arc { stroke: #fff3d1; }
  @media (prefers-reduced-motion: reduce) { #filmskip { transition: none; } }`;
  document.head.append(css);
  const mount = () => document.getElementById('stage')?.append(el);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  const arc = el.querySelector('.arc'), txt = el.querySelector('.txt'), peerEl = el.querySelector('.peer');

  // Start, as the page hands it to the game (index.html: ttPadFilter, ttKeyFilter)
  const padStart = new Map();   // controller -> Start down
  let keyStart = false, swallow = false;   // (swallow: Start kept from the game until it is let go)
  const startDown = () => keyStart || [...padStart.values()].some(Boolean);
  self.ttPadFilter = (k, buttons) => {
    padStart.set(k, !!(buttons & START));
    return film || swallow ? buttons & ~START : buttons;
  };
  self.ttKeyFilter = (vk, down) => {
    if (vk !== VK_RETURN) return false;
    keyStart = down;
    return !!(film || swallow);   // (true: not to the game)
  };

  // the vote
  let film = 0, since = 0, held = 0, mine = 0, skipped = 0, tries = 0;
  const theirs = new Set();   // the films the other player wants to skip (one may come before the film starts here)
  if (online) {
    const listen = (type, fn) => ((self.ttNetListeners ??= {})[type] ??= []).push(fn);
    listen('film-skip', (m) => { theirs.add(m.film >>> 0); });
    listen('peer-left', () => theirs.clear());
  }
  const log = (t) => (Module.printErr || console.log)('[FILMSKIP] ' + t);
  function skip() {
    if (skipped === film) return;
    // 1 ended; -1 a film played in frames, online: the game ends it on the frame both votes are in its input records
    const ok = Module._tt_web_film_skip(film);
    if (ok || ++tries > 20) {
      skipped = film; swallow = true;
      log(ok > 0 ? `film ${film.toString(16)} skipped` : ok < 0 ? `film ${film.toString(16)}: both voted, the game ends it` : `film ${film.toString(16)}: could not be skipped`);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!self.Module?.ttReady || !Module._tt_web_film) return;
    const f = Module._tt_web_film() >>> 0;
    if (f !== film) {   // a film began or ended
      if (film) theirs.delete(film);
      film = f; since = now; held = 0; mine = 0; tries = 0;
    }
    if (swallow && !startDown()) swallow = false;
    if (!film || skipped === film) { el.classList.remove('on'); return; }

    const down = startDown() && !swallow;
    if (mine !== film) {
      held = down ? held || now : 0;
      if (held && now - held >= HOLD_MS) {
        mine = film; held = 0;
        if (online) {   // (to the other page, for its picture; and into this player's input records, for the lockstep)
          Module._tt_web_film_vote?.(film);
          self.ttNetSend?.({ type: 'film-skip', film }); log(`voted to skip film ${film.toString(16)}`);
        }
      }
    }
    const peerWants = online && theirs.has(film);
    if (mine === film && (!online || peerWants)) skip();

    // the picture: the ring fills while Start is held; shown for a film's first seconds, while held, and while a vote is out
    const p = mine === film ? 1 : held ? Math.min(1, (now - held) / HOLD_MS) : 0;
    arc.style.strokeDashoffset = String(94.25 * (1 - p));
    el.classList.toggle('voted', mine === film);
    if (mine === film) txt.textContent = 'Waiting for your friend to hold START…';
    else txt.innerHTML = held ? (online ? 'Keep holding…' : 'Skipping…') : `Hold <kbd>START</kbd> to skip`;
    if (online) {
      peerEl.style.display = mine === film ? 'none' : 'inline';
      peerEl.classList.toggle('yes', peerWants);
      peerEl.textContent = peerWants ? 'Your friend wants to skip ✓' : 'Your friend: watching';
    }
    if (online && peerWants && mine !== film && !held) txt.innerHTML = `Hold <kbd>START</kbd> to agree`;
    el.classList.toggle('on', now - since < 5000 || !!held || mine === film || peerWants);
  }
  requestAnimationFrame(frame);
})();
