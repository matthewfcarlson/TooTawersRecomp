# The Two Towers in the browser (work in progress)

The port's game code compiled to WebAssembly (memory64, threads) with Emscripten. Plan and status: `../WEB_PORT.md`.

## Build

Needs Emscripten (`emcc`), CMake and Ninja, and the generated game code (`python generate.py <your disc>`).

```sh
web/build.sh          # -> build-web/twotowers_recomp.js + .wasm (the first build takes a few minutes)
```

## Play it locally

```sh
node web/serve.mjs    # http://localhost:8080/ ; --port, --disc <extracted disc folder> (default isos/extracted)
```

Open the address in **Chrome or Firefox** (Safari has no memory64), click the picture, and play with the keyboard:
W A S D move, K jump, J / I attacks, L parry, Enter Start, Backspace Back. The page shows the game's log underneath.

Any `KEY=VALUE` in the address's query is one of the game's switches, for example
`?TT_TWEAKS=SKIPMAINMENU=1;HERO=aragorn;LEVEL=01WEAT1` to start in the first level.

The server only listens on 127.0.0.1 and serves your disc to your own browser; it sends the cross-origin isolation
headers threads need. Saves and settings stay in the browser's private storage for the page (OPFS): the hard
disk's E: (UDATA, TDATA) is mapped into the save folder there, since the game folder is the read-only disc.

Rendering is WebGL2 (the port's OpenGL renderer, on its own thread with the canvas handed to it):
the levels run at the game's 30 frames/s, or 60 with `?TT_FPS=60` (upstream's experimental mode; it holds 60 in
the levels tried, `../WEB_PORT.md`). The picture is 16:9 by default (the game's Options -> Display -> Aspect ratio, or
`[Display] aspect` in the ini; the canvas takes its shape). `?RECOMP_RENDERER=software` uses the CPU renderer
instead (a few frames/s in a level), `?TT_WEB_SIZE=1920x1080` sets the canvas's resolution (default 960 lines).

**Ultra textures** (the GameCube high-resolution pack, GLOS69, downloaded separately): unpack its `GLOS69` folder
into `textures/` at the repository's root, copy the port's `twotowers/tools/ultra_textures/{masks,recipe.txt,pairs.txt}`
into `textures/textures_ultra/`, and build it once with `twotowers-setup ultra` run from `textures/` (a native
build's; a few minutes). `serve.mjs` then serves it (`--ultra <dir>` elsewhere, `--ultra off` without) and the page
turns it on; `?TT_ULTRA_TEX=0` turns it off. It is fetched as the game pairs textures, like the disc.

Sound starts on the first click or key (browsers allow nothing sooner): the emulated APU's output goes through a
ring in the shared memory to an AudioWorklet. Controllers go through the browser's Gamepad API (press a button on
one so the browser shows it), with rumble where the browser supports it; the game's own device and co-op settings
apply as on the desktop.

## Hosted (Cloudflare)

The same page can be served from Cloudflare, without any game files: on the first visit each player picks their
own ISO (and, if they want the Ultra textures, the GLOS69 folder unpacked from the pack's download); the page copies
them into the site's storage in their browser (OPFS: about 4.5 GB for the disc, a few seconds to a minute) and
builds the Ultra textures there once. Nothing is uploaded. `?setup` opens that screen again (to add the textures,
or remove the imported files).

```sh
web/build.sh && node web/site.mjs                     # -> web/netplay-server/public/ (the page, the build; never committed)
(cd web/netplay-server && npx wrangler dev)           # try it: http://localhost:8787/
node web/tools/hosted-check.mjs --iso <your .iso>     # a fresh browser through the first visit, then play
(cd web/netplay-server && npm run deploy)             # publish (your Cloudflare account; the build is the game's code
                                                      # translated from your disc: publishing it is your decision)
```

One Worker serves the files and the online co-op server on one origin (`wrangler.jsonc`: static assets first, the
Worker for `/match/<code>`, `/turn` and `/proof`); `_headers` gives the files the cross-origin isolation threads need.

**The build is only for players with the disc.** It sits under `/build/`, which the Worker answers first: without a
pass it is a 403. To get one, the page answers three questions about the imported disc: the SHA-256 of three 64 KB
pieces of its files, picked at random from 512 that `site.mjs` hashes from your disc at deploy time
(`gen/disc-proof.json`: hashes only, never committed). Right answers give a signed cookie (30 days). The signing key is
the Worker's secret `BUILD_SECRET` (`wrangler secret put BUILD_SECRET` once; `site.mjs` makes one in `.dev.vars` for
`wrangler dev`); without it the build stays closed. This keeps the translated code from being handed to anyone who
doesn't have the disc; someone who passes could still copy what their browser downloaded.

The splash (`index.html`, `#setup`) shows on every visit to the hosted page: the disc, the optional Ultra textures,
then Play (which also counts as the click browsers need before sound starts).

## Online co-op (in progress)

```sh
(cd web/netplay-server && npm install && npm run dev)   # the match server (Cloudflare Worker, locally: 8787)
node web/serve.mjs
```

**On the hosted page** (the splash's "Play together", `lobby.js`): the host picks the level and the two heroes and
makes a game; the server keeps those settings and the page shows its link, `…/?match=fell-7k2q`, to copy or share.
The friend opens the link (or types the code), and their game takes the settings from the server, so the two cannot
start differently. Each browser keeps a player id (localStorage): the maker is always player 1, the first other
player player 2 for good, a third is turned away, and a reload or the link opened again gets the same role back. A
game can't be joined halfway, so when a player comes back to a game under way, the other page reloads too and both
start the level over together. The splash lists your recent games (a week: then the server forgets them) to rejoin.

**One game, the host's settings and saves.** Both machines must start the very same game, so whatever changes it
comes from the host: the co-op settings (difficulty, player 2's teleport, double pickups) travel with the game and
are given to both games as `TT_COOP_*` switches, whatever each player's ini says (Easy against Expert parts the games
within a minute: `../NETPLAY.md`); and the host's files the game reads -- its saves (`saves/UDATA/45410010/`) and the
extra heroes' records (`heroes/records.dat`, which player 2 as Gandalf, Boromir... is played from) -- are sent to
the guest when it arrives, through the match server (`saves.js`, `lobby.js`). The guest's game runs on that copy in
`tt-games/<code>/` (`TT_WEB_HOME`), its own saves untouched; afterwards "Keep the saves from this game" copies them
into its own. Both pages fingerprint the settings, the build (`build-id.txt`, made by `site.mjs`) and the files; the
guest starts only on the host's fingerprint, and both are told if they differ. "Your saves" on the splash downloads
them as a `.zip` (saves, the title's data, the extra heroes' records and the settings) or imports one (from here, or
an Xbox save folder `45410010/...` zipped).

**With the switches in the address** (the test tools, and `serve.mjs`): both players open the same address, e.g.
`http://localhost:8080/?match=night1&TT_TWEAKS=SKIPMAINMENU=1;HERO=aragorn;LEVEL=01WEAT1&TT_COOP=clone&TT_COOP_P2CHAR=legolas`.
The first in is the host (player 1), the second the guest (player 2); `&server=wss://...` points at a deployed
server, `&ice=relay` allows only the TURN relay (to try it between machines that could connect directly). The game runs in lockstep at a fixed step with 3 frames of input delay; the line under the status shows the
connection (direct, relayed by TURN, or through the server) and the round trip, and says so if the two games ever
differ (a desync). Design and status: `../NETPLAY.md`.

### Two machines

`netplay-check.mjs --guest-cdp` puts the guest in a Chromium on another Mac (on the same network; it
needs only Playwright's cached Chromium, no Node). One ssh connection gives that machine this one's page and match
servers and this one its browser:

```sh
ssh -N -L 9223:127.0.0.1:9222 -R 8080:127.0.0.1:8080 -R 8787:127.0.0.1:8787 user@other-mac &
ssh user@other-mac 'cd ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64 &&
  "./Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/tt-guest --enable-gpu --ignore-gpu-blocklist \
  --use-angle=metal --disable-features=WebRtcHideLocalIpsWithMdns about:blank > /tmp/tt-chrome.log 2>&1 &'
node web/tools/netplay-check.mjs --seconds 200 --guest-cdp http://localhost:9223 [KEY=VALUE ...]
```

The game then runs on that machine's CPU and GPU and the match's data channel crosses the network (the disc and
the signalling still come through the tunnel).

## Test it

```sh
node web/run-node.mjs --seconds 60 TT_SHOTS=20000:@out/a.bmp       # the same build under Node, no window; frames to BMP
node web/tools/browser-check.mjs --seconds 40 [KEY=VALUE ...]       # headless Chromium on the running server
node web/tools/profile.mjs --warmup 50 --seconds 15 [KEY=VALUE ...]  # CPU profile of every worker, time per function
node web/tools/netplay-check.mjs --seconds 150 [KEY=VALUE ...]        # two headless players in one online match
node web/tools/together-check.mjs OUT [URL] [ISO]                       # make, share, join and reload a game, as players do
node web/tools/saves-check.mjs OUT [URL] ISO                            # a shared game's saves: the copy, keep, .zip, a refused copy
node web/tools/coop-suite.mjs [--only a,b] [--save DIR] [KEY=VALUE ...] # upstream's co-op bot suite in the browser
# --gpu on either: use the machine's GPU (headless Chrome otherwise draws WebGL in software)
```

`browser-check.mjs` and `profile.mjs` need `npm install` in `web/tools` (playwright-core) and a Chromium from Playwright's cache
(`npx playwright install chromium`).

`coop-suite.mjs` is `tools/coop-bot/suite.ps1` (upstream's fourteen co-op scenarios: bots, scripted pads and
`TT_COOP_*` test switches, then checks on the game's log) run on the web build: each scenario in a headless Chromium
of its own on the GPU (a fresh OPFS: its own ini and saves), its pad scripts read from `/bot` (`serve.mjs` serves
`tools/coop-bot` there), the canvas captured at its shot times. Every scenario also checks for no crash (an access
violation, a wasm trap, an abort, a page error) and a median of 28+ frames/s (`--min-fps`). The save scenarios want
a save to start from (`--save <a UDATA/45410010 folder>`, as upstream's `$SaveBackup`); without one they start with
none. About half an hour; results in `<out>/summary.txt`, each scenario's whole log and frames beside it.
