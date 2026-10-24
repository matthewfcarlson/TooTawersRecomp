// (web port) The page's start: the game needs your own disc (and, if you
// want them, the Ultra textures). From web/serve.mjs on your machine they
// come from its folders; on the hosted page (Cloudflare) you pick your ISO
// and the GLOS69 pack once, and they are copied into this site's private
// storage in your browser (OPFS, import-worker.js), where the game reads
// them (web_platform.c). Nothing is uploaded anywhere.
//
// On the hosted page the game's code (build/) is only for players with the
// disc: pass.js answers the server's questions about the imported copy, and
// its cookie opens build/ (and the match server, and the relay).
//
// A hosted site can also share its own copy of the disc and the Ultra
// textures with whoever has its password (netplay-server, /share): then the
// game streams them from the site, and nothing needs importing.
//
// Then the game starts (build/twotowers_recomp.js). ?TT_WEB_ULTRA_BUILD=<dir> is
// the Ultra textures' one-time build (web_ultra.cpp): the game's code run
// for that alone, then back here.
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('setup');
  const q = new URLSearchParams(location.search);

  async function opfsHas(path) {
    try {
      let d = await navigator.storage.getDirectory();
      const parts = path.split('/');
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      await d.getFileHandle(parts.at(-1));
      return true;
    } catch { return false; }
  }
  const serverHas = (name) => fetch(name, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  const loadGame = () => {
    // the game's switches as they are now (lobby.js may have added a shared game's)
    if (self.ttArgs) Module.arguments = Object.entries(self.ttArgs).map(([k, v]) => `${k}=${v}`);
    const s = document.createElement('script'); s.src = 'build/twotowers_recomp.js'; document.body.append(s);
  };

  const unlockBuild = () => self.ttPass.unlock();
  // the site's copy: {open: the site shares one, held: this browser has the password's pass}; on web/serve.mjs, null
  let share = null;
  const shareState = () => fetch('share', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  async function startGame() {
    const what = $('setup-what');
    if (self.ttLobby && !(await self.ttLobby.ready)) return;   // (a shared game's link that leads nowhere)
    if (self.ttLobby) {   // a shared game's guest: the host's saves first (lobby.js)
      what.textContent = 'Getting the game ready (the host’s saves)…';
      await self.ttLobby.gate;
    }
    what.textContent = 'Checking your disc…';
    try { await unlockBuild(); }
    catch (e) { what.textContent = ''; $('setup-error').textContent = e.message; panel.hidden = false; await refresh(); return; }
    what.textContent = '';
    document.body.classList.add('playing');
    panel.hidden = true;
    loadGame();
  }

  function run(msg, label) {
    return new Promise((resolve, reject) => {
      const w = new Worker('import-worker.js');
      const bar = $('setup-progress'), what = $('setup-what');
      bar.hidden = false; bar.value = 0; what.textContent = label;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          bar.max = m.total; bar.value = m.done;
          what.textContent = `${label}: ${(m.done / 1e9).toFixed(2)} of ${(m.total / 1e9).toFixed(2)} GB · ${m.what}`;
        } else { w.terminate(); bar.hidden = true; m.type === 'done' ? resolve() : reject(new Error(m.message)); }
      };
      w.postMessage(msg);
    });
  }

  async function refresh() {
    const own = await opfsHas('disc/.complete'), shared = !!share?.held, disc = own || shared;
    const ultra = shared || await opfsHas('ultra/textures_ultra/built.txt');
    const pack = await opfsHas('ultra/.pack-complete');
    $('setup-disc-state').textContent = shared ? "the site's copy ✓" : own ? 'imported ✓' : 'not imported yet';
    $('setup-ultra-state').textContent = shared ? "the site's copy ✓" : ultra ? 'built ✓' : pack ? 'copied, not built yet' : 'not imported (optional)';
    $('share-form').hidden = !share?.open || shared;
    $('setup-build').hidden = !pack || ultra;
    $('setup-play').disabled = !disc || self.ttLobbyBlocked;
    $('step-disc').classList.toggle('done', disc);
    $('step-ultra').classList.toggle('done', ultra);
    $('setup-play-note').textContent = disc ? (ultra ? 'Your disc and the Ultra textures are ready.' : 'Your disc is ready.') : 'Import your disc first.';
    if (navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      $('setup-space').textContent = `This site's storage: ${(usage / 1e9).toFixed(1)} GB used of ${(quota / 1e9).toFixed(0)} GB allowed.`;
    }
  }

  async function guard(fn) {
    const err = $('setup-error');
    err.textContent = '';
    document.querySelectorAll('#setup button, #setup input').forEach((b) => (b.disabled = true));
    try { await navigator.storage.persist?.(); await fn(); }
    catch (e) { err.textContent = e.message; }
    document.querySelectorAll('#setup button, #setup input').forEach((b) => (b.disabled = false));
    await refresh();
  }

  // (then the pass at once: the lobby waits on it to reach the match server)
  $('setup-iso').onchange = (e) => e.target.files[0] && guard(async () => { await run({ type: 'iso', file: e.target.files[0] }, 'Copying the disc'); await unlockBuild(); });
  // an ISO dropped on the disc's card: as if picked
  const drop = $('step-disc');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find((x) => /\.x?iso$/i.test(x.name));
    if (!f) { $('setup-error').textContent = 'That is not an .iso file.'; return; }
    const dt = new DataTransfer(); dt.items.add(f);
    $('setup-iso').files = dt.files; $('setup-iso').dispatchEvent(new Event('change'));
  });

  // the pack: the GLOS69 folder (unpacked from its download), put at ultra/GLOS69 whatever the folder is called;
  // then the port's own textures_ultra files from this site
  $('setup-pack').onchange = (e) => guard(async () => {
    const picked = [...e.target.files];
    if (!picked.some((f) => /(^|\/)tex1_/.test(f.webkitRelativePath)))
      throw new Error('That folder has no pack pictures (tex1_*.dds/png): pick the GLOS69 folder from the pack.');
    // the folder that holds the pictures becomes GLOS69/ (a pack unpacked with a folder around it works too)
    const first = picked.find((f) => /(^|\/)tex1_/.test(f.webkitRelativePath)).webkitRelativePath;
    const root = first.slice(0, first.lastIndexOf('/') + 1);
    const files = picked.filter((f) => f.webkitRelativePath.startsWith(root))
      .map((file) => ({ file, rel: file.webkitRelativePath.slice(root.length) }));
    await run({ type: 'folder', files, to: 'ultra/GLOS69' }, 'Copying the texture pack');
    const list = (await (await fetch('ultra-support.txt')).text()).split('\n').filter(Boolean);
    for (const f of list) await run({ type: 'url', url: `ultra-support/${f}`, to: `ultra/textures_ultra/${f}` }, `The port's texture files: ${f}`);
    const w = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('ultra')).getFileHandle('.pack-complete', { create: true });
    const s = await w.createWritable(); await s.write(`${files.length} files\n`); await s.close();
  });

  // the site's password: its pass opens the build and the site's copy (the game streams it: web_platform.c)
  $('share-form').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const r = await fetch('share', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify({ password: $('share-password').value }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `the password could not be checked (${r.status})`);
      $('share-password').value = '';
      share = await shareState();
      await unlockBuild();
    });
  };
  $('setup-build').onclick = () => { location.search = '?TT_WEB_ULTRA_BUILD=/local/ultra'; };
  $('setup-play').onclick = startGame;
  $('setup-forget').onclick = () => guard(async () => {
    if (!confirm('Remove the imported disc and textures from this browser? (Saves and settings stay.)')) return;
    const root = await navigator.storage.getDirectory();
    for (const n of ['disc', 'ultra']) await root.removeEntry(n, { recursive: true }).catch(() => {});
  });

  (async () => {
    if (q.has('TT_WEB_ULTRA_BUILD')) {   // the build: the game's code shows its progress in the log; back here when it ends
      const what = $('setup-what');
      panel.hidden = false; $('setup-choices').hidden = true;
      what.textContent = 'Building the Ultra textures (once; several minutes)…';
      Module.printErr = Module.print = (t) => {
        const m = /\[ULTRA-BUILD\] (\d+) (.*)/.exec(t);
        if (m) { $('setup-progress').hidden = false; $('setup-progress').max = 100; $('setup-progress').value = +m[1]; what.textContent = `Building the Ultra textures: ${m[1]}% · ${m[2]}`; }
        else if (/\[ULTRA-BUILD\] failed/.test(t)) what.textContent = t;
      };
      Module.onExit = (code) => { if (!code) location.search = ''; };
      try { await unlockBuild(); } catch (e) { $('setup-error').textContent = e.message; return; }
      loadGame();
      return;
    }
    // your machine's server with your disc (web/serve.mjs): straight into the game; the hosted page: the splash,
    // with Play once the disc is in (that click also lets the sound start)
    // (the hosted site's own copy, for its password's holders, is a choice on the splash like an imported disc)
    share = await shareState();
    if (!share && await serverHas('disc-manifest.json')) return startGame();
    // the bar's resolution changed (index.html): back into the game at once
    if (sessionStorage.getItem('tt-restart') === '1') {
      sessionStorage.removeItem('tt-restart');
      if (share?.held || await opfsHas('disc/.complete')) return startGame();
    }
    // a co-op game restarting after a reload (netplay.js): back into it at once
    if (q.get('match') && sessionStorage.getItem('tt-autostart') === q.get('match') && (share?.held || await opfsHas('disc/.complete'))) {
      sessionStorage.removeItem('tt-autostart');
      return startGame();
    }
    panel.hidden = false;
    await refresh();
  })();
})();
