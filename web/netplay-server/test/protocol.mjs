// (web port) The match protocol against a running server (npm run dev):
//   node test/protocol.mjs [ws://localhost:8787]
// Two players get host and guest, a third is refused, signalling and binary
// packets reach the other player, and leaving is announced.
const base = process.argv[2] || 'ws://localhost:8787';
const code = 'test' + Math.floor(Math.random() * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function join(name) {
  const ws = new WebSocket(`${base}/match/${code}`);
  ws.binaryType = 'arraybuffer';
  const got = [];
  ws.onmessage = (e) => got.push(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data));
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  return { name, ws, got, closed, open: new Promise((r) => (ws.onopen = r)) };
}
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };

const a = join('a'); await a.open; await sleep(100);
const b = join('b'); await b.open; await sleep(200);
check(a.got[0]?.type === 'welcome' && a.got[0].role === 'host' && !a.got[0].peer, 'first player is the host, alone');
check(b.got[0]?.type === 'welcome' && b.got[0].role === 'guest' && b.got[0].peer, 'second player is the guest, with a peer');
check(a.got.some((m) => m.type === 'peer-joined'), 'the host hears the guest join');
const c = join('c');
check(await Promise.race([c.closed, sleep(2000).then(() => 'open')]) === 4000, 'a third player is refused (4000)');
a.ws.send(JSON.stringify({ type: 'signal', sdp: 'offer-from-a' }));
b.ws.send(new Uint8Array([7, 1, 2, 3]));
await sleep(300);
check(b.got.some((m) => m.type === 'signal' && m.sdp === 'offer-from-a'), 'signalling reaches the other player');
check(a.got.some((m) => m instanceof Uint8Array && m[0] === 7 && m.length === 4), 'a binary packet is relayed as is');
check(!a.got.some((m) => m.sdp === 'offer-from-a'), 'nothing echoes back to the sender');
b.ws.close(); await sleep(300);
check(a.got.some((m) => m.type === 'peer-left'), 'the host hears the guest leave');
const t = await (await fetch(base.replace(/^ws/, 'http') + '/turn', { method: 'POST' })).json();
check(Array.isArray(t.iceServers) && t.iceServers.length > 0, `ICE servers (TURN ${t.turn ? 'on' : 'not configured: STUN only'})`);
a.ws.close();
process.exit(failed ? 1 : 0);
