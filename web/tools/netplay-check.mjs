#!/usr/bin/env node
// (web port) Two players in two headless Chromes, one online co-op match:
//
//   node web/tools/netplay-check.mjs [--seconds 150] [--out DIR] [--match CODE] [KEY=VALUE ...]
//
// Needs web/serve.mjs (8080) and the netplay server (web/netplay-server: npm run
// dev, 8787) running. Each browser has its own profile (its own saves). The
// host gets a scripted gamepad (walks and attacks from 40 s on); the guest is
// idle. Prints each side's status, the match line and the [NETPLAY] lines, and
// saves both canvases.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seconds = 150, out = null, match = 'check' + Math.floor(Math.random() * 1e6);
const query = new URLSearchParams();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--seconds') seconds = Number(argv[++i]);
  else if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else if (argv[i] === '--match') match = argv[++i];
  else if (argv[i].includes('=')) query.append(argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1));
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-netplay-'));
query.set('match', match);
const url = 'http://localhost:8080/?' + query.toString();
const exe = (() => {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
})();

async function player(name, scripted) {
  const ctx = await chromium.launchPersistentContext(path.join(out, name + '-profile'), {
    executablePath: exe, headless: true, viewport: { width: 1000, height: 1100 },
    // (two headless Chromes cannot resolve each other's mDNS host names: real addresses here)
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  if (scripted) await page.addInitScript(() => {
    const t0 = performance.now();
    const btn = (on) => ({ pressed: on, touched: on, value: on ? 1 : 0 });
    navigator.getGamepads = () => {
      const t = (performance.now() - t0) / 1000, k = Math.floor(t * 2);
      const walk = t > 40 && Math.floor(t / 3) % 3 !== 2;
      const buttons = Array.from({ length: 17 }, (_, i) => btn(t > 40 && ((i === 2 && k % 4 === 0) || (i === 3 && k % 7 === 3))));
      return [{ id: 'scripted pad', index: 0, connected: true, mapping: 'standard', buttons,
        axes: [walk ? Math.sin(t / 2) * 0.6 : 0, walk ? -0.9 : 0, 0, 0], timestamp: performance.now() }];
    };
  });
  await page.goto(url);
  return { name, ctx, page };
}

const host = await player('host', true);
await new Promise((r) => setTimeout(r, 3000));
const guest = await player('guest', false);
await new Promise((r) => setTimeout(r, seconds * 1000));
for (const p of [host, guest]) {
  const st = await p.page.evaluate(() => [document.getElementById('status')?.textContent, document.getElementById('netplay')?.textContent], null, { timeout: 30000 }).catch(() => ['?', '?']);
  const lines = await p.page.evaluate(() => (self.ttKeyLines || []).concat(self.ttLogLines || []).filter((l) => /NETPLAY/.test(l)), null, { timeout: 30000 }).catch(() => []);
  await p.page.locator('#screen').screenshot({ path: path.join(out, p.name + '.png'), timeout: 60000 }).catch(() => {});
  console.log(`--- ${p.name}: ${st[0]}\n    ${st[1]}`);
  console.log([...new Set(lines)].slice(0, 12).map((l) => '    ' + l.slice(0, 160)).join('\n'));
  await p.ctx.close();
}
console.log('output: ' + out);
