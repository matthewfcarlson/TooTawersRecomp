// (web port) The player's saves in the page's storage (OPFS): what is in
// them, a .zip of them to download or import, and the files a shared game
// runs on.
//
// The game's home is the OPFS folder tt/ (web_platform.c): the ini, and
// saves/ -- the hard disk's E:, so the game's saves are
// saves/UDATA/45410010/<save>/ (game.xsv and its .xbx) -- and heroes/records.dat
// (the extra heroes' records, heroes.c). A shared game's guest runs on a copy
// of the host's files in tt-games/<code>/ (TT_WEB_HOME), never on its own.
(function () {
  const TITLE = '45410010';
  // what a shared game takes from the host: whatever of the player's files the game reads
  const SHARED = (p) => p.startsWith(`saves/udata/${TITLE}/`) || p === 'heroes/records.dat';
  // what a download holds: those, the title's own data, and the settings
  const EXPORTED = (p) => SHARED(p) || p.startsWith(`saves/tdata/${TITLE}/`) || p === 'twotowers_recomp.ini';

  const root = () => navigator.storage.getDirectory();
  async function child(dir, name, kind, create) {   // (any case, as the game's own files system: icase)
    try { return kind === 'directory' ? await dir.getDirectoryHandle(name) : await dir.getFileHandle(name); } catch {}
    for await (const [n, h] of dir.entries()) if (n.toLowerCase() === name.toLowerCase() && h.kind === kind) return h;
    if (!create) return null;
    return kind === 'directory' ? dir.getDirectoryHandle(name, { create: true }) : dir.getFileHandle(name, { create: true });
  }
  async function dirAt(path, create) {
    let d = await root();
    for (const p of path.split('/').filter(Boolean)) { d = await child(d, p, 'directory', create); if (!d) return null; }
    return d;
  }

  // every file under home/ that keep(path) wants, as {path (lower case, '/'), name (as stored), bytes}, by path
  async function collect(home, keep) {
    const out = [], top = await dirAt(home, false);
    async function walk(dir, rel, shown) {
      for await (const [n, h] of dir.entries()) {
        const p = rel ? `${rel}/${n.toLowerCase()}` : n.toLowerCase(), s = shown ? `${shown}/${n}` : n;
        if (h.kind === 'directory') { if (keep(p + '/') || ['saves', 'saves/udata', 'saves/tdata', 'heroes', `saves/udata/${TITLE}`, `saves/tdata/${TITLE}`].includes(p)) await walk(h, p, s); }
        else if (keep(p)) out.push({ path: p, name: s, bytes: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
      }
    }
    if (top) await walk(top, '', '');
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  async function write(home, files) {
    for (const f of files) {
      const parts = f.name.split('/'), d = await dirAt(`${home}/${parts.slice(0, -1).join('/')}`, true);
      const w = await (await child(d, parts.at(-1), 'file', true)).createWritable();
      await w.write(f.bytes); await w.close();
    }
  }
  async function remove(home, rel) {   // (a file or a folder, any case)
    const parts = rel.split('/'), d = await dirAt(`${home}/${parts.slice(0, -1).join('/')}`, false);
    if (!d) return;
    for await (const [n] of d.entries()) if (n.toLowerCase() === parts.at(-1).toLowerCase()) await d.removeEntry(n, { recursive: true });
  }

  // ---- .zip (stored; reads stored or deflated, as other tools make them) ----
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], dir = [];
    let at = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.bytes), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
      h.setUint32(14, crc, true); h.setUint32(18, f.bytes.length, true); h.setUint32(22, f.bytes.length, true); h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, f.bytes);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
      c.setUint32(16, crc, true); c.setUint32(20, f.bytes.length, true); c.setUint32(24, f.bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, at, true);
      dir.push(new Uint8Array(c.buffer), name);
      at += 30 + name.length + f.bytes.length;
    }
    const size = dir.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, at, true);
    return new Blob([...parts, ...dir, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }
  async function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder(), out = [];
    let e = bytes.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('that is not a .zip file');
    let c = v.getUint32(e + 16, true);
    for (let i = 0, n = v.getUint16(e + 10, true); i < n; i++) {
      if (v.getUint32(c, true) !== 0x02014b50) throw new Error('a damaged .zip file');
      const method = v.getUint16(c + 10, true), csize = v.getUint32(c + 20, true), nl = v.getUint16(c + 28, true);
      const xl = v.getUint16(c + 30, true), kl = v.getUint16(c + 32, true), off = v.getUint32(c + 42, true);
      const name = dec.decode(bytes.subarray(c + 46, c + 46 + nl));
      c += 46 + nl + xl + kl;
      if (name.endsWith('/')) continue;
      const data = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true), raw = bytes.subarray(data, data + csize);
      let b;
      if (method === 0) b = raw;
      else if (method === 8) b = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error(`${name}: a compression this page cannot read`);
      out.push({ name, bytes: b });
    }
    return out;
  }

  // where a file from a .zip goes in the home: ours as they are; a bare 45410010/<save>/... (an Xbox save
  // folder zipped on its own) under saves/UDATA. Anything else, or with '..', is left out.
  function place(name) {
    const n = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (n.split('/').some((p) => p === '..' || p === '.')) return null;
    const lower = n.toLowerCase();
    if (EXPORTED(lower)) return n;
    const k = lower.indexOf(`${TITLE}/`);
    if (k >= 0 && !lower.slice(0, k).includes('tdata')) return `saves/UDATA/${n.slice(k)}`;
    return null;
  }

  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sha = async (b) => hex(await crypto.subtle.digest('SHA-256', b));
  // the fingerprint of a shared game's start: its settings, the build, and each of the files (by path, any case)
  async function fingerprint(files, settings, build) {
    const lines = [JSON.stringify(settings, Object.keys(settings || {}).sort()), build || ''];
    for (const f of files) lines.push(`${f.path} ${await sha(f.bytes)}`);
    return (await sha(new TextEncoder().encode(lines.join('\n')))).slice(0, 16);
  }
  // (a save is a folder in UDATA/<title>/; the files beside them are the title's own: its name and picture)
  const saveCount = (files) => new Set(files.filter((f) => f.path.startsWith(`saves/udata/${TITLE}/`) && f.path.split('/').length > 4).map((f) => f.path.split('/')[3])).size;

  self.ttSaves = {
    TITLE, SHARED, collect, write, remove, zip, unzip, place, fingerprint, saveCount,
    // the player's own: a .zip to keep
    async download() {
      const files = await collect('tt', EXPORTED);
      if (!files.length) throw new Error('there are no saves or settings in this browser yet');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip(files));
      a.download = `two-towers-saves-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return files.length;
    },
    // a .zip back in (a download from here, or an Xbox save folder): returns what it put where
    async import(file, confirmReplace) {
      const files = (await unzip(new Uint8Array(await file.arrayBuffer()))).map((f) => ({ ...f, name: place(f.name) })).filter((f) => f.name);
      if (!files.length) throw new Error('that .zip has no saves of this game in it');
      const mine = new Set((await collect('tt', EXPORTED)).map((f) => f.path));
      const clash = files.filter((f) => mine.has(f.name.toLowerCase()));
      if (clash.length && !confirmReplace(clash.length)) return 0;
      await write('tt', files);
      return files.length;
    },
    // a shared game's files, as the host has them (and the guest's copy: the same, read back)
    shared(home) { return collect(home, SHARED); },
    // the guest's copy for this game: what was there before goes, then the host's files
    async setShared(home, files) {
      await dirAt(home, true);   // (the game makes only the last folder of its home)
      await remove(home, `saves/UDATA/${TITLE}`); await remove(home, 'heroes/records.dat');
      await write(home, files);
    },
    async copyFile(from, to, rel) {   // (the player's settings into a shared game's home)
      const f = (await collect(from, (p) => p === rel))[0];
      if (f) await write(to, [f]);
    },
    // the guest's "keep a copy": the shared game's saves into the player's own; asks before replacing
    async keep(home, confirmReplace) {
      const files = await collect(home, SHARED);
      if (!files.length) return 0;
      const mine = await collect('tt', SHARED), byPath = new Map(mine.map((f) => [f.path, f]));
      const differ = files.filter((f) => byPath.has(f.path) && (byPath.get(f.path).bytes.length !== f.bytes.length || !byPath.get(f.path).bytes.every((x, i) => x === f.bytes[i])));
      if (differ.length && !confirmReplace(differ.length)) return 0;
      await write('tt', files.map((f) => ({ ...f, name: byPath.get(f.path)?.name ?? f.name })));
      return saveCount(files);
    },
    async forget(home) { const d = await dirAt(home.split('/').slice(0, -1).join('/'), false); if (d) await d.removeEntry(home.split('/').at(-1), { recursive: true }).catch(() => {}); },
  };
})();
