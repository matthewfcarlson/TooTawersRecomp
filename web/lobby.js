// (web port) Playing together, the splash's half: make a game and share its
// link, join one by its link or code, and come back to one (the recent games).
//
// A game is a match on the netplay server (netplay-server/src/index.js) that
// keeps its settings -- the level and the two heroes -- so the link is only
// ?match=<code>: the guest's page takes the settings from the server, and the
// two games cannot start differently. The browser keeps its own player id
// (localStorage), so a reload, or the link opened again, gets the same role
// back; netplay.js then restarts the level on both machines together.
//
// An address that brings its own switches (TT_TWEAKS, TT_COOP...: the test
// tools, older links) keeps them: the server's settings only fill what is
// missing.
(function () {
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const code = q.get('match');
  const local = location.port === '8080';   // (beside web/serve.mjs: wrangler dev's port, as netplay.js)
  const base = (q.get('server') || `${location.protocol}//${local ? location.hostname + ':8787' : location.host}`)
    .replace(/^ws/, 'http').replace(/\/$/, '');

  const LEVELS = [
    ['01WEAT1', 'Weathertop'], ['02GATE2', 'The Gates of Moria'], ['04BALIN1', "Balin's Tomb"], ['13AMON1', 'Amon Hen'],
    ['14FANG2', 'Fangorn Forest'], ['16ROHAN1', 'The Plains of Rohan'], ['17TOP1', "Helm's Deep: the Deeping Wall"],
    ['18HOLE1', "Helm's Deep: the Breach"], ['20YARD1', 'The Hornburg Courtyard'], ['21ORTH1', 'The Tower of Orthanc'],
  ];
  const HEROES = ['aragorn', 'legolas', 'gimli', 'isildur', 'gandalf', 'boromir', 'frodo'];
  const name = (h) => h[0].toUpperCase() + h.slice(1);
  const levelName = (c) => (LEVELS.find(([k]) => k === c) || [c, c])[1];
  const describe = (st) => `${name(st.p1)} & ${name(st.p2)} · ${levelName(st.level)}`;

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function playerId() {
    let id = store.get('tt-player', null);
    if (!id) { id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); store.set('tt-player', id); }
    return id;
  }
  self.ttPlayerId = playerId;   // (netplay.js)
  function remember(c, settings, role) {
    const games = store.get('tt-games', []).filter((g) => g.code !== c);
    const old = store.get('tt-games', []).find((g) => g.code === c);
    games.unshift({ code: c, settings, role: role ?? old?.role ?? null, at: Date.now() });
    store.set('tt-games', games.slice(0, 6));
  }
  self.ttRememberRole = (role) => { if (code && settingsKnown) remember(code, settingsKnown, role); };
  let settingsKnown = null;

  function newCode() {   // e.g. "fell-7k2q": easy to read out, no look-alike letters
    const words = ['ent', 'fell', 'horn', 'mere', 'wold', 'dale', 'ford', 'helm', 'rohan', 'moria', 'amon', 'shire', 'anor', 'ithil'];
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789', r = crypto.getRandomValues(new Uint8Array(5));
    return words[r[0] % words.length] + '-' + [...r.slice(1)].map((x) => abc[x % abc.length]).join('');
  }
  const link = (c) => `${location.origin}${location.pathname}?match=${encodeURIComponent(c)}`;
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const fill = (sel, items, value) => { sel.innerHTML = ''; for (const [v, t] of items) sel.append(new Option(t, v, false, v === value)); };

  // ---- no game in the address: make one, join one, or come back to one ----
  function lobby() {
    $('together-new').hidden = false;
    fill($('together-level'), LEVELS, '01WEAT1');
    fill($('together-p1'), HEROES.map((h) => [h, name(h)]), 'aragorn');
    fill($('together-p2'), HEROES.map((h) => [h, name(h)]), 'legolas');
    $('together-create').onclick = async () => {
      const err = $('together-error'); err.textContent = '';
      const settings = { level: $('together-level').value, p1: $('together-p1').value, p2: $('together-p2').value };
      $('together-create').disabled = true;
      try {
        for (let tries = 0; tries < 5; tries++) {
          const c = newCode();
          const r = await fetch(`${base}/match/${c}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                         body: JSON.stringify({ player: playerId(), settings }) });
          if (r.status === 409) continue;
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `the server said ${r.status}`);
          remember(c, settings, 'host');
          location.search = `?match=${encodeURIComponent(c)}`;
          return;
        }
        throw new Error('no free code: try again');
      } catch (e) { err.textContent = `Could not make the game: ${e.message}`; $('together-create').disabled = false; }
    };
    $('together-join').onsubmit = (e) => {
      e.preventDefault();
      const c = $('together-code').value.trim().toLowerCase().replace(/^.*[?&]match=/, '').replace(/[^a-z0-9_-]/g, '');
      if (c) location.search = `?match=${encodeURIComponent(c)}`;
    };
    const games = store.get('tt-games', []).filter((g) => Date.now() - g.at < 7 * 86400000);
    $('together-recent').hidden = !games.length;
    const list = $('together-recent-list'); list.innerHTML = '';
    for (const g of games) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="g-what"></span><span class="g-when"></span><a class="btn"></a>';
      li.querySelector('.g-what').textContent = `${g.code} · ${describe(g.settings)}${g.role ? ` · you are player ${g.role === 'host' ? 1 : 2}` : ''}`;
      li.querySelector('.g-when').textContent = ago(g.at);
      const a = li.querySelector('a'); a.textContent = 'Rejoin'; a.href = `?match=${encodeURIComponent(g.code)}`;
      list.append(li);
    }
  }

  // ---- a game in the address: its settings from the server, the link to share ----
  async function game() {
    $('together-game').hidden = false;
    $('together-code-shown').textContent = code;
    $('together-link').value = link(code);
    $('together-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(link(code)); $('together-copy').textContent = 'Copied ✓'; }
      catch { $('together-link').select(); document.execCommand('copy'); $('together-copy').textContent = 'Copied ✓'; }
      setTimeout(() => ($('together-copy').textContent = 'Copy the link'), 2000);
    };
    if (navigator.share) {
      $('together-share').hidden = false;
      $('together-share').onclick = () => navigator.share({ title: 'The Two Towers', text: 'Play The Two Towers with me', url: link(code) }).catch(() => {});
    }
    $('together-leave').href = location.pathname;
    let st = null;
    try {
      const r = await fetch(`${base}/match/${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (r.ok) st = (await r.json()).settings;
    } catch {}
    const args = self.ttArgs;
    if (st) {
      settingsKnown = st;
      remember(code, st);
      args.TT_TWEAKS ??= `SKIPMAINMENU=1;HERO=${st.p1};LEVEL=${st.level}`;
      args.TT_COOP ??= 'clone';
      args.TT_COOP_P2CHAR ??= st.p2;
      $('together-what').textContent = describe(st);
    } else if (args.TT_TWEAKS || args.TT_COOP) {
      $('together-what').textContent = 'the settings in this address';
    } else {
      $('together-what').textContent = '';
      $('together-error').textContent = `There is no game called "${code}" (they are kept for a week). Ask for a new link, or make a game.`;
      self.ttLobbyBlocked = true;
      $('setup-play').disabled = true;
      throw new Error('no such game');
    }
  }

  self.ttLobby = { ready: (code ? game() : Promise.resolve(lobby())).then(() => true, () => false) };
})();
