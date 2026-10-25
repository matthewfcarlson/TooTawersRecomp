#!/usr/bin/env python3
"""(web port) Every call the game makes into Direct3D, wrapped so that one thread at a time is inside it.

D3D's push buffer is the device's and unlocked; on the Xbox's one CPU the game's threads kept out of each other's
way by priority, here they run at once (src/tt_d3dlock.c). In every generated function outside D3D's code
(0x00114AC0-0x001275B0), each direct call into it -- RECOMP_ABI_CALL(0x00xxxxxxu, sub_00xxxxxx), and the guarded
arms of indirect calls, which are the same -- becomes

    { tt_d3d_enter(); RECOMP_ABI_CALL(...); tt_d3d_leave(); }

D3D's calls into itself are left alone (the lock is recursive per thread anyway). Idempotent; run after
postproc_regs.py (generate.py does)."""
import re, sys, glob, os

D3D = (0x00114AC0, 0x001275B0)
FN = re.compile(r'^\S.*\bsub_([0-9A-Fa-f]{8})(?:_gen)?\s*\(void\)')
CALL = re.compile(r'RECOMP_ABI_CALL\(0x([0-9A-Fa-f]{8})u, (sub_[0-9A-Fa-f]{8}(?:_gen)?)\);')
DECL = ('/* (web port) postproc_d3dlock.py: one thread in D3D at a time */\n'
        'extern void tt_d3d_enter(void); extern void tt_d3d_leave(void);\n')
MARK = 'tt_d3d_enter(); RECOMP_ABI_CALL('


def inside(va):
    return D3D[0] <= va < D3D[1]


def main(gen):
    total = files = 0
    for path in sorted(glob.glob(os.path.join(gen, 'recomp_*.c'))):
        if path.endswith(('recomp_dispatch.c', 'recomp_stubs_unresolved.c')):
            continue
        src = open(path).read()
        if MARK in src:
            continue   # (done)
        out, cur, n = [], None, 0
        for line in src.split('\n'):
            m = FN.match(line)
            if m:
                cur = int(m.group(1), 16)
            elif cur is not None and not inside(cur) and 'RECOMP_ABI_CALL(0x' in line:
                def wrap(c):
                    nonlocal n
                    if not inside(int(c.group(1), 16)):
                        return c.group(0)
                    n += 1
                    return '{ tt_d3d_enter(); %s tt_d3d_leave(); }' % c.group(0)
                line = CALL.sub(wrap, line)
            out.append(line)
        if n:
            src = '\n'.join(out)
            inc = src.find('#include "recomp_funcs.h"\n')
            at = inc + len('#include "recomp_funcs.h"\n') if inc >= 0 else 0
            open(path, 'w').write(src[:at] + DECL + src[at:])
            total += n
            files += 1
    print('d3dlock: %d calls into D3D wrapped in %d files' % (total, files))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'src', 'recomp', 'gen')))
