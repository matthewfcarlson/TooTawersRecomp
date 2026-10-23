#!/usr/bin/env node
// (web port) The co-op bot suite (tools/coop-bot, upstream's, Windows) on the
// web build: the same fourteen scenarios and checks, each run in headless
// Chromium on the page served by web/serve.mjs, its log checked as the
// PowerShell suite checks twotowers_log.txt.
//
//   node web/tools/coop-suite.mjs [--only a,b] [--out DIR] [--url http://localhost:8080/]
//                                 [--no-gpu] [--min-fps 28] [--slack 15] [--save DIR] [KEY=VALUE ...]
//
// Each scenario gets a browser profile of its own (its own OPFS: a fresh ini
// and saves), except save_reload, which goes on in save_buy's. --save DIR: a
// save to start the save scenarios from (the contents of a game's
// UDATA/45410010 folder, as the PowerShell suite's $SaveBackup); without it
// they start with no save, and the checks written against upstream's save
// (README there) may not hold. KEY=VALUE: switches for every scenario (e.g.
// TT_ULTRA_TEX=0). Pad scripts are read from /bot (serve.mjs serves
// tools/coop-bot there). Frames: the page's canvas at each scenario's shot
// times (the game's own frame dumps go to OPFS, where they are not kept).
//
// Writes <out>/<scenario>/{log.txt,shot_<s>.png} and <out>/summary.txt; prints
// PASS/FAIL per check. Exit code: the number of failed checks.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedChromium } from './chromium.mjs';

let only = [], out = null, url = 'http://localhost:8080/', gpu = true, minFps = 28, slack = 15, saveDir = null;
const extra = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') only = argv[++i].split(',');
  else if (a === '--out') out = path.resolve(argv[++i]);
  else if (a === '--url') url = argv[++i];
  else if (a === '--no-gpu') gpu = false;
  else if (a === '--min-fps') minFps = Number(argv[++i]);
  else if (a === '--slack') slack = Number(argv[++i]);
  else if (a === '--save') saveDir = path.resolve(argv[++i]);
  else if (a.includes('=')) extra[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
out ??= fs.mkdtempSync(path.join(os.tmpdir(), 'tt-coop-suite-'));
fs.mkdirSync(out, { recursive: true });

// --- the scenarios: tools/coop-bot/suite.ps1's, with its runners' switches -----------------------------------------
// runner p2char (run_p2char_ms.ps1): straight into a level, player 2 as a given hero, his pad from a script
// runner menu (run_menu.ps1): from the main menu, player 1's pad from a script
const S = (name, runner, a, env, checks, save) => ({ name, runner, a, env, checks, save });
const has = (d, re) => ({ d, has: re });
const not = (d, re) => ({ d, not: re });
const test = (d, fn) => ({ d, test: fn });
const count = (log, re) => log.filter((l) => re.test(l)).length;
const captured = {};

const SCENARIOS = [
  S('start_place', 'p2char', { Level: '04BALIN1', Hero: 'aragorn', P2: 'gimli', Pad: 'empty.txt', Seconds: 45, Shots: [30] }, { TT_SKIPMOVIES: '1' }, [
    has("player 2 is Gimli, from the save's record", /player 2 is gimli: his record/),
    has('his own character type (Gimli 8)', /twin's type \d+ -> 8/),
    has('placed beside player 1 on the pathmap', /\[COOP2\] place: pathmap/)]),
  S('weapons', 'p2char', { Level: '02GATE2', Hero: 'legolas', P2: 'gimli', Pad: 'p2_bowspam.txt', Seconds: 55, Shots: [44] }, { TT_SKIPMOVIES: '1', TT_COOP_NEARLOG: '1' }, [
    has("player 2 refuses player 1's weapons", /player 2 doesn't take .*weaponObj/),
    has("his axe gets Gimli's weapon id (0x17)", /id \w+ -> 17/),
    has('his throws are axes', /shoots: projectile (19|16) -> 16/),
    has("his throws leave from his own ranged weapon with Gimli's throwing-axe model (E7EEC090)", /shoots: projectile (19|16) -> 16, shooter \w+ model \w+ \(key E7EEC090\)/),
    has("his aiming names his own ranged weapon, not player 1's bow", /player 2's event names \w+ \(player 1's ranged weapon\): his copy/),
    has("his own ammo goes down, player 1's stays", /ammo P1 60\/60 P2 ([0-9]|1[0-9]|2[0-4])\/25/),
    has("his move picks ask his own hero's bought upgrades (Gimli's), not player 1's", /COOPMOVES\] player 2's move pick .* asks his own hero 3's upgrades, not player 1's hero 2/)]),
  S('weapons_bow', 'p2char', { Level: '02GATE2', Hero: 'legolas', P2: 'isildur', Pad: 'p2_bowspam.txt', Seconds: 55, Shots: [45] }, { TT_SKIPMOVIES: '1', TT_COOP_P1PORT: '0' }, [
    has("player 2 Isildur shoots from his own copy (Aragorn's bow, 36AC3F58)", /player 2 \(isildur\) shoots: .*\(key 36AC3F58\)/),
    not("never from player 1 Legolas' bow", /player 2 \(isildur\) shoots: .*\(key 0834F2D4\)/)]),
  // (380 s, not 200: player 1's script is timed from the first time the menus read his pad, which on the web is
  // the level's end, not the start; its presses at 170-185 s then come long after 200)
  S('kills_post', 'p2char', { Level: '04BALIN1', Hero: 'aragorn', P2: 'gimli', Pad: 'empty.txt', Seconds: 380, Shots: [60] },
    { TT_SKIPMOVIES: '1', TT_COOP_P1PORT: '0', TT_COOP_P2BOT: '1', TT_COOP_TESTEND: '120000:1', TT_COOP_KILLLOG: '1', TT_P1SCRIPT: '/bot/p1_postxp.txt', TT_COOP_TESTUPG: '3:32,3:36,3:13,3:28,1:32,1:36', TT_COOP_MOVELOG: '1' }, [
    has('a kill by player 2 pays him experience', /kill by player 2 \(enemy \w+, the game's award in his context\): \+[1-9]/),
    test('every award for his kills runs in his context', (log) => { const p2 = count(log, /\[KILLLOG\] award .*\(P2\)/); return p2 > 0 && p2 === count(log, /the game's award in his context/); }),
    not("player 1 gets no award for a kill he didn't make (player 1 idle)", /\[KILLLOG\] award .*\(P1\)/),
    has("player 2's stats screen gets his level's experience", /player 1's stats done: player 2's .*the level's [1-9]/),
    has('upgrades his hero bought open his moves', /COOPMOVES\] player 2 asked: hero 3's upgrade (32|36|13|28) = 1/),
    not("player 1's hero's upgrades never open player 2's moves", /COOPMOVES\] player 2 asked: hero 1's upgrade \d+ = \d \(from 09/)]),
  S('levelup_shops', 'p2char', { Level: '04BALIN1', Hero: 'legolas', P2: 'gimli', Pad: 'empty.txt', Seconds: 98, Shots: [30] },
    { TT_SKIPMOVIES: '1', TT_COOP_P1PORT: '0', TT_COOP_TESTEND: '20000:1', TT_COOP_TESTEXP1: '4000', TT_COOP_TESTEXP: '1500', TT_P1SCRIPT: '/bot/p1_lvlup2.txt' }, [
    has("player 1's shop gets his level-up and points (3875 + 4000)", /player 1's state put back for his shop \(hero 2: level 1, points to come 7875\)/),
    has("player 2's shop gets his (3875 + 1500)", /player 2's state put back for his shop \(hero 3: level 1, points to come 5375\)/)]),
  S('pickups', 'p2char', { Level: '04BALIN1', Hero: 'aragorn', P2: 'legolas', Pad: 'empty.txt', Seconds: 200, Shots: [60] },
    { TT_SKIPMOVIES: '1', TT_COOP_P2BOT: '1', TT_COOP_TESTAMMO: '3,3', TT_COOP_PICKLOG: '1' }, [
    test("player 2's quiver touch refills him (player 1 idle, quivers drop where the P2 Bot fights)", (log) => log.some((l) => {
      // (the log line's wording since: "[COOPPICK] pickup ...: its first touch (by P2) refills ... | ammo P1 a -> b, P2 c -> d";
      // suite.ps1 still looks for the older "(P2), in his context | ammo ...")
      const m = l.match(/\(P2\), in his context \| ammo P1 (\d+) -> (\d+), P2 (\d+) -> (\d+)/) || l.match(/\(by P2\) refills.*\| ammo P1 (\d+) -> (\d+), P2 (\d+) -> (\d+)/);
      return m && +m[4] > +m[3] && m[1] === m[2]; })),
    test('no player 2 touch refills player 1', (log) => !log.some((l) => { const m = l.match(/\(P2\).* \| ammo P1 (\d+) -> (\d+),/); return m && +m[2] > +m[1]; }))]),
  S('down_respawn', 'p2char', { Level: '04BALIN1', Hero: 'aragorn', P2: 'gimli', Pad: 'empty.txt', Seconds: 70, Shots: [30] }, { TT_SKIPMOVIES: '1', TT_COOP_TESTDOWN: '15000,99999999' }, [
    has('player 1 down while player 2 stands: no game over', /P1 down \(P2 alive\)/),
    has('player 1 respawns beside player 2', /P1 respawned beside P2/),
    not('no game over', /game over/)]),
  S('down_gameover', 'p2char', { Level: '04BALIN1', Hero: 'aragorn', P2: 'gimli', Pad: 'empty.txt', Seconds: 45, Shots: [35] }, { TT_SKIPMOVIES: '1', TT_COOP_TESTDOWN: '15000,20000' }, [
    has('both down: game over', /game over/)]),
  S('menus', 'menu', { Script: 'p1_selprobe.txt', Seconds: 75 }, { TT_SKIPMOVIES: '1' }, [
    has('the Co-op menu has its own background', /COOPMENU\] background: the three hunters/),
    has('the hero select gives each player his hero', /P2SELECT\] done: player 1 Aragorn, player 2 Legolas/),
    has('the level starts with player 2 as Legolas', /player 2 is legolas: his record/)]),
  S('camera', 'p2char', { Level: '02GATE2', Hero: 'legolas', P2: 'gimli', Pad: 'p2_away.txt', Seconds: 56, Shots: [46] },
    { TT_SKIPMOVIES: '1', TT_COOP_CAMLOG: '1', TT_COOP_TAGLOG: '1000', TT_COOP_ICONS: '1', TT_COOP_ZPROBELOG: '1' }, [
    has('the camera zooms out to the Normal cap (1.30) as they part', /zoom 1\.30 \(eased 1\.30\)/),
    test('both head markers are placed on screen', (log) => count(log, /\[COOPTAG\] P1 head .* -> frame/) > 0 && count(log, /\[COOPTAG\] P2 head .* -> frame/) > 0),
    test("the markers' depth probe works: a point under player 1's feet reads as behind the ground", (log) => {
      const r = count(log, /\[ZPROBE\] test: .*hidden by the ground \(right\)/), w = count(log, /\[ZPROBE\] test: .*NOT hidden/); return r >= 10 && w * 10 <= r; })]),
  S('checkpoint', 'p2char', { Level: '02GATE2', Hero: 'legolas', P2: 'gimli', Pad: 'empty.txt', Seconds: 95, Shots: [45] },
    { TT_SKIPMOVIES: '1', TT_COOP_P1PORT: '0', TT_COOP_P2BOT: '1', TT_COOP_RESPAWNID: '1', TT_COOP_TESTXP12: '500,300,7,3', TT_COOP_TESTCKPT: '6000', TT_COOP_TESTXP12B: '800,700,20,20', TT_COOP_TESTDOWN: '20000,21000', TT_P1SCRIPT: '/bot/p1_aspam_slow.txt', TT_P1SCRIPT_INPLAY: '1' }, [
    has("a checkpoint reload puts player 2's level experience back to his at the checkpoint, as player 1's (500/300 after 800/700)", /start of the level: player 1's level experience 500 \(was 800.*player 2's kept, as player 1's \(300\)/),
    has('and his other per-level stats (the kill counts) back to his at the checkpoint (7, 3 after 20, 20)', /and his other per-level stats \(record \+0x94\.\.\+0xB3\): \w+ 00000007 00000003/),
    has('at the Watcher the P2 Bot goes near a tentacle and parries', /\[P2BOT\] boss: parrying by a tentacle/),
    not('the P2 Bot never shoots', /COOPSHOT\] player 2/)]),
  S('shop_left', 'menu', { Script: 'p1_shopleft.txt', Seconds: 132 }, { TT_SKIPMOVIES: '1', TT_COOP_TESTEND: '15000:1', TT_COOP_TESTEXP: '1500' }, [
    test('left on the level tabs pages back, in both players\' shops', (log) => count(log, /\[SHOPLEFT\] .*let through \(the level tabs\)/) >= 2),
    test('left from the list and from Continue is held back', (log) => count(log, /\[SHOPLEFT\] .*held back/) >= 2),
    not('the shop never focuses its hidden Replay', /\[SHOPLEFT\] .*leaf focus 2/),
    test("player 2's stats screen has no Replay (not drawn, left held back)", (log) => count(log, /player 2's stats screen: Replay not drawn/) > 0 && count(log, /left on player 2's stats screen: held back/) > 0)], 'backup'),
  S('save_buy', 'menu', { Script: 'p1_buysave.txt', Seconds: 165 }, { TT_SKIPMOVIES: '1', TT_COOP_TESTEND: '15000:1', TT_COOP_TESTEXP: '1500' }, [
    has("player 2's shop closes with his experience committed (5375)", /player 2's upgrades done \(experience 5375/),
    test("his record's checksum at the shop's close", (log) => { const m = log.filter((l) => /record sum (\w+) \(his shop closed\)/.test(l)).pop(); if (m) captured.sum = m.match(/record sum (\w+)/)[1]; return !!m; }),
    test('the game saves', (log, run) => run.saves.some((f) => /game\.xsv$/i.test(f.path) && f.modified >= run.t0))], 'backup'),
  S('save_reload', 'menu', { Script: 'p1_buyprobe3.txt', Seconds: 125 }, { TT_SKIPMOVIES: '1', TT_COOP_TESTEND: '15000:1' }, [
    has("player 2's experience comes back from the save (5375)", /player 2 is legolas: his record from the save .*experience 5375/),
    test('his whole saved record comes back (checksum, upgrades included)', (log) => { const m = log.find((l) => /record sum (\w+) \(loaded/.test(l)); return !!(m && captured.sum && m.match(/record sum (\w+)/)[1] === captured.sum); })], 'after:save_buy'),
];

// every scenario also: no crash, and the frame rate
const COMMON = [
  not('no crash (access violation, wasm trap, abort)', /Access violation|\[CRASH\]|RuntimeError|Aborted\(|\[pageerror\]/),
  test(`frame rate ${minFps}+ (median)`, (log, run) => {
    const f = log.map((l) => l.match(/\[FPS\] (\d+) flips/)).filter(Boolean).map((m) => +m[1]).sort((a, b) => a - b);
    run.fps = f.length ? f[f.length >> 1] : null;
    return f.length > 3 && run.fps >= minFps;
  })];

// --- one run --------------------------------------------------------------------------------------------------------
function switches(s) {
  const q = { TT_WEB_LOGALL: '1', TT_COOP_P2BOT: '0', ...s.env };   // (the P2 Bot off unless a scenario sets it, as the runners do)
  if (s.runner === 'p2char') Object.assign(q, { TT_TWEAKS: `SKIPMAINMENU=1;HERO=${s.a.Hero};LEVEL=${s.a.Level}`, TT_COOP: 'clone', TT_COOP_PAD2SCRIPT: `/bot/${s.a.Pad}`, TT_COOP_P2CHAR: s.a.P2 });
  else Object.assign(q, { TT_P1SCRIPT: `/bot/${s.a.Script}`, TT_P1SCRIPT_FROMMENU: '1', TT_MENULOG: '1' });
  return { ...q, ...extra };
}

// the page's private files (OPFS): every file under it, with its size and time
const LIST_OPFS = async () => {
  const out = [];
  async function walk(dir, p) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') await walk(h, `${p}/${name}`);
      else { const f = await h.getFile(); out.push({ path: `${p}/${name}`, size: f.size, modified: f.lastModified }); }
    }
  }
  await walk(await navigator.storage.getDirectory(), '');
  return out;
};

// a save copied into the page's private files before the game starts, at rel: the game's save folder there
// (home tt/, its saves/ the hard disk's, UDATA/<title id> the game's saves)
async function seedSave(page, files, rel) {
  await page.evaluate(async ({ files, rel }) => {
    let root = await navigator.storage.getDirectory();
    for (const part of rel.split('/').filter(Boolean)) root = await root.getDirectoryHandle(part, { create: true });
    for (const { name, bytes } of files) {
      let dir = root; const parts = name.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(new Uint8Array(bytes)); await w.close();
    }
  }, { files, rel });
}

async function run(s, profile) {
  const dir = path.join(out, s.name);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: cachedChromium(), headless: true, viewport: { width: 1000, height: 1100 },
    args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=' + (process.platform === 'darwin' ? 'metal' : 'default')] : [] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const log = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/^\s*\[|^\s/.test(m.text())) log.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  if (s.save === 'backup' && saveDir) {
    await page.goto(new URL('bot-manifest.json', url).toString());   // (same origin: its private files)
    const files = [];
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else files.push({ name: r, bytes: [...fs.readFileSync(p)] }); } };
    walk(saveDir, '');
    await seedSave(page, files, 'tt/saves/UDATA/45410010');
  }
  const t0 = Date.now();
  const q = new URLSearchParams(switches(s));
  await page.goto(`${url}?${q}`);
  const take = async () => { for (const l of await page.evaluate(() => self.ttLogTake ? self.ttLogTake() : []).catch(() => [])) log.push(l); };   // (a batch can be too long to spread)
  // the scenario's time from when the game's code is ready (the runners count from the launch; the page first
  // downloads and compiles the game), plus slack for the slower start
  await page.waitForFunction(() => self.Module?.ttReady, null, { timeout: 120000 }).catch(() => log.push('[suite] the game never became ready'));
  const tr = Date.now();
  const shots = [...(s.a.Shots || [])].sort((a, b) => a - b);
  const end = tr + (s.a.Seconds + slack) * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(2000);
    await take();
    while (shots.length && Date.now() - tr >= shots[0] * 1000) {
      const sec = shots.shift();
      await page.locator('#screen').screenshot({ path: path.join(dir, `shot_${sec}.png`), timeout: 20000 }).catch(() => {});
    }
  }
  await take();
  const saves = await page.evaluate(LIST_OPFS).catch(() => []);
  await ctx.close();
  fs.writeFileSync(path.join(dir, 'log.txt'), log.join('\n'));
  fs.writeFileSync(path.join(dir, 'opfs.txt'), saves.map((f) => `${f.size}\t${new Date(f.modified).toISOString()}\t${f.path}`).join('\n'));
  return { log, saves: saves.filter((f) => !/Partition\d\.img$/.test(f.path)), t0, secs: (Date.now() - t0) / 1000 };
}

// --- the suite ------------------------------------------------------------------------------------------------------
const results = [], t0 = Date.now(), profiles = {};
console.log(`co-op suite on ${url} (${gpu ? 'GPU' : 'software WebGL'}), output in ${out}${saveDir ? `, save from ${saveDir}` : ''}`);
for (const s of SCENARIOS) {
  if (only.length && !only.includes(s.name)) continue;
  const after = s.save?.startsWith('after:') ? s.save.slice(6) : null;
  const profile = after && profiles[after] ? profiles[after] : path.join(out, s.name, 'profile');
  profiles[s.name] = profile;
  console.log(`== ${s.name}${after ? ` (in ${after}'s browser profile)` : ''}`);
  const r = await run(s, profile);
  for (const c of [...s.checks, ...COMMON]) {
    let ok;
    try { ok = c.has ? r.log.some((l) => c.has.test(l)) : c.not ? !r.log.some((l) => c.not.test(l)) : !!c.test(r.log, r); }
    catch (e) { ok = false; }
    results.push({ scenario: s.name, check: c.d, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.d}`);
  }
  console.log(`  (${r.log.length} log lines, ${r.secs.toFixed(0)} s, median ${r.fps ?? '?'} flips/s)`);
}
const fail = results.filter((r) => !r.ok).length;
const sum = `Co-op bot suite (web), ${new Date().toISOString().slice(0, 16)}, ${Math.round((Date.now() - t0) / 60000)} min: ` +
  `${results.length - fail} passed, ${fail} failed of ${results.length} checks in ${new Set(results.map((r) => r.scenario)).size} scenarios`;
fs.writeFileSync(path.join(out, 'summary.txt'), results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}\t${r.scenario}\t${r.check}`).join('\n') + '\n' + sum + '\n');
console.log(sum);
process.exit(fail);
