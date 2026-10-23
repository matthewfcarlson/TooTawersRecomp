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

// a created game: settings kept, the creator the host, roles kept across a reconnect, a third player refused
const http = base.replace(/^ws/, 'http'), g = 'game' + Math.floor(Math.random() * 1e6);
const pid = (n) => `player-${n}-${g}`;
const settings = { level: '01WEAT1', p1: 'gimli', p2: 'legolas' };
let r = await fetch(`${http}/match/${g}`, { method: 'POST', body: JSON.stringify({ player: pid('h'), settings }) });
check(r.status === 201, 'a game is made (201)');
r = await fetch(`${http}/match/${g}`, { method: 'POST', body: JSON.stringify({ player: pid('x'), settings }) });
check(r.status === 409, 'its code is then taken (409)');
const info = await (await fetch(`${http}/match/${g}`)).json();
check(info.settings?.p1 === 'gimli' && info.settings?.level === '01WEAT1', 'anyone can read its settings');
check((await fetch(`${http}/match/nosuch${g}`)).status === 404, 'an unknown game is a 404');
r = await fetch(`${http}/match/${g}x`, { method: 'POST', body: JSON.stringify({ player: pid('h'), settings: { ...settings, level: '../x' } }) });
check(r.status === 400, 'bad settings are refused');
const joinAs = (who) => { const ws = new WebSocket(`${base}/match/${g}?player=${pid(who)}`); ws.binaryType = 'arraybuffer';
  const got = []; ws.onmessage = (e) => got.push(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
  return { ws, got, closed: new Promise((res) => (ws.onclose = (e) => res(e.code))), open: new Promise((res) => (ws.onopen = res)) }; };
const guest = joinAs('guest'); await guest.open; await sleep(200);
check(guest.got[0]?.role === 'guest' && guest.got[0]?.settings?.p2 === 'legolas', 'a first-time joiner of a made game is the guest, with its settings');
const host = joinAs('h'); await host.open; await sleep(200);
check(host.got[0]?.role === 'host' && host.got[0]?.peer === true, 'the maker is the host, even arriving second');
check(guest.got.some((m) => m.type === 'peer-joined'), 'the guest hears the host arrive');
const host2 = joinAs('h'); await host2.open; await sleep(300);
check(host2.got[0]?.role === 'host', 'the host reconnecting (a reload) is the host again');
check(host.got.some((m) => m.type === 'replaced'), 'its old connection is told it was replaced');
guest.ws.send(JSON.stringify({ type: 'signal', sdp: 'after-the-return' })); await sleep(300);
check(host2.got.some((m) => m.sdp === 'after-the-return') && !host.got.some((m) => m.sdp === 'after-the-return'), 'messages go to the new connection only');
host.ws.close(); await sleep(300);
check(guest.got.filter((m) => m.type === 'peer-joined').length === 2 && !guest.got.some((m) => m.type === 'peer-left'), 'the guest hears a return, not a departure');
const third = joinAs('stranger');
check(await Promise.race([third.closed, sleep(2000).then(() => 'open')]) === 4000, 'a third player is refused (4000)');
guest.ws.close(); host2.ws.close();
process.exit(failed ? 1 : 0);
