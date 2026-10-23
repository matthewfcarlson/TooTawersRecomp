# CLAUDE.md

A fork of The Two Towers Recompiled (static recompilation of the Xbox game) aimed at a **browser build with online
co-op** and better visuals (WebGPU, compute-shader ray tracing). Read `WEB_PORT.md` first: goals, what's verified,
the blockers and the order of work. `README.md` and `COOP.md` describe upstream's port; `CHANGES.md` its history.

## Layout

- `twotowers/`: the game port (`src/*.c` hand-written overrides and features, `postproc_*.py` passes over the
  generated code, `CMakeLists.txt`). `twotowers/src/recomp/gen/`: generated C, never committed.
- `xboxrecomp-0.12.0/`: the recompilation toolkit (`tools/` pipeline, `src/kernel` kernel replacement and NV2A
  renderer backends, `src/nv2a` and `src/apu` GPU/audio emulation from xemu, `src/platform` Win32/POSIX layer).
- `isos/` (disc, unpacked in `isos/extracted/`) and `re/` (Ghidra project of the XBE): local, ignored.
- Remotes: `upstream` is Gumpolas/TooTawersRecomp; `origin` is our fork.

## Hard rules

- **Never commit game content:** the ISO or XBE, anything in `isos/`, `re/`, `game_files/`, generated code,
  texture dumps, saves, logs, screenshots of the game. Check `git status` and `git diff --cached --stat` before
  every commit.
- Upstream is active: keep changes in new files or small marked hunks so `git pull upstream main` merges cleanly.
- Licenses: the port is MIT; parts of `xboxrecomp-0.12.0/` taken from xemu are LGPL-2.1-or-later (see its `NOTICE`).
