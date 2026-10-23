// (web port) WasmFS's fetch backend (the disc and the Ultra textures, fetched
// from the page's server as the game reads them), replaced: linked with
// --js-library after Emscripten's own (src/lib/libwasmfs_fetch.js, 6.0.2),
// which it overrides. One change, marked FIX below.
//
// A file no larger than two chunks is fetched whole and kept as one chunk
// whose size is the file's; but a later read went on finding its chunks with
// the configured chunk size (4 MB), so a read past 4 MB in a file of 4-8 MB
// fetched the file again in 4 MB pieces over that one chunk while the sizes
// still said one chunk: the bytes came back from the wrong places. Seen as
// noise in Ultra textures (pictures of 5-6 MB); the disc's files of that size
// were read wrong the same way.
addToLibrary({
  _wasmfs_create_fetch_backend_js__deps: [
    '$wasmFS$backends',
    '$wasmFS$JSMemoryRanges',
    '_wasmfs_fetch_get_file_url',
    '_wasmfs_fetch_get_chunk_size',
  ],
  _wasmfs_create_fetch_backend_js: async function(backend) {
    async function getFileRange(file, offset, len) {
      var url = '';
      var fileUrl = UTF8ToString(__wasmfs_fetch_get_file_url(file));
      if (fileUrl.indexOf('://') !== -1) {
        url = fileUrl;
      } else {
        try {
          url = new URL(fileUrl, self.location.origin).toString();
        } catch (_e) {
          throw {status: 404};
        }
      }
      var chunkSize = __wasmfs_fetch_get_chunk_size(file);
      offset ??= 0;
      len ??= chunkSize;
      if (!(file in wasmFS$JSMemoryRanges)) {
        var fileInfo = await fetch(url, {method: 'HEAD', headers: {'Range': 'bytes=0-'}});
        if (fileInfo.ok &&
            fileInfo.headers.has('Content-Length') &&
            fileInfo.headers.get('Accept-Ranges') == 'bytes' &&
            (parseInt(fileInfo.headers.get('Content-Length'), 10) > chunkSize * 2)) {
          var size = parseInt(fileInfo.headers.get('Content-Length'), 10);
          wasmFS$JSMemoryRanges[file] = {size, chunks: [], chunkSize};
          len = Math.min(len, size - offset);
        } else {
          var wholeFileReq = await fetch(url);
          if (!wholeFileReq.ok) throw wholeFileReq;
          var wholeFileData = new Uint8Array(await wholeFileReq.arrayBuffer());
          wasmFS$JSMemoryRanges[file] = {size: wholeFileData.byteLength, chunks: [wholeFileData], chunkSize: wholeFileData.byteLength};
          return;
        }
      }
      // FIX: the chunks are the cached file's (one whole-file chunk, or ranges)
      chunkSize = wasmFS$JSMemoryRanges[file].chunkSize;
      if (len <= 0) return;
      var firstChunk = (offset / chunkSize) | 0;
      var lastChunk = ((offset + len - 1) / chunkSize) | 0;
      var i, allPresent = true;
      for (i = firstChunk; i <= lastChunk; i++) {
        if (!wasmFS$JSMemoryRanges[file].chunks[i]) { allPresent = false; break; }
      }
      if (allPresent) return;
      var start = firstChunk * chunkSize;
      var end = (lastChunk + 1) * chunkSize;
      var response = await fetch(url, {headers: {'Range': `bytes=${start}-${end - 1}`}});
      if (!response.ok) throw response;
      var bytes = new Uint8Array(await response.arrayBuffer());
      for (i = firstChunk; i <= lastChunk; i++) {
        wasmFS$JSMemoryRanges[file].chunks[i] = bytes.slice(i * chunkSize - start, (i + 1) * chunkSize - start);
      }
    }

    wasmFS$backends[backend] = {
      allocFile: async (file) => { /* nop */ },
      freeFile: async (file) => { wasmFS$JSMemoryRanges[file] = undefined; },
      write: async (file, buffer, length, offset) => {
        console.error('TODO: file writing in fetch backend? read-only for now');
      },
      read: async (file, buffer, length, offset) => {
        if (offset < 0 || length <= 0) return 0;
        try {
          await getFileRange(file, offset || 0, length);
        } catch (failedResponse) {
          return failedResponse.status === 404 ? -{{{ cDefs.ENOENT }}} : -{{{ cDefs.EBADF }}};
        }
        var fileInfo = wasmFS$JSMemoryRanges[file];
        length = Math.min(length, fileInfo.size - offset);
        if (length <= 0) return 0;
        var chunks = fileInfo.chunks, chunkSize = fileInfo.chunkSize;
        var firstChunk = (offset / chunkSize) | 0;
        var lastChunk = ((offset + length - 1) / chunkSize) | 0;
        var readLength = 0;
        for (var i = firstChunk; i <= lastChunk; i++) {
          var chunk = chunks[i];
          var start = Math.max(i * chunkSize, offset);
          var chunkStart = i * chunkSize;
          var end = Math.min(chunkStart + chunkSize, offset + length);
          HEAPU8.set(chunk.subarray(start - chunkStart, end - chunkStart), buffer + (start - offset));
          readLength = end - offset;
        }
        return readLength;
      },
      getSize: async (file) => {
        try {
          await getFileRange(file, 0, 0);
        } catch (failedResponse) {
          return 0;
        }
        return wasmFS$JSMemoryRanges[file].size;
      },
    };
  },
});
