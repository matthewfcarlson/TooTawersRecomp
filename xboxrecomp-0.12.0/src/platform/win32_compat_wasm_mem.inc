/* (web port) The guest's address space in WebAssembly (memory64).
 *
 * Included by win32_compat.c in place of the mmap-based arena, VirtualAlloc
 * and file mappings when __EMSCRIPTEN__ is defined.
 *
 * WebAssembly has one linear memory and no page tables: nothing can be
 * reserved without being backed, protected, or mapped twice. What it does
 * have is zero-filled memory that the engine does not commit until it is
 * touched. So the arena is one 4 GB allocation, fresh from sbrk and left
 * alone; VirtualAlloc and the first view of a file mapping claim pages of it
 * at the address asked for, and the layout's views keep their `va + offset`
 * addresses exactly as on the desktop.
 *
 * What cannot be had:
 *   - Aliasing. A second view of a mapping at another address (the RAM's
 *     mirrors, the tiled view at 0xF0000000, the flash's mirrors) fails, as
 *     MapViewOfFileEx fails on Windows when an address is taken, and the
 *     layout logs it. A second view with no address asked for is handed the
 *     first view's memory, which is what aliasing means there.
 *   - Protection. VirtualProtect succeeds and changes nothing: every write
 *     trap (AC97, OHCI, the APU's registers) has to be routed in code instead.
 *   - Faults. An access to arena memory nothing has claimed reads zeros and
 *     writes go nowhere visible, rather than faulting.
 */
#include <malloc.h>

static uintptr_t s_arena_lo, s_arena_hi;
/* one byte per 4 KB page: 0 never used (still zero), 1 in use, 2 free again
 * (written before, zeroed when next claimed) */
static uint8_t *s_arena_used;
static pthread_mutex_t s_arena_lock = PTHREAD_MUTEX_INITIALIZER;
#define ARENA_PG 4096u

void *w32_reserve_arena(size_t size, size_t align)
{
    void *p;
    if (s_arena_lo) return (void *)s_arena_lo;
    /* dlmalloc takes a request this size from fresh sbrk memory, which the
     * engine zero-fills on demand; nothing but the chunk header is written */
    p = memalign(align ? align : ARENA_PG, size);
    if (!p) return NULL;
    s_arena_used = (uint8_t *)calloc(size / ARENA_PG + 1, 1);
    if (!s_arena_used) { free(p); return NULL; }
    s_arena_lo = (uintptr_t)p;
    s_arena_hi = s_arena_lo + size;
    fprintf(stderr, "  [WASM] guest address space: 4 GB at linear 0x%llx\n", (unsigned long long)s_arena_lo);
    return p;
}

static int arena_has(const void *a, size_t len)
{
    uintptr_t x = (uintptr_t)a;
    return s_arena_lo && x >= s_arena_lo && x + len <= s_arena_hi && x + len >= x;
}

/* mark [a, a+len) used, zeroing pages used before; 0 if any of it is in use */
static int arena_claim(const void *a, size_t len)
{
    size_t i, p0 = ((uintptr_t)a - s_arena_lo) / ARENA_PG, n = (len + ARENA_PG - 1) / ARENA_PG;
    pthread_mutex_lock(&s_arena_lock);
    for (i = 0; i < n; i++) if (s_arena_used[p0 + i] == 1) { pthread_mutex_unlock(&s_arena_lock); return 0; }
    for (i = 0; i < n; i++) {
        if (s_arena_used[p0 + i] == 2)
            memset((void *)(s_arena_lo + (p0 + i) * (size_t)ARENA_PG), 0, ARENA_PG);
        s_arena_used[p0 + i] = 1;
    }
    pthread_mutex_unlock(&s_arena_lock);
    return 1;
}

static void arena_unclaim(const void *a, size_t len)
{
    size_t i, p0 = ((uintptr_t)a - s_arena_lo) / ARENA_PG, n = (len + ARENA_PG - 1) / ARENA_PG;
    pthread_mutex_lock(&s_arena_lock);
    for (i = 0; i < n; i++) if (s_arena_used[p0 + i] == 1) s_arena_used[p0 + i] = 2;
    pthread_mutex_unlock(&s_arena_lock);
}

/* zeroed memory outside the arena, for allocations at no particular address */
static void *heap_zeroed(size_t len)
{
    void *p = memalign(65536, len);
    if (p) memset(p, 0, len);
    return p;
}

LPVOID VirtualAlloc(LPVOID address, SIZE_T size, DWORD allocationType, DWORD protect)
{
    (void)protect;
    /* MEM_COMMIT on a region already reserved: it is backed already */
    if ((allocationType & MEM_COMMIT) && !(allocationType & MEM_RESERVE) && address
            && arena_has(address, size))
        return address;
    if (address) {
        if (!arena_has(address, size) || !arena_claim(address, size)) {
            SetLastError(ERROR_INVALID_ADDRESS);
            return NULL;
        }
        view_register(address, size);
        return address;
    }
    {
        void *p = heap_zeroed(size);
        if (!p) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
        view_register(p, size);
        return p;
    }
}

BOOL VirtualFree(LPVOID address, SIZE_T size, DWORD freeType)
{
    if (freeType & MEM_RELEASE) {
        size_t len = view_take(address);
        if (size == 0) size = len;
        if (size == 0) return FALSE;
        if (arena_has(address, size)) { arena_unclaim(address, size); return TRUE; }
        free(address);
        return TRUE;
    }
    return TRUE;   /* MEM_DECOMMIT: nothing to give back */
}

BOOL VirtualProtect(LPVOID address, SIZE_T size, DWORD newProtect, PDWORD oldProtect)
{
    (void)address; (void)size; (void)newProtect;
    if (oldProtect) *oldProtect = PAGE_READWRITE;
    return TRUE;
}

/* ---- File mappings: one block of memory each, its first view's ---------- */

static struct { void *map; uint8_t *mem; } s_wasm_maps[64];
static pthread_mutex_t s_wasm_maps_lock = PTHREAD_MUTEX_INITIALIZER;

static uint8_t **wasm_map_slot(void *map, int add)
{
    int i, fr = -1;
    for (i = 0; i < 64; i++) {
        if (s_wasm_maps[i].map == map) return &s_wasm_maps[i].mem;
        if (fr < 0 && !s_wasm_maps[i].map) fr = i;
    }
    if (!add || fr < 0) return NULL;
    s_wasm_maps[fr].map = map;
    s_wasm_maps[fr].mem = NULL;
    return &s_wasm_maps[fr].mem;
}

HANDLE CreateFileMappingA(HANDLE file, LPSECURITY_ATTRIBUTES sa, DWORD protect,
                          DWORD maxSizeHigh, DWORD maxSizeLow, LPCSTR name)
{
    SIZE_T size = ((SIZE_T)maxSizeHigh << 32) | maxSizeLow;
    w32_object *o;
    (void)file; (void)sa; (void)protect; (void)name;
    if (size == 0) { SetLastError(ERROR_INVALID_PARAMETER); return NULL; }
    o = obj_alloc(K_FILEMAP);
    o->fd       = -1;
    o->map_size = size;
    pthread_mutex_lock(&s_wasm_maps_lock);
    wasm_map_slot(o, 1);
    pthread_mutex_unlock(&s_wasm_maps_lock);
    return (HANDLE)o;
}

HANDLE CreateFileMappingW(HANDLE file, LPSECURITY_ATTRIBUTES sa, DWORD protect,
                          DWORD maxSizeHigh, DWORD maxSizeLow, LPCWSTR name)
{
    (void)name;
    return CreateFileMappingA(file, sa, protect, maxSizeHigh, maxSizeLow, NULL);
}

LPVOID MapViewOfFileEx(HANDLE mapping, DWORD access, DWORD offHigh, DWORD offLow,
                       SIZE_T count, LPVOID baseAddr)
{
    w32_object *o = (w32_object *)mapping;
    uint8_t **mem, *view = NULL;
    size_t off, len;
    (void)access;
    if (!o || o->kind != K_FILEMAP) { SetLastError(ERROR_INVALID_HANDLE); return NULL; }
    off = ((size_t)offHigh << 32) | offLow;
    len = count ? count : o->map_size - off;
    pthread_mutex_lock(&s_wasm_maps_lock);
    mem = wasm_map_slot(o, 1);
    if (!mem) { pthread_mutex_unlock(&s_wasm_maps_lock); SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    if (!*mem) {
        /* the first view decides where the mapping's memory is */
        if (baseAddr) {
            if (arena_has(baseAddr, len) && arena_claim(baseAddr, len)) {
                view = (uint8_t *)baseAddr;
                *mem = view - off;
            }
        } else if ((*mem = (uint8_t *)heap_zeroed(o->map_size)) != NULL) {
            view = *mem + off;
        }
    } else if (!baseAddr || (uint8_t *)baseAddr == *mem + off) {
        view = *mem + off;
    } else {
        static int said;
        if (said++ < 4)
            fprintf(stderr, "  [WASM] a second view at another address cannot alias the first"
                            " (asked for linear 0x%llx)\n", (unsigned long long)(uintptr_t)baseAddr);
    }
    pthread_mutex_unlock(&s_wasm_maps_lock);
    if (!view) { SetLastError(ERROR_INVALID_ADDRESS); return NULL; }
    view_register(view, len);
    return view;
}

LPVOID MapViewOfFile(HANDLE mapping, DWORD access, DWORD offHigh, DWORD offLow, SIZE_T count)
{
    return MapViewOfFileEx(mapping, access, offHigh, offLow, count, NULL);
}

/* The memory belongs to the mapping, which outlives its views. */
BOOL UnmapViewOfFile(LPCVOID baseAddr)
{
    return view_take(baseAddr) != 0;
}
