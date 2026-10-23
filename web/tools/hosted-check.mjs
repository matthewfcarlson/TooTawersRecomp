#!/usr/bin/env node
// (web port) The hosted site's first run, as a player has it: a fresh browser
// opens the site (wrangler dev in web/netplay-server, after web/site.mjs),
// picks the ISO (and the GLOS69 folder: --pack, then the Ultra build), and
// plays. Reports each step's time and the game's start.
//
//   node web/tools/hosted-check.mjs --iso <file> [--pack <GLOS69 folder>] [--url http://localhost:8787/] [--out DIR] [--seconds 40]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedChromium } from './chromium.mjs';

let iso = null, pack = null, url = 'http://localhost:8787/', out = null, seconds = 40;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--iso') iso = path.resolve(argv[++i]);
  else if (argv[i] === '--pack') pack = path.resolve(argv[++i]);
  else if (argv[i] === '--url') url = argv[++i];
  else if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else if (argv[i] === '--seconds') seconds = Number(argv[++i]);
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-hosted-'));
const ctx = await chromium.launchPersistentContext(path.join(out, 'profile'), {
  executablePath: cachedChromium(), headless: true, viewport: { width: 1000, height: 1100 },
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=' + (process.platform === 'darwin' ? 'metal' : 'default')] });
const page = ctx.pages()[0] ?? await ctx.newPage();
const lines = [];
page.on('console', (m) => lines.push(m.text()));
page.on('pageerror', (e) => lines.push('[pageerror] ' + e.message));
const t = () => ((Date.now() - t0) / 1000).toFixed(0) + ' s';
const t0 = Date.now();
await page.goto(url);
const fresh = await page.waitForSelector('#setup:not([hidden])', { timeout: 15000 }).then(() => true, () => false);
console.log(`${t()}: ${fresh ? 'the setup panel (no disc yet)' : 'straight into the game (a disc imported before)'}`);
const settle = async (label, timeout) => {
  await page.waitForFunction(() => { const p = document.getElementById('setup-progress'); return p.hidden && !document.getElementById('setup-iso').disabled; }, null, { timeout, polling: 1000 });
  const err = await page.textContent('#setup-error');
  console.log(`${t()}: ${label}${err ? ' -- ERROR: ' + err : ''} (${await page.textContent('#setup-space')})`);
};
if (fresh && iso) {
  await page.setInputFiles('#setup-iso', iso); await page.waitForTimeout(1000); await settle('disc copied', 1800000);
  await page.waitForFunction(() => /✓/.test(document.getElementById('setup-disc-state').textContent), null, { timeout: 30000 }).catch(() => {});
  console.log(`${t()}: disc ${await page.textContent('#setup-disc-state')}`);
}
if (fresh && pack) {
  await page.setInputFiles('#setup-pack', pack); await page.waitForTimeout(1000);
  await settle('pack copied: ' + await page.textContent('#setup-ultra-state'), 3600000);
  await page.click('#setup-build');
  await page.waitForURL((u) => !u.search.includes('TT_WEB_ULTRA_BUILD'), { timeout: 7200000 });
  console.log(`${t()}: Ultra textures built`);
  await page.waitForSelector('#setup-play:not([disabled])', { timeout: 60000 }).catch(() => {});
}
// a disc imported before: the page goes straight into the game; else press Play
if (await page.isVisible('#setup-play')) await page.click('#setup-play');
await page.waitForTimeout(seconds * 1000);
lines.push(...await page.evaluate(() => [...(self.ttKeyLines || []), ...(self.ttLogLines || [])]).catch(() => []));
await page.locator('#screen').screenshot({ path: path.join(out, 'canvas.png') }).catch(() => {});
fs.writeFileSync(path.join(out, 'console.txt'), lines.join('\n'));
await ctx.close();
console.log(`${t()}: played ${seconds} s; output in ${out}`);
const key = lines.filter((l) => /\[WEB\]|\[ULTRA|pageerror|RuntimeError|Aborted|\[CRASH\]/.test(l));
console.log(key.slice(0, 20).map((l) => '  ' + l.slice(0, 200)).join('\n'));
const fps = lines.map((l) => l.match(/\[FPS\] (\d+) flips/)).filter(Boolean).map((m) => +m[1]);
console.log(`frames/s, last ten seconds: ${fps.slice(-10).join(' ')}`);
