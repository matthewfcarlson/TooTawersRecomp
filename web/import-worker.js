// (web port) Your game files, into the page's private storage (OPFS), where
// the game reads them (web_platform.c): nothing leaves the machine. Run by
// import.js as a worker (synchronous OPFS writes are for workers only).
//
//   {type:'iso', file}           the disc image (Xbox ISO: redump or xiso) ->
//                                disc/, its files as on the disc; disc/.complete
//   {type:'folder', files, to}   picked folder's files (webkitRelativePath) -> to/
//                                (the Ultra pack: ultra/GLOS69/)
//   {type:'url', url, to}        one file from the site -> to (the port's
//                                textures_ultra support files)
// Answers {type:'progress', done, total, what}, then {type:'done'} or {type:'error', message}.
const SECTOR = 2048;
const CHUNK = 16 << 20;
// where the game partition starts in an image: 0 for an xiso; a full disc's (redump) by its kind (XGD1, XGD2, XGD3)
const PARTITIONS = [0, 0x18300000, 0x0FD90000, 0x02080000];
const MAGIC = 'MICROSOFT*XBOX*MEDIA';

// Every name is written in lower case: the game sees these folders through a
// case-insensitive layer (web_platform.c, /local), which looks names up in
// lower case, as on the console the disc's Default.xbe is default.xbe.
async function dirAt(path, create = true) {
  let d = await navigator.storage.getDirectory();
  for (const p of path.toLowerCase().split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
  return d;
}
async function remove(path) {
  const parts = path.split('/').filter(Boolean);
  const parent = await dirAt(parts.slice(0, -1).join('/'));
  await parent.removeEntry(parts.at(-1).toLowerCase(), { recursive: true }).catch(() => {});
}
async function bytes(file, at, n) { return new Uint8Array(await file.slice(at, at + n).arrayBuffer()); }

// a file's contents from a Blob (or part of one) into OPFS
async function write(dir, name, blob, onBytes) {
  const h = await (await dir.getFileHandle(name.toLowerCase(), { create: true })).createSyncAccessHandle();
  try {
    h.truncate(0);
    for (let at = 0; at < blob.size; at += CHUNK) {
      const b = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + CHUNK)).arrayBuffer());
      h.write(b, { at });
      onBytes(b.length);
    }
    h.flush();
  } finally { h.close(); }
}

async function iso(file) {
  let base = -1;
  for (const p of PARTITIONS) {
    if (p + 0x10000 + 20 > file.size) continue;
    if (new TextDecoder().decode(await bytes(file, p + 0x10000, 20)) === MAGIC) { base = p; break; }
  }
  if (base < 0) throw new Error('not an Xbox disc image (no XDVDFS volume found)');
  const hdr = new DataView((await bytes(file, base + 0x10000, 32)).buffer);
  const rootSector = hdr.getUint32(20, true), rootSize = hdr.getUint32(24, true);

  // the directory tree: each directory a binary tree of entries
  //   u16 left, u16 right (in 4-byte units from the table's start), u32 sector, u32 size, u8 attributes, u8 name length, name
  const files = [];
  async function walkDir(sector, size, path) {
    if (!size) return;
    const t = await bytes(file, base + sector * SECTOR, size), v = new DataView(t.buffer);
    const seen = new Set();
    const visit = async (off) => {
      if (off + 14 > size || seen.has(off)) return;
      seen.add(off);
      const left = v.getUint16(off, true), right = v.getUint16(off + 2, true);
      if (left === 0xffff) return;   // (an empty directory's padding)
      const sec = v.getUint32(off + 4, true), sz = v.getUint32(off + 8, true), attr = t[off + 12], n = t[off + 13];
      const name = new TextDecoder('latin1').decode(t.subarray(off + 14, off + 14 + n));
      if (left) await visit(left * 4);
      if (attr & 0x10) await walkDir(sec, sz, `${path}${name}/`);
      else files.push({ path: path + name, at: base + sec * SECTOR, size: sz });
      if (right) await visit(right * 4);
    };
    await visit(0);
  }
  await walkDir(rootSector, rootSize, '');
  if (!files.some((f) => /^default\.xbe$/i.test(f.path))) throw new Error('no default.xbe on this disc');

  await remove('disc');
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = await dirAt('disc/' + parts.slice(0, -1).join('/'));
    await write(dir, parts.at(-1), file.slice(f.at, f.at + f.size), (n) => { done += n; post(done, total, f.path); });
  }
  await write(await dirAt('disc'), '.complete', new Blob([`${file.name}\n${file.size}\n${files.length} files\n`]), () => {});
}

async function folder(files, to) {
  await remove(to);
  const total = files.reduce((s, f) => s + f.file.size, 0);
  let done = 0;
  for (const { file, rel } of files) {
    const parts = rel.split('/');
    await write(await dirAt(to + '/' + parts.slice(0, -1).join('/')), parts.at(-1), file, (n) => { done += n; post(done, total, rel); });
  }
}

async function fromUrl(url, to) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const parts = to.split('/');
  await write(await dirAt(parts.slice(0, -1).join('/')), parts.at(-1), await r.blob(), () => {});
}

function post(done, total, what) {
  const now = performance.now();
  if (now - (post.t ?? 0) < 200 && done < total) return;
  post.t = now;
  self.postMessage({ type: 'progress', done, total, what });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'iso') await iso(m.file);
    else if (m.type === 'folder') await folder(m.files, m.to);
    else if (m.type === 'url') await fromUrl(m.url, m.to);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
