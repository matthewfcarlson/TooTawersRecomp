#!/usr/bin/env node
// (web port) Development server for the browser build.
//
//   node web/serve.mjs [--port 8080] [--build build-web] [--disc isos/extracted]
//
// Serves the page (web/index.html), the build (twotowers_recomp.js/.wasm) and
// your extracted disc under disc/, with disc-manifest.json listing its files
// ("<size> <path>" per line) for the game's file system. Sends the
// cross-origin isolation headers threads need (SharedArrayBuffer), and
// answers HTTP Range requests so the game fetches the disc in chunks as it
// reads. Listens on 127.0.0.1 only: the disc is yours, not for the network.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let port = 8080, build = path.join(repo, 'build-web'), disc = path.join(repo, 'isos', 'extracted');
// the Ultra textures: a folder with GLOS69/ (the pack) and textures_ultra/ (built by twotowers-setup ultra)
// the co-op bot suite's pad scripts (tools/coop-bot/*.txt), at /bot in the game's files (web/tools/coop-suite.mjs)
const bot = path.join(repo, 'tools', 'coop-bot');
// the port's textures_ultra support files (masks, recipe, pairs): copied beside the pack before it is built
const ultraSrc = path.join(repo, 'twotowers', 'tools', 'ultra_textures');
const ultraSupport = () => ['recipe.txt', 'pairs.txt', ...listFiles(ultraSrc, ['masks']).map((l) => l.slice(l.indexOf(' ') + 1))];
let ultra = fs.existsSync(path.join(repo, 'textures', 'textures_ultra', 'built.txt')) ? path.join(repo, 'textures') : null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--build') build = path.resolve(argv[++i]);
  else if (argv[i] === '--disc') disc = path.resolve(argv[++i]);
  else if (argv[i] === '--ultra') ultra = argv[++i] === 'off' ? null : path.resolve(argv[i]);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };

function listFiles(root, subdirs) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && !/\.(part|ini)$/i.test(e.name)) out.push(`${fs.statSync(p).size} ${r}`);
    }
  };
  for (const sub of subdirs) if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub), sub);
  return out;
}

function manifest() {
  const out = listFiles(disc, ['']).map((l) => l.replace(/ \//, ' '));
  // (saves: the game's own UDATA/TDATA, written beside the disc by the desktop build; the page keeps its own)
  return out.filter((l) => !/^\d+ (UDATA|TDATA)\//i.test(l)).join('\n') + '\n';
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, {}, 'not found'); }
  if (!st.isFile()) return send(res, 404, {}, 'not found');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) return send(res, 416, { 'Content-Range': `bytes */${st.size}` }, '');
    status = 206;
  }
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  if (req.method === 'HEAD') return send(res, status, headers, '');
  res.writeHead(status, {
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store', ...headers,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// a path under root, or null if it climbs out
function under(root, rel) {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

// the disc's own spelling of a path (the game asks in lower case)
function icase(p, root = disc) {
  if (!p || fs.existsSync(p)) return p;
  let cur = root;
  for (const part of path.relative(root, p).split(path.sep)) {
    let names;
    try { names = fs.readdirSync(cur); } catch { return p; }
    const hit = names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return p;
    cur = path.join(cur, hit);
  }
  return cur;
}

http.createServer((req, res) => {
  res.on('finish', () => { if (res.statusCode >= 400) console.log(`${res.statusCode} ${req.method} ${req.url}`); });
  let url = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/+/g, '/');
  // the game asks for its files beside its script, build/ (disc, ultra, bot): the same as at the root
  if (url.startsWith('/build/') && !/^\/build\/twotowers_recomp\./.test(url)) url = url.slice('/build'.length);
  if (url === '/' || url === '/index.html') return sendFile(req, res, path.join(repo, 'web', 'index.html'));
  if (['/netplay.js', '/lobby.js', '/saves.js', '/import.js', '/import-worker.js'].includes(url)) return sendFile(req, res, path.join(repo, 'web', url.slice(1)));
  // the port's own files for the Ultra textures' build in the browser (import.js), as the hosted site has them
  if (url === '/ultra-support.txt') return send(res, 200, { 'Content-Type': 'text/plain' }, ultraSupport().join('\n') + '\n');
  if (url.startsWith('/ultra-support/') && ultraSupport().includes(url.slice('/ultra-support/'.length)))
    return sendFile(req, res, path.join(ultraSrc, url.slice('/ultra-support/'.length)));
  if (url === '/disc-manifest.json') return send(res, 200, { 'Content-Type': 'text/plain' }, manifest());
  if (url === '/ultra-manifest.json')
    return ultra ? send(res, 200, { 'Content-Type': 'text/plain' }, listFiles(ultra, ['GLOS69', 'textures_ultra']).join('\n') + '\n')
                 : send(res, 404, {}, 'no Ultra textures');
  if (url.startsWith('/ultra/') && ultra) {
    const f = icase(under(ultra, url.slice('/ultra/'.length)), ultra);
    return f ? sendFile(req, res, f) : send(res, 403, {}, 'no');
  }
  if (url === '/bot-manifest.json')
    return send(res, 200, { 'Content-Type': 'text/plain' }, listFiles(bot, ['']).filter((l) => /\.txt$/.test(l)).map((l) => l.replace(/ \//, ' ')).join('\n') + '\n');
  if (url.startsWith('/bot/') && /\.txt$/.test(url)) {
    const f = under(bot, url.slice('/bot/'.length));
    return f && fs.existsSync(f) ? sendFile(req, res, f) : send(res, 404, {}, 'no');
  }
  if (url.startsWith('/disc/')) {
    const f = icase(under(disc, url.slice('/disc/'.length)));
    return f ? sendFile(req, res, f) : send(res, 403, {}, 'no');
  }
  // the build: /build/ as on the hosted site (no disc check here: your machine, your disc)
  const f = under(build, url.replace(/^\/build\//, ''));
  return f ? sendFile(req, res, f) : send(res, 403, {}, 'no');
}).listen(port, '127.0.0.1', () => {
  console.log(`The Two Towers (web): http://localhost:${port}/`);
  console.log(`  build ${build}\n  disc  ${disc}\n  ultra ${ultra ?? '(none: textures/ with a built textures_ultra, or --ultra <dir>)'}`);
});
