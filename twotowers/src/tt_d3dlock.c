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
 * Recursive per thread (D3D calls into itself, and a callback may call back in); D3D's interrupt handler is called
 * by the runtime, not by game code, so it never takes the lock and cannot wait on it.
 *
 * Off for now: TT_D3DLOCK=1 turns it on, until a stress comparison (the GPU's semaphore releases held late, which
 * shows the overlap) says it does what it should without slowing the loads. */
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
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
    if (s_depth++ == 0) lock();
}

void tt_d3d_leave(void)
{
    if (!on()) return;
    if (s_depth > 0 && --s_depth == 0) unlock();
}
