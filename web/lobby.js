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
// One game, one set of what changes it: the host's. The co-op settings
// (difficulty, player 2's teleport, double pickups) travel with the game and
// are given to both games (TT_COOP_*), whatever each player's ini says; the
// host's files the game reads (saves.js: its saves and the extra heroes'
// records) are sent to the guest when it arrives ({type:"saves-part"},
// through the match server), and the guest's game runs on that copy in
// tt-games/<code>/ -- its own saves are left alone; "Keep" copies the game's
// into them afterwards. Both pages fingerprint the settings, the build and the
// files, and the guest starts only on the host's fingerprint.
//
// The match server is only for players with the disc (pass.js): nothing here
// asks it anything before ttPass.ready.
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
  const DIFFICULTY = ['Easy', 'Normal', 'Expert'];
  const describe = (st) => st.start === 'menu' ? `From the main menu · ${DIFFICULTY[st.difficulty ?? 1]}`
    : `${name(st.p1)} & ${name(st.p2)} · ${levelName(st.level)} · ${DIFFICULTY[st.difficulty ?? 1]}`;

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
    fill($('together-difficulty'), DIFFICULTY.map((d, i) => [String(i), d]), '1');
    // (the main menu: the game's own menus choose the heroes and the mission, together)
    $('together-start').onchange = () => { $('together-levelopts').hidden = $('together-start').value === 'menu'; };
    $('together-create').onclick = async () => {
      const err = $('together-error'); err.textContent = '';
      const settings = { start: $('together-start').value, level: $('together-level').value, p1: $('together-p1').value, p2: $('together-p2').value,
                         difficulty: +$('together-difficulty').value, teleport: +$('together-teleport').checked, pickups: +$('together-pickups').checked };
      if (!ttPass.held) { err.textContent = 'Import your disc first: then you can make a game.'; return; }
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
    if (!ttPass.held) $('together-what').textContent = 'Import your disc, and the game shows here.';
    const st = await settingsP;
    const args = self.ttArgs;
    if (st) {
      settingsKnown = st;
      remember(code, st);
      // the menus in lockstep too (tt_netplay.c): a level's end, its shops and the next level together; from the
      // main menu, the whole way (Co-op, Load Game, the save, the heroes, the mission)
      args.TT_NETPLAY_MENUS ??= '1';
      if (st.start === 'menu') args.TT_NETPLAY_FROM ??= 'menu';
      else {
        args.TT_TWEAKS ??= `SKIPMAINMENU=1;HERO=${st.p1};LEVEL=${st.level}`;
        args.TT_COOP ??= 'clone';
        args.TT_COOP_P2CHAR ??= st.p2;
      }
      // the host's co-op settings, not this player's ini; player 2 is the friend, never the bot
      args.TT_COOP_DIFFICULTY ??= String(st.difficulty ?? 1);
      args.TT_COOP_TELEPORT ??= String(st.teleport ?? 1);
      args.TT_COOP_PICKUPS ??= String(st.pickups ?? 1);
      args.TT_COOP_P2BOT = '0';
      $('together-what').textContent = describe(st);
    } else if (Object.keys(args).some((k) => /^TT_/.test(k))) {   // (the test tools: an address with the game's own switches)
      $('together-what').textContent = 'the settings in this address';
    } else {
      $('together-what').textContent = '';
      $('together-error').textContent = `There is no game called "${code}" (they are kept for a week). Ask for a new link, or make a game.`;
      self.ttLobbyBlocked = true;
      $('setup-play').disabled = true;
      throw new Error('no such game');
    }
  }

  // ---- the host's files for the guest, and the check that both start the same game ----
  let gateOpen;
  const gate = new Promise((r) => (gateOpen = r));   // (import.js waits on it before the game starts)
  const listen = (type, fn) => ((self.ttNetListeners ??= {})[type] ??= []).push(fn);
  const CHUNK = 192 * 1024;   // (base64 characters a message: well under the server's 1 MiB)
  const b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const say = (t, bad) => { const el = $('together-files'); el.textContent = t; el.className = bad ? 'bad' : ''; };

  // (listening from the start: the server's welcome can come before the settings)
  const settingsP = code ? ttPass.ready.then(() => fetch(`${base}/match/${encodeURIComponent(code)}`, { cache: 'no-store' }))
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.settings ?? null).catch(() => null) : Promise.resolve(null);
  if (code) shareFiles();
  function shareFiles() {
    const build = fetch('build-id.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    let mine = null, parts = [], role = null;
    listen('welcome', async (m) => {
      const st = await settingsP;
      if (!st) return;   // (an address with its own switches: no shared files)
      role = m.role;
      if (role === 'host') {   // the host plays on its own files; the guest gets them
        const files = await ttSaves.shared('tt');
        mine = { files, fp: await ttSaves.fingerprint(files, st, (await build).trim()) };
        if (wanted) sendFiles();
        say(`Your saves go to your friend when they join (${ttSaves.saveCount(files)} save${ttSaves.saveCount(files) === 1 ? '' : 's'}).`);
        gateOpen();
      } else {
        self.ttArgs.TT_WEB_HOME = `/opfs/tt-games/${code}`;
        say('Waiting for the host’s saves (they arrive when the host has the game open)…');
        if (m.peer) ttNetSend({ type: 'saves-want' });
      }
    });
    listen('peer-joined', () => { if (role === 'guest' && !mine) ttNetSend({ type: 'saves-want' }); });
    let wanted = false;
    listen('saves-want', () => { wanted = true; if (role === 'host' && mine) sendFiles(); });
    async function sendFiles() {
      const data = await b64(ttSaves.zip(mine.files)), n = Math.max(1, Math.ceil(data.length / CHUNK));
      for (let i = 0; i < n; i++) ttNetSend({ type: 'saves-part', fp: mine.fp, i, n, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
    listen('saves-part', async (m) => {
      if (role !== 'guest' || mine) return;
      parts[m.i] = m.data;
      if (parts.filter((x) => x != null).length !== m.n) return;
      const zipped = unb64(parts.join('')); parts = [];
      const home = `tt-games/${code}`;
      const files = (await ttSaves.unzip(zipped)).filter((f) => ttSaves.SHARED(f.name.toLowerCase()));
      await ttSaves.setShared(home, files);
      await ttSaves.copyFile('tt', home, 'twotowers_recomp.ini');   // (this player's own display and keys)
      const back = await ttSaves.shared(home), fp = await ttSaves.fingerprint(back, await settingsP, (await build).trim());
      if (fp !== m.fp) {
        ttNetSend({ type: 'saves-bad', fp });
        say('Your game and the host’s would not be the same (the saves or the game’s version differ): reload both pages.', true);
        return;
      }
      mine = { files: back, fp };
      ttNetSend({ type: 'saves-ok', fp });
      const n = ttSaves.saveCount(back);
      say(`You have the host’s saves (${n} save${n === 1 ? '' : 's'}) ✓ · fingerprint ${fp.slice(0, 8)}`);
      gateOpen();
    });
    listen('saves-ok', (m) => { if (role === 'host') say(m.fp === mine?.fp ? `Your friend has your saves ✓ · fingerprint ${m.fp.slice(0, 8)}` : 'Your friend’s copy differs: reload both pages.', m.fp !== mine?.fp); });
    listen('saves-bad', () => { if (role === 'host') say('Your friend’s game would not be the same as yours (the game’s version may differ): reload both pages.', true); });
  }

  // ---- the guest's "keep": the shared game's saves into the player's own ----
  async function offerKeep() {
    const files = await ttSaves.shared(`tt-games/${code}`).catch(() => []);
    const n = ttSaves.saveCount(files);
    if (!n) return;
    $('together-keep').hidden = false;
    $('together-keep').textContent = `Keep the saves from this game (${n})`;
    $('together-keep').onclick = async () => {
      try {
        const k = await ttSaves.keep(`tt-games/${code}`, (c) => confirm(`${c} of your own save files would be replaced by this game's. Go on?`));
        if (k) $('together-keep').textContent = `Kept ✓ (${k} save${k === 1 ? '' : 's'})`;
      } catch (e) { $('together-error').textContent = `Could not keep the saves: ${e.message}`; }
    };
  }

  // ---- the player's own saves: a .zip out, a .zip in ----
  async function savesRow() {
    const files = await ttSaves.shared('tt').catch(() => []), n = ttSaves.saveCount(files);
    $('saves-state').textContent = n ? `${n} save${n === 1 ? '' : 's'} in this browser` : 'no saves in this browser yet';
  }
  $('saves-download').onclick = async () => {
    $('saves-error').textContent = '';
    try { await ttSaves.download(); } catch (e) { $('saves-error').textContent = e.message; }
  };
  $('saves-import').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    $('saves-error').textContent = '';
    try {
      const k = await ttSaves.import(f, (c) => confirm(`${c} of your files would be replaced by the ones in ${f.name}. Go on?`));
      if (k) $('saves-state').textContent = `imported ${k} file${k === 1 ? '' : 's'} ✓`;
    } catch (err) { $('saves-error').textContent = `Could not import ${f.name}: ${err.message}`; }
  };

  // old shared games' copies go when they leave the recent list
  (async () => {
    try {
      const keep = new Set(store.get('tt-games', []).map((g) => g.code).concat(code ? [code] : []));
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('tt-games');
      for await (const [n] of d.entries()) if (!keep.has(n)) await d.removeEntry(n, { recursive: true }).catch(() => {});
    } catch {}
  })();

  const ready = (code ? game() : Promise.resolve(lobby())).then(() => true, () => false);
  ready.then((ok) => { if (!ok || !settingsKnown) gateOpen(); else offerKeep(); });   // (no shared game: nothing to wait for)
  savesRow();
  self.ttLobby = { ready, gate };
})();
