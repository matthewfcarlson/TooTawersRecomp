/* (web port) Skipping a film: Start held over one of the game's films (the
 * intros, the films before and after a level) ends it. The page (index.html)
 * does the holding, its picture and, online, the two players' vote
 * (netplay.js: both hold Start, then both machines end the film); this is the
 * game's half.
 *
 *   tt_web_film()       the film playing now, as a number (its file's name,
 *                       the same on both machines), or 0: none, the death
 *                       movie a level keeps open, or the main menu's.
 *   tt_web_film_skip(id) ends that film, if it is still the one playing
 *                       (online, a film played in frames is left to the
 *                       lockstep: tt_web_film_vote, tt_netplay.c).
 *
 * The game plays a film to its end (A and Start do nothing). Bink's movie
 * (HBINK: +0 width, +4 height, +8 frames, +0xC the frame now, +0x10 the last
 * shown, +0x14 / +0x18 the rate) is found in memory and put at its last frame:
 * the game's film loop (0x000E8B70) ends at frame == frames - 1, as at its end
 * (menus.c's click on the intro films does the same).
 *
 * Online, the films outside play (the intros) are outside the lockstep: each
 * machine plays them at its own pace, so the page ends them on both once both
 * players have voted. The film before a level is played in frames, as play is:
 * each player's vote goes in their input records (tt_netplay.c, NP_FILM_VOTE)
 * and both machines end it on the first frame both votes are in -- ended at
 * whatever moment each page heard the other's vote, the two games went out of
 * step (seen: film frames 210 and 212, a desync 30 frames later). MIT, as the
 * rest of the port. */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define FS_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FS_EXPORT
#endif

extern ptrdiff_t xbox_GetMemoryOffset(void);
extern uint32_t xbox_FilmId(void);

#define FS_MEM32(a) (*(volatile uint32_t *)((uintptr_t)xbox_GetMemoryOffset() + (uint32_t)(a)))
#define FS_GAMESTATE 0x4AD050u   /* 4: the main menu, 6: play, 8: a film or loading */

FS_EXPORT uint32_t tt_web_film(void)
{
    uint32_t id = xbox_FilmId();
    if (!id || FS_MEM32(FS_GAMESTATE) == 4) return 0;   /* (the title's and the main menu's film plays behind them) */
    return id;
}
FS_EXPORT uint32_t tt_web_film_state(void) { return FS_MEM32(FS_GAMESTATE); }

/* every HBINK-looking block (a film's, and others the game keeps open): the one
 * playing is past its first frame */
static int fs_find(uint32_t *out, int max)
{
    const uint8_t *m = (const uint8_t *)(uintptr_t)xbox_GetMemoryOffset();
    uint32_t a;
    int n = 0;
    for (a = 0x10000u; a < 0x84000000u - 0x40u && n < max; a += 4) {
        const uint32_t *q;
        uint32_t w, h, fr, fn, rate, div;
        if (a == 0x04000000u) a = 0x80010000u;
        q = (const uint32_t *)(m + a);
        w = q[0];
        if (w < 320 || w > 1280) continue;
        h = q[1]; if (h < 200 || h > 720) continue;
        fr = q[2]; if (fr < 2 || fr > 200000) continue;
        fn = q[3]; if (fn < 1 || fn > fr) continue;
        if (q[4] > fr) continue;
        rate = q[5]; div = q[6];
        if (!div || rate / div < 10 || rate / div > 61) continue;
        out[n++] = a;
    }
    return n;
}

/* ends the film (the game's thread, online: tt_netplay.c, on the frame both votes are in) */
int tt_film_skip_now(uint32_t id)
{
    uint32_t c[16], best = 0, bestfn = 0;
    int n, i;
    if (!id || xbox_FilmId() != id) return 0;
    n = fs_find(c, 16);
    for (i = 0; i < n; i++) {
        uint32_t fr = FS_MEM32(c[i] + 8), fn = FS_MEM32(c[i] + 0xC);
        fprintf(stderr, "[FILMSKIP] a film at %08X: frame %u of %u\n", c[i], fn, fr);
        if (fn >= 2 && fn < fr - 1 && fn > bestfn) { best = c[i]; bestfn = fn; }
    }
    if (!best) { fprintf(stderr, "[FILMSKIP] film %08X: its movie not found (or at its end)\n", id); return 0; }
    FS_MEM32(best + 0xC) = FS_MEM32(best + 8) - 1;
    fprintf(stderr, "[FILMSKIP] film %08X skipped at frame %u (state %u)\n", id, bestfn, FS_MEM32(FS_GAMESTATE));
    return 1;
}

/* the page's skip: 1 ended, 0 not (no such film), -1 left to the lockstep -- online, a film played in frames
 * (the one before a level) ends on the frame both players' votes are in (tt_netplay.c, tt_web_film_vote): one
 * ended here, at whatever moment the page runs, ended on a different frame on each machine (a desync) */
FS_EXPORT int tt_web_film_skip(uint32_t id)
{
    extern int tt_netplay_film_lockstep(void);
    if (!id || tt_web_film() != id) return 0;
    if (tt_netplay_film_lockstep()) return -1;
    return tt_film_skip_now(id);
}
