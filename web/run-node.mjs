#!/usr/bin/env node
// (web port) Run the WebAssembly build under Node for a while and report.
//
//   node web/run-node.mjs [--seconds 60] [--out DIR] [--build build-web] [KEY=VALUE ...]
//
// KEY=VALUE arguments reach the game as environment variables (TT_TWEAKS,
// TT_SHOTS, TT_P1SCRIPT, RECOMP_RENDERER, ...). The game sees the host's files
// under /host; "@out" in a value stands for the run's folder there, e.g.
//   TT_SHOTS=20000:@out/title.bmp
// The disc defaults to isos/extracted and the renderer to software. The log
// (twotowers_log.txt), ini and frames land in the run's folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let seconds = 60, out = null, build = path.join(repo, 'build-web');
const pass = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seconds') seconds = Number(argv[++i]);
  else if (a === '--out') out = path.resolve(argv[++i]);
  else if (a === '--build') build = path.resolve(argv[++i]);
  else if (a.includes('=')) pass.push(a);
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-run-'));
fs.mkdirSync(out, { recursive: true });

const host = (p) => '/host' + path.resolve(p);
const env = {
  TT_WEB_HOME: host(out),
  TWOTOWERS_GAME_DIR: host(path.join(repo, 'isos', 'extracted')),
  RECOMP_RENDERER: 'software',
};
for (const kv of pass) {
  const k = kv.slice(0, kv.indexOf('=')), v = kv.slice(kv.indexOf('=') + 1);
  env[k] = v.replaceAll('@out', host(out));
}
const args = [path.join(build, 'twotowers_recomp.js'), ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];

const t0 = Date.now();
const log = fs.createWriteStream(path.join(out, 'stdout.txt'));
const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const timer = setTimeout(() => { child.kill('SIGKILL'); }, seconds * 1000);
child.on('exit', (code, sig) => {
  clearTimeout(timer);
  log.end(() => report(code, sig));
});

function report(code, sig) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const read = (f) => { try { return fs.readFileSync(path.join(out, f), 'utf8'); } catch { return ''; } };
  const text = read('stdout.txt') + '\n' + read('twotowers_log.txt');
  const lines = text.split('\n');
  const pick = (re, n = 8) => lines.filter((l) => re.test(l) && l.length < 2000).slice(0, n).map((l) => l.slice(0, 200));
  const crash = pick(/\[CRASH\]|Aborted|RuntimeError|abort\(|unreachable|out of bounds/i, 12);
  const keys = pick(/\[WEB\]|\[WASM\]|\[BOOT\]|\[GL\]|\[NV2A\] GPU|\[FBWIN\]|\[SW3D\]|Starting game|\[EXIT\]/);
  const ended = sig === 'SIGKILL' ? `still running at ${seconds}s (stopped)` : `exited (code ${code}${sig ? ', ' + sig : ''})`;
  console.log(`run: ${ended} after ${secs}s; output in ${out}`);
  if (keys.length) console.log('boot:\n  ' + keys.join('\n  '));
  if (crash.length) console.log('PROBLEMS:\n  ' + crash.join('\n  '));
  const shots = fs.readdirSync(out).filter((f) => /\.(bmp|png)$/i.test(f));
  if (shots.length) console.log('frames: ' + shots.join(', '));
  console.log('last lines:\n  ' + lines.filter((l) => l.trim() && !/UNIMPL/.test(l)).slice(-8).join('\n  '));
}
