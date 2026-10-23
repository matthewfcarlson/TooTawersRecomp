#!/usr/bin/env node
// (web port) Playing together, as two players do it on the hosted page: two headless Chromes; the host makes a
// game on the splash (lobby.js), the guest opens its link, both press Play; a minute in, the host reloads and
// presses Play again, and the guest's page must start over with it (netplay.js). Prints each side's match line.
//
//   node web/tools/together-check.mjs OUT_DIR [URL (default http://localhost:8787/)] [ISO (imports it into a fresh profile)]
import { chromium } from 'playwright-core';
import { cachedChromium } from './chromium.mjs';
const out = process.argv[2], base = process.argv[3] || 'http://localhost:8787/', iso = process.argv[4];
const open = async (name) => {
  const ctx = await chromium.launchPersistentContext(`${out}/${name}`, { executablePath: cachedChromium(), headless: true, viewport: { width: 1280, height: 1000 },
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`));
  return { ctx, page };
};
const net = (p) => p.evaluate(() => document.getElementById('netplay')?.textContent).catch(() => '?');
const host = await open('host'), guest = await open('guest');
for (const p of [host, guest]) {   // (a fresh profile: import the disc first)
  await p.page.goto(base); await p.page.waitForSelector('#setup:not([hidden])');
  if (!/✓/.test(await p.page.textContent('#setup-disc-state').catch(() => '')) && iso) {
    await p.page.waitForTimeout(1000);
    if (!/✓/.test(await p.page.textContent('#setup-disc-state'))) {
      await p.page.setInputFiles('#setup-iso', iso);
      await p.page.waitForFunction(() => /✓/.test(document.getElementById('setup-disc-state').textContent), null, { timeout: 600000 });
      console.log('disc imported');
    }
  }
}
await host.page.goto(base); await host.page.waitForSelector('#together-new:not([hidden])');
await host.page.selectOption('#together-p2', 'legolas');
await host.page.click('#together-create');
await host.page.waitForURL(/match=/); await host.page.waitForSelector('#together-game:not([hidden])');
const link = await host.page.inputValue('#together-link');
console.log('link:', link, '|', await host.page.textContent('#together-what'));
await host.page.screenshot({ path: `${out}/host-splash.png` });
await guest.page.goto(link); await guest.page.waitForSelector('#together-game:not([hidden])'); await guest.page.waitForTimeout(2000);
console.log('guest sees:', await guest.page.textContent('#together-what'), '|', await guest.page.textContent('#together-status'));
console.log('host sees:', await host.page.textContent('#together-status'));
await guest.page.screenshot({ path: `${out}/guest-splash.png` });
await host.page.click('#setup-play'); await guest.page.click('#setup-play');
await host.page.waitForTimeout(60000);
console.log('60 s in. host:', await net(host.page), '| guest:', await net(guest.page));
console.log('host args:', await host.page.evaluate(() => Module.arguments.filter((a) => /TT_(TWEAKS|COOP|NETPLAY)/.test(a)).join(' ')));
console.log('guest args:', await guest.page.evaluate(() => Module.arguments.filter((a) => /TT_(TWEAKS|COOP|NETPLAY)/.test(a)).join(' ')));
console.log('-- the host reloads');
await host.page.reload(); await host.page.waitForSelector('#setup-play:not([disabled])'); await host.page.click('#setup-play');
await guest.page.waitForTimeout(8000);
console.log('guest after:', await net(guest.page), '| guest url', guest.page.url());
await host.page.waitForTimeout(60000);
console.log('60 s after. host:', await net(host.page), '| guest:', await net(guest.page));
const fps = async (p) => p.evaluate(() => document.getElementById('status').textContent).catch(() => '?');
console.log('status host:', await fps(host.page), '| guest:', await fps(guest.page));
await host.ctx.close(); await guest.ctx.close();
