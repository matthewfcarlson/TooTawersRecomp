#!/bin/sh
# (web port) Build the WebAssembly version into build-web/ (Emscripten's emcc,
# cmake and ninja on the PATH; generate.py run first, see ../README.md).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
# DirectSound's pointer accesses to the APU (generate.py runs it; here for code generated before it existed)
python3 "$here/twotowers/postproc_apu_ptr.py" "$here/twotowers/src/recomp/gen" | grep -v "^recomp_" || true
python3 "$here/twotowers/postproc_heap.py" "$here/twotowers/src/recomp/gen"   # (the game heap's size: likewise)
if [ ! -f "$here/build-web/build.ninja" ]; then
    flags="-sMEMORY64=1 -pthread -msimd128 -msse4.1"
    emcmake cmake -S "$here/twotowers" -B "$here/build-web" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DSDL2_DIR="$here/web/cmake" "-DCMAKE_C_FLAGS=$flags" "-DCMAKE_CXX_FLAGS=$flags"
fi
ninja -C "$here/build-web"
