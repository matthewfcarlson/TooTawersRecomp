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
 * between machines, the first frame of play does not.
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
    if (st == 6 || st == 8) s_play_frames++;   /* (tt_clock_ms) */
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
    if (!on) return;
    if (st != 6 && st != 8) { s_frame = 0; return; }
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
