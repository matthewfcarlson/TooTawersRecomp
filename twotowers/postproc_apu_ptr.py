#!/usr/bin/env python3
"""(web port) Route DirectSound's pointer accesses to the APU through a checked
access, for builds with no fault handler (WebAssembly).

On the desktop the APU's registers (0xFE800000-0xFE87FFFF) are unmapped: an
access through a computed pointer faults and apu_mmio_hook.c emulates it.
postproc_apu.py turns the constant-address ones into calls; the rest -- nearly
all of DirectSound's, which keeps the register block's address in its device
object -- still rely on the fault. WebAssembly has none: those reads and writes
went to plain memory, and the title's interrupt handler read stale status and
trap registers (no notifications, and after the pause menu an idle voice it
could never take off the list: the sound cut out).

In DirectSound's code (RANGE) every non-constant MEM8/16/32 becomes
    MEMn(a) = e;   ->  TT_DSWn(a, e);
    ... MEMn(a) ... ->  ... TT_DSRn(a) ...
which in the web build check the address and call the APU for its registers,
and elsewhere are exactly MEMn (the desktop keeps its fault path unchanged).
Run after postproc_apu.py (generate.py does)."""
import re, sys, glob, os

RANGE = (0x128B60, 0x134934)    # DirectSound (the XBE's DSOUND section)
FN = re.compile(r'^\S.*\bsub_([0-9A-Fa-f]{8})\s*\(')
ACC = re.compile(r'(?<![A-Za-z0-9_])(S?)MEM(8|16|32)\(')
CONST = re.compile(r'^\s*(-?\d+|0x[0-9A-Fa-f]+)u?\s*$')
STACK = re.compile(r'^\s*(L_)?e[bs]p(\s*\+\s*-?(\d+|0x[0-9A-Fa-f]+)u?)?\s*$')

DECL = r'''/* (web port) postproc_apu_ptr.py: DirectSound's pointer accesses, checked for the APU */
#ifdef __EMSCRIPTEN__
extern uint32_t xbox_apu_rn(uint32_t va, int size); extern void xbox_apu_wn(uint32_t va, uint32_t v, int size);
#define TT_DS_APU(a) ((uint32_t)((a) - 0xFE800000u) < 0x80000u)
static inline uint32_t TT_DSR8(uint32_t a)  { return TT_DS_APU(a) ? (uint8_t)xbox_apu_rn(a, 1) : MEM8(a); }
static inline uint32_t TT_DSR16(uint32_t a) { return TT_DS_APU(a) ? (uint16_t)xbox_apu_rn(a, 2) : MEM16(a); }
static inline uint32_t TT_DSR32(uint32_t a) { return TT_DS_APU(a) ? xbox_apu_rn(a, 4) : MEM32(a); }
static inline void TT_DSW8(uint32_t a, uint32_t v)  { if (TT_DS_APU(a)) xbox_apu_wn(a, (uint8_t)v, 1); else MEM8(a) = (uint8_t)v; }
static inline void TT_DSW16(uint32_t a, uint32_t v) { if (TT_DS_APU(a)) xbox_apu_wn(a, (uint16_t)v, 2); else MEM16(a) = (uint16_t)v; }
static inline void TT_DSW32(uint32_t a, uint32_t v) { if (TT_DS_APU(a)) xbox_apu_wn(a, v, 4); else MEM32(a) = v; }
#define TT_DSSR32(a) ((int32_t)TT_DSR32(a))
#else
#define TT_DSR8(a)  MEM8(a)
#define TT_DSR16(a) MEM16(a)
#define TT_DSR32(a) MEM32(a)
#define TT_DSSR32(a) SMEM32(a)
#define TT_DSW8(a, v)  ((void)(MEM8(a) = (v)))
#define TT_DSW16(a, v) ((void)(MEM16(a) = (v)))
#define TT_DSW32(a, v) ((void)(MEM32(a) = (v)))
#endif
'''

def close_paren(s, i):
    """s[i] is just past an opening '('; the index of its closing ')'."""
    d = 1
    while i < len(s):
        if s[i] == '(': d += 1
        elif s[i] == ')':
            d -= 1
            if not d: return i
        i += 1
    raise ValueError('unbalanced: ' + s)

def stmt_end(s, i):
    """The ';' ending the expression that starts at i (depth 0)."""
    d = 0
    while i < len(s):
        c = s[i]
        if c in '([{': d += 1
        elif c in ')]}': d -= 1
        elif c == ';' and d == 0: return i
        i += 1
    raise ValueError('no ; in: ' + s)

def rewrite(s):
    """Rewrites the accesses in s; returns (text, count)."""
    out, i, n = [], 0, 0
    while True:
        m = ACC.search(s, i)
        if not m:
            out.append(s[i:]); return ''.join(out), n
        a0 = m.end(); a1 = close_paren(s, a0)
        addr = s[a0:a1]
        out.append(s[i:m.start()])
        if CONST.match(addr) or STACK.match(addr):   # a constant (plain memory, or postproc_apu.py's), the stack
            out.append(s[m.start():a1 + 1]); i = a1 + 1; continue
        addr2, k = rewrite(addr); n += k + 1
        signed, bits = m.group(1), m.group(2)
        rest = s[a1 + 1:]
        w = re.match(r'\s*=(?!=)', rest)
        if w:                                     # a store: MEMn(a) = e; (SMEM32 too: the same bits)
            e0 = a1 + 1 + w.end(); e1 = stmt_end(s, e0)
            rhs, k = rewrite(s[e0:e1]); n += k
            out.append('TT_DSW%s(%s, %s)' % (bits, addr2, rhs.strip()))
            i = e1
        else:
            out.append('TT_DS%sR%s(%s)' % ('S' if signed else '', bits, addr2))
            i = a1 + 1

def process(path):
    lines = open(path).read().split('\n')
    cur, n = None, 0
    for j, line in enumerate(lines):
        m = FN.match(line)
        if m: cur = int(m.group(1), 16)
        if cur is not None and RANGE[0] <= cur < RANGE[1] and 'MEM' in line:
            code, sep, comment = line.partition('/*') if line.lstrip().startswith('/*') else (line, '', '')
            new, k = rewrite(code)
            if k: lines[j] = new + sep + comment; n += k
    if n:
        text = '\n'.join(lines)
        idx = text.rfind('#include'); eol = text.find('\n', idx) + 1
        open(path, 'w').write(text[:eol] + DECL + text[eol:])
    return n

total = 0
for f in sorted(glob.glob(os.path.join(sys.argv[1], 'recomp_*.c'))):
    if 'postproc_apu_ptr.py' in open(f).read():
        continue
    k = process(f)
    if k: print('%s: %d DirectSound accesses' % (os.path.basename(f), k))
    total += k
print('DirectSound pointer accesses checked:', total)
