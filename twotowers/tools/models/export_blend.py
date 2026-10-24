"""The Two Towers (Xbox) characters -> Blender .blend files: mesh, skeleton, skin
weights, texture and test animations, for checking bone binding and weight
painting before making replacement models.

  python3 -I twotowers/tools/models/export_blend.py --disc isos/extracted --out DIR [--only NAME] [--blender PATH]

Runs in two stages: plain python3 reads the disc and writes, per character, a
JSON description and its texture as a PNG into DIR/.work; then it starts
Blender headless with this same file as the script, which builds and saves
DIR/<name>.blend (texture packed in) and removes the work files. Nothing from
the game is in this file.

What the game's data looks like (verified against the disc):
- Level files (Worlds/*.bf{a,l,g,i}, UI/*.BFF): u32 @4 the directory offset;
  there u32 count, then {u32 type, u32 offset, u32 key}; a resource runs to the
  next resource's offset.
- Mesh, type 100 (" XBG"): part count @0x2C, parts from 0x30, each 9 u32
  {vertex count, ?, vertex offset (from part+4), .., index count, index offset
  (from part+0x1C), palette count} then the palette, {u8 skeleton bone, u8
  model slot} pairs (padded to 4). Vertices 48 bytes: position, normal, uv,
  then two {slot * 3, weight} float pairs (the slot is a model slot, looked up
  in the palette). Indices: u16 triangle strips (degenerates skipped, winding
  alternating).
- Animation set, type 150 ("aniz"): u16 @6 slot count, u32 @0x10 the slot
  table (u32 record offsets, 0 none); the skeleton ("hier") at +0x40: bone
  count +8, matrices +0xC (128 bytes a bone: the inverse bind, then the bind's
  world transform, row vectors, translation in the last row), parents +0x10
  (u8, +1; 0 the root), "skel" chunk +0x14 (attach points {u32 used, u32 bone}:
  0 the bow hand, 1 the sword hand). A record ("anim"): u32 @8 its length in ms,
  u32 @0x20 the bones' table (u32 offsets from the record, 0 none); a bone's
  keys: u8 rotation count, u8 position count, 2 pad, then {u16 ms, i16 x, y, z}
  rotations (x,y,z * 32767 of a unit quaternion, w >= 0: local = bind local *
  key) and the same for positions (offset / 256 added to the bind offset, in
  the parent's frame). (heroes.c's rt_pose plays them the same way.)
- Texture, type 300: a 0x80 header (u32 +4 width, +8 height) with the Xbox D3D
  texture at +0x2C, its format word at +0x38 (bits 8..15 the format: 0x0C
  DXT1, 0x0E DXT3, 0x0F DXT5, 0x06/0x07 A8R8G8B8, 0x02/0x03 A1R5G5B5, 0x04
  A4R4G4B4, 0x05 R5G6B5, 0x19 A8, 0x00 L8 -- the uncompressed ones swizzled);
  the top level's pixels at +0x80.
- Which mesh, animation set and texture make a character: the level's object
  records hold {mesh key, animation set key, texture key} as three u32 after
  the object's name (heroes.c's skin_apply_one finds the hero's the same way);
  the heroes' come from heroes.c's table. The game data is Z up, as Blender.
"""
import sys, os, struct, json, glob, re, zlib, math, argparse, subprocess, shutil

# ---------------------------------------------------------------- reading
def res(path):
    """-> (file bytes, {(type, key): (start, end)})"""
    b = open(path, 'rb').read()
    d = struct.unpack_from('<I', b, 4)[0]
    n = struct.unpack_from('<I', b, d)[0]
    ents = [struct.unpack_from('<III', b, d + 4 + 12 * i) for i in range(n)]
    offs = sorted(set(o for t, o, k in ents) | {d})
    nxt = {o: e for o, e in zip(offs, offs[1:] + [d])}
    return b, {(t, k): (o, nxt[o]) for t, o, k in ents}, ents

def u32(b, o): return struct.unpack_from('<I', b, o)[0]

def mesh_parts(m):
    """mesh resource -> [{verts: [12 floats], tris: [(a,b,c)], pal: {slot: skeleton bone}}]"""
    out = []; p = 0x30
    for _ in range(u32(m, 0x2C)):
        h = struct.unpack_from('<9I', m, p)
        vc, vo, ic, io, c = h[0], h[2] + p + 4, h[6], h[7] + p + 0x1C, h[8]
        pal = {m[p + 0x25 + 2 * j]: m[p + 0x24 + 2 * j] for j in range(c)}
        V = [struct.unpack_from('<12f', m, vo + 48 * i) for i in range(vc)]
        I = struct.unpack_from('<%dH' % ic, m, io)
        T = []
        for i in range(ic - 2):
            a, b2, c2 = I[i], I[i + 1], I[i + 2]
            if len({a, b2, c2}) < 3: continue
            T.append((a, b2, c2) if i % 2 == 0 else (b2, a, c2))
        out.append(dict(verts=V, tris=T, pal=pal))
        p = (p + 0x24 + 2 * c + 3) & ~3
    return out

def skeleton(A):
    """animation set -> (parents, bind world matrices (4x4 column convention, row-major lists), attach bones)"""
    h = 0x40
    nb, mo, po, so = struct.unpack_from('<4I', A, h + 8)
    par = [A[h + po + i] - 1 for i in range(nb)]
    W = []
    for i in range(nb):
        f = struct.unpack_from('<16f', A, h + mo + 128 * i + 64)
        W.append([f[c * 4 + r] for r in range(4) for c in range(4)])   # row vectors -> column convention (transpose)
    att = []
    g = h + so
    if A[g:g + 4] == b'skel':
        t = g + u32(A, g + 0xC)
        for k in range(min(u32(A, g + 8), 8)):
            o = u32(A, t + 4 * k)
            att.append(u32(A, t + o + 4) if o and u32(A, t + o) else None)
    return par, W, att

def anim_slots(A):
    n = struct.unpack_from('<H', A, 6)[0]; tab = u32(A, 0x10)
    return [u32(A, tab + 4 * s) for s in range(n)]

def anim_record(A, rec, nb):
    """-> (length ms, per bone (rotation keys [(ms, x, y, z)], position keys [(ms, x, y, z)]))"""
    dur = u32(A, rec + 8); bt = rec + u32(A, rec + 0x20); bones = []
    for b in range(nb):
        bo = u32(A, bt + 4 * b); R = P = []
        if bo:
            k = rec + bo; nr, np_ = A[k], A[k + 1]
            R = [struct.unpack_from('<H3h', A, k + 4 + 8 * i) for i in range(nr)]
            P = [struct.unpack_from('<H3h', A, k + 4 + 8 * (nr + i)) for i in range(np_)]
        bones.append((R, P))
    return dur, bones

def sample(keys, t):
    if not keys: return None
    if t <= keys[0][0]: return keys[0][1:]
    for a, b in zip(keys, keys[1:]):
        if a[0] <= t <= b[0]:
            f = (t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0
            return tuple(a[i] + (b[i] - a[i]) * f for i in (1, 2, 3))
    return keys[-1][1:]

# ---------------------------------------------------------------- textures
def _swz_masks(w, h):
    mx = my = 0; bit = 1; mb = 1
    while bit < w or bit < h:
        if bit < w: mx |= mb; mb <<= 1
        if bit < h: my |= mb; mb <<= 1
        bit <<= 1
    return mx, my

def _deposit(v, mask):
    r = 0; i = 0; b = 1
    while mask >> i:
        if (mask >> i) & 1:
            if v & b: r |= 1 << i
            b <<= 1
        i += 1
    return r

def _dxt_colors(c0, c1, alpha1bit):
    def rgb(c): return [((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31]
    a, b = rgb(c0), rgb(c1)
    if c0 > c1 or not alpha1bit:
        return [a + [255], b + [255], [(2 * x + y) // 3 for x, y in zip(a, b)] + [255], [(x + 2 * y) // 3 for x, y in zip(a, b)] + [255]]
    return [a + [255], b + [255], [(x + y) // 2 for x, y in zip(a, b)] + [255], [0, 0, 0, 0]]

def texture(T):
    """texture resource -> (width, height, RGBA bytes, top row first), or None"""
    w, h = u32(T, 4), u32(T, 8)
    fmt = (u32(T, 0x38) >> 8) & 0xFF
    d = T[0x80:]
    out = bytearray(w * h * 4)
    if fmt in (0x0C, 0x0E, 0x0F):
        bs = 8 if fmt == 0x0C else 16; i = 0
        for by in range(0, h, 4):
            for bx in range(0, w, 4):
                blk = d[i:i + bs]; i += bs
                cb = blk[bs - 8:]
                c0, c1, bits = struct.unpack_from('<HHI', cb)
                pal = _dxt_colors(c0, c1, fmt == 0x0C)
                if fmt == 0x0E:
                    al = [((int.from_bytes(blk[:8], 'little') >> (4 * k)) & 15) * 17 for k in range(16)]
                elif fmt == 0x0F:
                    a0, a1 = blk[0], blk[1]; ab = int.from_bytes(blk[2:8], 'little')
                    if a0 > a1: ap = [a0, a1] + [((6 - k) * a0 + (k + 1) * a1) // 7 for k in range(6)]
                    else: ap = [a0, a1] + [((4 - k) * a0 + (k + 1) * a1) // 5 for k in range(4)] + [0, 255]
                    al = [ap[(ab >> (3 * k)) & 7] for k in range(16)]
                else: al = None
                for k in range(16):
                    y, x = by + k // 4, bx + k % 4
                    c = pal[(bits >> (2 * k)) & 3]
                    o = 4 * (y * w + x)
                    out[o:o + 4] = bytes(c[:3] + [c[3] if al is None else al[k]])
        return w, h, bytes(out)
    bpp = {0x06: 4, 0x07: 4, 0x02: 2, 0x03: 2, 0x04: 2, 0x05: 2, 0x19: 1, 0x00: 1}.get(fmt)
    if not bpp: return None
    mx, my = _swz_masks(w, h)
    XS = [_deposit(x, mx) for x in range(w)]; YS = [_deposit(y, my) for y in range(h)]
    for y in range(h):
        for x in range(w):
            s = (XS[x] | YS[y]) * bpp; o = 4 * (y * w + x)
            if bpp == 4: out[o:o + 4] = bytes((d[s + 2], d[s + 1], d[s], d[s + 3] if fmt == 0x06 else 255))
            elif bpp == 1: v = d[s]; out[o:o + 4] = bytes((255, 255, 255, v) if fmt == 0x19 else (v, v, v, 255))
            else:
                v = d[s] | d[s + 1] << 8
                if fmt == 0x05: c = (((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31, 255)
                elif fmt == 0x04: c = (((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, (v >> 12) * 17)
                else: c = (((v >> 10) & 31) * 255 // 31, ((v >> 5) & 31) * 255 // 31, (v & 31) * 255 // 31, 255 if fmt == 0x03 or v >> 15 else 0)
                out[o:o + 4] = bytes(c)
    return w, h, bytes(out)

def write_png(path, w, h, rgba):
    raw = b''.join(b'\0' + rgba[4 * w * y:4 * w * (y + 1)] for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

# ---------------------------------------------------------------- which characters
# the heroes (heroes.c's s_skins: level file, mesh, animation set, texture)
HEROES = [
    ('Aragorn', '04BALIN1.bfa', 0xE9B808FE, 0xDE94124A, 0x66829AC2),
    ('Legolas', '04BALIN1.bfl', 0x9EDC669E, 0xEE4A9EBA, 0x58C546AD),
    ('Gimli',   '04BALIN1.bfg', 0x71EB3C66, 0xAAE0DF66, 0xF35ADE70),
    ('Isildur', '04BALIN1.bfi', 0x37EA8A4E, 0x53DFD442, 0xCD25E3B2),
    ('Boromir', '04BALIN1.bfa', 0xA6841986, 0xF9C62B16, 0xFD8B0956),
    ('Gandalf', '04BALIN1.bfa', 0x3E74698A, 0xDDAEA31C, 0xF2BE2DCC),
    ('Frodo',   '04BALIN1.bfa', 0xD7848F26, 0x4346DB86, 0xD4263554),
    ('Lurtz',   '13AMON1.bfa',  0x282C7492, 0xBC42B3A8, 0x2D8D24C0),
    ('Elrond',  '00ISUL1.bfa',  0x1F042846, 0xAE864136, 0xDF80247E),
    ('Sauron',  '00ISUL1.bfa',  0x33B93016, 0xCD95CCEE, 0x1748140C),
    ('UrukHaiBerserker', '14FANG2.bfa', 0x0FEDC9FA, 0x97E4B3C4, 0xDDF43A28),
]
LABELS = {0xA50B5410: 'Numenorean', 0xAEF3DB04: 'Frodo_Weathertop', 0x46CFE37E: 'Orc_Prologue'}   # (records without a usable name)
SKIP = re.compile(r'weapon|prop_|fallingTree', re.I)

def find_file(disc, name):
    for f in glob.glob(os.path.join(disc, 'Worlds', '*')):
        if os.path.basename(f).lower() == name.lower(): return f

def object_records(path, b, ents):
    """the level's {mesh, animation set, texture} key triples -> the object names before them"""
    kt = {}
    for t, o, k in ents: kt.setdefault(k, set()).add(t)
    d = u32(b, 4); W = struct.unpack_from('<%dI' % (d // 4), b, 0); out = {}
    for i in range(2, len(W) - 3):
        if 100 in kt.get(W[i], ()) and 150 in kt.get(W[i + 1], ()) and 300 in kt.get(W[i + 2], ()):
            nm = ''
            for j in range(4 * i - 2, max(0, 4 * i - 0x80), -1):
                if b[j] == 0 and 65 <= b[j + 1] < 123:
                    s = b[j + 1:4 * i].split(b'\0')[0]
                    if re.fullmatch(rb'[A-Za-z][A-Za-z_]{3,}\d*', s): nm = s.decode(); break
            out.setdefault(W[i:i + 3], []).append(nm)
    return out

def clean_name(names):
    names = [n for n in names if n]
    if not names: return None
    pref = sorted(names, key=lambda n: (not re.search('Obj|Hero', n), -names.count(n), len(n), n))[0]
    n = re.sub(r'\d+$', '', pref)
    n = re.sub(r'(Hero|Obj)(_1st)?$', '', n) or n
    return n[:1].upper() + n[1:]

def gather(disc, only=None):
    """-> [[name, level file path, mesh key, anim key, tex key, [(file, other texture key)], note]]
    The same model under several keys (each level's copy) is one character; a texture the
    same model gets elsewhere (another picture, not another copy) is a variant."""
    recs = {}   # (mesh, anim, tex) -> [(file, names)]
    for f in sorted(glob.glob(os.path.join(disc, 'Worlds', '*.bf?'))):
        b, E, ents = res(f)
        for k, names in object_records(f, b, ents).items(): recs.setdefault(k, []).append((f, names))
    chars = []; seen = {}; files = {}
    def load(f):
        if f not in files: files.clear(); files[f] = res(f)
        return files[f]
    def crc(f, t, k): b, E, _ = load(f); o, e = E[(t, k)]; return zlib.crc32(b[o + (0x80 if t == 300 else 0):e])   # (a texture's header differs between copies)
    for nm, f, mk, ak, tk in HEROES:
        f = find_file(disc, f)
        chars.append([nm, f, mk, ak, tk, [], 'heroes.c table', {crc(f, 300, tk)}]); seen[mk] = seen[crc(f, 100, mk)] = chars[-1]
    for (mk, ak, tk), occ in sorted(recs.items(), key=lambda r: r[1][0][0]):
        names = [n for f, ns in occ for n in ns]
        for f, _ in occ:
            h = crc(f, 100, mk); c = seen.get(mk) or seen.get(h)
            if c:
                th = crc(f, 300, tk)
                if th not in c[7]: c[5].append((f, tk)); c[7].add(th)
                seen[mk] = seen[h] = c; continue
            nm = LABELS.get(mk) or clean_name(names) or 'mesh'
            if SKIP.search(nm): break
            chars.append([nm, f, mk, ak, tk, [], 'object record %s in %s' % ('/'.join(sorted(set(n for n in names if n))[:3]), os.path.basename(f)), {crc(f, 300, tk)}])
            seen[mk] = seen[h] = chars[-1]
    names = [c[0] for c in chars]
    for c in chars[len(HEROES):]:
        if names.count(c[0]) > 1 or c[0] == 'mesh': c[0] = '%s_%08X' % (c[0], c[2])
    for c in chars: del c[7:]
    if only: chars = [c for c in chars if any(o.lower() in c[0].lower() for o in only.split(','))]
    return chars

# ---------------------------------------------------------------- the character, for Blender
# The game's world is left-handed (Aragorn faces -Y with his sword hand, the skeleton's attach
# point 1, at +X): seen in Blender's right-handed space he is mirrored. MIRROR (the default)
# flips X on the way in -- positions, normals, bones, motions, triangle winding -- so the
# character looks as in the game; a re-import has to flip it back (--raw keeps the game's X).
def qmat(x, y, z):
    import numpy as np
    w = math.sqrt(max(0.0, 1 - x * x - y * y - z * z))
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])

def rotm(axis, ang):
    import numpy as np
    a = np.asarray(axis, float); a = a / (np.linalg.norm(a) or 1); c, s = math.cos(ang), math.sin(ang); x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])

def anatomy(par, pos, wsum, att):
    """readable names for the bones a humanoid has: {bone: name}, and the joints for the
    range-of-motion test. pos: bind positions in the game's space (+X the character's right)."""
    nb = len(par); zs = [p[2] for p in pos]; H = (max(zs) - min(zs)) or 1; z0 = min(zs)
    def up(b):
        out = [b]
        while par[out[-1]] >= 0 and len(out) < nb: out.append(par[out[-1]])
        return out
    def lca(a, b):
        A = up(a)
        for x in up(b):
            if x in A: return x
    def dist(a, b): return math.dist(pos[a], pos[b])
    names = {}; joints = {}
    side = lambda b: int(pos[b][0] > 0.05 * H) - int(pos[b][0] < -0.05 * H)
    def tip(s, low):
        c = [b for b in range(nb) if side(b) == s and ((pos[b][2] - z0 < 0.15 * H) if low else (pos[b][2] - z0 > 0.4 * H))]
        if not c: return None
        return min(c, key=lambda b: (round(pos[b][2], 2), pos[b][1])) if low else max(c, key=lambda b: abs(pos[b][0]))
    feet = {s: tip(s, True) for s in (1, -1)}; hands = {s: tip(s, False) for s in (1, -1)}
    if None in feet.values() or None in hands.values(): return names, joints
    pelvis, chest = lca(feet[1], feet[-1]), lca(hands[1], hands[-1])
    if pelvis is None or chest is None or pelvis in up(hands[1]) and pelvis == chest: return names, joints
    def chain(root, t): p = up(t); return list(reversed(p[:p.index(root)]))   # root (excluded) .. tip
    def limb(path, start):
        """the two longest consecutive segments: upper arm and forearm, thigh and shin"""
        P = path if len(path) >= 3 else [start] + path; L = [dist(a, b) for a, b in zip(P, P[1:])]
        if len(L) < 2: return None
        i = max(range(len(L) - 1), key=lambda i: L[i] + L[i + 1])
        return P[i], P[i + 1], P[i + 2]
    lab = {1: 'R', -1: 'L'}
    for s in (1, -1):
        path = chain(chest, hands[s]); j = limb(path, chest)
        if not j or j[0] == chest: return {}, {}
        a, b, c = j
        for x in path[:path.index(a)]: names[x] = lab[s] + '_clavicle'
        names[a], names[b], names[c] = lab[s] + '_shoulder', lab[s] + '_elbow', lab[s] + '_hand'
        joints[lab[s] + '_shoulder'], joints[lab[s] + '_elbow'], joints[lab[s] + '_hand'] = a, b, c
        path = chain(pelvis, feet[s]); j = limb(path, pelvis)
        if not j or j[0] == pelvis: return {}, {}
        a, b, c = j
        names[a], names[b], names[c] = lab[s] + '_hip', lab[s] + '_knee', lab[s] + '_foot'
        joints[lab[s] + '_hip'], joints[lab[s] + '_knee'], joints[lab[s] + '_foot'] = a, b, c
        rest = path[path.index(c) + 1:]
        if rest: names[rest[0]] = lab[s] + '_toe'; joints[lab[s] + '_toe'] = rest[0]
    names[pelvis] = 'pelvis'; joints['pelvis'] = pelvis
    base = lca(pelvis, chest)
    if chest != pelvis:
        sp = [x for x in chain(base, chest) if x != pelvis]
        names[chest] = 'chest'; joints['spine'] = sp
        for k, x in enumerate(sp[:-1]): names[x] = 'spine_%d' % (k + 1)
    for x in up(base):
        if x not in names: names[x] = 'root' if par[x] < 0 else 'root_%d' % (len(up(x)) - 1)
    arms = set()
    for s in (1, -1):
        for b in range(nb):
            if names.get(chain(chest, hands[s])[0]) and chain(chest, hands[s])[0] in up(b): arms.add(b)
    sh = min(pos[joints['R_shoulder']][2], pos[joints['L_shoulder']][2])
    cand = [b for b in range(nb) if b != chest and chest in up(b) and b not in arms and abs(pos[b][0]) < 0.05 * H and pos[b][2] > sh]
    if cand:
        head = max(cand, key=lambda b: wsum.get(b, 0))
        names[head] = 'head'; joints['head'] = head
        neck = chain(chest, head)[:-1]
        for k, x in enumerate(neck): names[x] = 'neck' if len(neck) == 1 else 'neck_%d' % (k + 1)
        joints['neck'] = neck
    return names, joints

def describe(name, f, mk, ak, tk, variants, note, work, mirror=True, game_anims=True):
    """write work/<name>.json (and its textures as PNGs) for the Blender stage"""
    import numpy as np
    b, E, _ = res(f)
    parts = mesh_parts(b[slice(*E[(100, mk)])]); A = b[slice(*E[(150, ak)])]
    par, W, att = skeleton(A); nb = len(par)
    W = [np.array(w, float).reshape(4, 4) for w in W]
    S = np.diag([-1.0 if mirror else 1.0, 1, 1, 1])
    # the mesh
    V, N, UV, T, G = [], [], [], [], []; wsum = {}; warn = []
    for pi, p in enumerate(parts):
        base = len(V)
        for v in p['verts']:
            V.append(v[0:3]); N.append(v[3:6]); UV.append((v[6], 1 - v[7])); g = {}
            for si, wi in ((8, 9), (10, 11)):
                if v[wi] > 0:
                    sl = int(round(v[si] / 3)); bone = p['pal'].get(sl)
                    if bone is None or bone >= nb: warn.append('part %d: slot %d not in its palette / skeleton' % (pi, sl)); continue
                    g[bone] = g.get(bone, 0) + v[wi]; wsum[bone] = wsum.get(bone, 0) + v[wi]
            G.append(sorted(g.items()))
        T += [(a + base, b2 + base, c + base) for a, b2, c in p['tris']]
    V = np.array(V); N = np.array(N); T = np.array(T)
    if mirror: V[:, 0] *= -1; N[:, 0] *= -1; T = T[:, [0, 2, 1]]
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]]); vn = N[T].sum(1)
    if (np.einsum('ij,ij->i', fn, vn) < 0).mean() > 0.5: T = T[:, [0, 2, 1]]   # (the strips' first triangle's winding)
    # the skeleton
    pos = [tuple(w[:3, 3]) for w in W]
    names, joints = anatomy(par, pos, wsum, att)
    Wm = [S @ w @ S for w in W]; P = np.array([w[:3, 3] for w in Wm])
    zs = P[:, 2]; H = float(max(zs.max() - zs.min(), V[:, 2].max() - V[:, 2].min(), 1e-3))
    kids = {i: [j for j in range(nb) if par[j] == i] for i in range(nb)}
    def ndesc(i): return 1 + sum(ndesc(k) for k in kids[i])
    chain_next = {}
    for key in ('R_shoulder', 'R_elbow', 'L_shoulder', 'L_elbow', 'R_hip', 'R_knee', 'L_hip', 'L_knee'):
        if key in joints:
            nxt = {'shoulder': 'elbow', 'elbow': 'hand', 'hip': 'knee', 'knee': 'foot'}[key[2:]]
            chain_next[joints[key]] = joints[key[:2] + nxt]
    for k in ('spine', 'neck'):
        L = joints.get(k, [])
        for a, c in zip(L, L[1:]): chain_next[a] = c
    if 'neck' in joints and joints['neck']: chain_next[joints['neck'][-1]] = joints['head']
    for sd in 'RL':
        if sd + '_toe' in joints: chain_next[joints[sd + '_foot']] = joints[sd + '_toe']
    bones = []
    for i in range(nb):
        h = P[i]; t = None
        c = chain_next.get(i)
        opts = ([c] if c is not None else []) + sorted(kids[i], key=lambda k: (-ndesc(k), -np.linalg.norm(P[k] - h)))
        for k in opts:
            if np.linalg.norm(P[k] - h) > 0.015 * H: t = P[k]; break
        if t is None:
            d = h - P[par[i]] if par[i] >= 0 else np.array([0, 0, 1.0])
            if np.linalg.norm(d) < 1e-4: d = Wm[i][:3, 1]   # (a bone where its parent is: along its own Y)
            ln = min(max(0.3 * float(np.linalg.norm(h - P[par[i]])) if par[i] >= 0 else 0.05 * H, 0.03 * H), 0.08 * H)
            t = h + d / np.linalg.norm(d) * ln
        nm = '%s (%02d)' % (names[i], i) if i in names else 'bone_%02d' % i
        bones.append(dict(name=nm, parent=par[i], head=[round(x, 5) for x in h], tail=[round(float(x), 5) for x in t]))
    # actions: per frame, each bone's deformation in armature space (pose * rest^-1), 3x4
    def pack(D): return [[round(float(x), 5) for x in (S @ d @ S)[:3].ravel()] for d in D]
    actions = [dict(name='range_of_motion', fps=30, interp='BEZIER', frames=rom(par, W, joints, wsum, H), mirror=mirror)]
    actions[0]['frames'] = [(fr, pack(D)) for fr, D in actions[0]['frames']]
    if game_anims:
        slots = anim_slots(A)
        for label, prefs in (('idle', (34, 33, 160, 0)), ('move', (9, 2, 0))):
            s = next((s for s in prefs if s < len(slots) and slots[s]), None)
            if s is None or any(a['name'].endswith('_slot%d' % s) for a in actions): continue
            dur, keys = anim_record(A, slots[s], nb)
            n = max(2, int(round(dur / 1000 * 30)) + 1)
            fr = [(k, pack(game_pose(par, W, keys, dur * k / (n - 1)))) for k in range(n)]
            actions.append(dict(name='game_%s_slot%d' % (label, s), fps=30, interp='LINEAR', frames=fr))
    # textures
    def tex(f2, k, out):
        b2, E2, _ = res(f2) if f2 != f else (b, E, None)
        r = texture(b2[slice(*E2[(300, k)])])
        if not r: return None
        write_png(out, *r); return dict(path=out, key='%08X' % k, alpha=min(r[2][3::4]) < 128)
    tx = tex(f, tk, os.path.join(work, name + '_tex.png'))
    tv = [t for t in (tex(f2, k, os.path.join(work, '%s_tex_%08X.png' % (name, k))) for f2, k in variants) if t]
    d = dict(name=name, source='%s mesh %08X, animation set %08X, texture %08X (%s)' % (os.path.basename(f), mk, ak, tk, note),
             mirrored=mirror, height=H, verts=V.round(5).tolist(), normals=N.round(4).tolist(), uvs=np.array(UV).round(5).tolist(),
             tris=T.tolist(), groups=[[[bones[bn]['name'], round(w, 4)] for bn, w in g] for g in G], bones=bones,
             texture=tx, variants=tv, actions=actions, parts=len(parts))
    json.dump(d, open(os.path.join(work, name + '.json'), 'w'))
    return dict(name=name, bones=nb, named=len(names), verts=len(V), tris=len(T), parts=len(parts), texture=bool(tx),
                actions=[a['name'] for a in actions], warn=sorted(set(warn))[:3])

def game_pose(par, W, keys, t):
    """the game's pose at t ms -> per bone deformation (world * bind^-1), game space"""
    import numpy as np
    nb = len(par); Q = [None] * nb; Pp = [None] * nb; D = []
    for i in range(nb):
        R, Pk = keys[i]; p = par[i]
        Rw, Tw = W[i][:3, :3], W[i][:3, 3]
        if p < 0: BL, BT = Rw, Tw.copy()
        else: BL = W[p][:3, :3].T @ Rw; BT = W[p][:3, :3].T @ (Tw - W[p][:3, 3])
        k = sample(R, t); lr = BL @ qmat(*(c / 32767 for c in k)) if k else BL
        k = sample(Pk, t); lt = BT + (np.array(k) / 256 if k else 0)
        if p < 0: Q[i], Pp[i] = lr, lt
        else: Q[i] = Q[p] @ lr; Pp[i] = Pp[p] + Q[p] @ lt
        M = np.eye(4); M[:3, :3] = Q[i]; M[:3, 3] = Pp[i]
        D.append(M @ np.linalg.inv(W[i]))
    return D

def rom(par, W, joints, wsum, H):
    """the range-of-motion test: [(frame, per bone deformation)], game space (+X the right,
    -Y forward). Each joint group bends in turn, over 10 s at 30 fps."""
    import numpy as np
    nb = len(par); pos = [w[:3, 3] for w in W]
    fwd, upv = np.array([0, -1.0, 0]), np.array([0, 0, 1.0])
    def d_of(j, k): v = pos[k] - pos[j]; return v / (np.linalg.norm(v) or 1)
    def toward(j, k, target):   # axis turning bone j (pointing at k) toward target
        a = np.cross(d_of(j, k), target); return a if np.linalg.norm(a) > 1e-3 else np.array([1.0, 0, 0])
    J = joints; steps = []   # each: [(bone, axis, degrees)] at its peak, then (optionally) the opposite
    if 'head' in J:
        hb = [J['head']] + J.get('neck', [])
        steps.append(('head turn', [(b, upv, 50 / len(hb)) for b in hb], True))
        steps.append(('head nod', [(b, np.array([1.0, 0, 0]), 30 / len(hb)) for b in hb], True))
    for s in 'RL':
        if s + '_shoulder' in J:
            a, e, h = J[s + '_shoulder'], J[s + '_elbow'], J[s + '_hand']
            steps.append((s + ' shoulder raise', [(a, toward(a, e, upv), 70)], True))
            steps.append((s + ' shoulder forward', [(a, toward(a, e, fwd), 60)], False))
            steps.append((s + ' elbow', [(e, toward(e, h, fwd), 100)], False))
    if J.get('spine'):
        sp = J['spine']
        steps.append(('spine bend', [(b, np.array([1.0, 0, 0]), -45 / len(sp)) for b in sp], True))
        steps.append(('spine twist', [(b, upv, 40 / len(sp)) for b in sp], True))
    for s in 'RL':
        if s + '_hip' in J:
            a, k, f = J[s + '_hip'], J[s + '_knee'], J[s + '_foot']
            steps.append((s + ' hip', [(a, toward(a, k, fwd), 70)], True))
            steps.append((s + ' hip out', [(a, toward(a, k, np.array([1.0 if s == 'R' else -1.0, 0, 0])), 40)], False))
            steps.append((s + ' knee', [(k, toward(k, f, -fwd), 100)], False))
    for s in 'RL':
        if s + '_foot' in J:
            f = J[s + '_foot']
            steps.append((s + ' foot', [(f, np.array([1.0, 0, 0]), 35)], True))
    if not steps:   # not a humanoid: the most weighted bones, each bent one way and the other
        top = sorted((b for b in range(nb) if par[b] >= 0), key=lambda b: -wsum.get(b, 0))[:10]
        for b in top: steps.append(('bone %d' % b, [(b, np.array([1.0, 0, 0]), 40)], True))
    per = max(20, 300 // len(steps)); out = []
    def pose(rots):
        D = [None] * nb
        for i in range(nb):
            L = np.eye(4)
            for b, ax, deg in rots:
                if b == i:
                    R = np.eye(4); R[:3, :3] = rotm(ax, math.radians(deg)); Tp = np.eye(4); Tp[:3, 3] = pos[i]; Tn = np.eye(4); Tn[:3, 3] = -pos[i]
                    L = Tp @ R @ Tn
            D[i] = L if par[i] < 0 else D[par[i]] @ L
        return D
    rest = pose([])
    for n, (label, rots, both) in enumerate(steps):
        f0 = n * per
        out.append((f0, rest))
        if both:
            out.append((f0 + per // 4, pose(rots)))
            out.append((f0 + 3 * per // 4, pose([(b, a, -d) for b, a, d in rots])))
        else:
            out.append((f0 + per // 2, pose(rots)))
    out.append((len(steps) * per, rest))
    return out

# ---------------------------------------------------------------- the Blender stage
def build_blend(js, out_dir, preview=None):
    import bpy
    from mathutils import Matrix, Vector
    d = json.load(open(js)); name = d['name']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene; sc.render.fps = 30
    # the armature, at the bind pose
    ad = bpy.data.armatures.new(name + '_skeleton'); ad.display_type = 'OCTAHEDRAL'
    arm = bpy.data.objects.new(name + '_rig', ad); sc.collection.objects.link(arm); arm.show_in_front = True
    bpy.context.view_layer.objects.active = arm; arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    EB = []
    for b in d['bones']:
        eb = ad.edit_bones.new(b['name']); eb.head = b['head']; eb.tail = b['tail']; eb.roll = 0; EB.append(eb)
    for eb, b in zip(EB, d['bones']):
        if b['parent'] >= 0: eb.parent = EB[b['parent']]; eb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    # the mesh: UVs, the game's normals, the two weights a vertex has
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in d['verts']], [], [tuple(t) for t in d['tris']]); me.update()
    uv = me.uv_layers.new(name='UVMap'); vi = [0] * len(me.loops); me.loops.foreach_get('vertex_index', vi)
    uv.data.foreach_set('uv', [c for i in vi for c in d['uvs'][i]])
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.normals_split_custom_set_from_vertices([tuple(n) for n in d['normals']])
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); ob.parent = arm
    for b in d['bones']: ob.vertex_groups.new(name=b['name'])
    for i, g in enumerate(d['groups']):
        for bn, w in g: ob.vertex_groups[bn].add([i], w, 'REPLACE')
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    # the material, its texture packed in
    mat = bpy.data.materials.new(name + '_mat'); mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']; bsdf.inputs['Roughness'].default_value = 0.8
    if d['texture']:
        img = bpy.data.images.load(d['texture']['path']); img.name = '%s_%s' % (name, d['texture']['key']); img.pack()
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img; tn.location = (-400, 200)
        nt.links.new(tn.outputs['Color'], bsdf.inputs['Base Color'])
        if d['texture']['alpha']:
            nt.links.new(tn.outputs['Alpha'], bsdf.inputs['Alpha'])
            try: mat.surface_render_method = 'DITHERED'
            except Exception: mat.blend_method = 'HASHED'
    for v in d['variants']:   # the same model's other textures (other levels, other people): packed, unused
        im = bpy.data.images.load(v['path']); im.name = '%s_%s_variant' % (name, v['key']); im.pack(); im.use_fake_user = True
    me.materials.append(mat)
    # the actions: deformations (pose * rest^-1, armature space) -> each bone's basis
    rest = {b.name: b.matrix_local.copy() for b in ad.bones}
    names = [b['name'] for b in d['bones']]; par = [b['parent'] for b in d['bones']]
    arm.animation_data_create()
    for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
    made = []
    for a in d['actions']:
        act = bpy.data.actions.new(a['name']); act.use_fake_user = True
        arm.animation_data.action = act
        if hasattr(arm.animation_data, 'action_slot') and act.slots: arm.animation_data.action_slot = act.slots[0]
        cols = {n: ([], [], [], [], [], [], []) for n in names}; prevq = {}
        for fr, D in a['frames']:
            M = [Matrix([D[i][0:4], D[i][4:8], D[i][8:12], [0, 0, 0, 1]]) for i in range(len(names))]
            for i, n in enumerate(names):
                B = rest[n]; Dp = M[par[i]] if par[i] >= 0 else Matrix.Identity(4)
                basis = B.inverted() @ Dp.inverted() @ M[i] @ B
                loc, q, _ = basis.decompose()
                if n in prevq and prevq[n].dot(q) < 0: q.negate()
                prevq[n] = q
                c = cols[n]
                for k in range(3): c[k].append((fr, loc[k]))
                for k in range(4): c[3 + k].append((fr, q[k]))
        for n in names:
            for k, path, idx in [(k, 'location', k) for k in range(3)] + [(3 + k, 'rotation_quaternion', k) for k in range(4)]:
                vals = cols[n][k]
                if max(abs(v - vals[0][1]) for _, v in vals) < 1e-5 and abs(vals[0][1] - (1.0 if k == 3 else 0.0)) < 1e-5: continue
                fc = act.fcurves.new('pose.bones["%s"].%s' % (n, path), index=idx, action_group=n)
                fc.keyframe_points.add(len(vals)); fc.keyframe_points.foreach_set('co', [x for fv in vals for x in fv])
                ip = a['interp']
                for kp in fc.keyframe_points: kp.interpolation = ip
                fc.update()
        made.append(act)
    rom_act = made[0]
    arm.animation_data.action = rom_act
    if hasattr(arm.animation_data, 'action_slot') and rom_act.slots: arm.animation_data.action_slot = rom_act.slots[0]
    sc.frame_start, sc.frame_end = 0, int(d['actions'][0]['frames'][-1][0]); sc.frame_set(0)
    ob['tt_source'] = d['source']; ob['tt_mirrored_x'] = d['mirrored']; arm['tt_mirrored_x'] = d['mirrored']
    out = os.path.join(out_dir, name + '.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
    if preview: render_preview(d, arm, ob, preview)
    return out

def render_preview(d, arm, ob, out_dir):
    """bind pose and a few range-of-motion frames, front and side, textured (Workbench)"""
    import bpy
    from mathutils import Vector
    sc = bpy.context.scene; H = d['height']
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x, sc.render.resolution_y = 320, 400; sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    world = bpy.data.worlds.new('w'); sc.world = world; world.color = (0.25, 0.25, 0.28)
    ext = max(max(v[k] for v in d['verts']) - min(v[k] for v in d['verts']) for k in range(3))
    cd = bpy.data.cameras.new('cam'); cd.type = 'ORTHO'; cd.ortho_scale = ext * 1.3
    cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    c = Vector([(min(v[k] for v in d['verts']) + max(v[k] for v in d['verts'])) / 2 for k in range(3)])
    rom = d['actions'][0]['frames']; fr = [0] + [f for f, _ in rom if f % 20 and f < rom[-1][0]]
    pick = [(None, 0)] + [(None, f) for f in fr[1::max(1, len(fr) // 6)][:6]]
    for a in d['actions'][1:]:   # and the game's motions, halfway through
        pick.append((a['name'], a['frames'][len(a['frames']) // 2][0]))
    tiles = []; ad = arm.animation_data; rom_act = ad.action
    for an, f in pick:
        act = bpy.data.actions[an] if an else rom_act
        ad.action = act
        if hasattr(ad, 'action_slot') and act.slots: ad.action_slot = act.slots[0]
        sc.frame_set(f)
        for k, dirv in enumerate((Vector((0.35, -1, 0.15)), Vector((1, -0.2, 0.1)))):
            r = arm.pose.bones[0].head; cc = c + Vector((r.x - d['bones'][0]['head'][0], r.y - d['bones'][0]['head'][1], 0))   # (following the root's moves)
            dv = dirv.normalized(); cam.location = cc + dv * ext * 3; cd.clip_end = ext * 10
            cam.rotation_euler = (-dv).to_track_quat('-Z', 'Y').to_euler()
            p = os.path.join(out_dir, '_%s_%d.png' % (d['name'], len(tiles))); sc.render.filepath = p
            bpy.ops.render.render(write_still=True); tiles.append(p)
    # one sheet: columns = frames, rows = views
    ims = [bpy.data.images.load(p) for p in tiles]
    w, h = ims[0].size; cols = len(pick)
    sheet = bpy.data.images.new('sheet', w * cols, h * 2)
    px = [0.0] * (w * cols * h * 2 * 4)
    for n, im in enumerate(ims):
        col, row = n // 2, 1 - n % 2
        src = list(im.pixels)
        for y in range(h):
            o = ((row * h + y) * w * cols + col * w) * 4
            px[o:o + w * 4] = src[y * w * 4:(y + 1) * w * 4]
    sheet.pixels = px; sheet.filepath_raw = os.path.join(out_dir, d['name'] + '_preview.png'); sheet.file_format = 'PNG'; sheet.save()
    for p in tiles: os.remove(p)
    ad.action = rom_act
    if hasattr(ad, 'action_slot') and rom_act.slots: ad.action_slot = rom_act.slots[0]

# ---------------------------------------------------------------- main
def main_blender(argv):
    ap = argparse.ArgumentParser(); ap.add_argument('--build'); ap.add_argument('--out'); ap.add_argument('--preview')
    a = ap.parse_args(argv)
    for js in sorted(glob.glob(os.path.join(a.build, '*.json'))):
        print('[blend] ' + build_blend(js, a.out, a.preview), flush=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--disc', required=True, help='the unpacked disc (has Worlds/)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', help='comma list: characters whose name contains one of these')
    ap.add_argument('--blender', default='/Applications/Blender.app/Contents/MacOS/Blender')
    ap.add_argument('--raw', action='store_true', help="keep the game's X (left-handed: the character comes out mirrored)")
    ap.add_argument('--no-game-anims', action='store_true')
    ap.add_argument('--preview', action='store_true', help='also render OUT/previews/<name>_preview.png (bind pose and test frames)')
    ap.add_argument('--list', action='store_true', help='only list the characters found')
    a = ap.parse_args()
    chars = gather(a.disc, a.only)
    if a.list:
        for c in chars: print('%-28s %-13s mesh %08X anim %08X tex %08X  %s' % (c[0], os.path.basename(c[1]), c[2], c[3], c[4], c[6]))
        return
    os.makedirs(a.out, exist_ok=True); work = os.path.join(a.out, '.work'); os.makedirs(work, exist_ok=True)
    summary = []
    for c in chars:
        try: r = describe(*c, work=work, mirror=not a.raw, game_anims=not a.no_game_anims)
        except Exception as e: print('skipped %s: %s' % (c[0], e)); continue
        r['source'] = '%s mesh %08X anim %08X tex %08X (%s)' % (os.path.basename(c[1]), c[2], c[3], c[4], c[6]); summary.append(r)
        print('%-28s %3d bones (%2d named) %5d verts %5d tris %d part(s) tex %-3s %s %s' % (r['name'], r['bones'], r['named'], r['verts'], r['tris'], r['parts'], 'yes' if r['texture'] else 'NO', ','.join(r['actions']), '; '.join(r['warn'])), flush=True)
    pv = os.path.join(a.out, 'previews')
    if a.preview: os.makedirs(pv, exist_ok=True)
    cmd = [a.blender, '-b', '--factory-startup', '--python-exit-code', '1', '-P', os.path.abspath(__file__), '--', '--build', work, '--out', a.out] + (['--preview', pv] if a.preview else [])
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for l in p.stdout.splitlines():
        if l.startswith('[blend]') or 'Error' in l or 'Traceback' in l or l.startswith('  '): print(l)
    json.dump(summary, open(os.path.join(a.out, 'characters.json'), 'w'), indent=1)
    if p.returncode == 0: shutil.rmtree(work)
    else: sys.exit('Blender failed (work files kept in %s)' % work)

if __name__ == '__main__':
    try: import bpy   # noqa: F401  (inside Blender: the second stage)
    except ImportError: main()
    else: main_blender(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
