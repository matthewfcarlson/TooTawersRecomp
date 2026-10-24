#!/usr/bin/env node
// (web port) Two players in two headless Chromes, one online co-op match:
//
//   node web/tools/netplay-check.mjs [--seconds 150] [--out DIR] [--match CODE] [--guest-cdp URL] [--guest-pause S] [KEY=VALUE ...]
//
// Needs web/serve.mjs (8080) and the netplay server (web/netplay-server: npm run
// dev, 8787) running. Each browser has its own profile (its own saves). The
// host gets a scripted gamepad (walks and attacks from 40 s on); the guest is
// idle. Prints each side's status, the match line and the [NETPLAY] lines, and
// saves both canvases.
//
// --guest-cdp http://localhost:9223: the guest is a Chromium on another machine, started there with
// --remote-debugging-port and reached through an ssh tunnel that also gives it this machine's 8080 and
// 8787 (web/README.md, "Two machines"): the game then runs on that machine, the match over the network.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seconds = 150, out = null, guestCdp = null, menusAt = 0, guestPause = 0, shotsEvery = 0, pulls = [], match = 'check' + Math.floor(Math.random() * 1e6);
const query = new URLSearchParams();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--seconds') seconds = Number(argv[++i]);
  else if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else if (argv[i] === '--match') match = argv[++i];
  else if (argv[i] === '--guest-cdp') guestCdp = argv[++i];
  else if (argv[i] === '--menus') menusAt = Number(argv[++i]);
  else if (argv[i] === '--guest-pause') guestPause = Number(argv[++i]);
  else if (argv[i] === '--shots') shotsEvery = Number(argv[++i]);
  else if (argv[i] === '--pull') pulls.push(argv[++i]);
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

// --menus S: from S seconds on, the host's pad presses A and Start instead of attacking (through a level's
// end, its screens and shops: with TT_NETPLAY_MENUS=1 and TT_COOP_TESTEND)
async function player(name, scripted, cdp) {
  let ctx, page, browser;
  if (cdp) {   // (a browser elsewhere: a fresh context of its own, closed at the end)
    browser = await chromium.connectOverCDP(cdp);
    ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    page = await ctx.newPage();
  } else {
    ctx = await chromium.launchPersistentContext(path.join(out, name + '-profile'), {
      executablePath: exe, headless: true, viewport: { width: 1000, height: 1100 },
      // (two headless Chromes cannot resolve each other's mDNS host names: real addresses here)
      args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
    page = ctx.pages()[0] ?? await ctx.newPage();
  }
  if (scripted) await page.addInitScript((menusAt) => {
    const t0 = performance.now();
    const btn = (on) => ({ pressed: on, touched: on, value: on ? 1 : 0 });
    navigator.getGamepads = () => {
      const t = (performance.now() - t0) / 1000, k = Math.floor(t * 2);
      const walk = t > 40 && Math.floor(t / 3) % 3 !== 2;
      let menu = menusAt > 0 && t > menusAt;
      // (menus, by the front-end screen the game last logged: its results and shops (9, 10) right then A, to their
      // Continue; the mission select (1) a d-pad step (a walk around the map) then A, until a place opens; any other A and Start)
      const press = (every, at = 0) => (t + at) % every < 0.25;
      const lines = self.ttKeyLines || [];
      let screen = -1;
      for (let j = lines.length - 1; j >= 0 && j > lines.length - 400; j--) { const m = /front-end screen (\d+)/.exec(lines[j]); if (m) { screen = +m[1]; break; } }
      const shop = screen === 9 || screen === 10;
      if (screen === 6 || screen === 8) menu = false;   // (in play again -- the next level: fighting, not Start's pause menu)
      const buttons = Array.from({ length: 17 }, (_, i) => btn(t > 40 && (menu
        ? (i === 0 && press(shop ? 3 : screen === 1 ? 4 : 2.5, shop ? 1.5 : screen === 1 ? 2 : 0)) || (shop && i === 15 && press(3))
          || (screen === 1 && i === [14, 12, 15, 13][(Math.floor(t / 4) * 7 + 3) % 11 % 4] && press(4)) || (!shop && screen !== 1 && i === 9 && press(6.5, 1))
        : (i === 2 && k % 4 === 0) || (i === 3 && k % 7 === 3))));
      return [{ id: 'scripted pad', index: 0, connected: true, mapping: 'standard', buttons,
        axes: [walk ? Math.sin(t / 2) * 0.6 : 0, walk ? -0.9 : 0, 0, 0], timestamp: performance.now() }];
    };
  }, menusAt);
  // --guest-pause S: the guest's pad presses Start at S seconds and again 10 s later (its pause, then on)
  if (!scripted && guestPause > 0) await page.addInitScript((at) => {
    const t0 = performance.now();
    navigator.getGamepads = () => {
      const t = (performance.now() - t0) / 1000, on = (t > at && t < at + 0.3) || (t > at + 10 && t < at + 10.3);
      const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: on && i === 9, touched: on && i === 9, value: on && i === 9 ? 1 : 0 }));
      return [{ id: 'scripted pad', index: 0, connected: true, mapping: 'standard', buttons, axes: [0, 0, 0, 0], timestamp: performance.now() }];
    };
  }, guestPause);
  await page.goto(url);
  return { name, ctx, page, browser };
}

const host = await player('host', true);
await new Promise((r) => setTimeout(r, 3000));
const guest = await player('guest', false, guestCdp);
// --shots S: both players' pictures every S seconds, side by side in time (<out>/<s>-host.png, -guest.png)
const shot = (p, name) => p.page.locator('#screen').screenshot({ path: path.join(out, name), timeout: 60000 }).catch((e) => console.log(`(${name}: no screenshot: ${e.message.split('\n')[0]})`));
for (let t = 0; t < seconds; ) {
  const step = shotsEvery > 0 ? Math.min(shotsEvery, seconds - t) : seconds - t;
  await new Promise((r) => setTimeout(r, step * 1000)); t += step;
  if (shotsEvery > 0) await Promise.all([shot(host, `${String(t).padStart(4, '0')}-host.png`), shot(guest, `${String(t).padStart(4, '0')}-guest.png`)]);
}
await Promise.all([shot(host, 'host.png'), shot(guest, 'guest.png')]);   // (both at once: then the ends)
for (const p of [host, guest]) {
  const all = await p.page.evaluate(() => [(self.ttKeyLines || []).join('\n'), (self.ttLogLines || []).join('\n')], null, { timeout: 30000 }).catch(() => ['', '']);
  fs.writeFileSync(path.join(out, `${p.name}-key-lines.txt`), all[0]); fs.writeFileSync(path.join(out, `${p.name}-log.txt`), all[1]);
  for (const rel of pulls) {   // (--pull PATH: a file from each player's storage, e.g. a state hash: <name>-<file>)
    const b64 = await p.page.evaluate(async (rel) => {
      let d = await navigator.storage.getDirectory(); const parts = rel.split('/');
      for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
      const b = new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
      let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s);
    }, rel).catch((e) => { console.log(`(${p.name}: pull ${rel}: ${e.message.split('\n')[0]})`); return null; });
    if (b64) fs.writeFileSync(path.join(out, `${p.name}-${path.basename(rel)}`), Buffer.from(b64, 'base64'));
  }
  const st = await p.page.evaluate(() => [document.getElementById('status')?.textContent, document.getElementById('netplay')?.textContent], null, { timeout: 30000 }).catch(() => ['?', '?']);
  const lines = await p.page.evaluate(() => (self.ttKeyLines || []).concat(self.ttLogLines || []).filter((l) => /NETPLAY/.test(l)), null, { timeout: 30000 }).catch(() => []);
  console.log(`--- ${p.name}: ${st[0]}\n    ${st[1]}`);
  const u = [...new Set(lines)];
  console.log(u.slice(0, 8).concat(u.length > 14 ? ['    ...'] : [], u.slice(Math.max(8, u.length - 6))).map((l) => '    ' + l.slice(0, 160)).join('\n'));
  await p.ctx.close();
  if (p.browser) await p.browser.close();   // (only disconnects: that browser stays up)
}
console.log('output: ' + out);
