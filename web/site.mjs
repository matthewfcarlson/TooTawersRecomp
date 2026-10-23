#!/usr/bin/env node
// (web port) The hosted site's files, for Cloudflare (web/netplay-server: one
// Worker serves them as static assets beside the match server):
//
//   node web/site.mjs [--build build-web] [--disc isos/extracted]   -> web/netplay-server/public/, gen/
//
// The page, its scripts, the build (build/: the Worker serves it only to
// players who showed they have the disc), the port's own files for the Ultra
// textures' build (ultra-support/), and _headers: the cross-origin isolation
// threads need. No game files: players import their own (import.js).
//
// gen/disc-proof.json: the Worker's questions about the disc, SHA-256 hashes
// of 64 KB pieces of its files at random places (nothing of the disc itself;
// never committed all the same). .dev.vars: a BUILD_SECRET for wrangler dev,
// if there is none (the deployed one: wrangler secret put BUILD_SECRET).
// The build is the game's code translated from the disc: public/ is never
// committed (.gitignore), and publishing it is the owner's decision.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let build = path.join(repo, 'build-web'), disc = path.join(repo, 'isos', 'extracted');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--build') build = path.resolve(argv[++i]);
  else if (argv[i] === '--disc') disc = path.resolve(argv[++i]);
}
const server = path.join(repo, 'web', 'netplay-server');
const out = path.join(server, 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'ultra-support', 'masks'), { recursive: true });
fs.mkdirSync(path.join(out, 'build'));

const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));
for (const f of ['index.html', 'netplay.js', 'import.js', 'import-worker.js']) copy(path.join(repo, 'web', f), f);
for (const f of ['twotowers_recomp.js', 'twotowers_recomp.wasm']) {
  if (!fs.existsSync(path.join(build, f))) { console.error(`no ${f} in ${build}: build first (web/build.sh)`); process.exit(1); }
  copy(path.join(build, f), `build/${f}`);
}
const src = path.join(repo, 'twotowers', 'tools', 'ultra_textures');
const support = ['recipe.txt', 'pairs.txt', ...fs.readdirSync(path.join(src, 'masks')).filter((n) => n.endsWith('.png')).map((n) => `masks/${n}`)];
for (const f of support) copy(path.join(src, f), `ultra-support/${f}`);
fs.writeFileSync(path.join(out, 'ultra-support.txt'), support.join('\n') + '\n');
fs.writeFileSync(path.join(out, '_headers'), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
`);

// the disc questions: 512 pieces, each file's chance by its size (the import keeps the disc's own names: disc/<path>)
const PIECE = 65536, QUESTIONS = 512;
if (!fs.existsSync(disc)) { console.error(`no disc at ${disc} (--disc <the extracted disc>): the disc check needs it`); process.exit(1); }
const files = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.isFile() && !e.name.startsWith('.')) { const size = fs.statSync(p).size; if (size >= PIECE) files.push({ p, r, size }); }
  }
})(disc, '');
const total = files.reduce((a, f) => a + f.size, 0), questions = [];
for (let k = 0; k < QUESTIONS; k++) {
  let at = crypto.randomInt(0, total), f = files[0];
  for (f of files) { if (at < f.size) break; at -= f.size; }
  const offset = Math.min(f.size - PIECE, at) & ~4095, fd = fs.openSync(f.p, 'r'), buf = Buffer.alloc(PIECE);
  fs.readSync(fd, buf, 0, PIECE, offset); fs.closeSync(fd);
  questions.push({ path: f.r, offset, length: PIECE, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}
fs.mkdirSync(path.join(server, 'gen'), { recursive: true });
fs.writeFileSync(path.join(server, 'gen', 'disc-proof.json'), JSON.stringify({ made: new Date().toISOString(), questions }) + '\n');
const vars = path.join(server, '.dev.vars');
if (!/^BUILD_SECRET=/m.test(fs.existsSync(vars) ? fs.readFileSync(vars, 'utf8') : ''))
  fs.appendFileSync(vars, `BUILD_SECRET=${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });

const mb = (f) => (fs.statSync(path.join(out, f)).size / 1048576).toFixed(1);
console.log(`site in ${out}: the build ${mb('build/twotowers_recomp.wasm')} MB (Cloudflare's limit: 25 MiB a file), ${support.length} Ultra support files;`);
console.log(`  the disc check: ${questions.length} questions over ${files.length} files of ${disc}`);
