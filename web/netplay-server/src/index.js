// (web port) The hosted game's Worker: the site's files (static assets,
// public/ from web/site.mjs: the page and the build, no game data) and online
// co-op's signalling and fallback relay for two players (NETPLAY.md).
//
//   GET  /match/<code>   WebSocket: the match's Durable Object (one per code)
//   POST /turn           ICE servers for the RTCPeerConnection: Cloudflare's
//                        TURN when TURN_KEY_ID and TURN_KEY_API_TOKEN are set
//                        (wrangler secret put), else Cloudflare's STUN only
//
// Inside a match (JSON text messages, binary relayed as is):
//   server -> client  {type:"welcome", role:"host"|"guest", peer:bool}
//                     {type:"peer-joined"} / {type:"peer-left"}
//   client -> other   {type:"signal", ...}   SDP and ICE candidates
//                     {type:"hash", ...}     desync checks
//                     {type:"start", ...}    the host's level, heroes, start
//                     anything binary        input packets, when the data
//                                            channel cannot connect (relay)
// A third connection is told {type:"full"} and closed (code 4000).
import { DurableObject } from "cloudflare:workers";

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
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected a WebSocket", { status: 426, headers: CORS });
      // the object is created near whoever opens the match first, and stays there
      return env.MATCH.getByName(m[1].toLowerCase()).fetch(request);
    }

    if (url.pathname === "/turn" && request.method === "POST") return iceServers(env);

    // (the site's files are answered before this, web/site.mjs; anything else is not here -- the page asks for
    // disc-manifest.json to learn whether a server holds the disc, and on the hosted site none does)
    return new Response("not found", { status: 404, headers: CORS });
  },
};

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

export class Match extends DurableObject {
  async fetch(request) {
    const sockets = this.ctx.getWebSockets();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (sockets.length >= 2) {   // (not kept: told, then closed)
      server.accept();
      server.send(JSON.stringify({ type: "full" }));
      server.close(4000, "match full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    const taken = sockets.map((s) => s.deserializeAttachment()?.role);
    const role = taken.includes("host") ? "guest" : "host";
    server.serializeAttachment({ role });
    server.send(JSON.stringify({ type: "welcome", role, peer: sockets.length === 1 }));
    for (const other of sockets) other.send(JSON.stringify({ type: "peer-joined" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // everything a player sends goes to the other one
  async webSocketMessage(ws, message) {
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.send(message);
  }

  async webSocketClose(ws, code, reason) {
    for (const other of this.ctx.getWebSockets())
      if (other !== ws) other.send(JSON.stringify({ type: "peer-left" }));
  }
}
