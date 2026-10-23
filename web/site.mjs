#!/usr/bin/env node
// (web port) The hosted site's files, for Cloudflare (web/netplay-server: one
// Worker serves them as static assets beside the match server):
//
//   node web/site.mjs [--build build-web]   -> web/netplay-server/public/
//
// The page, its scripts, the build, the port's own files for the Ultra
// textures' build (ultra-support/), and _headers: the cross-origin isolation
// threads need. No game files: players import their own (import.js).
// The build is the game's code translated from the disc: public/ is never
// committed (.gitignore), and publishing it is the owner's decision.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let build = path.join(repo, 'build-web');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i] === '--build') build = path.resolve(argv[++i]);
const out = path.join(repo, 'web', 'netplay-server', 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'ultra-support', 'masks'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));
for (const f of ['index.html', 'netplay.js', 'import.js', 'import-worker.js']) copy(path.join(repo, 'web', f), f);
for (const f of ['twotowers_recomp.js', 'twotowers_recomp.wasm']) {
  if (!fs.existsSync(path.join(build, f))) { console.error(`no ${f} in ${build}: build first (web/build.sh)`); process.exit(1); }
  copy(path.join(build, f), f);
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
const mb = (f) => (fs.statSync(path.join(out, f)).size / 1048576).toFixed(1);
console.log(`site in ${out}: the build ${mb('twotowers_recomp.wasm')} MB (Cloudflare's limit: 25 MiB a file), ${support.length} Ultra support files`);
