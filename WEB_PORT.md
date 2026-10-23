# Web port: plan and current thinking

This fork of [The Two Towers Recompiled](https://github.com/Gumpolas/TooTawersRecomp) (upstream: `upstream` remote)
aims at three things, in this order of dependency:

1. **The game in a web browser** (WebAssembly, WebGPU).
2. **Online co-op with a second player in another browser**, built on the port's couch co-op (see `COOP.md`).
   Lockstep first; rollback later if input delay feels bad.
3. **Better visuals, in the browser and on the desktop:** high internal resolution, better textures, and
   compute-shader ray tracing (shadows, AO, maybe one bounce of indirect light).

Written 2026-10-22, at the start of the fork; the status below was updated the same day.

## Status (2026-10-22)

**The game runs in the browser** (Chrome, Firefox; `web/README.md`): the menus and videos at 30 frames/s, the levels
at about 4 (software rendering), keyboard only, no sound yet. One build (wasm64, pthreads, WasmFS) runs in the page and
under Node for tests. What it took:

- **Memory:** the guest's 4 GB as one untouched allocation in linear memory, with views claimed at `va + offset`
  as on the desktop (`win32_compat_wasm_mem.inc`). Second views can't alias: the RAM mirrors and the tiled view at
  0xF0000000 are refused and logged. No evidence yet that the game uses them (it plays a level without).
- **Device traps:** only the APU (pointer accesses from DirectSound) and AC'97 still trapped on the desktop; the GPU
  never did (its aperture is plain memory, answered by a polling thread), and USB went away with 1.9.5's direct input.
  AC'97 resets are now completed in code (`postproc_ac97.py`); the APU's pointer accesses still need it.
- **Files:** the disc fetched from the dev server in chunks as read (WasmFS fetch backend, case-insensitive); home
  (ini, saves, the hard-disk images) in OPFS, with Emscripten's OPFS read/write replaced (`web/opfs_fix.js`: they
  failed with a shared heap under memory64).
- **Fixes the web needed:** two function-pointer type mismatches WebAssembly traps on (the APU's thread start, the
  pad hooks' `unsigned long`), a cycle counter that never repeats (a coarse browser clock gave the game a divide by
  zero), no raw 5.8 GB partition images in memory.
- **Display and input:** no SDL window; each flipped frame is converted and drawn on the page's canvas, keys go
  straight to the game's key table.
- **macOS (native):** upstream's experimental build now opens its window (frame loop on the main thread); it still
  needs `RECOMP_GPU_ASYNC=1` and hasn't been played through.

**Next:** profiling. The game's own code takes ~120 ms a frame in a level in the browser (natively ~2 ms), and
far more under Node. Then sound (DirectSound output from a worker), WebGPU rendering, netplay.

## Why a fork of the recomp, not a decomp

We started on a byte-matching decomp (the tooling of a sister project) and dropped it. The recomp already plays the
whole game, and since 1.9.6 it has two-player co-op: a second hero with their own controller, weapons, health,
experience and shop, enemies that target either hero, a shared camera that zooms out. The work left is platform
(WebAssembly), netcode and the renderer, none of which needs C++ source for every game function. Where we need to
understand game code (the main loop, timing, camera, random numbers), we reverse-engineer just that, with the
Ghidra project in `re/` (local, ignored) and override the function in C, the way `twotowers/src/*.c` already does.

## Verified so far

- **The disc matches.** The USA retail `default.xbe` here has the SHA-256 `generate.py` expects
  (`ae2d1b53…`). XBE facts: linked 2002-10-29, XDK 4928, Stormfront's *Fusion* engine
  (`C:\Fusion\xbox\Game\Burn\FusionXbox.exe`), no RTTI, embeds Lua 4.0. Image ends at 0x9194E0.
- **Code generation works.** `generate.py` (about 6 minutes) translates 8,718 of 8,724 functions (0 failed) into
  1.25 million lines of C in 38 files under `twotowers/src/recomp/gen/` (ignored; already generated in this
  checkout). 27 unresolved call targets are stubbed.
- **The translated game code compiles to WebAssembly unchanged.** Every file in `gen/` builds with
  `emcc -O2 -c` (flags below) with no errors, in about 30 s on 10 cores; 18 MB of objects, so the final `.wasm` should
  be around 10-15 MB. x87 floating point is translated to plain `double` (`postproc_x87.py`), which WebAssembly runs
  exactly (and identically on every machine, which netplay needs).
  ```sh
  emcc -O2 -c -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DXBOX_LOW_AREA_BASE=0x00920000 \
      -include twotowers/src/rc_fastmath.h -Itwotowers/src -Itwotowers/src/recomp -Ixboxrecomp-0.12.0/include FILE.c
  ```
- **Memory access** in the translated code is `MEMn(addr)` = `*(volatile T*)(addr + g_xbox_mem_offset)`
  (`gen/recomp_types.h`). In WebAssembly the guest's 64 MB can sit in linear memory with a fixed offset.

## What blocks the browser build

| Piece | Today | Web plan |
|---|---|---|
| GPU (NV2A, 0xFD000000) and audio (APU, 0xFE800000) registers | *(Corrected after reading the code.)* The GPU aperture is plain memory; a polling thread acks the GPU (`xbox_memory_layout.c`). Only the APU (unmapped, fault + x86 decode, `apu_mmio_hook.c`) and an AC'97 write trap use faults. | No faults in WebAssembly. AC'97: done in code. APU: constant accesses already calls (`postproc_apu.py`); the pointer accesses from DirectSound (0x128B60-0x134934) still to route through a checked `MEMn`. |
| Memory mirrors | 28 aliased views of one file mapping (`src/kernel/xbox_memory_layout.c`): the same RAM at several addresses (contiguous/physical addresses, 0x80000000+). | WebAssembly can't alias pages: mask the address in the checked `MEMn` path (and in the GPU's reads of guest memory). Find out at run time whether game code (not only the XDK) uses mirrored addresses. |
| Kernel, threads, files | Win32, plus a POSIX emulation of it (`src/platform/win32_compat.c`). Xbox threads become host threads. | Emscripten pthreads (needs `SharedArrayBuffer`: serve with COOP/COEP headers); the disc read from a user-picked file into the browser's file storage (OPFS) through Emscripten's filesystem. |
| Renderer | NV2A push-buffer emulation (from xemu) drawing with Direct3D 11, Vulkan (DXVK) or OpenGL 3.3 core (`src/kernel/nv2a_gl.inc`), plus a CPU renderer (`renderer=software`, `nv2a_sw3d.inc`). | First boot on the software renderer. Then a **WebGPU** backend (not WebGL2: WebGL2 has no compute shaders, which the ray tracing needs). The same backend runs on the desktop through Dawn or wgpu, so the browser and desktop builds share one renderer. The GL backend is the closest model to port from. |
| Audio | APU emulation (from xemu) on its own thread, SDL2 output. | SDL2's Emscripten audio (Web Audio). Watch the CPU cost of the emulated DSP. |
| Input | SDL2 (controllers, keyboard, mouse). | SDL2's Emscripten backend (Gamepad API). |

## Netplay

The co-op runs **one** game with two players' controllers, so online play is: both browsers run the same build from
the same disc, and each frame exchanges the two players' inputs (WebRTC data channel; a small signaling server, for
example a Cloudflare Worker). That is lockstep, and it only works if the game is deterministic given its inputs:

- **Fixed tick.** Upstream deliberately makes game time follow the real frame rate (1.9.4-1.9.5: animations, falls,
  movement thresholds scale with frame time). In a netplay session, pin the frame time to a fixed step (30 or 60 Hz)
  and decouple presentation.
- **Threads.** If the game's own threads (streaming, loading, sound) change game state depending on when they
  finish, the two copies drift apart. Audit which threads the game creates and what they write.
- **Clocks and random seeds.** Anything read from a clock (`KeQueryPerformanceCounter`, RDTSC, the frame time) or
  seeded from one has to be pinned or synchronized.
- **Desync detection** from the start: hash the simulation state every N frames and compare.

**Rollback later.** A snapshot is the guest's 64 MB of RAM plus emulated GPU and audio state; copying 64 MB a frame
is too slow in a browser. Options: dirty-page tracking (possible in the checked/plain `MEMn` split), or snapshot only
the structures that hold simulation state once they're known. Re-simulating several frames also needs the game loop
run without drawing, which needs the main loop understood.

**Zero-code fallback:** Parsec or Steam Remote Play Together on the native co-op build.

## Visuals

- **Resolution:** upstream already renders at 1x-12x internally with aspect ratios 4:3-32:9 and edge-anchored HUD.
  Check which of these work in the GL backend (some features, such as the co-op head markers, are D3D11-only) and
  carry them into WebGPU.
- **Textures:** upstream's Ultra textures (sharper menus, text and HUD, plus the community GameCube 4K pack). The
  pack is about 5.75 GB, too large for a browser: build a web variant (2K, compressed to GPU formats), downloaded on
  demand into OPFS.
- **Ray tracing (compute shaders, WebGPU):** the renderer sees the GPU's command stream, so most geometry arrives
  already transformed by the game's vertex shaders, and there's no scene description. Plan: capture each draw's
  transformed vertices in a compute pass, un-project them with the inverse of the camera's view-projection
  matrix (read from game memory once the camera is located in `re/`), skip screen-space draws (HUD, 2D), and rebuild
  a BVH every frame (polygon counts of this era make that cheap). Materials from each draw's bound textures; lights
  from the game's light list or vertex-shader constants. Target: ray-traced shadows and ambient occlusion with a
  denoiser, maybe one bounce of indirect light; not full path tracing.
- **Native "remaster" alternative** (only if wanted later): RTX Remix needs D3D8/9 fixed-function calls, meaning an
  interception at the D3D8 API level instead of the GPU-command level. Larger rewrite, Windows and NVIDIA only.

## Order of work

1. **Native baseline.** Build upstream as is (Linux or Windows; on Apple silicon it needs an x86-64 SDL2 under
   Rosetta) and play a level, so there's a reference to compare the web build against.
2. **Checked memory access.** Split `MEMn` into plain and checked by the function's XBE section (in the generator
   or a post-pass like `postproc_apu.py`); route MMIO through the NV2A/APU handlers and mask mirrors; remove the
   fault handlers. Verify natively first (same picture, same sound), then try a native arm64 macOS build.
3. **Boot in the browser on the software renderer.** Emscripten build target in CMake, pthreads, the disc in
   OPFS, SDL2 audio/input. Goal: the title screen, then a level.
4. **WebGPU renderer**, ported from the GL backend: picture at any resolution, Ultra textures; Dawn on the desktop.
5. **Netplay:** fixed tick, determinism audit, state hashing, WebRTC input exchange, signaling server.
6. **Ray tracing** on the WebGPU renderer.
7. Rollback, if needed.

## Repository notes

- `isos/` (the disc image and `isos/extracted/`, the unpacked disc) and `re/` (a Ghidra 12.0.3 project of the XBE
  with the ghidra-xbe loader, `re/ghidra/twotowers.gpr`; Ghidra itself in `re/tools/`) are local and ignored.
- Regenerate the game code with `python generate.py isos/extracted` (needs `capstone`). Generated files are never
  committed (`.gitignore`).
- Upstream is active (1.9.x releases every few days). Keep our changes in separate files or small, clearly marked
  hunks so `git pull upstream main` stays easy.
