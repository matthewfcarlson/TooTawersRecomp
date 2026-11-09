/* (web port, memory study) Wrappers for the allocator, linked in only when the build adds
 * -Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc,--wrap=memalign,--wrap=posix_memalign,--wrap=aligned_alloc
 * (cmake -DCMAKE_EXE_LINKER_FLAGS=...): every request of 1 MB or more is logged with its size and C stack,
 * and the total asked so far, for finding what the heap beyond the guest's 4 GB is made of. Unused otherwise. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <emscripten.h>

#define AW_MIN (1u << 20)
void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
void *__real_memalign(size_t, size_t);
int __real_posix_memalign(void **, size_t, size_t);
void *__real_aligned_alloc(size_t, size_t);

static volatile unsigned long long aw_total;
static volatile int aw_busy;

/* by size class: requests, bytes asked (cumulative, frees not seen) */
static volatile unsigned long long aw_cnt[5], aw_bytes[5];
static volatile unsigned aw_tick, aw_sample;
static void aw_class(size_t n)
{
    int c = n < 4096 ? 0 : n < 65536 ? 1 : n < AW_MIN ? 2 : 3;
    aw_cnt[c]++; aw_bytes[c] += n;
    if (!(++aw_tick & 0x3FFFF))
        fprintf(stderr, "[ALLOC] classes asked so far: <4K %llu (%llu MB), 4-64K %llu (%llu MB), 64K-1M %llu (%llu MB), >=1M %llu (%llu MB)\n",
                aw_cnt[0], aw_bytes[0] >> 20, aw_cnt[1], aw_bytes[1] >> 20, aw_cnt[2], aw_bytes[2] >> 20, aw_cnt[3], aw_bytes[3] >> 20);
}

static void aw_note(const char *what, size_t n)
{
    char st[1024];
    if (aw_busy) return;
    aw_class(n);
    if (n >= 16384 && n < AW_MIN && !(++aw_sample % 256)) {   /* one in 256 of the middle sizes, with its stack */
        aw_busy = 1;
        st[0] = 0;
        emscripten_get_callstack(EM_LOG_C_STACK | EM_LOG_NO_PATHS, st, sizeof st);
        { char *c; for (c = st; *c; c++) if (*c == '\n') *c = ' '; }
        fprintf(stderr, "[ALLOC-S] %zu %s\n", n, st);
        aw_busy = 0;
        return;
    }
    if (n < AW_MIN) return;
    aw_busy = 1;
    aw_total += n;
    st[0] = 0;
    emscripten_get_callstack(EM_LOG_C_STACK | EM_LOG_NO_PATHS | EM_LOG_FUNC_PARAMS, st, sizeof st);
    {   /* the stack on one line */
        char *c;
        for (c = st; *c; c++) if (*c == '\n') *c = ' ';
    }
    fprintf(stderr, "[ALLOC] %s %.1f MB (all big ones so far %.0f MB): %s\n", what, n / 1048576.0, aw_total / 1048576.0, st);
    aw_busy = 0;
}

void *__wrap_malloc(size_t n) { void *p = __real_malloc(n); aw_note("malloc", n); return p; }
void *__wrap_calloc(size_t a, size_t b) { void *p = __real_calloc(a, b); aw_note("calloc", a * b); return p; }
void *__wrap_realloc(void *q, size_t n) { void *p = __real_realloc(q, n); aw_note("realloc", n); return p; }
void *__wrap_memalign(size_t al, size_t n) { void *p = __real_memalign(al, n); aw_note("memalign", n); return p; }
int __wrap_posix_memalign(void **o, size_t al, size_t n) { int r = __real_posix_memalign(o, al, n); aw_note("posix_memalign", n); return r; }
void *__wrap_aligned_alloc(size_t al, size_t n) { void *p = __real_aligned_alloc(al, n); aw_note("aligned_alloc", n); return p; }
