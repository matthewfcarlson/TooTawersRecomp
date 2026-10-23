#!/usr/bin/env node
// (web port) Profile the game in headless Chromium: the sampling CPU profiler
// on every worker (the game's threads are workers), then time per function.
//
//   node web/tools/profile.mjs [--warmup 40] [--seconds 15] [--top 30] [--out DIR] [KEY=VALUE ...]
//
// Needs web/serve.mjs running. Waits --warmup seconds (loading), profiles for
// --seconds, writes one .cpuprofile per busy worker to DIR (open them in
// Chrome DevTools' Performance panel) and prints each one's top functions by
// self time. Built with --profiling-funcs, the wasm functions carry their
// names (sub_XXXXXXXX: the game's code at that address).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let warmup = 40, seconds = 15, top = 30, out = null, url = 'http://localhost:8080/';
const query = new URLSearchParams();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--warmup') warmup = Number(argv[++i]);
  else if (a === '--seconds') seconds = Number(argv[++i]);
  else if (a === '--top') top = Number(argv[++i]);
  else if (a === '--out') out = path.resolve(argv[++i]);
  else if (a === '--url') url = argv[++i];
  else if (a.includes('=')) query.append(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-profile-'));
fs.mkdirSync(out, { recursive: true });

function cachedChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const base of [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
  }
  return undefined;
}

const ctx = await chromium.launchPersistentContext(path.join(out, 'profile-dir'), {
  executablePath: cachedChromium(), headless: true, viewport: { width: 1000, height: 1100 } });
const page = ctx.pages()[0] ?? await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

// workers through the old non-flattened protocol: messages wrapped per session
const workers = new Map();   // sessionId -> { url, pending: Map(id -> resolve) }
let nextId = 1;
cdp.on('Target.attachedToTarget', (e) => {
  if (e.targetInfo.type === 'worker') workers.set(e.sessionId, { title: e.targetInfo.url, pending: new Map() });
});
cdp.on('Target.receivedMessageFromTarget', (e) => {
  const w = workers.get(e.sessionId);
  const msg = JSON.parse(e.message);
  if (w && msg.id && w.pending.has(msg.id)) { w.pending.get(msg.id)(msg); w.pending.delete(msg.id); }
});
function send(sessionId, method, params = {}) {
  const w = workers.get(sessionId), id = nextId++;
  return new Promise((resolve) => {
    w.pending.set(id, resolve);
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => resolve({}));
  });
}
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });

const full = url + (query.toString() ? '?' + query.toString() : '');
await page.goto(full);
console.log(`page: ${full}\nwarming up ${warmup}s, then profiling ${seconds}s on ${workers.size}+ workers`);
await page.waitForTimeout(warmup * 1000);
const ids = [...workers.keys()];
await Promise.all(ids.map(async (s) => { await send(s, 'Profiler.enable'); await send(s, 'Profiler.setSamplingInterval', { interval: 200 }); await send(s, 'Profiler.start'); }));
await page.waitForTimeout(seconds * 1000);
const profiles = await Promise.all(ids.map((s) => send(s, 'Profiler.stop').then((r) => ({ s, p: r.result?.profile }))));
const status = await page.evaluate(() => document.getElementById('status')?.textContent, null, { timeout: 20000 }).catch(() => '?');
await ctx.close();

// self time per function, per worker (time spent waiting left out)
const WAITS = new Set(['(idle)', '(program)', 'emscripten_futex_wait', 'Atomics.wait', '(root)']);
const results = [];
for (const { s, p } of profiles) {
  if (!p) continue;
  const dt = new Map();   // node id -> self microseconds
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) || 0) + (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0));
  const byFn = new Map();
  let busy = 0, total = 0;
  for (const n of p.nodes) {
    const us = dt.get(n.id) || 0;
    total += us;
    const name = n.callFrame.functionName || '(anonymous)';
    if (WAITS.has(name)) continue;   // a thread waiting, not working
    busy += us;
    byFn.set(name, (byFn.get(name) || 0) + us);
  }
  results.push({ s, p, busy, total, byFn });
}
results.sort((a, b) => b.busy - a.busy);
console.log(`status at the end: ${status}`);
results.forEach((r, k) => {
  if (r.busy < 0.02 * r.total && k > 0) return;   // (idle threads: not listed)
  const file = path.join(out, `worker${k}.cpuprofile`);
  fs.writeFileSync(file, JSON.stringify(r.p));
  const rows = [...r.byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`\nworker ${k}: busy ${(100 * r.busy / Math.max(1, r.total)).toFixed(0)}% of ${(r.total / 1e6).toFixed(1)}s  (${file})`);
  for (const [name, us] of rows) console.log(`  ${(100 * us / Math.max(1, r.busy)).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(7)} ms  ${name.slice(0, 90)}`);
});
