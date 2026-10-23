/* (web port) Start-up for the WebAssembly build, before WinMain.
 *
 * Settings: every KEY=VALUE argument becomes an environment variable, so the
 * game's switches (TWOTOWERS_GAME_DIR, TT_TWEAKS, TT_SHOTS, TT_P1SCRIPT,
 * RECOMP_RENDERER, ...) are given the same way on both hosts: on Node's
 * command line, and in the browser from the page's URL query.
 *
 * Under Node there is no window (TT_WEB_HEADLESS): frames are seen through
 * the game's frame dumps (TT_SHOTS, RECOMP_FB_DUMP).
 *
 * TT_WEB_EXIT_AFTER=<seconds> ends the run cleanly then (a profiler's output,
 * the runner's time limit).
 *
 * Files (WasmFS): under Node the host's file system is mounted at /host, so a
 * test run reads the disc where it is and writes its log, ini and frames into
 * TT_WEB_HOME on the host. In the browser the disc is fetched from the page's
 * server as the game reads it (disc/, listed in disc-manifest.json: lines of
 * "<size> <path>"; web/serve.mjs), and frames go to the page's canvas
 * (TT_WEB_CANVAS). */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <pthread.h>
#include <unistd.h>
#include <fcntl.h>
#include <emscripten.h>
#include <emscripten/wasmfs.h>

static void *exit_after(void *p)
{
    sleep((unsigned)(uintptr_t)p);
    fprintf(stderr, "[WEB] TT_WEB_EXIT_AFTER: %u s, ending the run\n", (unsigned)(uintptr_t)p);
    exit(0);
}

/* The disc, from the page's server: the manifest names every file (a fetch
 * backend lists nothing by itself), and each is fetched in chunks when read. */
static void mount_disc(void)
{
    char *list = (char *)EM_ASM_PTR({
        var x = new XMLHttpRequest();   /* (synchronous: this is a worker) */
        x.open('GET', 'disc-manifest.json', false);
        x.send();
        return x.status == 200 ? stringToNewUTF8(x.responseText) : 0;
    });
    backend_t b;
    char *line, *save = NULL;
    int n = 0;
    if (!list) { fprintf(stderr, "[WEB] no disc-manifest.json from the server: no disc\n"); return; }
    /* names matched without regard to case, as on the console (the disc has
     * Default.xbe, the game opens default.xbe); the fetches then ask for
     * lower-case paths, which the server matches the same way */
    b = wasmfs_create_fetch_backend("disc", 4u << 20);
    if (b) b = wasmfs_create_icase_backend(b);
    if (!b || wasmfs_create_directory("/disc", 0777, b) != 0) {
        fprintf(stderr, "[WEB] could not create /disc\n");
        free(list);
        return;
    }
    for (line = strtok_r(list, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        char *path = strchr(line, ' '), full[1024], *sl;
        if (!path) continue;
        snprintf(full, sizeof full, "/disc/%s", path + 1);
        for (sl = full + 6; (sl = strchr(sl, '/')) != NULL; sl++) {   /* its folders first */
            *sl = 0;
            mkdir(full, 0777);
            *sl = '/';
        }
        {
            int fd = wasmfs_create_file(full, 0444, b);
            if (fd >= 0) { close(fd); n++; }
        }
    }
    free(list);
    {   /* The hard disk's save partition maps into the game folder (UDATA:
         * saves, TDATA: the title's data), and the disc is read-only: those
         * two in memory for now (lost on reload) */
        backend_t m = wasmfs_create_memory_backend();
        wasmfs_create_directory("/disc/UDATA", 0777, m);
        wasmfs_create_directory("/disc/TDATA", 0777, m);
    }
    setenv("TWOTOWERS_GAME_DIR", "/disc", 0);
    fprintf(stderr, "[WEB] disc: %d files, fetched as they are read\n", n);
}

void tt_web_init(int argc, char **argv)
{
    int i, node = EM_ASM_INT({ return ENVIRONMENT_IS_NODE ? 1 : 0; });
    for (i = 1; i < argc; i++)
        if (strchr(argv[i], '=')) putenv(strdup(argv[i]));
    if (node) {
        setenv("TT_WEB_HEADLESS", "1", 0);   /* no window, no canvas */
        backend_t b = wasmfs_create_node_backend("/");
        if (!b || wasmfs_create_directory("/host", 0777, b) != 0)
            fprintf(stderr, "[WEB] could not mount the host's files at /host\n");
    }
    if (!node) {
        /* home (ini, saves, the hard disk's partition images) in the
         * origin's private file system, which keeps it across visits and,
         * unlike memory, can hold the 5.8 GB of partition images the
         * kernel sizes up front without allocating them */
        backend_t o = wasmfs_create_opfs_backend();
        if (o && wasmfs_create_directory("/opfs", 0777, o) == 0) {
            mkdir("/opfs/tt", 0777);
            setenv("TT_WEB_HOME", "/opfs/tt", 0);
        } else {
            fprintf(stderr, "[WEB] no OPFS: home in memory (lost on reload), partition images left empty\n");
            setenv("TT_WEB_NO_SPARSE", "1", 0);
        }
        setenv("TT_WEB_HEADLESS", "1", 0);   /* no SDL window: the page draws (TT_WEB_CANVAS) */
        setenv("TT_WEB_CANVAS", "1", 0);
        /* SDL's browser audio wants the page's thread, and the game runs in a
         * worker: silent for now */
        setenv("SDL_AUDIODRIVER", "dummy", 0);
        mount_disc();
    }
    if (getenv("TT_WEB_EXIT_AFTER")) {
        pthread_t th;
        pthread_create(&th, NULL, exit_after, (void *)(uintptr_t)atoi(getenv("TT_WEB_EXIT_AFTER")));
        pthread_detach(th);
    }
    if (!getenv("TT_WEB_HOME")) setenv("TT_WEB_HOME", "/home/web_user", 1);
    mkdir(getenv("TT_WEB_HOME"), 0777);
    fprintf(stderr, "[WEB] %s, home %s, game %s\n", node ? "Node" : "browser",
            getenv("TT_WEB_HOME"), getenv("TWOTOWERS_GAME_DIR") ? getenv("TWOTOWERS_GAME_DIR") : "(unset)");
}
