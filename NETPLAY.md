# Online co-op: design notes

Two players in two browsers play the port's co-op (`COOP.md`) as one game. This file is the design and what has
been measured; `WEB_PORT.md` has the wider plan. Written 2026-10-23.

## The model: deterministic lockstep with input delay

Both browsers run the same build from the same disc, start a level together, and from then on exchange only
**inputs**: each frame, each side's controller state (about 20 bytes). Frame *N* runs on both machines only
when both players' inputs for *N* are there. Each side sends its input for frame *N + D* while running frame
*N*, so a delay of *D* frames (2–3 at 30 fps: 67–100 ms) hides the network's latency; a packet later than that
stalls both games until it arrives.

This needs the game to be **deterministic**: the same state and the same inputs give the same next state, on
both machines. Rollback (predicting the other's input, re-simulating when wrong) can come later if the delay
feels bad; it needs fast snapshots of the game's state, which lockstep does not.

## Determinism: what was done and measured

Tools (all in the tree):

- **A fixed time step.** `TT_FAKE_FRAME_MS=33.333333` gives every frame the same 1/30 s (upstream's switch; the
  game otherwise steps by real elapsed time).
- **A per-frame input latch** (`twotowers/src/tt_netplay.c`, hooked into `xbox_InputGetState` through
  `xbox_input_latch`): each frame's input is fixed at the frame boundary (the game's frame timer,
  `sub_000E3350`), and every poll of the pads in that frame gets it. For testing it comes from a script,
  `TT_NETINPUT_SCRIPT` (lines `from to port control [value]`); the network will be the next source.
- **Frames counted in play.** Frame numbers count only frames in play (game state `0x4AD050` is 6 or 8), from 1 at
  the start of play: how many frames a level's load takes depends on how fast its files arrive, which differs
  between machines; the first frame of play does not. This is the **load barrier**: lockstep starts there.
- **State hashing** (`twotowers/src/tt_statehash.c`, `TT_STATEHASH`, `TT_STATEHASH_INPLAY`): every frame, a hash
  of each 64 KB page of RAM and of the contiguous window, and a hash of every actor's and the player's position
  (the simulation, without the buffers around it). `web/tools/statehash.py` compares two runs.
  `TT_STATEHASH_SHOTS=dir:f1,f2` takes pictures at given frames.

Results (Node, the same build twice, side by side, Weathertop, same script):

- **Memory is not a usable hash as is.** The two runs' RAM differs from the first frame in ~130–270 of 2,048
  pages: GPU command and vertex buffers (most of the contiguous window), audio buffers, stacks, timers and
  counters. A desync check must hash the simulation's state, not all of memory: for now the actors' and the
  player's positions (`tt_statehash.c`), to be widened as the game's state is mapped.
- **Standing still, and the opening cutscene: identical.** With no input, or input during Weathertop's opening
  cutscene (input ignored there), every actor's position matched in every frame, 1,575 frames.
- **In combat, the runs parted at in-play frame 1,129**, ~4 s into the scripted fighting: actor positions, pages
  of `.data/.bss` and of objects all at once -- one decision going differently, from state that already differed
  when play began. Two causes found and fixed:
  1. **Half of the frame timer ran on real time.** `TT_FAKE_FRAME_MS` pinned the step the game mostly uses
     (`0x4B8B98` ms, `0x4B8BA0` s) but not the raw step (`0x4B8B94`, `0x4B8B9C`) or the unpaused copies
     (`0x4B8BA4`-`0x4B8BB0`), which game code reads too (`sub_000471F0`, `sub_000843F0`, ...). Now all eight
     (`twotowers_manual.c`, `tt_frametime`). Not enough alone: the runs then parted at frame 1,116.
  2. **Thread start-up raced the heap.** Each guest thread allocated its TIB from the guest heap as it started,
     racing its creator's next allocations; the two Bink threads, started back to back, put theirs in either
     order, so everything allocated after sat 4 KB apart between runs (pointers at play start: `0x013210AC` vs
     `0x013220AC`). The game processes something in address order, and in combat that order decided. The TIB
     is now allocated by the creator, after the stack (`kernel_bridge.c`; the kernel's timer thread too).
- **With both fixed: identical actor positions in all 1,432 frames compared** (430 of them in combat), well past
  the old split. The pages that still differ (153, from 266) are GPU and sound buffers, the profiler's cycle
  counts (`0x6B1800`-`0x6B1CB0`), the timer's raw source values, counters (`0x8D2170`), and a few heap records of
  contiguous-memory allocations (sound or GPU buffers allocated on real-time schedules) -- to be classified as
  harmless or not by longer runs.
- **Random numbers in the code**: the C runtime's `rand()` (`sub_0010011D`, state per thread, called from four
  functions) and a per-object generator in `sub_00107ACC` (state at `+0x40C`, constant `0x19660D`); deterministic
  given the same state and call order, which the fixes above give.

### Online, end to end (2026-10-23, night)

Built: the match server (`web/netplay-server`: a Worker and one Durable Object per match, tested locally with
`wrangler dev`), the page's client (`web/netplay.js`) and the game's network input mode (`tt_netplay.c`,
`TT_NETPLAY=1`). `web/tools/netplay-check.mjs` plays a match between two headless Chromes on one machine.

- **Lockstep works**: two browsers run one co-op game (Aragorn and Legolas) at 30 frames/s, each frame waiting
  for the other's input; the inputs are identical on both sides (their running hash matches at every check).
- **The data channel did not connect locally**: signalling completes (offer, answer, candidates both ways) but
  ICE stays in "checking" -- this machine's only route is a VPN (10.2.0.2), which does not hairpin, and Chrome
  gathers no loopback candidates. Between real players the direct path or Cloudflare TURN covers it; the
  fallback through the server worked at once (2-10 ms round trip locally).
- **The co-op game parted** (`same inputs, the game differs`), between frames ~1,030 and ~1,140. Found and
  fixed on the way: the co-op's own timers (114 uses of `GetTickCount` in `coop_now()`), the heroes' fall and
  sprint timing, and the cutscene test (`tt_in_scene`: "no HUD drawn for 300 ms of wall time", true on any slow
  frame) now run on `tt_clock_ms()`, game time at a fixed step.

### The frame count (2026-10-23): fixed

**The cause: frames were counted from the game's frame timer, and a level's load ticks it in a tight loop.**
While a level loads (game state 6 already), its load wait (`sub_0007C1D0`, calling the timer from `0x0007C234`)
ticks the frame timer thousands of times for each loading-screen frame shown: 1.5-3.3 million ticks in a
Weathertop load under Node, as many as the machine is fast. Each was counted as a frame in play (and, at the fixed
step, given 33 ms of game time), so "frame 1,000" of an input script, or of the online exchange, was a different
moment of the game on each machine. Seen with `TT_NETPLAY_WATCH` (a word's changes by frame): the fade-in from
black at the level's start came at 89, 90 and 92 in three runs (fewer ticks there: the per-frame state hashing
slowed the load loop), and everything after was shifted the same: the intro ended exactly 1,022 frames after the
fade in all three. A 5 s stall at frame 500 changed nothing.

**The fix** (`tt_netplay.c`, `tt_netplay_tick`): a tick is a frame when a frame was shown since the last tick
(the game's wait for the next frame, `sub_000E00E0`, ran between them) and it is not the load wait's. The level
loop's ticks all qualify (the intro's from `0x000E8CDF`, play's and the pause menu's from `0x0007C41C`); ticks
without a frame between (the load wait's, loads within the level -- the intro's end, `0x0007CE1E` --, pausing and
resuming, `0x0007C5C6` / `0x0007B868`) do not. Frames in play count from the level's first frame (frame 2 is the
fade-in on every machine), as do `tt_clock_ms()` and the state hash's frames. At the fixed step a frame gets the
step, a tick of a load within the level no time, and the ticks before the level's first frame their real time
(they only draw the loading screen). `TT_NETPLAY_TICKLOG=n` logs the ticks and where the timer was called from.

**Result: two Node runs of the co-op fight script (Aragorn and Legolas, Weathertop, frames 1,150-2,745) matched in
every one of 5,105 frames** (actor positions; the same enemies targeting each hero, the same 17 and 2 hits, the
same health), where they used to part ~65 frames into the fight. **Stalls too:** runs held 5 s at frame 4 (as the
host waits for the guest at the start, which used to part at frame 1,030 every time) and at frame 1,300 (mid-fight)
matched the unstalled run in all 5,164 frames. **Online:** two browsers (`netplay-check.mjs`, the host's pad walking
and attacking) played five minutes of one match at 30 frames/s with no desync reported.

The earlier lead (the game's frame pacing by real vblanks: `0x4B7618` counted by the vblank callback
`sub_000DFF80` on the kernel's timer thread, read by the frame wait) was not it: only the frame wait reads those
words, and it clears them every frame. They differ between runs (noise, as are the D3D runtime's fence and
push-buffer bookkeeping at `0x4B7280`-`0x4B72BC`, the profiler's cycle counts and the timer's raw source values)
without the simulation reading them.

Next steps for determinism: longer play, other levels, a level's end and the next level's load, saves and
checkpoints; two real machines (different speeds); then what the other threads write into game memory on real-time
schedules -- the kernel timer thread runs guest code (the vblank interrupt, sound interrupts, D3D callbacks, timer
DPCs) at real 60 Hz; the APU updates DirectSound's state; the loader streams. Anything the simulation reads from
those must be tied to game frames. A desync check must then hash more than positions: the frame-1,128 diff of the
first failure showed orientations differing before positions did.

## Transport on Cloudflare

Researched 2026-10-22 from Cloudflare's docs (sources below). Lockstep is sensitive to **jitter and loss** more
than to average latency: one late packet stalls both players. So head-of-line blocking (TCP, ordered delivery)
matters, and each packet should carry the last several frames of input, so that one lost packet stalls nothing.

| | WebRTC DataChannel, P2P (+ Cloudflare TURN) | Realtime SFU DataChannels | WebSocket via a Durable Object |
|---|---|---|---|
| Path | A→B direct; relayed: A→PoP→(Cloudflare)→PoP→B | always A→PoP→Cloudflare→PoP→B | A→PoP→the DO's data centre→PoP→B |
| Added latency vs direct | 0 direct; ~0–10 ms relayed (estimate) | ~2–15 ms (estimate, unmeasured) | ~5–40+ ms, more when players are far apart |
| Unordered / unreliable | yes (`ordered:false, maxRetransmits:0`) | yes, per channel | no: TCP, head-of-line blocking |
| NAT | ICE; TURN over UDP/TCP/TLS 443 | client→SFU only: practically always | always works (443) |
| Cost | STUN free; TURN $0.05/GB, 1,000 GB/month free (shared with SFU) | $0.05/GB, same free tier | DO requests + duration: ~$0.01 per match-hour |
| Code | most: ICE/SDP via signalling + TURN credentials | medium: SFU HTTP API from a Worker | least |

Facts from the docs: `turn.cloudflare.com` is anycast (the nearest PoP), credentials are minted by a Worker
(`generate-ice-servers`, TTL up to 48 h); the SFU supports unordered/unreliable DataChannels per channel; a Durable
Object is created near its first request and does not move (`locationHint` only on creation); incoming WebSocket
messages bill at 20:1 as requests; deploys disconnect a DO's WebSockets. **No WebTransport** on Workers/DOs
(not listed among supported protocols). Not verified: measured latency of TURN or SFU relaying vs direct; how often
P2P fails in practice (third-party figures: ~10–25% of sessions need TURN).

**Plan:**

- **Primary: WebRTC DataChannel peer to peer**, `ordered: false, maxRetransmits: 0`, each packet
  `{frame, the last ~8 frames of input, ack}`; STUN and **Cloudflare TURN** both in `iceServers`, so a pair
  that cannot connect directly relays over Cloudflare's nearest PoPs.
- **Signalling: one Durable Object per match**, reached by a match code: relays SDP and ICE candidates, assigns host
  and guest, agrees the level, the hero choices and the start; also exchanges state hashes for desync checks.
- **Last resort: the same DO relays the inputs over its WebSockets** if ICE fails within ~5 s (worse under loss,
  but it always connects).
- The SFU's DataChannels are the alternative primary if NAT failures turn out to be common: always relayed, but
  always connects, with UDP all the way.

Minimal pieces: a Worker (`GET /match/:code` → the match's DO over WebSocket, `locationHint` from the first
player's region; `POST /turn` → ICE servers from Cloudflare's TURN API with the key in a secret); the DO (two
WebSockets, hibernation API, relays signalling); the client (page JS: the RTCPeerConnection and DataChannel, and
an interface to the game's input latch in shared memory).

Sources (with the "last updated" date shown on each page):
- TURN: https://developers.cloudflare.com/realtime/turn/ (2026-09-25), FAQ https://developers.cloudflare.com/realtime/turn/faq/ (2026-07-14), credentials https://developers.cloudflare.com/realtime/turn/generate-credentials/ (2026-09-25)
- Realtime pricing: https://developers.cloudflare.com/realtime/pricing/ (2026-09-22)
- SFU DataChannels: https://developers.cloudflare.com/realtime/sfu/datachannels/ (2026-09-22), limits https://developers.cloudflare.com/realtime/sfu/limits/ (2026-10-06)
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/ (2026-10-18), data location https://developers.cloudflare.com/durable-objects/reference/data-location/ (2026-06-26), WebSockets https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (2026-09-30)
- Workers protocols: https://developers.cloudflare.com/workers/reference/protocols/ (2026-10-13)
- Third party, on how often TURN is needed: https://openvidu.io/blog/2026/06/09/turn-key-considerations/, https://medium.com/@fippo/what-kind-of-turn-server-is-being-used-d67dbfc2ff5d
