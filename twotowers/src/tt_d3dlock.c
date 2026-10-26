/* (web port) One game thread in Direct3D at a time (postproc_d3dlock.py wraps every call the game makes into D3D,
 * 0x00114AC0-0x001275B0, in tt_d3d_enter / tt_d3d_leave).
 *
 * D3D's push buffer -- the GPU's command list, its write pointer and the space it reserves -- is the device's, not
 * a thread's, and nothing in D3D locks it. The Xbox has one CPU, and the game's threads keep out of each other's
 * way by priority: its loading-screen thread (0x000E7AE0) is raised above the main thread while a loading screen
 * shows (0x000E7340) and dropped to idle after (0x000E7940), so on the console the two never write it at once.
 * Here they are real threads and run at once: at a loading screen's hand-off both reserved the same space, a
 * method's arguments were overwritten by the other's semaphore release, PUT was published inside them, and the
 * GPU's reader lost its place (a freeze a few frames into a new screen; holds of seconds at loading screens).
 * With the lock a thread's D3D call runs whole before another's starts -- the order the console's single CPU kept.
 *
 * A push-buffer recording is kept whole too. Both threads draw their frames into a recording (the frame's start,
 * 0x000E01E0, calls BeginPushBuffer at 0x000E026D; its end, 0x000E0280, EndPushBuffer at 0x000E033D), and while
 * one records, the device's put pointer is the recording's: anything another thread put in then went into that
 * recording, not the GPU's stream -- the flush's callback (0x000E08D0: InsertCallback(2), kick, wait for 0x1BB3BC
 * to read 2) never ran, and the flush waited for the watchdog (300 ms). A thread that leaves D3D with the device
 * recording (its flags' bit 2) keeps the lock until it leaves with the recording ended.
 *
 * Recursive per thread (D3D calls into itself, and a callback may call back in); D3D's interrupt handler is called
 * by the runtime, not by game code, so it never takes the lock and cannot wait on it.
 *
 * Off for now: TT_D3DLOCK=1 turns it on. Under the stress knob (the GPU's semaphore releases held late), level end
 * to the second level: off, 2 of 8 runs corrupted the push buffer and froze; on, 0 of 5, no holds, loads and frame
 * rate the same. Still to run on other levels before it is the default. */
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <stddef.h>
extern ptrdiff_t g_xbox_mem_offset;
#define DEV_MEM32(a) (*(volatile uint32_t *)((uintptr_t)(uint32_t)(a) + g_xbox_mem_offset))
#if defined(_WIN32)
#include <windows.h>
static CRITICAL_SECTION s_cs;
static INIT_ONCE s_once = INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK cs_init(PINIT_ONCE o, PVOID p, PVOID *c) { (void)o; (void)p; (void)c; InitializeCriticalSection(&s_cs); return TRUE; }
static void lock(void) { InitOnceExecuteOnce(&s_once, cs_init, NULL, NULL); EnterCriticalSection(&s_cs); }
static void unlock(void) { LeaveCriticalSection(&s_cs); }
#define TLS __declspec(thread)
#else
#include <pthread.h>
static pthread_mutex_t s_mu = PTHREAD_MUTEX_INITIALIZER;
static void lock(void) { pthread_mutex_lock(&s_mu); }
static void unlock(void) { pthread_mutex_unlock(&s_mu); }
#define TLS __thread
#endif

static TLS int s_depth;
static TLS int s_rec;   /* this thread left D3D with the device recording: it keeps the lock until the recording ends */
static int s_on = -1;

static int on(void)
{
    if (s_on < 0) {
        const char *e = getenv("TT_D3DLOCK");
        s_on = e && *e == '1';
        if (s_on) fprintf(stderr, "[D3DLOCK] on (TT_D3DLOCK=1): one game thread in D3D at a time\n");
    }
    return s_on;
}

void tt_d3d_enter(void)
{
    if (!on()) return;
    if (s_depth++ == 0 && !s_rec) lock();
}

void tt_d3d_leave(void)
{
    if (!on()) return;
    if (s_depth > 0 && --s_depth == 0) {
        uint32_t dev = DEV_MEM32(0x00124180u);   /* (D3D's device; flags at +8, bit 2: recording a push buffer) */
        s_rec = dev && (DEV_MEM32(dev + 8) & 4u);
        if (!s_rec) unlock();
    }
}
