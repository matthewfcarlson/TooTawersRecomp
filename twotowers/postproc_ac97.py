#!/usr/bin/env python3
"""(web port) Complete AC'97 bus-master resets in the generated C instead of
in a page-fault handler.

DirectSound resets each AC'97 DMA channel by setting RR (bit 1) of its
control byte (0xFEC0010B + channel) and then reads the byte once, expecting
the controller to have cleared it (see the AC'97 note in
xbox_memory_layout.c). That was modelled by write-protecting the page and
single-stepping each write with the trap flag, which a browser cannot do,
and which Rosetta 2 reports as a breakpoint (the macOS build died in
DirectSoundCreate).

Every write whose address has a constant in the AC'97 block gets a call
after it:
    MEM8(L_eax + -20971253) = 2;  ->  MEM8(L_eax + -20971253) = 2; xbox_Ac97WriteDone();
which does what the trap's second half did: clears RR in every channel.
The file also defines g_ac97_writes_routed, which main.c reads, so a build
from generated code this pass has not seen fails to link rather than hang.
Run after every relift (generate.py does)."""
import re, sys, glob, os

LO, HI = 0xFEC00000, 0xFEC01000
CONST = re.compile(r'(?<![\w.])(-?\d+|0x[0-9A-Fa-f]+)u?\b')
WRITE = re.compile(r'^(\s*)S?MEM(?:8|16|32)\((.*?)\) = .*;\s*(/\*.*\*/)?\s*$')
CALL = ' xbox_Ac97WriteDone();'
DECL = 'extern void xbox_Ac97WriteDone(void);\n'
FLAG = 'const int g_ac97_writes_routed = 1;\n'

def is_ac97(addr):
    return any(LO <= (int(t, 0) & 0xFFFFFFFF) < HI for t in CONST.findall(addr))

def process(path, define_flag):
    src = open(path).read()
    if DECL in src:
        return 0, FLAG in src
    out, n = [], 0
    for line in src.split('\n'):
        m = WRITE.match(line)
        if m and is_ac97(m.group(2)):
            line = line.rstrip() + CALL
            n += 1
        out.append(line)
    if n:
        text = '\n'.join(out)
        idx = text.rfind('#include')
        eol = text.find('\n', idx) + 1
        text = text[:eol] + DECL + (FLAG if define_flag else '') + text[eol:]
        open(path, 'w').write(text)
    return n, n and define_flag

total, flagged = 0, False
for f in sorted(glob.glob(os.path.join(sys.argv[1], 'recomp_*.c'))):
    k, has_flag = process(f, not flagged)
    flagged = flagged or bool(has_flag)
    if k:
        print('%s: %d AC97 writes' % (os.path.basename(f), k))
    total += k
if not flagged:
    sys.exit('No AC97 writes found: is this The Two Towers\' generated code?')
print('AC97 writes routed:', total)
