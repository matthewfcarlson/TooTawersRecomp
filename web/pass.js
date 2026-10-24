// (web port) The hosted site's disc pass. The game's code (build/), the match
// server (/match) and the TURN relay (/turn) are only for players with the
// disc: the server asks for the SHA-256 of three 64 KB pieces of its files,
// answered here from the copy imported into this site's storage (only the
// hashes are sent), and a cookie then opens all three for 30 days
// (netplay-server/src/index.js).
//
// It is fetched as soon as the disc is here (at load, or once import.js has
// imported it), since the lobby and netplay.js talk to the match server before
// the game starts: they wait on ttPass.ready. Beside web/serve.mjs the build
// is open and the local match server asks for no pass: ready at once.
(function () {
  let done;
  const ready = new Promise((r) => (done = r));
  let held = false, trying = null;

  // a file of the imported disc (its names as on the disc; any case, as the game asks)
  async function discFile(rel) {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('disc');
    const parts = rel.split('/');
    const find = async (dir, name, kind) => {
      try { return kind === 'dir' ? await dir.getDirectoryHandle(name) : await dir.getFileHandle(name); } catch {}
      for await (const [n, h] of dir.entries()) if (n.toLowerCase() === name.toLowerCase() && h.kind === (kind === 'dir' ? 'directory' : 'file')) return h;
      throw new Error(`the imported disc has no ${rel}`);
    };
    for (const p of parts.slice(0, -1)) d = await find(d, p, 'dir');
    return (await find(d, parts.at(-1), 'file')).getFile();
  }

  // nothing to do if the build is already open to us (a pass held, or web/serve.mjs)
  async function check() {
    const head = await fetch('build/twotowers_recomp.js', { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return;
    if (head.status !== 403) throw new Error(`the game's files could not be loaded (${head.status})`);
    const r0 = await fetch('proof', { cache: 'no-store' });
    const ask = await r0.json().catch(() => ({ error: `the disc check could not start (${r0.status})` }));
    if (ask.error) throw new Error(ask.error);
    const hashes = [];
    for (const q of ask.ask) {
      const bytes = await (await discFile(q.path)).slice(q.offset, q.offset + q.length).arrayBuffer();
      hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    const r = await fetch('proof', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify({ exp: ask.exp, ids: ask.ids, mac: ask.mac, hashes }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `the disc check failed (${r.status})`);
  }
  // (one check at a time; a failed one can be tried again)
  const unlock = () => (trying ??= check().then(() => { held = true; done(); }, (e) => { trying = null; throw e; }));

  self.ttPass = { ready, unlock, get held() { return held; } };
  unlock().catch(() => {});   // (no disc yet: import.js tries again after the import, and shows any error at Play)
})();
