// (web port) The hosted game's Worker: the site's files (static assets,
// public/ from web/site.mjs: the page and the build, no game data) and online
// co-op's signalling and fallback relay for two players (NETPLAY.md).
//
//   GET  /match/<code>   WebSocket: the match's Durable Object (one per code);
//                        ?player=<id>: the browser's own id (kept across
//                        reloads: the same id gets its role back)
//   POST /match/<code>   create a game: {player, settings} -> 201, or 409 if
//                        the code is taken; the creator is the host
//   GET  /match/<code>   (not a WebSocket) {settings, players} or 404
//   POST /turn           ICE servers for the RTCPeerConnection: Cloudflare's
//                        TURN when TURN_KEY_ID and TURN_KEY_API_TOKEN are set
//                        (wrangler secret put), else Cloudflare's STUN only
//   GET  /proof          three questions about the player's disc
//   POST /proof          the answers: a cookie that opens /build/ (30 days)
//   GET  /build/*        the build (the game's code, translated from the
//                        disc): only with that cookie
//   GET  /share          {open, held}: whether this site shares its own copy
//                        of the disc and Ultra textures, and whether this
//                        browser holds the password's pass
//   POST /share          {password}: right, the disc pass and the share pass
//                        (30 days; a new SHARE_PASSWORD ends them all)
//   GET  /disc-manifest.json, /disc/*, /ultra-manifest.json, /ultra/* (and
//                        the same under /build/, where the game asks): the
//                        site's copy, from R2 (FILES), with ranges -- only
//                        with the share pass; for anyone else not here, so
//                        the game reads its player's own imported disc
//   /share-upload/<key>  (Authorization: Bearer UPLOAD_SECRET) the copy put
//                        in R2: HEAD, PUT, and a multipart upload for the big
//                        files (web/tools/share-upload.mjs)
//
// The proof: the build is only for players who have the disc. The page has
// it in the browser's storage (import.js); the questions are SHA-256 hashes of
// 64 KB pieces of its files, picked at random from a table made from the disc
// at deploy time (web/site.mjs -> gen/disc-proof.json, never committed: hashes
// only, nothing of the disc). Only hashes cross the network. Signed with
// BUILD_SECRET (wrangler secret put; .dev.vars locally, made by site.mjs).
//
// The disc pass also opens /match and /turn: the match server and the TURN
// relay are only for players with the disc, so other sites and scripts get
// neither (the cookie is SameSite=Strict: only this site's pages send it).
// The one exception is web/serve.mjs's page on this machine with wrangler dev
// (http://localhost:8080 to localhost:8787), which has no pass.
//
// Limits (the abuse there could be; a game is far below them):
//   - rate limits (wrangler.jsonc, Workers rate limiting: per Cloudflare
//     location, approximate): relay credentials per pass and per address,
//     games made and joined per pass, disc checks per address
//   - each match connection's speed (Match.allow): bytes and messages a
//     second, with a burst for the host's saves; over it, closed (4008)
//   Cloudflare's TURN has no speed limit of its own (only a credential's
//   life, ttl): the rate limits keep the credentials few.
//
// A created game keeps its settings (level, heroes) for the guest's page to
// take, and its two players' ids, for a week. Without one (an address with
// the switches in it, the test tools), the first in is the host, as before.
//
// The players' pages also send each other the host's save files for a
// shared game ({type:"saves-want"|"saves-part"|"saves-ok"|"saves-bad"},
// lobby.js): relayed like any other message.
//
// Inside a match (JSON text messages, binary relayed as is):
//   server -> client  {type:"welcome", role:"host"|"guest", peer:bool, settings}
//                     {type:"replaced"}   the same player connected again elsewhere
//                     {type:"peer-joined"[, resume:true]} / {type:"peer-left"}
//   client -> other   {type:"signal", ...}   SDP and ICE candidates
//                     {type:"hash", ...}     desync checks
//                     {type:"start", ...}    the host's level, heroes, start
//                     anything binary        input packets, when the data
//                                            channel cannot connect (relay)
// A third connection is told {type:"full"} and closed (code 4000).
import { DurableObject } from "cloudflare:workers";
import proofTable from "../gen/disc-proof.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (url.pathname === "/proof" && !(await allowed(env.PROOF_LIMIT, "ip:" + ip)))
      return Response.json({ error: "too many disc checks from here: wait a minute" }, { status: 429 });
    const m = url.pathname.match(/^\/match\/([A-Za-z0-9_-]{3,32})$/);
    if (m || url.pathname === "/turn") {
      const pass = await passOf(request, env);
      if (!pass && !localPage(request, url))
        return Response.json({ error: "online play is for players with the disc: import it on the first page" }, { status: 403, headers: CORS });
      const who = pass || "ip:" + ip;
      if (url.pathname === "/turn" && request.method === "POST") {
        if (!(await allowed(env.TURN_LIMIT, who)) || !(await allowed(env.TURN_IP_LIMIT, "ip:" + ip)))   // (STUN still: a direct connection)
          return Response.json({ iceServers: STUN, turn: false, error: "too many relay requests: wait a minute" }, { status: 429, headers: CORS });
        return iceServers(env);
      }
      if (m && (request.method === "POST" || request.headers.get("Upgrade") === "websocket") && !(await allowed(env.GAME_LIMIT, who)))
        return Response.json({ error: "too many games made or joined: wait a minute" }, { status: 429, headers: CORS });
    }
    if (m) {
      // the object is created near whoever opens the match first, and stays there
      const res = await env.MATCH.getByName(m[1].toLowerCase()).fetch(request);
      if (res.webSocket) return res;
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    if (url.pathname === "/proof") return proof(request, env);
    if (url.pathname === "/share") {
      if (request.method === "POST" && !(await allowed(env.PROOF_LIMIT, "ip:" + ip)))
        return Response.json({ error: "too many tries from here: wait a minute" }, { status: 429 });
      return share(request, env);
    }
    if (url.pathname.startsWith("/share-upload/")) return shareUpload(request, env, url);
    // (the game's fetches join their folder and the file's path with a slash of their own: disc//default.xbe)
    const shared = url.pathname.replace(/\/{2,}/g, "/").replace(/^\/build\//, "/").match(/^\/((?:disc|ultra)-manifest\.json|(?:disc|ultra)\/.+)$/);
    if (shared) return sharedFile(request, env, shared[1]);
    if (url.pathname.startsWith("/build/")) return build(request, env);

    // (the site's files are answered before this, web/site.mjs; anything else is not here -- the page asks for
    // disc-manifest.json to learn whether a server holds the disc, and on the hosted site none does)
    return new Response("not found", { status: 404, headers: CORS });
  },
};

// ---- the disc proof and the build behind it ----
const QUESTIONS = 3, ASK_TTL = 300, PASS_TTL = 30 * 86400, COOKIE = "tt_disc";
const ISOLATION = {   // (the page's threads need these on every file; _headers covers the public ones)
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const enc = new TextEncoder();
async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.BUILD_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function same(a, b) {   // (constant time)
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const now = () => Math.floor(Date.now() / 1000);

// the player's pass (its signature: the key its rate limits are counted by), or null
async function passOf(request, env) {
  if (!env.BUILD_SECRET) return null;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tt_disc=(\d+)\.([A-Za-z0-9_-]+)/);
  return m && Number(m[1]) > now() && same(m[2], await sign(env, "pass." + m[1])) ? m[2] : null;
}
const hasPass = async (request, env) => !!(await passOf(request, env));
// web/serve.mjs's page on this machine, to wrangler dev (never so on Cloudflare: the address is the Worker's own)
const localPage = (request, url) => /^(localhost|127\.0\.0\.1)$/.test(url.hostname) &&
  /^http:\/\/(localhost|127\.0\.0\.1):8080$/.test(request.headers.get("Origin") || "");
const allowed = async (limiter, key) => !limiter || (await limiter.limit({ key })).success;

async function proof(request, env) {
  if (!env.BUILD_SECRET || !proofTable.questions?.length)
    return Response.json({ error: "this server is not set up for the disc check" }, { status: 503 });
  if (request.method === "GET") {
    const pick = new Set();
    const r = new Uint32Array(QUESTIONS * 4);
    crypto.getRandomValues(r);
    for (const x of r) { if (pick.size === QUESTIONS) break; pick.add(x % proofTable.questions.length); }
    const ids = [...pick], exp = now() + ASK_TTL;
    return Response.json({
      exp, ids, mac: await sign(env, `ask.${exp}.${ids.join(",")}`),
      ask: ids.map((i) => { const q = proofTable.questions[i]; return { path: q.path, offset: q.offset, length: q.length }; }),
    }, { headers: { "Cache-Control": "no-store" } });
  }
  if (request.method !== "POST") return new Response("GET or POST", { status: 405 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  const { exp, ids, mac, hashes } = body || {};
  if (!Array.isArray(ids) || !Array.isArray(hashes) || ids.length !== QUESTIONS || hashes.length !== QUESTIONS ||
      !(Number(exp) > now()) || !same(mac, await sign(env, `ask.${exp}.${ids.join(",")}`)))
    return Response.json({ error: "the questions ran out or were changed: ask again" }, { status: 400 });
  const right = ids.every((id, k) => same(String(hashes[k]).toLowerCase(), proofTable.questions[id]?.sha256));
  if (!right)
    return Response.json({ error: "that disc is not the one this build was made from (The Two Towers, Xbox, USA)" }, { status: 403 });
  const until = now() + PASS_TTL;
  return Response.json({ ok: true, until }, { headers: {
    "Cache-Control": "no-store",
    "Set-Cookie": `${COOKIE}=${until}.${await sign(env, "pass." + until)}; Path=/; Max-Age=${PASS_TTL}; HttpOnly; Secure; SameSite=Strict`,
  } });
}

async function build(request, env) {
  if (!(await hasPass(request, env)))
    return new Response("the build is for players with the disc: import it on the first page", { status: 403, headers: { ...ISOLATION, "Cache-Control": "no-store" } });
  const r = await env.ASSETS.fetch(request);
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
  h.set("Cache-Control", "private, max-age=3600");   // (never a shared cache: it is only for this player)
  return new Response(r.body, { status: r.status, headers: h });
}

// ---- the site's own copy, behind a password (SHARE_PASSWORD; the files in R2, FILES) ----
// The share pass is signed with a tag of the password, so a new password ends every pass given for the old one.
const SHARE_COOKIE = "tt_share";
const sharing = (env) => !!(env.SHARE_PASSWORD && env.FILES && env.BUILD_SECRET);
const pwTag = async (env, pw) => (await sign(env, "pw." + pw)).slice(0, 16);
async function hasShare(request, env) {
  if (!sharing(env)) return false;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tt_share=(\d+)\.([A-Za-z0-9_-]+)/);
  return !!m && Number(m[1]) > now() && same(m[2], await sign(env, `share.${m[1]}.${await pwTag(env, env.SHARE_PASSWORD)}`));
}

async function share(request, env) {
  const nostore = { "Cache-Control": "no-store" };
  if (request.method === "GET") return Response.json({ open: sharing(env), held: await hasShare(request, env) }, { headers: nostore });
  if (request.method !== "POST") return new Response("GET or POST", { status: 405 });
  if (!sharing(env)) return Response.json({ error: "this site does not share a copy" }, { status: 404 });
  let body;
  try { body = await request.json(); } catch { body = null; }
  // (compared as signatures: the same length whatever was typed, in constant time)
  if (typeof body?.password !== "string" || !same(await pwTag(env, body.password), await pwTag(env, env.SHARE_PASSWORD)))
    return Response.json({ error: "that is not the password" }, { status: 403, headers: nostore });
  const until = now() + PASS_TTL, attrs = `Path=/; Max-Age=${PASS_TTL}; HttpOnly; Secure; SameSite=Strict`;
  const h = new Headers(nostore);
  h.append("Set-Cookie", `${COOKIE}=${until}.${await sign(env, "pass." + until)}; ${attrs}`);
  h.append("Set-Cookie", `${SHARE_COOKIE}=${until}.${await sign(env, `share.${until}.${await pwTag(env, env.SHARE_PASSWORD)}`)}; ${attrs}`);
  return Response.json({ ok: true, until }, { headers: h });
}

// a file of the copy: the disc's and the pack's names in lower case (the game asks so; share-upload.mjs puts them so)
async function sharedFile(request, env, path) {
  const notHere = () => new Response("not found", { status: 404, headers: { ...ISOLATION, "Cache-Control": "no-store" } });
  if (!["GET", "HEAD"].includes(request.method) || path.includes("..") || !(await hasShare(request, env))) return notHere();
  const key = path.endsWith("-manifest.json") ? path : path.toLowerCase();
  const h = new Headers({ ...ISOLATION, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=604800" });
  if (request.method === "HEAD") {   // (the fetch backend's first look: the whole size, whatever range it names)
    const o = await env.FILES.head(key);
    if (!o) return notHere();
    o.writeHttpMetadata(h);
    h.set("Content-Length", String(o.size));
    return new Response(null, { status: 200, headers: h });
  }
  const o = await env.FILES.get(key, { range: request.headers });
  if (!o) return notHere();
  o.writeHttpMetadata(h);
  if (request.headers.has("Range") && o.range) {
    const off = o.range.offset ?? (o.range.suffix !== undefined ? o.size - o.range.suffix : 0);
    const len = o.range.length ?? (o.size - off);
    h.set("Content-Range", `bytes ${off}-${off + len - 1}/${o.size}`);
    h.set("Content-Length", String(len));
    return new Response(o.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(o.size));
  return new Response(o.body, { status: 200, headers: h });
}

// putting the copy in R2 (web/tools/share-upload.mjs): small files in one PUT, big ones in parts (a request's body
// is at most 100 MB)
async function shareUpload(request, env, url) {
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!env.UPLOAD_SECRET || !env.FILES || !same(await sign(env, "up." + auth), await sign(env, "up." + env.UPLOAD_SECRET)))
    return Response.json({ error: "not allowed" }, { status: 403 });
  const key = decodeURIComponent(url.pathname.slice("/share-upload/".length));
  if (!/^((disc|ultra)-manifest\.json|(disc|ultra)\/[a-z0-9_.\/ -]+)$/.test(key) || key.includes(".."))
    return Response.json({ error: "bad key" }, { status: 400 });
  const id = url.searchParams.get("uploadId");
  if (request.method === "HEAD") {
    const o = await env.FILES.head(key);
    return new Response(null, { status: o ? 200 : 404, headers: o ? { "X-Size": String(o.size) } : {} });
  }
  if (request.method === "PUT" && !id) {
    await env.FILES.put(key, request.body);
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.searchParams.has("uploads")) {
    const u = await env.FILES.createMultipartUpload(key);
    return Response.json({ uploadId: u.uploadId });
  }
  if (id) {
    const u = env.FILES.resumeMultipartUpload(key, id);
    if (request.method === "PUT") {
      const part = await u.uploadPart(Number(url.searchParams.get("partNumber")), request.body);
      return Response.json(part);
    }
    if (request.method === "POST") {
      const { parts } = await request.json();
      await u.complete(parts);
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") { await u.abort(); return Response.json({ ok: true }); }
  }
  return new Response("bad request", { status: 400 });
}

const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];
async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN)
    return Response.json({ iceServers: STUN, turn: false }, { headers: CORS });
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 4 * 3600 }),   // a long session's worth
    },
  );
  if (!r.ok) return Response.json({ iceServers: STUN, turn: false, error: r.status }, { headers: CORS });
  const body = await r.json();
  // port 53 only works with trickle ICE off the browser's resolver: left out (Cloudflare's advice)
  const servers = (body.iceServers || []).map((s) => ({
    ...s,
    urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
  }));
  return Response.json({ iceServers: servers, turn: true }, { headers: CORS });
}

const WEEK = 7 * 86400 * 1000;
const PLAYER = /^[A-Za-z0-9_-]{8,64}$/;
const HEROES = /^[a-z]{3,16}$/, LEVEL = /^[0-9]{2}[A-Z]{3,6}[0-9]$/;

// each match connection's speed limit. A game sends about 5 KB and 35 messages a second (the inputs when the data
// channel cannot connect, the desync checks); the host's saves come all at once (base64, 192 KB a message). A
// connection may send a burst of BURST, refilled at RATE a second, and no message over BIGGEST
const BURST = { bytes: 8 << 20, msgs: 600 }, RATE = { bytes: 128 << 10, msgs: 100 }, BIGGEST = 512 << 10;

export class Match extends DurableObject {
  speed = new Map();   // connection -> {t, bytes, msgs} (in memory: after a hibernation, a full burst again)
  allow(ws, size) {
    const t = Date.now() / 1000;
    let b = this.speed.get(ws);
    if (!b) this.speed.set(ws, (b = { t, ...BURST }));
    b.bytes = Math.min(BURST.bytes, b.bytes + (t - b.t) * RATE.bytes) - size;
    b.msgs = Math.min(BURST.msgs, b.msgs + (t - b.t) * RATE.msgs) - 1;
    b.t = t;
    return size <= BIGGEST && b.bytes >= 0 && b.msgs >= 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const game = await this.ctx.storage.get("game");   // {settings, host, guest, created} for a created game
    if (request.headers.get("Upgrade") !== "websocket") {
      if (request.method === "GET")
        return game ? Response.json({ settings: game.settings, players: this.ctx.getWebSockets().length })
                    : Response.json({ error: "no such game" }, { status: 404 });
      if (request.method !== "POST") return new Response("expected a WebSocket, GET or POST", { status: 426 });
      let body;
      try { body = await request.json(); } catch { body = null; }
      if (game || this.ctx.getWebSockets().length) return Response.json({ error: "that code is taken" }, { status: 409 });
      const st = body?.settings;
      if (!PLAYER.test(body?.player || "") || !st || !LEVEL.test(st.level) || !HEROES.test(st.p1) || !HEROES.test(st.p2))
        return Response.json({ error: "bad game settings" }, { status: 400 });
      // the co-op settings that change the game (options.c: difficulty 0-2, player 2's teleport, double pickups):
      // the host's, for both games (each player's own ini would make two different games)
      const flag = (v, max, def) => (Number.isInteger(v) && v >= 0 && v <= max ? v : def);
      const settings = { start: st.start === "menu" ? "menu" : "level", level: st.level, p1: st.p1, p2: st.p2,
                         difficulty: flag(st.difficulty, 2, 1), teleport: flag(st.teleport, 1, 1), pickups: flag(st.pickups, 1, 1) };
      await this.ctx.storage.put("game", { settings, host: body.player, guest: null, created: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + WEEK);
      return Response.json({ ok: true, settings }, { status: 201 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const refuse = (why) => {   // (not kept: told, then closed)
      server.accept();
      server.send(JSON.stringify({ type: "full" }));
      server.close(4000, why);
      return new Response(null, { status: 101, webSocket: client });
    };
    const player = PLAYER.test(url.searchParams.get("player") || "") ? url.searchParams.get("player") : null;
    let sockets = this.ctx.getWebSockets();
    // the same browser again (a reload, a second tab): it takes its place back. The old connection is told
    // ({type:"replaced"}: its page closes it) and marked: nothing more is sent to it, its end is no departure
    for (const s of sockets) {
      const at = s.deserializeAttachment();
      if (player && at?.player === player && !at.replaced) {
        s.serializeAttachment({ ...at, replaced: true });
        try { s.send(JSON.stringify({ type: "replaced" })); } catch {}
      }
    }
    sockets = sockets.filter((s) => !s.deserializeAttachment()?.replaced);
    let role;
    if (game) {   // a created game: the host is its creator, the guest the first other player, kept for good
      if (player && player === game.host) role = "host";
      else if (player && (!game.guest || game.guest === player)) {
        role = "guest";
        if (!game.guest) { game.guest = player; await this.ctx.storage.put("game", game); }
      } else return refuse("this game has its two players");
      if (sockets.some((s) => s.deserializeAttachment()?.role === role)) return refuse("that player is already in");
    } else {
      if (sockets.length >= 2) return refuse("match full");
      role = sockets.map((s) => s.deserializeAttachment()?.role).includes("host") ? "guest" : "host";
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, player });
    server.send(JSON.stringify({ type: "welcome", role, peer: sockets.length === 1, settings: game?.settings ?? null }));
    // (?resume=1: the same page's connection again after the server dropped it -- a deploy -- not a return: its game goes on)
    const resume = url.searchParams.get("resume") === "1";
    for (const other of sockets) other.send(JSON.stringify(resume ? { type: "peer-joined", resume: true } : { type: "peer-joined" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() { await this.ctx.storage.deleteAll(); }   // (a week after it was made: the game is forgotten)

  // everything a player sends goes to the other one
  async webSocketMessage(ws, message) {
    if (ws.deserializeAttachment()?.replaced) return;
    if (!this.allow(ws, typeof message === "string" ? message.length : message.byteLength)) {
      // too fast: told and closed; marked as a replaced connection is (nothing more to or from it), the other told
      ws.serializeAttachment({ ...ws.deserializeAttachment(), replaced: true });
      try { ws.send(JSON.stringify({ type: "too-fast" })); ws.close(4008, "too fast"); } catch {}
      for (const other of this.ctx.getWebSockets())
        if (other !== ws && !other.deserializeAttachment()?.replaced) other.send(JSON.stringify({ type: "peer-left" }));
      this.speed.delete(ws);
      return;
    }
    for (const other of this.ctx.getWebSockets()) if (other !== ws && !other.deserializeAttachment()?.replaced) other.send(message);
  }

  async webSocketClose(ws, code, reason) {
    this.speed.delete(ws);
    if (ws.deserializeAttachment()?.replaced) return;   // (the same player's new connection took its place: no departure)
    for (const other of this.ctx.getWebSockets())
      if (other !== ws && !other.deserializeAttachment()?.replaced) other.send(JSON.stringify({ type: "peer-left" }));
  }
}
