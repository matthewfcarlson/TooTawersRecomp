/* (netplay) The game's state, hashed at each frame boundary.
 *
 * Lockstep netplay runs the same game on two machines from the same inputs and
 * relies on both staying identical; a hash of the state every frame (or every
 * few) is how a desync is noticed, and comparing the hashes of two runs is how
 * the things that make the game non-deterministic are found.
 *
 * Called once a game frame from the game's frame timer (sub_000E3350, in
 * twotowers_manual.c). With TT_STATEHASH=<file>, each frame appends a record:
 *
 *   uint32 magic 'TTSH', uint32 frame, uint32 game ms, uint32 pages,
 *   uint64 hash[pages]
 *
 * one hash per 64 KB page of main RAM (0x00010000-0x04000000) then of the
 * contiguous window (0x80000000-0x84000000, where the game keeps many of its
 * objects). web/tools/statehash.py compares two runs: the first frame they
 * differ, and in which pages. TT_STATEHASH_EVERY=n hashes every n-th frame
 * (default 1); TT_STATEHASH_FROM=n starts at frame n.
 *
 * Frames counted from boot do not line up between two machines: how many go
 * by while a level loads depends on how fast its files arrive. With
 * TT_STATEHASH_INPLAY=1 the frame number counts only frames in play (the
 * game's state at 0x4AD050 is 6 or 8), from 1 each time play begins, so two
 * runs compare from the first frame of the level on. A last entry after the
 * pages hashes every actor's position (the objects with vtable 0x001741C0 in
 * the contiguous window, x y z at +0xF0, as TT_ACTLOG finds them) and the
 * player's: the simulation itself, without the buffers around it.
 * TT_STATEHASH_SHOTS=dir:f1,f2,... asks for a picture of those frames
 * (dir/f<frame>.bmp), to compare two runs by eye at the same moment.
 * TT_STATEHASH_DUMP=dir:f1,f2,... writes all of RAM and the contiguous window
 * at those frames (dir/ram_<frame>.bin, 64 MB each from 0x00010000; then
 * cont_<frame>.bin), to diff two runs word by word where their hashes part;
 * with TT_STATEHASH_DUMPPAGES=va,va,... (hex) only those 64 KB pages
 * (dir/pages_<frame>.bin, in that order: small enough to take out of a
 * browser).
 * TT_STATEHASH_DUMPDATA=dir:from-to writes the image's .data/.bss
 * (0x0018B6E0-0x008DD998) at every frame from..to (dir/data_<frame>.bin),
 * to find the first word in which two runs part.
 * TT_STATEHASH_INJECT=<file> (testing): at frame 1, writes the words listed
 * in the file (lines "<hex address> <hex value>") -- another run's values,
 * to find which of the words that differ at the start of play matter.
 *
 * The hash is not a cryptographic one: 64-bit words mixed by multiply and
 * rotate, enough to tell two states apart. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern ptrdiff_t g_xbox_mem_offset;

#define SH_PAGE      0x10000u
#define SH_RAM_LO    0x00010000u
#define SH_RAM_HI    0x04000000u
#define SH_CONT_LO   0x80000000u
#define SH_CONT_HI   0x84000000u
#define SH_PAGES     (((SH_RAM_HI - SH_RAM_LO) + (SH_CONT_HI - SH_CONT_LO)) / SH_PAGE)
#define SH_GAMESTATE 0x4AD050u
#define SH_PLAYER    0x43B15Cu
#define SH_ACTOR_VT  0x001741C0u

static uint64_t sh_page(const uint64_t *w)
{
    uint64_t h = 0x9E3779B97F4A7C15ull;
    unsigned i;
    for (i = 0; i < SH_PAGE / 8; i += 4) {
        h = (h ^ w[i])     * 0xFF51AFD7ED558CCDull; h = (h << 31) | (h >> 33);
        h = (h ^ w[i + 1]) * 0xC4CEB9FE1A85EC53ull; h = (h << 29) | (h >> 35);
        h = (h ^ w[i + 2]) * 0xFF51AFD7ED558CCDull; h = (h << 31) | (h >> 33);
        h = (h ^ w[i + 3]) * 0xC4CEB9FE1A85EC53ull; h = (h << 29) | (h >> 35);
    }
    return h ^ (h >> 32);
}

#define SH_MEM32(va) (*(const volatile uint32_t *)((uintptr_t)(uint32_t)(va) + g_xbox_mem_offset))

/* the actors' and the player's positions, hashed (order: as they lie in memory) */
static uint64_t sh_actors(uint32_t *count)
{
    const uint32_t *w = (const uint32_t *)((uintptr_t)SH_CONT_LO + g_xbox_mem_offset);
    uint64_t h = 0x9E3779B97F4A7C15ull;
    uint32_t i, n = 0, p = SH_MEM32(SH_PLAYER);
    for (i = 0; i < (SH_CONT_HI - SH_CONT_LO) / 4u - 0x40u; i++)
        if (w[i] == SH_ACTOR_VT) {
            h = (h ^ w[i + 0xF0 / 4]) * 0xFF51AFD7ED558CCDull;
            h = (h ^ w[i + 0xF4 / 4]) * 0xC4CEB9FE1A85EC53ull;
            h = (h ^ w[i + 0xF8 / 4]) * 0xFF51AFD7ED558CCDull;
            n++;
        }
    if (p) for (i = 0; i < 3; i++) h = (h ^ SH_MEM32(p + 0xF0 + 4 * i)) * 0xC4CEB9FE1A85EC53ull;
    *count = n;
    return h ^ (h >> 29);
}

/* (netplay) the simulation's hash now, for the desync check (tt_netplay.c) */
uint64_t tt_statehash_sim(void)
{
    uint32_t n;
    return sh_actors(&n);
}

void tt_statehash_frame(uint32_t game_ms)
{
    static int on = -1, every = 1, from = 0, inplay = 0;
    static FILE *f;
    static uint32_t frame;
    static uint64_t *hs;
    uint32_t va, k = 0, hdr[4];
    if (on < 0) {
        const char *p = getenv("TT_STATEHASH");
        on = 0;
        if (p && *p && (f = fopen(p, "wb")) != NULL && (hs = (uint64_t *)malloc((SH_PAGES + 1) * 8u)) != NULL) on = 1;
        inplay = getenv("TT_STATEHASH_INPLAY") != NULL;
        if (getenv("TT_STATEHASH_EVERY")) every = atoi(getenv("TT_STATEHASH_EVERY"));
        if (getenv("TT_STATEHASH_FROM")) from = atoi(getenv("TT_STATEHASH_FROM"));
        if (every < 1) every = 1;
        if (on) fprintf(stderr, "  [STATEHASH] %u pages a frame to %s (every %d, from frame %d)\n", (unsigned)SH_PAGES, p, every, from);
    }
    if (on && inplay) {
        uint32_t st = SH_MEM32(SH_GAMESTATE);
        extern int tt_netplay_tick_kind(void);
        if (st != 6 && st != 8) { frame = 0; return; }
        if (tt_netplay_tick_kind() != 1) return;   /* (a load's tick, not a frame: tt_netplay.c) */
    }
    frame++;
    if (frame == 1) {   /* testing: another run's words, at the start of play */
        static int done;
        const char *inj = getenv("TT_STATEHASH_INJECT");
        FILE *fi;
        if (inj && !done && (fi = fopen(inj, "r")) != NULL) {
            unsigned a, v, n = 0;
            while (fscanf(fi, "%x %x", &a, &v) == 2) {
                *(volatile uint32_t *)((uintptr_t)a + g_xbox_mem_offset) = v;
                n++;
            }
            fclose(fi);
            done = 1;
            fprintf(stderr, "  [STATEHASH] frame 1: %u word(s) written from %s\n", n, inj);
        }
    }
    {   /* .data/.bss at every frame of a range */
        static const char *dd = (const char *)1; static unsigned from, to;
        if (dd == (const char *)1) {
            dd = getenv("TT_STATEHASH_DUMPDATA");
            if (dd && strchr(dd, ':')) sscanf(strchr(dd, ':') + 1, "%u-%u", &from, &to);
        }
        if (dd && frame >= from && frame <= to) {
            char path[512]; FILE *d;
            snprintf(path, sizeof path, "%.*s/data_%05u.bin", (int)(strchr(dd, ':') - dd), dd, (unsigned)frame);
            if ((d = fopen(path, "wb"))) { fwrite((const void *)((uintptr_t)0x0018B6E0u + g_xbox_mem_offset), 1, 0x008DD998u - 0x0018B6E0u, d); fclose(d); }
        }
    }
    {   /* pictures of chosen frames */
        static const char *shots = (const char *)1;
        if (shots == (const char *)1) shots = getenv("TT_STATEHASH_SHOTS");
        if (shots) {
            const char *c = strchr(shots, ':'), *q;
            for (q = c ? c + 1 : NULL; q && *q; ) {
                if ((uint32_t)atoi(q) == frame) {
                    extern void xbox_PresentDumpRequest(const char *path);
                    static char path[512];
                    snprintf(path, sizeof path, "%.*s/f%05u.bmp", (int)(c - shots), shots, (unsigned)frame);
                    xbox_PresentDumpRequest(path);
                }
                q = strchr(q, ',');
                if (q) q++;
            }
        }
    }
    {   /* RAM dumps of chosen frames */
        static const char *dumps = (const char *)1;
        if (dumps == (const char *)1) dumps = getenv("TT_STATEHASH_DUMP");
        if (dumps) {
            const char *c = strchr(dumps, ':'), *q;
            for (q = c ? c + 1 : NULL; q && *q; ) {
                if ((uint32_t)atoi(q) == frame) {
                    char path[512];
                    FILE *d;
                    const char *pg = getenv("TT_STATEHASH_DUMPPAGES");
                    if (pg) {   /* TT_STATEHASH_DUMPPAGES=va,va,... (hex): only those 64 KB pages, one after another (pages_<frame>.bin) */
                        snprintf(path, sizeof path, "%.*s/pages_%05u.bin", (int)(c - dumps), dumps, (unsigned)frame);
                        if ((d = fopen(path, "wb"))) {
                            for (; pg && *pg; pg = strchr(pg, ',') ? strchr(pg, ',') + 1 : NULL)
                                fwrite((const void *)((uintptr_t)(uint32_t)(strtoul(pg, NULL, 16) & ~(SH_PAGE - 1u)) + g_xbox_mem_offset), 1, SH_PAGE, d);
                            fclose(d);
                        }
                        fprintf(stderr, "  [STATEHASH] frame %u: pages dumped\n", (unsigned)frame);
                        goto next_dump;
                    }
                    snprintf(path, sizeof path, "%.*s/ram_%05u.bin", (int)(c - dumps), dumps, (unsigned)frame);
                    if ((d = fopen(path, "wb"))) { fwrite((const void *)((uintptr_t)SH_RAM_LO + g_xbox_mem_offset), 1, SH_RAM_HI - SH_RAM_LO, d); fclose(d); }
                    snprintf(path, sizeof path, "%.*s/cont_%05u.bin", (int)(c - dumps), dumps, (unsigned)frame);
                    if ((d = fopen(path, "wb"))) { fwrite((const void *)((uintptr_t)SH_CONT_LO + g_xbox_mem_offset), 1, SH_CONT_HI - SH_CONT_LO, d); fclose(d); }
                    fprintf(stderr, "  [STATEHASH] frame %u dumped\n", (unsigned)frame);
                }
            next_dump:
                q = strchr(q, ',');
                if (q) q++;
            }
        }
    }
    if (!on || (int)frame < from || frame % (uint32_t)every) return;
    for (va = SH_RAM_LO; va < SH_RAM_HI; va += SH_PAGE)
        hs[k++] = sh_page((const uint64_t *)((uintptr_t)va + g_xbox_mem_offset));
    for (va = SH_CONT_LO; va < SH_CONT_HI; va += SH_PAGE)
        hs[k++] = sh_page((const uint64_t *)((uintptr_t)va + g_xbox_mem_offset));
    {
        uint32_t na;
        hs[k++] = sh_actors(&na);
        if (frame == 1 || frame % 300 == 0) fprintf(stderr, "  [STATEHASH] frame %u: %u actors, positions %016llx\n", frame, na, (unsigned long long)hs[k - 1]);
    }
    hdr[0] = 0x48535454u;   /* 'TTSH' */
    hdr[1] = frame; hdr[2] = game_ms; hdr[3] = k;
    fwrite(hdr, 4, 4, f);
    fwrite(hs, 8, k, f);
    fflush(f);
}
