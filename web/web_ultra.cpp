// (web port) The Ultra textures built in the browser, as twotowers-setup's
// "ultra" does on the desktop (tools/ultra_textures/ultra_build.h): the
// GLOS69 pack the player picked (web/import.js copies it to the page's
// private storage, with the port's textures_ultra support files) made into
// the files the game reads, once. Run by web_platform.c for
// TT_WEB_ULTRA_BUILD=<folder>; the page reads the "[ULTRA-BUILD]" lines.
#include "../twotowers/tools/ultra_textures/ultra_build.h"

extern "C" int tt_web_ultra_build(const char *dir)
{
    std::string err;
    int last = -1;
    if (!ultra_build::needed(dir)) {
        fprintf(stderr, "[ULTRA-BUILD] done: already built\n");
        return 0;
    }
    int r = ultra_build::build(dir, [&](double f, const std::string &what) {
        int p = (int)(f * 100);
        if (p != last) { last = p; fprintf(stderr, "[ULTRA-BUILD] %d %s\n", p, what.c_str()); }
    }, err);
    if (r) fprintf(stderr, "[ULTRA-BUILD] failed: %s\n", err.c_str());
    else fprintf(stderr, "[ULTRA-BUILD] done\n");
    return r;
}
