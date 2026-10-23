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
the levels run at the game's 30 frames/s. `?RECOMP_RENDERER=software` uses the CPU renderer instead (a few
frames/s in a level), `?TT_WEB_SIZE=1920x1440` sets the canvas's resolution (default 1280x960).

Sound starts on the first click or key (browsers allow nothing sooner): the emulated APU's output goes through a
ring in the shared memory to an AudioWorklet. Controllers go through the browser's Gamepad API (press a button on
one so the browser shows it), with rumble where the browser supports it; the game's own device and co-op settings
apply as on the desktop.

## Test it

```sh
node web/run-node.mjs --seconds 60 TT_SHOTS=20000:@out/a.bmp       # the same build under Node, no window; frames to BMP
node web/tools/browser-check.mjs --seconds 40 [KEY=VALUE ...]       # headless Chromium on the running server
node web/tools/profile.mjs --warmup 50 --seconds 15 [KEY=VALUE ...]  # CPU profile of every worker, time per function
# --gpu on either: use the machine's GPU (headless Chrome otherwise draws WebGL in software)
```

`browser-check.mjs` and `profile.mjs` need `npm install` in `web/tools` (playwright-core) and a Chromium from Playwright's cache
(`npx playwright install chromium`).
