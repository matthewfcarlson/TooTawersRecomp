/* (netplay) Rollback, first experiment: does restoring the guest's RAM at a frame boundary replay the same game?
 *
 * TT_RB_TEST=<n>:<m> (with a scripted run, TT_NETINPUT_SCRIPT, or online): at the frame in play n, before its
 * simulation, the guest's memory is copied (the 64 MB of RAM at 0x10000 and the contiguous window at 0x80000000,
 * which is separate storage here). At frame n+m the memory is copied again (the first pass's end), then the first
 * copy is written back, the frame counter is set back to n, and the m frames run a second time with the same inputs.
 * At n+m again the memory is compared with the first pass's end: the pages that differ, and for the first few the
 * words, say what state a rollback needs beyond RAM (threads, devices, host-side state) or what in RAM is
 * time-dependent. The cost of the copy and the restore is printed ([ROLLBACK]).
 *
 * Called from tt_netplay_frame (tt_netplay.c), on the game's thread, at each frame's start. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
static double rb_ms(void) { return emscripten_get_now(); }
#else
#include <time.h>
static double rb_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
#endif

extern ptrdiff_t g_xbox_mem_offset;

#define RB_RAM_LO  0x00010000u
#define RB_RAM_LEN (0x04000000u - 0x00010000u)
#define RB_CONT_LO 0x80000000u
#define RB_CONT_LEN 0x04000000u

/* Host-side state the game's simulation depends on that is not in guest memory (frame counters, clocks, sums kept
 * in C statics): each module registers it (tt_rb_reg) and it is saved and restored with the memory. */
#define RB_REGS 64
static struct { void *p; size_t n; } rb_reg[RB_REGS];
static int rb_nreg;
void tt_rb_reg(void *p, size_t n)
{
    int i;
    for (i = 0; i < rb_nreg; i++) if (rb_reg[i].p == p) return;
    if (rb_nreg < RB_REGS) { rb_reg[rb_nreg].p = p; rb_reg[rb_nreg].n = n; rb_nreg++; }
}
static size_t rb_host_len(void) { size_t t = 0; int i; for (i = 0; i < rb_nreg; i++) t += rb_reg[i].n; return t; }

typedef struct { uint8_t *ram, *cont, *host; } RBImage;
static RBImage rb_img_new(void)
{
    RBImage i;
    i.ram = (uint8_t *)malloc(RB_RAM_LEN); i.cont = (uint8_t *)malloc(RB_CONT_LEN); i.host = (uint8_t *)malloc(rb_host_len() + 1);
    return i;
}
static void rb_save(RBImage *i)
{
    int k; size_t o = 0;
    for (k = 0; k < rb_nreg; k++) { memcpy(i->host + o, rb_reg[k].p, rb_reg[k].n); o += rb_reg[k].n; }
    memcpy(i->ram, (const void *)((uintptr_t)RB_RAM_LO + g_xbox_mem_offset), RB_RAM_LEN);
    memcpy(i->cont, (const void *)((uintptr_t)RB_CONT_LO + g_xbox_mem_offset), RB_CONT_LEN);
}
static void rb_load(const RBImage *i)
{
    int k; size_t o = 0;
    for (k = 0; k < rb_nreg; k++) { memcpy(rb_reg[k].p, i->host + o, rb_reg[k].n); o += rb_reg[k].n; }
    memcpy((void *)((uintptr_t)RB_RAM_LO + g_xbox_mem_offset), i->ram, RB_RAM_LEN);
    memcpy((void *)((uintptr_t)RB_CONT_LO + g_xbox_mem_offset), i->cont, RB_CONT_LEN);
}

/* the 4 KB pages (and for the first few, words) in which the live memory differs from an image */
static void rb_compare(const RBImage *a)
{
    const uint32_t *live[2] = { (const uint32_t *)((uintptr_t)RB_RAM_LO + g_xbox_mem_offset), (const uint32_t *)((uintptr_t)RB_CONT_LO + g_xbox_mem_offset) };
    const uint32_t *img[2] = { (const uint32_t *)a->ram, (const uint32_t *)a->cont };
    const uint32_t base[2] = { RB_RAM_LO, RB_CONT_LO }, len[2] = { RB_RAM_LEN, RB_CONT_LEN };
    uint32_t r, pg, w, total = 0, words = 0, shown = 0;
    for (r = 0; r < 2; r++) {
        uint32_t npg = 0, nwords = 0;
        for (pg = 0; pg < len[r] / 4096u; pg++) {
            const uint32_t *l = live[r] + pg * 1024u, *m = img[r] + pg * 1024u;
            uint32_t nd = 0, first = 0;
            for (w = 0; w < 1024u; w++) if (l[w] != m[w]) { if (!nd) first = w; nd++; }
            if (!nd) continue;
            npg++; nwords += nd;
            if (shown++ < 40)
                fprintf(stderr, "  [ROLLBACK]   page %08X: %u word(s) differ, first at %08X: %08X now, %08X first time\n",
                        base[r] + pg * 4096u, nd, base[r] + pg * 4096u + first * 4u, l[first], m[first]);
        }
        fprintf(stderr, "  [ROLLBACK] %s: %u page(s), %u word(s) differ\n", r ? "contiguous window" : "RAM", npg, nwords);
        total += npg; words += nwords;
    }
    fprintf(stderr, "  [ROLLBACK] the second pass %s the first (%u pages, %u words)\n", total ? "DIFFERS from" : "matches", total, words);
}

/* The actors found at the snapshot frame (the objects with vtable 0x001741C0 in the contiguous window, x y z at
 * +0xF0), followed by address through both passes. The ones that moved in the first pass are the live ones: the
 * rest are objects left in freed memory, which differ between any two runs. */
#define RB_ACT_MAX 1024
#define RB_MAXF 1024
static uint32_t rb_act[RB_ACT_MAX], rb_nact;
static float *rb_p1, *rb_p2;   /* [frame][actor][xyz] */
static void rb_actors_find(void)
{
    const uint32_t *w = (const uint32_t *)((uintptr_t)RB_CONT_LO + g_xbox_mem_offset);
    uint32_t i;
    rb_nact = 0;
    for (i = 0; i < RB_CONT_LEN / 4u - 0x40u && rb_nact < RB_ACT_MAX; i++) if (w[i] == 0x001741C0u) rb_act[rb_nact++] = RB_CONT_LO + i * 4u;
}
static void rb_actors_read(float *dst)
{
    uint32_t a;
    for (a = 0; a < rb_nact; a++) memcpy(dst + a * 3u, (const void *)((uintptr_t)rb_act[a] + 0xF0u + g_xbox_mem_offset), 12);
}
static void rb_actors_report(int m)
{
    uint32_t a, live = 0, bad = 0;
    int f;
    for (a = 0; a < rb_nact; a++) {
        int moved = 0, first = -1;
        for (f = 1; f <= m; f++) if (memcmp(rb_p1 + ((size_t)f * rb_nact + a) * 3u, rb_p1 + (size_t)a * 3u, 12)) { moved = 1; break; }
        if (!moved) continue;
        live++;
        for (f = 0; f <= m; f++) if (memcmp(rb_p1 + ((size_t)f * rb_nact + a) * 3u, rb_p2 + ((size_t)f * rb_nact + a) * 3u, 12)) { first = f; break; }
        if (first >= 0) {
            bad++;
            if (bad <= 12) fprintf(stderr, "  [ROLLBACK]   actor %08X diverges at +%d frames: %g,%g,%g against %g,%g,%g\n", rb_act[a], first,
                rb_p2[((size_t)first * rb_nact + a) * 3u], rb_p2[((size_t)first * rb_nact + a) * 3u + 1], rb_p2[((size_t)first * rb_nact + a) * 3u + 2],
                rb_p1[((size_t)first * rb_nact + a) * 3u], rb_p1[((size_t)first * rb_nact + a) * 3u + 1], rb_p1[((size_t)first * rb_nact + a) * 3u + 2]);
        }
    }
    fprintf(stderr, "  [ROLLBACK] actors: %u found, %u moved in the first pass, %u of those differ in the second\n", rb_nact, live, bad);
}

int tt_rb_test(volatile uint32_t *frame)
{
    static int n = -1, m, state;   /* state: 0 waiting, 1 first pass, 2 second pass, 3 done */
    static RBImage snap, end1;
    uint32_t fr = *frame;
    if (n < 0) {
        const char *e = getenv("TT_RB_TEST");
        n = 0;
        if (e && sscanf(e, "%d:%d", &n, &m) == 2 && n > 0 && m > 0) fprintf(stderr, "  [ROLLBACK] test: frame %d, then %d frames twice\n", n, m);
        else n = 0;
    }
    if (!n || state == 3) return 0;
    if ((state == 1 || state == 2) && fr >= (uint32_t)n && fr <= (uint32_t)(n + m) && m < RB_MAXF)
        rb_actors_read((state == 1 ? rb_p1 : rb_p2) + (size_t)(fr - (uint32_t)n) * rb_nact * 3u);
    if (state == 0 && fr == (uint32_t)n) {
        double t0 = rb_ms();
        snap = rb_img_new(); end1 = rb_img_new();
        if (!snap.host || !snap.ram || !snap.cont || !end1.ram || !end1.cont) { fprintf(stderr, "  [ROLLBACK] no memory for the images\n"); state = 3; return 0; }
        rb_save(&snap);
        rb_actors_find();
        rb_p1 = (float *)calloc((size_t)(m + 1) * rb_nact * 3u + 3u, 4); rb_p2 = (float *)calloc((size_t)(m + 1) * rb_nact * 3u + 3u, 4);
        rb_actors_read(rb_p1);
        fprintf(stderr, "  [ROLLBACK] frame %u: snapshot taken (%.1f ms, %d host variables, %u bytes)\n", fr, rb_ms() - t0, rb_nreg, (unsigned)rb_host_len());
        state = 1;
    } else if (state == 1 && fr == (uint32_t)(n + m)) {
        double t0 = rb_ms(), t1;
        rb_save(&end1);
        t1 = rb_ms();
        rb_load(&snap);
        fprintf(stderr, "  [ROLLBACK] frame %u: end of the first pass kept (%.1f ms), frame %d restored (%.1f ms)\n", fr, t1 - t0, n, rb_ms() - t1);
        rb_actors_read(rb_p2);   /* (frame n again) */
        *frame = (uint32_t)n;
        state = 2;
        return 1;
    } else if (state == 2 && fr == (uint32_t)(n + m)) {
        fprintf(stderr, "  [ROLLBACK] frame %u: the second pass ends\n", fr);
        rb_actors_report(m);
        rb_compare(&end1);
        state = 3;
    }
    return 0;
}
