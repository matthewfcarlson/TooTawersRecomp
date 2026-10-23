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
//
// The proof: the build is only for players who have the disc. The page has
// it in the browser's storage (import.js); the questions are SHA-256 hashes of
// 64 KB pieces of its files, picked at random from a table made from the disc
// at deploy time (web/site.mjs -> gen/disc-proof.json, never committed: hashes
// only, nothing of the disc). Only hashes cross the network. Signed with
// BUILD_SECRET (wrangler secret put; .dev.vars locally, made by site.mjs).
//
// A created game keeps its settings (level, heroes) for the guest's page to
// take, and its two players' ids, for a week. Without one (an address with
// the switches in it, the test tools), the first in is the host, as before.
//
// Inside a match (JSON text messages, binary relayed as is):
//   server -> client  {type:"welcome", role:"host"|"guest", peer:bool, settings}
//                     {type:"replaced"}   the same player connected again elsewhere
//                     {type:"peer-joined"} / {type:"peer-left"}
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

    const m = url.pathname.match(/^\/match\/([A-Za-z0-9_-]{3,32})$/);
    if (m) {
      // the object is created near whoever opens the match first, and stays there
      const res = await env.MATCH.getByName(m[1].toLowerCase()).fetch(request);
      if (res.webSocket) return res;
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }

    if (url.pathname === "/turn" && request.method === "POST") return iceServers(env);
    if (url.pathname === "/proof") return proof(request, env);
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

async function hasPass(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tt_disc=(\d+)\.([A-Za-z0-9_-]+)/);
  return !!m && Number(m[1]) > now() && same(m[2], await sign(env, "pass." + m[1]));
}

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
  if (!env.BUILD_SECRET || !(await hasPass(request, env)))
    return new Response("the build is for players with the disc: import it on the first page", { status: 403, headers: { ...ISOLATION, "Cache-Control": "no-store" } });
  const r = await env.ASSETS.fetch(request);
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(ISOLATION)) h.set(k, v);
  h.set("Cache-Control", "private, max-age=3600");   // (never a shared cache: it is only for this player)
  return new Response(r.body, { status: r.status, headers: h });
}

async function iceServers(env) {
  const stun = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN)
    return Response.json({ iceServers: stun, turn: false }, { headers: CORS });
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 4 * 3600 }),   // a long session's worth
    },
  );
  if (!r.ok) return Response.json({ iceServers: stun, turn: false, error: r.status }, { headers: CORS });
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

export class Match extends DurableObject {
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
      const settings = { level: st.level, p1: st.p1, p2: st.p2 };
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
    for (const other of sockets) other.send(JSON.stringify({ type: "peer-joined" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() { await this.ctx.storage.deleteAll(); }   // (a week after it was made: the game is forgotten)

  // everything a player sends goes to the other one
  async webSocketMessage(ws, message) {
    if (ws.deserializeAttachment()?.replaced) return;
    for (const other of this.ctx.getWebSockets()) if (other !== ws && !other.deserializeAttachment()?.replaced) other.send(message);
  }

  async webSocketClose(ws, code, reason) {
    if (ws.deserializeAttachment()?.replaced) return;   // (the same player's new connection took its place: no departure)
    for (const other of this.ctx.getWebSockets())
      if (other !== ws && !other.deserializeAttachment()?.replaced) other.send(JSON.stringify({ type: "peer-left" }));
  }
}
