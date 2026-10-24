#!/usr/bin/env node
// (web port) Put this machine's copy of the disc (and the Ultra textures) in the hosted site's R2 bucket, for
// the players who have the site's password (netplay-server/src/index.js, /share):
//
//   TT_UPLOAD_SECRET=... node web/tools/share-upload.mjs [--url https://...] [--disc isos/extracted] [--ultra textures|off]
//
// TT_UPLOAD_SECRET is the Worker's UPLOAD_SECRET (wrangler secret put UPLOAD_SECRET): from the environment only,
// never an argument. --url defaults to the deployed site; http://localhost:8787 is wrangler dev's (local R2).
// --ultra is the folder with GLOS69/ and a built textures_ultra/ (as web/serve.mjs takes it). The keys are the
// files' paths in lower case (the game asks so); a file already there at the same size is skipped, so a run
// that stopped goes on where it was. The manifests (what the game lists) go last.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
let site = 'https://twotowers-netplay.matthewcdev.workers.dev', disc = path.join(repo, 'isos', 'extracted');
let ultra = path.join(repo, 'textures');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url') site = argv[++i].replace(/\/+$/, '');
  else if (argv[i] === '--disc') disc = path.resolve(argv[++i]);
  else if (argv[i] === '--ultra') ultra = argv[++i] === 'off' ? null : path.resolve(argv[i]);
}
const secret = process.env.TT_UPLOAD_SECRET;
if (!secret) { console.error('TT_UPLOAD_SECRET is not set (the Worker\'s UPLOAD_SECRET)'); process.exit(1); }
if (ultra && !fs.existsSync(path.join(ultra, 'textures_ultra', 'built.txt'))) { console.error(`no built textures_ultra in ${ultra} (--ultra off to leave them out)`); process.exit(1); }

// "<size> <path>" for every file under root's subdirs, as web/serve.mjs lists them
function listFiles(root, subdirs) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !/\.(part|ini)$/i.test(e.name)) out.push({ size: fs.statSync(p).size, rel: r, file: p });
    }
  };
  for (const sub of subdirs) if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub), sub);
  return out;
}
const discFiles = listFiles(disc, ['']).filter((f) => !/^(UDATA|TDATA)\//i.test(f.rel));
const ultraFiles = ultra ? listFiles(ultra, ['GLOS69', 'textures_ultra']) : [];
const jobs = [...discFiles.map((f) => ({ ...f, key: `disc/${f.rel.toLowerCase()}` })),
              ...ultraFiles.map((f) => ({ ...f, key: `ultra/${f.rel.toLowerCase()}` }))];
const total = jobs.reduce((n, f) => n + f.size, 0);
console.log(`${site}: ${discFiles.length} disc files, ${ultraFiles.length} Ultra files, ${(total / 1e9).toFixed(2)} GB`);

const auth = { Authorization: `Bearer ${secret}` };
const at = (key, q = '') => `${site}/share-upload/${key.split('/').map(encodeURIComponent).join('/')}${q}`;
async function call(url, opts, tries = 8) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...auth, ...opts.headers } });
      if (r.ok || r.status === 404 || i >= tries) return r;
      if (r.status === 403) { console.error('the server refused the upload secret'); process.exit(1); }
    } catch (e) { if (i >= tries) throw e; }
    await new Promise((res) => setTimeout(res, Math.min(30000, 2000 * i * i)));   // (a dropped connection: longer each time)
  }
}
const read = (file, start, end) => {   // (a part of a file, as a Buffer)
  const fd = fs.openSync(file, 'r'), b = Buffer.alloc(end - start);
  try { fs.readSync(fd, b, 0, b.length, start); } finally { fs.closeSync(fd); }
  return b;
};

const PART = 48 << 20, ONE_PUT = 90 << 20;
let done = 0, sent = 0, skipped = 0;
const failed = [];
async function upload(f) {
  const head = await call(at(f.key), { method: 'HEAD' });
  if (head.ok && Number(head.headers.get('X-Size')) === f.size) { skipped++; return; }
  if (f.size <= ONE_PUT) {
    const r = await call(at(f.key), { method: 'PUT', body: read(f.file, 0, f.size) });
    if (!r.ok) throw new Error(`${f.rel}: ${r.status} ${await r.text()}`);
  } else {
    const { uploadId } = await (await call(at(f.key, '?uploads'), { method: 'POST' })).json();
    const parts = [];
    for (let n = 1, off = 0; off < f.size; n++, off += PART) {
      const r = await call(at(f.key, `?uploadId=${encodeURIComponent(uploadId)}&partNumber=${n}`),
                           { method: 'PUT', body: read(f.file, off, Math.min(f.size, off + PART)) });
      if (!r.ok) throw new Error(`${f.rel} part ${n}: ${r.status} ${await r.text()}`);
      parts.push(await r.json());
    }
    const r = await call(at(f.key, `?uploadId=${encodeURIComponent(uploadId)}`),
                         { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }) });
    if (!r.ok) throw new Error(`${f.rel}: completing: ${r.status} ${await r.text()}`);
  }
  sent += f.size;
}

// four at a time; progress every few seconds
const queue = [...jobs].sort((a, b) => b.size - a.size);
let last = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let f; (f = queue.shift()); ) {
    // (a file that still fails after its retries is left for the next run, which skips what is there)
    for (let k = 1; ; k++) {
      try { await upload(f); break; }
      catch (e) {
        if (k >= 3) { failed.push(f.rel); console.log(`  ${f.rel}: ${e.cause?.code || e.message} -- left for the next run`); break; }
        await new Promise((res) => setTimeout(res, 10000 * k));
      }
    }
    done++;
    if (Date.now() - last > 5000 || !queue.length) {
      last = Date.now();
      console.log(`  ${done}/${jobs.length} files (${skipped} already there), ${(sent / 1e9).toFixed(2)} GB sent`);
    }
  }
}));

if (failed.length) {   // (no manifests yet: the game would list files that are not there)
  console.log(`${failed.length} file(s) not uploaded; run again to finish: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}`);
  process.exit(1);
}
// the manifests last: the game lists only what is there
const manifest = (files) => files.map((f) => `${f.size} ${f.rel}`).join('\n') + '\n';
for (const [key, files] of [['disc-manifest.json', discFiles], ['ultra-manifest.json', ultraFiles]]) {
  if (!files.length) continue;
  const r = await call(at(key), { method: 'PUT', body: manifest(files) });
  if (!r.ok) throw new Error(`${key}: ${r.status}`);
}
console.log(`done: ${jobs.length} files, ${(sent / 1e9).toFixed(2)} GB sent, ${skipped} already there`);
