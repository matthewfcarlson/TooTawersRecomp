// (web port) The page's start: the game needs your own disc (and, if you
// want them, the Ultra textures). From web/serve.mjs on your machine they
// come from its folders; on the hosted page (Cloudflare) you pick your ISO
// and the GLOS69 pack once, and they are copied into this site's private
// storage in your browser (OPFS, import-worker.js), where the game reads
// them (web_platform.c). Nothing is uploaded anywhere.
//
// Then the game starts (twotowers_recomp.js). ?TT_WEB_ULTRA_BUILD=<dir> is
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
  const startGame = () => { panel.hidden = true; const s = document.createElement('script'); s.src = 'twotowers_recomp.js'; document.body.append(s); };

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
    const disc = await opfsHas('disc/.complete'), ultra = await opfsHas('ultra/textures_ultra/built.txt');
    const pack = await opfsHas('ultra/.pack-complete');
    $('setup-disc-state').textContent = disc ? 'imported ✓' : 'not imported yet';
    $('setup-ultra-state').textContent = ultra ? 'built ✓' : pack ? 'copied, not built yet' : 'not imported (optional)';
    $('setup-build').hidden = !pack || ultra;
    $('setup-play').disabled = !disc;
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

  $('setup-iso').onchange = (e) => e.target.files[0] && guard(() => run({ type: 'iso', file: e.target.files[0] }, 'Copying the disc'));

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
      const s = document.createElement('script'); s.src = 'twotowers_recomp.js'; document.body.append(s);
      return;
    }
    // your machine's server with your disc (web/serve.mjs), or a disc imported before: straight into the game
    if (await serverHas('disc-manifest.json') || (await opfsHas('disc/.complete') && !q.has('setup'))) return startGame();
    panel.hidden = false;
    await refresh();
  })();
})();
