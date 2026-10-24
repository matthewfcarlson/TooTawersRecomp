#!/usr/bin/env node
// (web port) Open the game's page in headless Chromium and report what it did.
//
//   node web/tools/browser-check.mjs [--seconds 40] [--out DIR] [--url http://localhost:8080/] [KEY=VALUE ...]
//
// --push FILE:PATH puts a file into the page's storage before the game starts (PATH from the OPFS root: the game
// sees tt/x as /opfs/tt/x); --pull PATH copies one out into DIR afterwards (a state hash, TT_STATEHASH=/opfs/tt/h.bin).
//
// Needs web/serve.mjs running. KEY=VALUE arguments go into the page's query
// (the game's switches). Writes screen.png (the page) and console.txt to DIR,
// and prints the page's status line and the end of the game's log. Uses
// Playwright's cached Chromium (npx playwright install chromium, or
// CHROMIUM=<path to an executable>).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seconds = 40, out = null, url = 'http://localhost:8080/', gpu = false;
const pushes = [], pulls = [];
const query = new URLSearchParams();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seconds') seconds = Number(argv[++i]);
  else if (a === '--out') out = path.resolve(argv[++i]);
  else if (a === '--url') url = argv[++i];
  else if (a === '--gpu') gpu = true;
  else if (a === '--push') pushes.push(argv[++i].split(':'));
  else if (a === '--pull') pulls.push(argv[++i]);
  else if (a.includes('=')) query.append(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-browser-'));
fs.mkdirSync(out, { recursive: true });

function cachedChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const alt = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const base of [root, alt]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

// a profile of its own on disk, like a real browser's: an incognito context
// has a small storage quota, too small for the game's hard-disk images in OPFS
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  executablePath: cachedChromium(), headless: true, viewport: { width: 1000, height: 1100 },
  // --gpu: the machine's GPU (headless Chrome otherwise draws WebGL in software, SwiftShader)
  args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=' + (process.platform === 'darwin' ? 'metal' : 'default')] : [] });
const page = browser.pages()[0] ?? await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
const full = url + (query.toString() ? '?' + query.toString() : '');
// a file in OPFS, from the page: {path}, read as base64 / written from base64
const opfs = (op, rel, b64) => page.evaluate(async ([op, rel, b64]) => {
  let d = await navigator.storage.getDirectory(); const parts = rel.split('/');
  for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: op === 'put' });
  if (op === 'put') { const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close(); return null; }
  const b = new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s);
}, [op, rel, b64]);
if (pushes.length) {   // (into the origin's storage from a page of it that runs nothing: then the game's page)
  await page.goto(new URL(url).origin + '/pass.js');
  for (const [file, rel] of pushes) await opfs('put', rel, fs.readFileSync(file).toString('base64'));
}
await page.goto(full);
await page.waitForTimeout(seconds * 1000);
const status = await page.textContent('#status').catch(() => '(no status)');
const gameLog = await page.evaluate(() => (self.ttLogLines || []).join('\n'), null, { timeout: 30000 }).catch(() => '');
fs.writeFileSync(path.join(out, 'game-log.txt'), gameLog);
const keyLines = await page.evaluate(() => (self.ttKeyLines || []).join('\n'), null, { timeout: 30000 }).catch(() => '');
fs.writeFileSync(path.join(out, 'key-lines.txt'), keyLines);
await page.screenshot({ path: path.join(out, 'screen.png'), timeout: 90000 }).catch((e) => console.log('screenshot failed: ' + e.message.split('\n')[0]));
await page.locator('#screen').screenshot({ path: path.join(out, 'canvas.png') }).catch(() => {});
fs.writeFileSync(path.join(out, 'console.txt'), consoleLines.join('\n'));
for (const rel of pulls) {
  const b64 = await opfs('get', rel).catch((e) => { console.log(`pull ${rel}: ${e.message.split('\n')[0]}`); return null; });
  if (b64) fs.writeFileSync(path.join(out, path.basename(rel)), Buffer.from(b64, 'base64'));
}
await browser.close();

const bad = consoleLines.filter((l) => /pageerror|\[error\]|RuntimeError|Aborted|\[CRASH\]/i.test(l));
console.log(`page: ${full}\nstatus: ${status}\noutput: ${out}`);
if (bad.length) console.log('PROBLEMS:\n  ' + bad.slice(0, 10).map((l) => l.slice(0, 220)).join('\n  '));
console.log('console:\n  ' + consoleLines.slice(-6).map((l) => l.slice(0, 220)).join('\n  '));
console.log('key lines:\n  ' + keyLines.split('\n').filter((l) => /\[(WEB|ULTRA|GL)\]/.test(l)).slice(0, 14).map((l) => l.slice(0, 200)).join('\n  '));
console.log('game log (end):\n  ' + gameLog.split('\n').filter((l) => l.trim() && !/UNIMPL/.test(l)).slice(-14).map((l) => l.slice(0, 220)).join('\n  '));
