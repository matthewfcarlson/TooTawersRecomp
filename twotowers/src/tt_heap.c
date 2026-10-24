/* (web port) The size of the game's own heap (postproc_heap.py routes the
 * game's constant through here).
 *
 * The game allocates everything a level holds -- the level file itself, its
 * models, textures and objects -- from one block of contiguous memory it takes
 * at start, 32 MB on the console. The recomp's contiguous window is 64 MB, of
 * which the game's other requests (framebuffers, sound buffers, a 3.5 MB one
 * once play begins) take about 18.6 MB, and the GPU's instance memory 128 KB
 * more: the heap can grow to 44 MB with no other change (45 leaves 0.3 MB;
 * 48 has the window refuse that 3.5 MB: "[CONTIG] arena exhausted"). Room for
 * denser replacement models: Helm's Deep, the fullest level, has 6 MB of the
 * heap free at 32 and 18 at 44. The browser build takes 44 by default, the
 * desktop the console's 32; TT_GAME_HEAP_MB=32..44 picks (anything else: the
 * default). Beyond 44 the window itself has to grow (XBOX_CONTIG_SIZE, and
 * what assumes it ends at 0x84000000).
 *
 * Online, both players must use the same size (it moves where the game's
 * later allocations land): set it for both, or for neither. */
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

uint32_t tt_game_heap_size(void)
{
    static uint32_t size;
    if (!size) {
#ifdef __EMSCRIPTEN__
        const int def = 44;
#else
        const int def = 32;
#endif
        const char *e = getenv("TT_GAME_HEAP_MB");
        int mb = e ? atoi(e) : def;
        if (mb < 32 || mb > 44) mb = def;
        size = (uint32_t)mb << 20;
        if (mb != 32) fprintf(stderr, "[HEAP] the game's heap: %d MB (the console's is 32)\n", mb);
    }
    return size;
}
