#!/usr/bin/env node
// (web port) A shared game's saves, as players have them (lobby.js, saves.js): two headless Chromes on the hosted
// page. The host has a save the guest hasn't; the host makes a game, the guest joins: the guest's game must run on a
// copy of the host's files (tt-games/<code>, its own saves untouched), both fingerprints the same. Then the guest
// keeps the game's saves, downloads its saves as a .zip and imports it in the host's browser. Last, a guest whose
// copy arrives with another fingerprint (changed on the way) must be refused.
//
//   node web/tools/saves-check.mjs OUT_DIR [URL (default http://localhost:8787/)] ISO
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { cachedChromium } from './chromium.mjs';

const [out, base = 'http://localhost:8787/', iso] = process.argv.slice(2);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };
const open = async (name) => {
  const ctx = await chromium.launchPersistentContext(path.join(out, name), { executablePath: cachedChromium(), headless: true,
    viewport: { width: 1280, height: 1000 }, acceptDownloads: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const log = [];
  page.on('console', (m) => log.push(m.text()));
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  await page.goto(base); await page.waitForSelector('#setup:not([hidden])'); await page.waitForTimeout(1000);
  if (!/✓/.test(await page.textContent('#setup-disc-state'))) {
    await page.setInputFiles('#setup-iso', iso);
    await page.waitForFunction(() => /✓/.test(document.getElementById('setup-disc-state').textContent), null, { timeout: 600000 });
  }
  return { name, ctx, page, log };
};
// a file's bytes in a page's storage (path from the OPFS root), or null
const read = (p, rel) => p.page.evaluate(async (rel) => {
  try { let d = await navigator.storage.getDirectory(); const parts = rel.split('/');
    for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
    return [...new Uint8Array(await (await (await d.getFileHandle(parts.at(-1))).getFile()).arrayBuffer())]; } catch { return null; }
}, rel);
const SAVE = 'tt/saves/UDATA/45410010/TESTSAVE01/notes.bin';
const bytes = Array.from({ length: 70000 }, (_, i) => (i * 31 + 7) & 255);

const host = await open('host');
await host.page.evaluate(async ([rel, b]) => {   // the host's save (a stand-in: a folder the game doesn't read)
  let d = await navigator.storage.getDirectory(); const parts = rel.split('/');
  for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable(); await w.write(new Uint8Array(b)); await w.close();
}, [SAVE, bytes]);
await host.page.reload(); await host.page.waitForSelector('#together-new:not([hidden])');
await host.page.selectOption('#together-difficulty', '2');
await host.page.click('#together-create');
await host.page.waitForSelector('#together-game:not([hidden])');
const link = await host.page.inputValue('#together-link'), code = new URL(link).searchParams.get('match');
console.log('game', code, '·', await host.page.textContent('#together-what'));

const guest = await open('guest');
check(await read(guest, SAVE) === null, 'the guest does not have the host’s save');
await guest.page.goto(link);
await guest.page.waitForFunction(() => /✓/.test(document.getElementById('together-files').textContent), null, { timeout: 60000 }).catch(() => {});
console.log('  guest:', await guest.page.textContent('#together-files'));
await host.page.waitForFunction(() => /✓/.test(document.getElementById('together-files').textContent), null, { timeout: 30000 }).catch(() => {});
console.log('  host: ', await host.page.textContent('#together-files'));
const fpOf = async (p) => (/fingerprint (\w+)/.exec(await p.page.textContent('#together-files')) || [])[1];
check((await fpOf(guest)) && (await fpOf(guest)) === (await fpOf(host)), 'both pages have the same fingerprint');
const copy = await read(guest, SAVE.replace('tt/', `tt-games/${code}/`));
check(copy && copy.length === bytes.length && copy.every((x, i) => x === bytes[i]), 'the guest has the host’s save, byte for byte, in the game’s own folder');
check(await read(guest, SAVE) === null, 'the guest’s own saves are untouched');

await host.page.click('#setup-play'); await guest.page.click('#setup-play');
await guest.page.waitForTimeout(45000);
const homeLine = (await guest.page.evaluate(() => self.ttKeyLines || [])).find((l) => /\[WEB\] browser, home/.test(l)) || '';
check(homeLine.includes(`/opfs/tt-games/${code}`), `the guest’s game runs on that folder (${homeLine.trim()})`);
const args = await guest.page.evaluate(() => Module.arguments.join(' '));
check(/TT_COOP_DIFFICULTY=2/.test(args) && /TT_COOP_P2BOT=0/.test(args), 'the guest’s game has the host’s co-op settings (Expert)');
const net = (p) => p.page.evaluate(() => document.getElementById('netplay').textContent).catch(() => '?');
const nh = await net(host), ng = await net(guest);
console.log('  host:', nh, '\n  guest:', ng);
check(/connected/.test(nh) && /connected/.test(ng) && !/DESYNC/.test(nh + ng), 'the two games run together, no desync');
await host.ctx.close(); await guest.ctx.close();

// keep, download, import
const g2 = await open('guest');
await g2.page.goto(link); await g2.page.waitForSelector('#together-keep:not([hidden])', { timeout: 30000 }).catch(() => {});
g2.page.on('dialog', (d) => d.accept());
await g2.page.click('#together-keep').catch(() => {});
await g2.page.waitForTimeout(1500);
const kept = await read(g2, SAVE);
check(kept && kept.length === bytes.length, `“Keep” puts the game’s saves into the guest’s own (${await g2.page.textContent('#together-keep').catch(() => '?')})`);
await g2.page.goto(base); await g2.page.waitForSelector('#saves-download');
const [dl] = await Promise.all([g2.page.waitForEvent('download'), g2.page.click('#saves-download')]);
const zipPath = path.join(out, 'saves.zip'); await dl.saveAs(zipPath);
check(fs.statSync(zipPath).size > bytes.length, `the download is a .zip of the saves (${fs.statSync(zipPath).size} bytes, ${dl.suggestedFilename()})`);
await g2.ctx.close();
const h2 = await open('host');
await h2.page.evaluate(async () => { const r = await navigator.storage.getDirectory(); await (await (await (await (await r.getDirectoryHandle('tt')).getDirectoryHandle('saves')).getDirectoryHandle('UDATA')).getDirectoryHandle('45410010')).removeEntry('TESTSAVE01', { recursive: true }); });
check(await read(h2, SAVE) === null, 'the host’s save removed');
h2.page.on('dialog', (d) => d.accept());
await h2.page.setInputFiles('#saves-import', zipPath); await h2.page.waitForTimeout(2000);
const back = await read(h2, SAVE);
check(back && back.every((x, i) => x === bytes[i]), `importing the .zip brings it back (${await h2.page.textContent('#saves-state')})`);
await h2.ctx.close();

// a copy that arrives changed: refused
const g3 = await open('guest');   // (the same player: a game keeps its two)
await g3.page.routeWebSocket(/\/match\//, (ws) => {
  const server = ws.connectToServer();
  server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"saves-part"') ? m.replace(/"fp":"(\w)/, (_, c) => `"fp":"${c === '0' ? '1' : '0'}`) : m));
  ws.onMessage((m) => server.send(m));
});
const h3 = await open('host');
await h3.page.goto(link); await h3.page.waitForTimeout(3000);
await g3.page.goto(link);
await g3.page.waitForTimeout(8000);
const said = await g3.page.textContent('#together-files');
check(/would not be the same/.test(said), `a changed copy is refused (${said})`);
check(/would not be the same/.test(await h3.page.textContent('#together-files')), 'and the host is told');
await g3.ctx.close(); await h3.ctx.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
