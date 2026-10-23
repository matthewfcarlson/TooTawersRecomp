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
- **In combat: they part at in-play frame 1,129**, ~4 s after the scripted fighting starts: actor positions,
  five pages of `.data/.bss` and dozens of object pages part within two frames, all at once. Positions were
  identical to the bit until then, so it is one decision going differently, not drift: most likely state that
  already differed when play began (a random generator advanced during loading, which takes a different number of
  frames on each run) read for the first time when the AI acts. Being narrowed down (word-level RAM diffs at
  frames 1, 1128 and 1129).
- **Random numbers in the code**: the C runtime's `rand()` (`sub_0010011D`, state per thread, called from four
  functions) and a per-object generator in `sub_00107ACC` (state at `+0x40C`, constant `0x19660D`). The AI's
  dice are not yet identified.

Next steps for determinism, in order: find what differs at play start and is read at frame 1,129; either make it
identical at the barrier (reseed / copy at play start) or make the pre-play phase deterministic; repeat with longer
fights and both heroes (co-op); then the other threads (the loader, Bink, the APU's writes into game memory).

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
