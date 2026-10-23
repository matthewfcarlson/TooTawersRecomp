#!/usr/bin/env python3
"""(netplay) Compare two runs' state hashes (TT_STATEHASH files, tt_statehash.c).

    python3 web/tools/statehash.py A.bin B.bin [--map]

Lines up the two runs by frame number and reports the first frame whose state
differs, which 64 KB pages differ there, and how the set of differing pages
grows after it. --map names the pages by what the XBE puts there (sections,
heap, the contiguous window). Pages that differ in every frame from the start
are noise (buffers written by other threads); the first frame where a page
starts to differ, and stays different, is where the runs fork."""
import struct, sys
from collections import Counter

PAGE = 0x10000
RAM_LO, RAM_HI, CONT_LO = 0x00010000, 0x04000000, 0x80000000
NRAM = (RAM_HI - RAM_LO) // PAGE

# The Two Towers' XBE (default_analysis.json) and the port's layout
REGIONS = [
    (0x00010000, 0x00012000, 'XBE headers'), (0x00012000, 0x00114AC0, '.text'),
    (0x00114AC0, 0x0016FF88, 'XDK code (D3D, DSOUND, XACT, BINK, WMA, XPP)'),
    (0x0016FFA0, 0x0018B6D8, '.rdata'), (0x0018B6E0, 0x008DD998, '.data/.bss'),
    (0x008DD9A0, 0x00920000, 'DOLBY, BINKDATA, image sections'),
    (0x00920000, 0x009A0000, 'runtime: TIB, TLS, kernel data'),
    (0x009A0000, 0x011A0000, 'stacks'), (0x011A0000, 0x04000000, 'heap'),
    (0x80000000, 0x84000000, 'contiguous window'),
]

NPAGES = NRAM + (0x84000000 - CONT_LO) // PAGE
ACTORS = NPAGES   # the last entry: the actors' and the player's positions

def page_va(i):
    if i == ACTORS:
        return 'actors'
    return RAM_LO + i * PAGE if i < NRAM else CONT_LO + (i - NRAM) * PAGE

def region(va):
    if va == 'actors':
        return 'ACTOR POSITIONS (the simulation)'

    for lo, hi, name in REGIONS:
        if lo <= va < hi:
            return name
    return '?'

def load(path):
    out = {}
    with open(path, 'rb') as f:
        while True:
            h = f.read(16)
            if len(h) < 16:
                break
            magic, frame, ms, n = struct.unpack('<4I', h)
            if magic != 0x48535454:
                raise SystemExit(f'{path}: bad record')
            body = f.read(8 * n)
            if len(body) < 8 * n:
                break
            out[frame] = (ms, struct.unpack(f'<{n}Q', body))
    return out

def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    a, b = load(sys.argv[1]), load(sys.argv[2])
    named = '--map' in sys.argv
    frames = sorted(set(a) & set(b))
    print(f'{len(a)} and {len(b)} frames; {len(frames)} in both')
    noisy = None   # pages differing in every compared frame so far
    first = None
    ever = Counter()
    for fr in frames:
        (ma, ha), (mb, hb) = a[fr], b[fr]
        diff = {i for i in range(len(ha)) if ha[i] != hb[i]}
        for i in diff:
            ever[i] += 1
        if ma != mb and first is None:
            print(f'frame {fr}: game time differs ({ma} vs {mb} ms)')
        if diff and first is None:
            first = fr
            print(f'first difference at frame {fr} (game {ma} ms): {len(diff)} page(s)')
            for i in sorted(diff)[:40]:
                va = page_va(i)
                print(f'  {"page " + format(va, "08X") if va != "actors" else "actors       "}  {region(va) if named else ""}')
    act = [fr for fr in frames if len(a[fr][1]) > ACTORS and a[fr][1][ACTORS] != b[fr][1][ACTORS]]
    print(f'actor positions: ' + (f'first differ at frame {act[0]}, in {len(act)} of {len(frames)} frames' if act else f'identical in all {len(frames)} frames'))
    if first is None:
        print('identical in every frame compared')
        return
    by = Counter(region(page_va(i)) for i in ever)
    print(f'\npages that ever differed: {len(ever)} (frames compared after the first difference: {len([f for f in frames if f >= first])})')
    for name, n in by.most_common():
        print(f'  {n:5d}  {name}')
    last = frames[-1]
    final = sum(1 for i in range(len(a[last][1])) if a[last][1][i] != b[last][1][i])
    print(f'at the last frame ({last}): {final} page(s) differ')

if __name__ == '__main__':
    main()
