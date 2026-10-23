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
 * Later: the local devices plus the other player's, over the network. */
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

static int np_latch(tt_np_dword port, TTPadState *state)
{
    if (!s_frame) return xbox_InputGetStateLocal(port, state) == 0;   /* not in play: the pads as they are */
    if (port >= NP_PORTS || (port == 1 && !s_port1)) return 0;
    *state = s_latched[port];
    return 1;
}

/* the frame in play now (0: not in play), for the state hash and the network */
uint32_t tt_netplay_frame_number(void) { return s_frame; }

void tt_netplay_frame(void)
{
    static int on = -1;
    uint32_t st;
    if (on < 0) {
        const char *sc = getenv("TT_NETINPUT_SCRIPT");
        on = 0;
        if (sc && *sc) { np_load_script(sc); on = 1; xbox_input_latch = np_latch; }
    }
    if (!on) return;
    st = *(const volatile uint32_t *)((uintptr_t)NP_GAMESTATE + g_xbox_mem_offset);
    if (st != 6 && st != 8) { s_frame = 0; return; }
    s_frame++;
    np_script_frame(s_frame);
}
