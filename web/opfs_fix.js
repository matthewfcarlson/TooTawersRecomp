// (web port) WasmFS's OPFS reads and writes, replaced (linked with
// --js-library after Emscripten's own, which it overrides).
//
// Emscripten's versions hand the access handle a view of the heap. Under
// pthreads the heap is a SharedArrayBuffer, and with memory64 the pointer can
// arrive as a BigInt; either way the call threw a TypeError and every write
// came back EINVAL (files stayed empty; truncate, which passes no buffer,
// worked). These copy through an ordinary buffer, with plain numbers.
addToLibrary({
  _wasmfs_opfs_read_access__i53abi: true,
  _wasmfs_opfs_read_access__deps: ['$wasmfsOPFSAccessHandles'],
  _wasmfs_opfs_read_access: (accessID, bufPtr, len, pos) => {
    const handle = wasmfsOPFSAccessHandles.get(accessID);
    bufPtr = Number(bufPtr); len = Number(len); pos = Number(pos);
    const tmp = new Uint8Array(len);
    try {
      const n = handle.read(tmp, { at: pos });
      HEAPU8.set(n === len ? tmp : tmp.subarray(0, n), bufPtr);
      return n;
    } catch (e) {
      return e.name == 'TypeError' ? -{{{ cDefs.EINVAL }}} : -{{{ cDefs.EIO }}};
    }
  },

  _wasmfs_opfs_write_access__i53abi: true,
  _wasmfs_opfs_write_access__deps: ['$wasmfsOPFSAccessHandles'],
  _wasmfs_opfs_write_access: (accessID, bufPtr, len, pos) => {
    const handle = wasmfsOPFSAccessHandles.get(accessID);
    bufPtr = Number(bufPtr); len = Number(len); pos = Number(pos);
    try {
      return handle.write(HEAPU8.slice(bufPtr, bufPtr + len), { at: pos });
    } catch (e) {
      return e.name == 'TypeError' ? -{{{ cDefs.EINVAL }}} : -{{{ cDefs.EIO }}};
    }
  },
});
