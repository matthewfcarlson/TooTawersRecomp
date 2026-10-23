/* (netplay) Each game frame's input, fixed at the frame's start.
 *
 * Lockstep netplay needs both machines to give the game the same input on the
 * same frame, however their polls line up with the wall clock. Here the input
 * of a frame in play is decided once, at the frame boundary (the game's frame
 * timer, sub_000E3350), and every poll of the pads during that frame gets it
 * (xbox_input_latch, xinput_device.c). Outside play -- menus, loading -- the
 * pads are read as usual.
 *
 * Frames are counted in play only (the game's state at 0x4AD050 is 6 or 8),
 * from 1 each time play begins: how many frames a level's load takes differs
 * between machines, the first frame of play does not. They are the game's
 * frames, not every tick of its frame timer (a level's load ticks it
 * thousands of times a frame: tt_netplay_tick).
 *
 * Sources of a frame's input, for now:
 *   TT_NETINPUT_SCRIPT=<file>   lines "<from> <to> <port> <control> [value]":
 *       frames from..to (in play, inclusive), port 0 or 1; controls A B X Y
 *       BLACK WHITE LT RT (analog, value 0-255, default 255), START BACK UP
 *       DOWN LEFT RIGHT LS RS (digital), LX LY RX RY (value -32768..32767).
 *       '#' starts a comment. Port 0 is there in play whatever the script
 *       says; port 1 once the script names it.
 *   TT_NETINPUT_STALL=<frame>:<ms>   (testing) holds the game thread that long
 *       at that frame, as waiting for the other player does online.
 *   TT_NETPLAY=1   online co-op (web/netplay.js; NETPLAY.md): the local
 *       player's device, sampled at frame F, is the input of frame F + D
 *       (TT_NETPLAY_DELAY, default 3: 100 ms at 30 frames/s) and goes to the
 *       other player; frame F runs once the other's input for F is here. The
 *       host is player 1 (port 0), the guest player 2 (port 1, the co-op's
 *       second hero); frames 1..D have no input on either side. Every 30
 *       frames the simulation's hash goes to the page for the desync check.
 *       The page reaches this through tt_np_set_role and tt_np_remote, and is
 *       reached through Module.ttNetInput and Module.ttNetHash. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* DWORD in the input layer's terms: unsigned long on Windows, 32 bits elsewhere */
#if defined(_WIN32)
typedef unsigned long tt_np_dword;
#else
typedef uint32_t tt_np_dword;
#endif

/* xinput_xbox.h's state, declared here (its header brings the runtime's Windows definitions) */
typedef struct {
    uint32_t dwPacketNumber;
    struct { uint16_t wButtons; uint8_t bAnalogButtons[8]; int16_t sThumbLX, sThumbLY, sThumbRX, sThumbRY; } Gamepad;
} TTPadState;

extern int (*volatile xbox_input_latch)(tt_np_dword port, TTPadState *state);
extern tt_np_dword xbox_InputGetStateLocal(tt_np_dword port, TTPadState *state);
extern ptrdiff_t g_xbox_mem_offset;

#define NP_GAMESTATE 0x4AD050u
#define NP_PORTS 2

typedef struct { uint32_t from, to; int port, kind, idx; int value; } NPEvent;
enum { NP_ANALOG, NP_DIGITAL, NP_STICK };
static NPEvent *s_ev;
static int s_nev;
static int s_port1;                      /* port 1 named in the script */
static volatile uint32_t s_frame;        /* frames in play (0: not in play) */
static TTPadState s_latched[NP_PORTS];

static int np_control(const char *c, int *kind, int *idx)
{
    static const char *an[] = { "A", "B", "X", "Y", "BLACK", "WHITE", "LT", "RT" };
    static const struct { const char *n; int bit; } dg[] = {
        { "UP", 0x0001 }, { "DOWN", 0x0002 }, { "LEFT", 0x0004 }, { "RIGHT", 0x0008 },
        { "START", 0x0010 }, { "BACK", 0x0020 }, { "LS", 0x0040 }, { "RS", 0x0080 } };
    static const char *st[] = { "LX", "LY", "RX", "RY" };
    int i;
    for (i = 0; i < 8; i++) if (!strcmp(c, an[i])) { *kind = NP_ANALOG; *idx = i; return 1; }
    for (i = 0; i < 8; i++) if (!strcmp(c, dg[i].n)) { *kind = NP_DIGITAL; *idx = dg[i].bit; return 1; }
    for (i = 0; i < 4; i++) if (!strcmp(c, st[i])) { *kind = NP_STICK; *idx = i; return 1; }
    return 0;
}

static void np_load_script(const char *path)
{
    FILE *f = fopen(path, "r");
    char line[256];
    int cap = 0;
    if (!f) { fprintf(stderr, "  [NETPLAY] cannot read the input script %s\n", path); return; }
    while (fgets(line, sizeof line, f)) {
        char ctl[16] = "";
        unsigned from, to;
        int port, value = 0, n, kind, idx;
        char *hash = strchr(line, '#');
        if (hash) *hash = 0;
        n = sscanf(line, "%u %u %d %15s %d", &from, &to, &port, ctl, &value);
        if (n < 4 || port < 0 || port >= NP_PORTS || !np_control(ctl, &kind, &idx)) continue;
        if (n < 5) value = kind == NP_ANALOG ? 255 : 1;
        if (s_nev == cap) { cap = cap ? cap * 2 : 64; s_ev = (NPEvent *)realloc(s_ev, (size_t)cap * sizeof *s_ev); }
        s_ev[s_nev].from = from; s_ev[s_nev].to = to; s_ev[s_nev].port = port;
        s_ev[s_nev].kind = kind; s_ev[s_nev].idx = idx; s_ev[s_nev].value = value;
        s_nev++;
        if (port == 1) s_port1 = 1;
    }
    fclose(f);
    fprintf(stderr, "  [NETPLAY] input script %s: %d event(s), in-play frames\n", path, s_nev);
}

/* the pads as the script has them on frame fr */
static void np_script_frame(uint32_t fr)
{
    int i;
    memset(s_latched, 0, sizeof s_latched);
    for (i = 0; i < s_nev; i++) {
        NPEvent *e = &s_ev[i];
        TTPadState *s = &s_latched[e->port];
        if (fr < e->from || fr > e->to) continue;
        if (e->kind == NP_ANALOG) s->Gamepad.bAnalogButtons[e->idx] = (uint8_t)e->value;
        else if (e->kind == NP_DIGITAL) s->Gamepad.wButtons |= (uint16_t)e->idx;
        else {
            int16_t v = (int16_t)(e->value < -32768 ? -32768 : e->value > 32767 ? 32767 : e->value);
            if (e->idx == 0) s->Gamepad.sThumbLX = v; else if (e->idx == 1) s->Gamepad.sThumbLY = v;
            else if (e->idx == 2) s->Gamepad.sThumbRX = v; else s->Gamepad.sThumbRY = v;
        }
    }
    for (i = 0; i < NP_PORTS; i++) s_latched[i].dwPacketNumber = fr;
}

/* ---- Over the network ---------------------------------------------------- */
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#include <emscripten/threading.h>
#define NP_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define NP_EXPORT
#endif
#define NP_RING 256
static int s_net, s_delay = 3;
static volatile int s_net_role = -1;   /* 0 host (player 1), 1 guest (player 2); -1 not known yet */
static struct { volatile uint32_t frame; TTPadState st; } s_remote[NP_RING];
static struct { uint32_t frame; TTPadState st; } s_local[NP_RING];
static uint32_t s_input_hash;

NP_EXPORT void tt_np_set_role(int guest) { s_net_role = guest ? 1 : 0; }

/* the other player's input for a frame (analog buttons packed four to an int, low byte first) */
NP_EXPORT void tt_np_remote(int frame, int buttons, int a0123, int a4567, int lx, int ly, int rx, int ry)
{
    TTPadState st;
    int i;
    uint32_t k = (uint32_t)frame & (NP_RING - 1);
    if (frame <= 0 || s_remote[k].frame == (uint32_t)frame) return;
    memset(&st, 0, sizeof st);
    st.dwPacketNumber = (uint32_t)frame;
    st.Gamepad.wButtons = (uint16_t)buttons;
    for (i = 0; i < 4; i++) {
        st.Gamepad.bAnalogButtons[i] = (uint8_t)((uint32_t)a0123 >> (8 * i));
        st.Gamepad.bAnalogButtons[4 + i] = (uint8_t)((uint32_t)a4567 >> (8 * i));
    }
    st.Gamepad.sThumbLX = (int16_t)lx; st.Gamepad.sThumbLY = (int16_t)ly;
    st.Gamepad.sThumbRX = (int16_t)rx; st.Gamepad.sThumbRY = (int16_t)ry;
    s_remote[k].st = st;
    __atomic_store_n(&s_remote[k].frame, (uint32_t)frame, __ATOMIC_RELEASE);
}

static uint32_t np_pack(const uint8_t *a) { return (uint32_t)a[0] | (uint32_t)a[1] << 8 | (uint32_t)a[2] << 16 | (uint32_t)a[3] << 24; }

static void np_net_frame(uint32_t fr)
{
    TTPadState mine, none;
    uint32_t t = fr + (uint32_t)s_delay, k;
    memset(&none, 0, sizeof none);
    /* the local player's input now is frame fr + D's */
    if (xbox_InputGetStateLocal(0, &mine) != 0) memset(&mine, 0, sizeof mine);
    s_local[t & (NP_RING - 1)].frame = t;
    s_local[t & (NP_RING - 1)].st = mine;
#if defined(__EMSCRIPTEN__)
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.ttNetInput) Module.ttNetInput($0, $1, $2, $3, $4, $5, $6, $7); },
        (int)t, (int)mine.Gamepad.wButtons, (int)np_pack(mine.Gamepad.bAnalogButtons), (int)np_pack(mine.Gamepad.bAnalogButtons + 4),
        (int)mine.Gamepad.sThumbLX, (int)mine.Gamepad.sThumbLY, (int)mine.Gamepad.sThumbRX, (int)mine.Gamepad.sThumbRY);
#endif
    /* this frame's: none for the first D, then both players' */
    k = fr & (NP_RING - 1);
    {
        TTPadState local = (fr > (uint32_t)s_delay && s_local[k].frame == fr) ? s_local[k].st : none, remote = none;
        if (fr > (uint32_t)s_delay) {
            uint32_t waited = 0;
            while (s_net_role < 0 || __atomic_load_n(&s_remote[k].frame, __ATOMIC_ACQUIRE) != fr) {
#if defined(__EMSCRIPTEN__)
                emscripten_thread_sleep(0.25);
#endif
                if (++waited % 8000 == 0) fprintf(stderr, "  [NETPLAY] frame %u: waiting for the other player (%u s)\n", fr, waited / 4000);
            }
            remote = s_remote[k].st;
        }
        while (s_net_role < 0) {   /* (the first frames too need to know which player is which) */
#if defined(__EMSCRIPTEN__)
            emscripten_thread_sleep(1.0);
#endif
        }
        s_latched[s_net_role] = local;
        s_latched[1 - s_net_role] = remote;
        s_latched[0].dwPacketNumber = s_latched[1].dwPacketNumber = fr;
    }
    {   /* every input the game was given, hashed: told apart from the simulation's
         * own hash, a desync says whether the inputs or the game differed */
        static uint32_t ih = 2166136261u;
        const uint8_t *b = (const uint8_t *)&s_latched[0].Gamepad;
        size_t i;
        for (i = 0; i < sizeof s_latched[0].Gamepad; i++) ih = (ih ^ b[i]) * 16777619u;
        b = (const uint8_t *)&s_latched[1].Gamepad;
        for (i = 0; i < sizeof s_latched[1].Gamepad; i++) ih = (ih ^ b[i]) * 16777619u;
        s_input_hash = ih;
    }
    if (fr % 30 == 0) {   /* the desync check */
        extern uint64_t tt_statehash_sim(void);
        uint64_t h = tt_statehash_sim();
        (void)h;
#if defined(__EMSCRIPTEN__)
        MAIN_THREAD_ASYNC_EM_ASM({ if (Module.ttNetHash) Module.ttNetHash($0, $1 >>> 0, $2 >>> 0, $3 >>> 0); },
            (int)fr, (int)(uint32_t)(h >> 32), (int)(uint32_t)h, (int)s_input_hash);
#endif
    }
}

static int np_latch(tt_np_dword port, TTPadState *state)
{
    if (!s_frame) return xbox_InputGetStateLocal(port, state) == 0;   /* not in play: the pads as they are */
    if (port >= NP_PORTS || (port == 1 && !s_port1)) return 0;
    *state = s_latched[port];
    return 1;
}

/* (netplay) A clock for the title's own gameplay code (the co-op's timers,
 * the heroes' fall and sprint timing), which used the wall clock: at a fixed
 * step (TT_FAKE_FRAME_MS: online, and determinism tests) it is the time spent
 * in play -- frames in play since start-up times the step, the same on both
 * machines however long each one's loading took -- and the wall clock
 * otherwise, as before. */
static volatile uint32_t s_play_frames;
uint32_t tt_timer_caller;           /* where the frame timer was called from (sub_000E3350's return address) */
volatile uint32_t tt_frame_waits;   /* the game's waits for the next frame (sub_000E00E0): one a frame shown */

/* Which of the frame timer's ticks are frames of the game. While a level
 * loads, its load wait (sub_0007C1D0: ticks the timer until the level is
 * ready, called from 0x0007C234) ticks it thousands of times for each
 * loading-screen frame shown -- as many as the machine is fast -- and loads
 * within a level (a scene's end loads, for one) tick it without a frame
 * between. Counting those made frame 1,000 a different moment on each
 * machine. A frame in play is a tick after a frame was shown (the game's
 * wait for the next frame, sub_000E00E0, between it and the last tick) other
 * than the load wait's: counted from the level's first (the fade-in from
 * black at its start: the same moment on every machine). At a fixed step
 * (tt_frametime, twotowers_manual.c) a frame is given the step, a tick of a
 * load within the level no time, and the ticks before the level's first
 * frame their real time (they draw the loading screen only).
 * Returns 1 (a frame), 0 (no time), -1 (real time). */
static int s_level_started, s_tick_kind = -1;
void tt_netplay_tick(uint32_t caller)   /* (each tick, first: sub_000E3350 with its return address) */
{
    static uint32_t last_waits;
    uint32_t st = *(const volatile uint32_t *)((uintptr_t)NP_GAMESTATE + g_xbox_mem_offset), w = tt_frame_waits;
    tt_timer_caller = caller;
    if (st != 6 && st != 8) { s_level_started = 0; s_tick_kind = -1; }
    else if (w != last_waits && caller != 0x0007C234u) { s_level_started = 1; s_tick_kind = 1; }
    else s_tick_kind = s_level_started ? 0 : -1;
    last_waits = w;
}
int tt_netplay_tick_kind(void) { return s_tick_kind; }
uint32_t tt_clock_ms(void)
{
    static double step = -1.0;
    if (step < 0.0) { const char *e = getenv("TT_FAKE_FRAME_MS"); step = e ? atof(e) : 0.0; }
    if (step > 0.0) return (uint32_t)((double)s_play_frames * step);
#if defined(_WIN32)
    { extern __declspec(dllimport) unsigned long __stdcall GetTickCount(void); return (uint32_t)GetTickCount(); }
#else
    { extern uint32_t GetTickCount(void); return GetTickCount(); }
#endif
}

/* the frame in play now (0: not in play), for the state hash and the network */
uint32_t tt_netplay_frame_number(void) { return s_frame; }

void tt_netplay_frame(void)
{
    static int on = -1;
    uint32_t st = *(const volatile uint32_t *)((uintptr_t)NP_GAMESTATE + g_xbox_mem_offset);
    if (s_tick_kind == 1) s_play_frames++;   /* (tt_clock_ms) */
    if (on < 0) {
        const char *sc = getenv("TT_NETINPUT_SCRIPT"), *net = getenv("TT_NETPLAY");
        on = 0;
        if (net && *net && *net != '0') {
            extern volatile int xbox_input_netplay;
            s_net = 1; s_port1 = 1; on = 1;
            xbox_input_netplay = 1;   /* this machine's devices: its one player's (port 0) */
            if (getenv("TT_NETPLAY_DELAY")) s_delay = atoi(getenv("TT_NETPLAY_DELAY"));
            if (s_delay < 1) s_delay = 1;
            if (s_delay > 30) s_delay = 30;
            xbox_input_latch = np_latch;
            fprintf(stderr, "  [NETPLAY] online: input delay %d frames\n", s_delay);
        } else if (sc && *sc) { np_load_script(sc); on = 1; xbox_input_latch = np_latch; }
    }
    {   /* testing: TT_NETPLAY_WATCH=addr,addr,... (hex) -- each word's changes ([NPWATCH]: frames
         * counted for tt_clock_ms, frames in play) */
        static int nw = -1; static uint32_t wa[16], wv[16];
        if (nw < 0) {
            const char *e = getenv("TT_NETPLAY_WATCH");
            nw = 0;
            while (e && *e && nw < 16) { wa[nw] = (uint32_t)strtoul(e, NULL, 16); wv[nw] = 0xDEADBEEFu; nw++; e = strchr(e, ','); if (e) e++; }
        }
        for (int i = 0; i < nw; i++) {
            uint32_t v = *(const volatile uint32_t *)((uintptr_t)wa[i] + g_xbox_mem_offset);
            if (v != wv[i]) { fprintf(stderr, "  [NPWATCH] frame %u (%u in play): %08X %08X -> %08X\n", s_play_frames, s_frame, wa[i], wv[i], v); wv[i] = v; }
        }
    }
    {   /* testing: TT_NETPLAY_TICKLOG=n -- in play (state 6 or 8), the timer's ticks after a frame
         * (the first n of each stretch), and those without one where it is called from somewhere new
         * ([NPTICK]: the real time, the frames shown, the caller; tt_netplay_tick) */
        static int tl = -1, n; static uint32_t lastst, lastw, lastc;
        if (tl < 0) { const char *e = getenv("TT_NETPLAY_TICKLOG"); tl = e ? atoi(e) : 0; }
        if (st != lastst) { lastst = st; n = 0; }
        if (tl > 0 && (st == 6 || st == 8) && tt_frame_waits == lastw && tt_timer_caller != lastc) {
            lastc = tt_timer_caller;
            fprintf(stderr, "  [NPTICK] tick %u: no frame wait since the last, called from %08X\n", s_play_frames, tt_timer_caller);
        }
        if (tl > 0 && (st == 6 || st == 8) && n < tl && tt_frame_waits != lastw) {
            extern float tt_frame_real_ms(void);
            n++;
            fprintf(stderr, "  [NPTICK] tick %u: real %.3f ms, frame waits %u (+%u), called from %08X\n", s_play_frames, (double)tt_frame_real_ms(), tt_frame_waits, tt_frame_waits - lastw, tt_timer_caller);
            lastc = 0;
            lastw = tt_frame_waits;
        }
    }
    if (!on) return;
    if (st != 6 && st != 8) { s_frame = 0; return; }
    if (s_tick_kind != 1) return;   /* (a load's tick: the frame's input stays latched) */
    s_frame++;
    if (s_net) np_net_frame(s_frame);
    else np_script_frame(s_frame);
    {   /* testing: a wait for the other player, without one */
        static int sf = -1, sms;
        if (sf < 0) { const char *e = getenv("TT_NETINPUT_STALL"); sf = 0; if (e) { sf = atoi(e); sms = strchr(e, ':') ? atoi(strchr(e, ':') + 1) : 0; } }
        if (sf > 0 && s_frame == (uint32_t)sf && sms > 0) {
            fprintf(stderr, "  [NETPLAY] stalling frame %u for %d ms (TT_NETINPUT_STALL)\n", s_frame, sms);
#if defined(__EMSCRIPTEN__)
            emscripten_thread_sleep((double)sms);
#endif
        }
    }
}
