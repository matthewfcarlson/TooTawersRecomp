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
//
// FIX 2: the chunks were kept for the whole session: streamed from a server
// (the hosted site's disc and Ultra textures, 11 GB), the tab's memory only
// grew. Now they are kept up to CACHE_CAP bytes, the least recently read
// dropped first (and fetched again if read again); a read's own never.
//
// FIX 3: what is being fetched, told to the page (a BroadcastChannel,
// "tt-loading": {inflight, bytes}) for its loading bar.
//
// FIX 4: read-ahead. The game's reads wait for their chunk; streamed from a
// site, each new 4 MB was a round trip and a download in the middle of a film
// or of play (frames held for a sixth of a second and more). A file read in
// order -- a film, a streamed sound bank, a level's files -- now has its next
// AHEAD chunks fetched in the background, and a read that finds its chunk on
// the way waits for that fetch instead of making another.
addToLibrary({
  $wasmFS$fetchCache: { cap: 768 * 1024 * 1024, bytes: 0, lru: new Map() },   // key "file:chunk" -> bytes, oldest first
  _wasmfs_create_fetch_backend_js__deps: [
    '$wasmFS$backends',
    '$wasmFS$JSMemoryRanges',
    '_wasmfs_fetch_get_file_url',
    '_wasmfs_fetch_get_chunk_size',
    '$wasmFS$fetchCache',
  ],
  _wasmfs_create_fetch_backend_js: async function(backend) {
    var cache = wasmFS$fetchCache;
    // (FIX 3) fetches in flight and bytes so far, for the page's loading bar (at most every 150 ms, and when idle)
    var act = { inflight: 0, bytes: 0, last: 0 };
    var chan = typeof BroadcastChannel != 'undefined' ? new BroadcastChannel('tt-loading') : null;
    function report() {
      var t = Date.now();
      if (chan && (act.inflight === 0 || t - act.last > 150)) { act.last = t; chan.postMessage({ inflight: act.inflight, bytes: act.bytes }); }
    }
    async function get(url, opts) {
      act.inflight++; report();
      try {
        var r = await fetch(url, opts);
        if (!r.ok) throw r;
        var b = new Uint8Array(await r.arrayBuffer());
        act.bytes += b.byteLength;
        return b;
      } finally { act.inflight--; report(); }
    }
    function keep(file, i, n) {   // (FIX 2) chunk i of file used now: newest
      var k = file + ':' + i;
      if (cache.lru.has(k)) cache.lru.delete(k); else cache.bytes += n;
      cache.lru.set(k, n);
    }
    function trim(file, first, last) {   // (FIX 2) drop the oldest chunks past the cap, never this read's
      for (var [k, n] of cache.lru) {
        if (cache.bytes <= cache.cap) break;
        var at = k.lastIndexOf(':'), f = +k.slice(0, at), i = +k.slice(at + 1);
        if (f === file && i >= first && i <= last) continue;
        cache.lru.delete(k); cache.bytes -= n;
        if (wasmFS$JSMemoryRanges[f]) wasmFS$JSMemoryRanges[f].chunks[i] = undefined;
      }
    }
    // (FIX 4) chunks on the way: "file:chunk" -> a promise (resolved once that chunk is in the cache); each file's
    // last chunk read, to tell reads in order from jumps
    var AHEAD = 2, pending = new Map(), lastRead = {};
    function fetchAhead(file, url, first, last) {
      var r = wasmFS$JSMemoryRanges[file], cs = r.chunkSize, start = first * cs, end = Math.min(r.size, (last + 1) * cs);
      if (start >= end) return;
      var p = get(url, {headers: {'Range': `bytes=${start}-${end - 1}`}}).then((bytes) => {
        if (wasmFS$JSMemoryRanges[file] !== r) return;   // (freed meanwhile)
        for (var i = first; i <= last && i * cs - start < bytes.length; i++) {
          if (!r.chunks[i]) { r.chunks[i] = bytes.slice(i * cs - start, (i + 1) * cs - start); keep(file, i, r.chunks[i].byteLength); }
        }
        trim(file, first, last);
      }, () => {}).finally(() => { for (var i = first; i <= last; i++) pending.delete(file + ':' + i); });
      for (var i = first; i <= last; i++) pending.set(file + ':' + i, p);
    }
    function readAhead(file, url, first, last) {
      var r = wasmFS$JSMemoryRanges[file], prev = lastRead[file];
      lastRead[file] = last;
      if (!r || r.chunks.length === 1 && r.chunkSize === r.size) return;   // (a whole file: nothing after it)
      if (prev === undefined || first < prev || first > prev + 1) return;   // (not in order)
      var n = Math.ceil(r.size / r.chunkSize), from = last + 1, to = Math.min(n - 1, last + AHEAD);
      while (from <= to && (r.chunks[from] || pending.has(file + ':' + from))) from++;
      if (from <= to) fetchAhead(file, url, from, to);
    }
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
          var wholeFileData = await get(url);
          wasmFS$JSMemoryRanges[file] = {size: wholeFileData.byteLength, chunks: [wholeFileData], chunkSize: wholeFileData.byteLength};
          keep(file, 0, wholeFileData.byteLength); trim(file, 0, 0);
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
      if (!allPresent) {   // (FIX 4) on the way already: wait for those fetches
        var waits = [];
        for (i = firstChunk; i <= lastChunk; i++) if (!wasmFS$JSMemoryRanges[file].chunks[i] && pending.has(file + ':' + i)) waits.push(pending.get(file + ':' + i));
        if (waits.length) {
          await Promise.all(waits);
          allPresent = true;
          for (i = firstChunk; i <= lastChunk; i++) if (!wasmFS$JSMemoryRanges[file]?.chunks[i]) { allPresent = false; break; }
        }
      }
      if (allPresent) { for (i = firstChunk; i <= lastChunk; i++) keep(file, i, wasmFS$JSMemoryRanges[file].chunks[i].byteLength); readAhead(file, url, firstChunk, lastChunk); return; }
      var start = firstChunk * chunkSize;
      var end = (lastChunk + 1) * chunkSize;
      var bytes = await get(url, {headers: {'Range': `bytes=${start}-${end - 1}`}});
      for (i = firstChunk; i <= lastChunk; i++) {
        wasmFS$JSMemoryRanges[file].chunks[i] = bytes.slice(i * chunkSize - start, (i + 1) * chunkSize - start);
        keep(file, i, wasmFS$JSMemoryRanges[file].chunks[i].byteLength);
      }
      trim(file, firstChunk, lastChunk);
      readAhead(file, url, firstChunk, lastChunk);
    }

    wasmFS$backends[backend] = {
      allocFile: async (file) => { /* nop */ },
      freeFile: async (file) => {
        var r = wasmFS$JSMemoryRanges[file];
        if (r) r.chunks.forEach((c, i) => { if (c && cache.lru.delete(file + ':' + i)) cache.bytes -= c.byteLength; });
        wasmFS$JSMemoryRanges[file] = undefined;
      },
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
