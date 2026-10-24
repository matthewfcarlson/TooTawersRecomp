#!/usr/bin/env python3
"""(web port) The game's own heap: its size from tt_game_heap_size() instead of the
constant 32 MB.

The game takes one block of contiguous memory at start (sub_000E6E00:
MmAllocateContiguousMemoryEx(0x2000000, 0, -1, 4)), keeps its base / end / size
at 0x6B1CFC / 0x6B1CF8 / 0x6B1CF4 and allocates every level's files and objects
from both ends of it. Levels leave 5.5-15 MB of it free: room for denser
replacement models wants more. The size appears three times in the function --
the size asked for, the end computed from the base, the size stored -- and all
three become tt_game_heap_size() (src/tt_heap.c: 32 MB unless TT_GAME_HEAP_MB
asks for more). Idempotent; run after postproc_regs.py (generate.py does)."""
import re, sys, glob, os

FN = 'void sub_000E6E00(void)'
SIZE = '0x2000000'
SITES = [   # (each must match exactly once in the function's body)
    re.compile(r'(PUSH32\((?:L_)?esp, )0x2000000(\);)'),
    re.compile(r'(_fb = \(uint32_t\)\()0x2000000(\) & 0xFFFFFFFFu;)'),
    re.compile(r'((?:L_)?eax = (?:L_)?eax \+ )0x2000000(;)'),
    re.compile(r'(MEM32\(0x6B1CF4\) = )0x2000000(;)'),
]
DECL = '/* (web port) postproc_heap.py: the game heap\'s size */\nextern uint32_t tt_game_heap_size(void);\n'


def main(gen):
    for path in sorted(glob.glob(os.path.join(gen, '*.c'))):
        src = open(path).read()
        at = src.find('\n' + FN + '\n{')
        if at < 0:
            continue
        end = src.find('\n}\n', at)
        body = src[at:end]
        if 'tt_game_heap_size()' in body:
            print('heap: already sized by tt_game_heap_size() in ' + os.path.basename(path))
            return 0
        for rx in SITES:
            body, n = rx.subn(r'\1tt_game_heap_size()\2', body)
            if n != 1:
                print('heap: %s matched %d times in sub_000E6E00 (expected 1): not rewritten' % (rx.pattern, n), file=sys.stderr)
                return 1
        src = src[:at] + body + src[end:]
        inc = src.find('#include "recomp_funcs.h"\n')
        if inc >= 0:
            inc += len('#include "recomp_funcs.h"\n')
            src = src[:inc] + DECL + src[inc:]
        else:
            src = DECL + src
        open(path, 'w').write(src)
        print('heap: sized by tt_game_heap_size() in ' + os.path.basename(path))
        return 0
    print('heap: sub_000E6E00 not found', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'src', 'recomp', 'gen')))
