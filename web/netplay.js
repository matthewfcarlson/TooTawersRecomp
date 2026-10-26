// (web port) Online co-op, the page's half (NETPLAY.md): the match on the
// netplay server (web/netplay-server), the WebRTC data channel to the other
// player, and the game's input latch (twotowers/src/tt_netplay.c).
//
// Loaded by index.html when the address has ?match=<code>. Both players open
// the same address; the first in is the host (player 1), the second the guest
// (player 2). &server=<ws(s)://host> picks the server (default: the page's own
// origin, as hosted on Cloudflare; beside web/serve.mjs's port 8080, the same
// host's port 8787 -- wrangler dev). The game is told TT_NETPLAY=1.
//
// Packets on the data channel (unordered, no retransmits), little-endian:
//   1 input   u32 newest frame, u8 n, then n x 18 bytes: the inputs of frames
//             newest, newest-1, ... (u16 buttons, 8 analog bytes, 4 x i16 sticks)
//   2 ping    f64 the sender's time        3 pong   f64 that time, echoed
// Every packet carries the last 8 frames' inputs, so a lost one stalls nothing.
// If the data channel is not open 6 s after both are in, the same packets go
// through the server (WebSocket, relayed by the match's Durable Object).
// State hashes go through the server ({type:"hash"}): reliable, and slow is fine.
//
// Coming back (lobby.js): the page joins with this browser's player id, so a
// reload gets its role back. A game cannot be joined halfway (both machines
// step the same game from its first frame), so when the other player comes
// back to a game under way here (past its first second), this page reloads
// too and both start the level again together (sessionStorage tt-autostart:
// straight into the game). A game still at its start just waits for them.
//
// A desync (the two games' hashes differ) cannot be mended in place: both
// pages see it, say so, and start the level again together, the same way --
// at most twice in 10 minutes (sessionStorage tt-desyncs), then they only say
// so. An address with the game's own switches (TT_..., the test tools) only
// reports it, as before.
(function () {
  const q = new URLSearchParams(location.search);
  const code = q.get('match');
  if (!code) return;
  // the server: the page's own origin when hosted (the same Worker), wrangler dev's port beside web/serve.mjs
  const local = location.port === '8080';
  const server = (q.get('server') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${local ? location.hostname + ':8787' : location.host}`).replace(/\/$/, '');
  const httpServer = server.replace(/^ws/, 'http');
  const REDUNDANCY = 8;
  const REC = 22;   // (one frame's record: the pad, 18 bytes, then the host's sound end, 4 -- tt_netplay.c np_snd_*)

  const state = { role: null, ws: null, pc: null, dc: null, path: 'connecting', rtt: null, relay: false, desync: null };
  const sent = new Map();          // frame -> REC bytes (my inputs, for resending)
  const myHashes = new Map(), theirHashes = new Map();
  let newestSent = 0, peerIn = false, relayTimer = null;

  const log = (t) => (Module.printErr || console.log)('[NETPLAY] ' + t);
  function show() {
    const el = document.getElementById('netplay');
    if (!el) return;
    el.textContent = `Online co-op "${code}": ${state.role ?? '…'}, ${state.path}` +
      (state.rtt != null ? `, round trip ${state.rtt.toFixed(0)} ms` : '') +
      (state.desync ? ` · DESYNC at frame ${state.desync}` : '');
    el.className = state.desync ? 'bad' : '';
    const sp = document.getElementById('together-status');   // (the splash's game card)
    if (sp) { sp.textContent = (state.role ? `You are player ${state.role === 'host' ? 1 : 2}: ` : '') + state.path; sp.className = /full|closed|left|another/.test(state.path) ? 'bad' : ''; }
  }
  function restartTogether() {
    state.path = 'the other player is back: starting the level again for both of you'; show(); log(state.path);
    try { sessionStorage.setItem('tt-autostart', code); } catch {}
    setTimeout(() => location.reload(), 1500);
  }

  function recover(frame) {
    if ([...q.keys()].some((k) => /^TT_/.test(k))) return;   // (a test: report only)
    let recent = [];
    try { recent = JSON.parse(sessionStorage.getItem('tt-desyncs') || '[]').filter((t) => Date.now() - t < 600000); } catch {}
    if (recent.length >= 2) {
      state.path = 'the two games went out of step again: reload to start the level again'; show();
      return;
    }
    try { sessionStorage.setItem('tt-desyncs', JSON.stringify(recent.concat(Date.now()))); sessionStorage.setItem('tt-autostart', code); } catch {}
    state.path = `the two games went out of step (frame ${frame}): starting the level again for both of you`; show(); log(state.path);
    setTimeout(() => location.reload(), 3000);
  }

  function ready(fn) {
    if (Module.ttReady) return fn();
    (Module.ttReadyQueue ??= []).push(fn);
  }

  // --- from the game ---------------------------------------------------------
  // (a frame's input: the pad, then 'ev' -- the host's sound end for that frame, tt_netplay.c np_snd_*)
  Module.ttNetInput = (frame, buttons, a0123, a4567, lx, ly, rx, ry, ev) => {
    const b = new DataView(new ArrayBuffer(REC));
    b.setUint16(0, buttons, true);
    b.setUint32(2, a0123 >>> 0, true); b.setUint32(6, a4567 >>> 0, true);
    b.setInt16(10, lx, true); b.setInt16(12, ly, true); b.setInt16(14, rx, true); b.setInt16(16, ry, true);
    b.setUint32(18, (ev || 0) >>> 0, true);
    sent.set(frame, new Uint8Array(b.buffer));
    sent.delete(frame - 64);
    newestSent = Math.max(newestSent, frame);
    sendInputs();
  };
  Module.ttNetHash = (frame, hi, lo, inputs) => {
    // the simulation's hash (every actor's whole object: tt_statehash.c), then the hash of every input given so far
    const h = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0') + '/' + inputs.toString(16).padStart(8, '0');
    myHashes.set(frame, h);
    compare(frame);
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'hash', frame, h }));
  };
  function compare(frame) {
    const a = myHashes.get(frame), b = theirHashes.get(frame);
    if (!a || !b) return;
    const [sa, ia] = a.split('/'), [sb, ib] = b.split('/');
    if ((sa !== sb || ia !== ib) && !state.desync) {
      state.desync = frame;
      const what = ia !== ib ? 'the inputs differ' : 'same inputs, the game differs';
      log(`DESYNC at frame ${frame} (${what}): ${a} here, ${b} there`);
      show();
      recover(frame);
    }
    myHashes.delete(frame); theirHashes.delete(frame);
  }

  function packet() {
    const n = Math.min(REDUNDANCY, newestSent);
    const out = new Uint8Array(6 + REC * n), v = new DataView(out.buffer);
    v.setUint8(0, 1); v.setUint32(1, newestSent, true); v.setUint8(5, n);
    for (let i = 0; i < n; i++) {
      const f = sent.get(newestSent - i);
      if (f) out.set(f, 6 + REC * i);
    }
    return out;
  }
  function sendRaw(bytes) {
    if (state.dc?.readyState === 'open') state.dc.send(bytes);
    else if (state.relay && state.ws?.readyState === 1) state.ws.send(bytes);
  }
  function sendInputs() { if (newestSent) sendRaw(packet()); }

  // --- to the game -----------------------------------------------------------
  function receive(data) {
    const v = new DataView(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0);
    const type = v.getUint8(0);
    if (type === 1) {
      const newest = v.getUint32(1, true), n = v.getUint8(5);
      if (!Module.ttReady) return;
      for (let i = n - 1; i >= 0; i--) {
        const o = 6 + REC * i;
        Module._tt_np_remote(newest - i, v.getUint16(o, true), v.getUint32(o + 2, true) | 0, v.getUint32(o + 6, true) | 0,
                             v.getInt16(o + 10, true), v.getInt16(o + 12, true), v.getInt16(o + 14, true), v.getInt16(o + 16, true),
                             v.getUint32(o + 18, true) | 0);
      }
    } else if (type === 2) {
      const pong = new Uint8Array(9); pong[0] = 3; pong.set(new Uint8Array(v.buffer, v.byteOffset + 1, 8), 1);
      sendRaw(pong);
    } else if (type === 3) {
      state.rtt = performance.now() - v.getFloat64(1, true);
      show();
    }
  }
  setInterval(() => {
    const p = new DataView(new ArrayBuffer(9)); p.setUint8(0, 2); p.setFloat64(1, performance.now(), true);
    sendRaw(new Uint8Array(p.buffer));
    sendInputs();   // (a lull in the game's frames: the last ones again)
  }, 1000);

  // --- the match and the data channel ----------------------------------------
  async function iceServers() {
    try { return (await (await fetch(httpServer + '/turn', { method: 'POST' })).json()).iceServers; }
    catch { return [{ urls: 'stun:stun.cloudflare.com:3478' }]; }
  }
  // one peer connection, however many messages ask for it while it is being made
  let peerMade = null, remoteSet = false;
  const earlyCandidates = [];
  function startPeer() { return (peerMade ??= makePeer()); }
  async function makePeer() {
    // ?ice=relay: TURN only (to try the relay between two machines that could connect directly)
    const pc = state.pc = new RTCPeerConnection({ iceServers: await iceServers(), iceTransportPolicy: q.get('ice') === 'relay' ? 'relay' : 'all' });
    const dc = state.dc = pc.createDataChannel('inputs', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';
    dc.onopen = async () => {
      clearTimeout(relayTimer);
      state.relay = false;
      const stats = await pc.getStats();
      let kind = 'direct';
      stats.forEach((r) => { if (r.type === 'local-candidate' && r.candidateType === 'relay' && [...stats.values()].some((p) => p.type === 'candidate-pair' && p.selected !== false && p.state === 'succeeded' && p.localCandidateId === r.id)) kind = 'relayed (TURN)'; });
      state.path = `connected, ${kind}`; show(); log(state.path);
      sendInputs();
    };
    dc.onmessage = (e) => receive(e.data);
    pc.onicecandidate = (e) => e.candidate && state.ws.send(JSON.stringify({ type: 'signal', candidate: e.candidate }));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') useRelay('the direct connection failed'); };
    if (state.role === 'host') {
      await pc.setLocalDescription(await pc.createOffer());
      state.ws.send(JSON.stringify({ type: 'signal', sdp: pc.localDescription }));
    }
    relayTimer = setTimeout(() => useRelay('no data channel after 6 s'), 6000);
  }
  function useRelay(why) {
    if (state.dc?.readyState === 'open' || state.relay) return;
    state.relay = true;
    state.path = 'connected through the server (relay)';
    log(`${state.path}: ${why}`); show();
    sendInputs();
  }
  async function addCandidate(c) {
    try { await state.pc.addIceCandidate(c); } catch (e) { log('ICE candidate refused: ' + e.message); }
  }
  async function onSignal(m) {
    await startPeer();
    if (m.sdp) {
      await state.pc.setRemoteDescription(m.sdp);
      remoteSet = true;
      if (m.sdp.type === 'offer') {
        await state.pc.setLocalDescription(await state.pc.createAnswer());
        state.ws.send(JSON.stringify({ type: 'signal', sdp: state.pc.localDescription }));
      }
      for (const c of earlyCandidates.splice(0)) await addCandidate(c);   // (those that came before it)
    } else if (m.candidate) {
      if (remoteSet) await addCandidate(m.candidate);
      else earlyCandidates.push(m.candidate);
    }
  }

  // the lobby's own messages (lobby.js: the host's saves for the guest) go through the same connection: it sends
  // with ttNetSend and hears every message, ours included, through ttNetListeners[type]
  self.ttNetSend = (obj) => { if (state.ws?.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; } return false; };
  const tell = (m) => { for (const fn of self.ttNetListeners?.[m.type] || []) try { fn(m); } catch (e) { log(`${m.type}: ${e.message}`); } };

  let signals = Promise.resolve();   // (signalling messages handled in the order they came)
  // (the match server is only for players with the disc: once pass.js has its pass)
  if (self.ttPass && !self.ttPass.held) state.path = 'waiting for the disc check';
  (self.ttPass?.ready ?? Promise.resolve()).then(() => connect(false));
  // (a connection the server dropped -- a deploy drops them all -- is made again, as a resume: the other page goes
  // on, where a player's return restarts the level; the inputs lost meanwhile come again with the next ones)
  let retry = 1000;
  function connect(resume) {
    const q = [self.ttPlayerId ? `player=${self.ttPlayerId()}` : '', resume ? 'resume=1' : ''].filter(Boolean).join('&');
    const ws = state.ws = new WebSocket(`${server}/match/${encodeURIComponent(code)}` + (q ? `?${q}` : ''));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return receive(e.data);   // relayed inputs
      const m = JSON.parse(e.data);
      queueMicrotask(() => tell(m));
      if (m.type === 'welcome') {
        retry = 1000;
        state.role = m.role;
        self.ttRememberRole?.(m.role);
        ready(() => Module._tt_np_set_role(m.role === 'guest' ? 1 : 0));
        state.path = m.peer ? 'connecting to the other player' : 'waiting for the other player';
        log(`joined as the ${m.role}`); show();
        if (m.peer) { peerIn = true; startPeer(); }
      } else if (m.type === 'peer-joined' && m.resume) {   // (their connection again, the game going on)
        peerIn = true; log('the other player\'s connection is back');
        if (state.relay) { state.path = 'connected through the server (relay)'; show(); }
        startPeer();
      } else if (m.type === 'peer-joined') {
        // they came back to a game under way here: start again together. (Not a game still at its start, waiting
        // for them -- the page that just restarted for them is one: it would send them round again.)
        if (Module.ttReady && newestSent > 30) return restartTogether();
        peerIn = true; state.path = 'connecting to the other player'; show(); startPeer();
      } else if (m.type === 'peer-left') {
        state.path = 'the other player left (when they open the link again, the level starts over for both)'; show(); log(state.path);
      } else if (m.type === 'replaced') {   // (this browser opened the game again elsewhere: that one plays)
        state.replaced = true; ws.close(); state.dc?.close(); state.pc?.close();
        state.path = 'this game was opened in another tab or window'; show(); log(state.path);
      } else if (m.type === 'too-fast') {   // (the server's speed limit: far above what a game sends; not made again)
        state.full = true;
        state.path = 'the server closed this connection: it was sending too much'; show(); log(state.path);
      } else if (m.type === 'full') {
        state.full = true;
        state.path = 'this game already has its two players'; show();
      } else if (m.type === 'signal') signals = signals.then(() => onSignal(m)).catch((e) => log('signalling: ' + e.message));
      else if (m.type === 'hash') { theirHashes.set(m.frame, m.h); compare(m.frame); }
    };
    ws.onclose = (e) => {
      if (state.replaced || state.full || state.ws !== ws) return;
      if (!state.relay || state.dc?.readyState !== 'open') { state.path = 'the server connection was lost: connecting again'; show(); }
      log(`the server connection closed (${e.code}): again in ${retry / 1000} s`);
      setTimeout(() => connect(true), retry);
      retry = Math.min(retry * 2, 10000);
    };
  }
  show();
})();
