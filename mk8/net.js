// Online rooms over the mk8-server WebSocket (docs/NETWORK.md §5). The protocol, room state and
// lockstep driver live in wasm (`NetClient`, crate mk8-net); this module owns the socket,
// shuttles bytes, reconnects (the client rejoins its room automatically) and fans out events.
//
// Server: ws(s)://<page host>/ws, or `?ws=ws://host:port/ws` (development: page and romfs served
// from another origin, e.g. tools/web-online-smoke.mjs).
//
// Interface:
//   connect(profile)            open the socket (idempotent); profile = { name, combo: [d, b, t, g] }
//   on(type, cb)                events of NetClient.next_event (welcome joined left kicked room
//                               face race_start race_ended desync error) + 'connection' {connected}
//   createRoom() / joinRoom(code) / leaveRoom()
//   setProfile(profile) / setReady(bool) / setFace(Uint8Array | null)
//   setSettings(settings) / startRace(settings)   host; settings JSON as in NETWORK.md
//   kick(player)                host: remove that player from the room (they get 'kicked')
//   raceDone() / endRace()
//   racing()                    a race (lockstep) is running for this client
//   tick(sx, sy, buttons, maxSteps) -> Uint8Array   one 60 Hz tick (flat sim commands for app.step_net)
//   reportChecksum(frame, hash) after simulating a frame with NetClient.checksum_due(frame)
//   face(player) -> Blob | null, room() / race() (parsed JSON), myId(), buffered(), flush()
//   maxPlayers()                the server's cap on a room's grid size ("Racers"; 2..=255, 12 for
//                               a build without the setting), also in the 'welcome' event
//   sendSignal(to, json) / on('signal', {from, data})   WebRTC signaling for www/live.js
//   httpUrl(path)               URL on the room server (e.g. /ice.json)
// The wasm glue is NOT imported here: main.js initialises one module instance and publishes it
// as window.__mk8Pkg. A second import (e.g. a stale cached mk8_web.js) would be a separate,
// uninitialised instance ("wasm is undefined").
const pkg = () => {
  const m = window.__mk8Pkg;
  if (!m || !m.NetClient) throw new Error('the game module is not initialised yet (reload the page)');
  return m;
};
const NetClient = new Proxy(function NetClient() {}, { construct: (_t, args) => new (pkg().NetClient)(...args) });
const net_parse_room_code = (s) => pkg().net_parse_room_code(s);

let client = null;
let ws = null;
let everOpen = false;
let connected = false;
let closedByUs = false;
const handlers = new Map();
const params = new URLSearchParams(location.search);

function wsUrl() {
  const o = params.get('ws');
  if (o) return o;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function emit(type, ev) { for (const cb of handlers.get(type) || []) { try { cb(ev); } catch (e) { console.error(e); } } }
export function on(type, cb) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(cb); }

export function flush() {
  // While the socket is (re)connecting, messages stay queued in the client (on reconnect
  // `reconnected()` replaces them with Hello + Rejoin).
  if (!client || !ws || ws.readyState !== 1) return;
  for (let m; (m = client.next_outgoing()) !== undefined;) ws.send(m);
}
function drain() {
  for (let j; (j = client.next_event()) !== undefined;) {
    let ev;
    try { ev = JSON.parse(j); } catch { continue; }
    emit(ev.type, ev);
  }
}

/** Connection diagnostics for the lobby status line and `window.__mk8Net`. */
const diag = { errors: 0, closes: 0, failedOpens: 0, lastClose: null, url: null };
window.__mk8Net = diag;

function open() {
  closedByUs = false;
  diag.url = wsUrl();
  let sock;
  try { sock = new WebSocket(wsUrl()); } catch (e) { emit('error', { code: 'connect', message: String(e.message || e) }); return; }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    if (everOpen) client.reconnected(); // Hello + Rejoin (same player, same kart)
    everOpen = true;
    connected = true;
    emit('connection', { connected: true });
    flush();
  };
  sock.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    try { client.on_message(new Uint8Array(e.data)); } catch (err) { console.error('net: bad message', err); }
    flush();
    drain();
  };
  sock.onerror = () => { diag.errors++; };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    const was = connected;
    connected = false;
    diag.lastClose = { code: e.code, reason: e.reason || '', clean: e.wasClean, at: Date.now() };
    diag.closes++;
    if (!was) diag.failedOpens++;
    console.info(`net: socket closed (code ${e.code}${e.reason ? ', ' + e.reason : ''}); ${closedByUs ? 'closed by us' : 'reconnecting in 1 s'}`);
    if (was || !closedByUs) emit('connection', { connected: false, code: e.code, reason: e.reason || '' });
    if (!closedByUs) setTimeout(open, 1000);
  };
}

/** Open the connection once (later calls only update the profile). */
export function connect(profile) {
  if (!client) {
    const c = profile.combo;
    client = new NetClient(profile.name, c[0], c[1], c[2], c[3]);
    open();
  } else setProfile(profile);
}
export const isConnected = () => connected;
export const started = () => client !== null;

export function parseCode(s) { return net_parse_room_code(String(s || '')) ?? null; }
export function createRoom() { client.create_room(); flush(); }
export function joinRoom(code) {
  const c = parseCode(code);
  if (!c) throw new Error('that is not a room code (6 letters / digits)');
  client.join_room(c); flush();
}
export function leaveRoom() { if (client) { client.leave_room(); flush(); } }
export function setProfile(p) { if (client) { const c = p.combo; client.set_profile(p.name, c[0], c[1], c[2], c[3]); flush(); } }
export function setReady(r) { client.set_ready(!!r); flush(); }
export function setFace(bytes) { if (!client) return; if (bytes) client.set_face(bytes); else client.clear_face(); flush(); }
export function setSettings(s) { client.set_settings(JSON.stringify(s)); flush(); }
export function startRace(s) { if (s) client.set_settings(JSON.stringify(s)); client.start_race(); flush(); }
export function endRace() { client.end_race(); flush(); }
/** Host only: remove that player from the room (the lobby only). */
export function kick(player) { if (client) { client.kick(player); flush(); } }
/** WebRTC signaling payload (string, <= 16 KB) for room member `to`. */
export function sendSignal(to, data) { if (client) { client.send_signal(to, data); flush(); } }
/** HTTP(S) URL on the room server (e.g. '/ice.json'). */
export function httpUrl(path) { const u = new URL(wsUrl()); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'; u.pathname = path; u.search = ''; return u.href; }
export function raceDone() { client.race_done(); flush(); }

export function racing() { return !!client && client.racing(); }
export function tick(sx, sy, buttons, maxSteps) { return client.tick(sx, sy, buttons, maxSteps); }
export function reportChecksum(frame, hash) { client.report_checksum(frame, hash); }
export function buffered() { return client ? client.buffered() : 0; }
export function raceBytes() { return client ? client.race_bytes() : undefined; }
export function myId() { return client ? client.my_id() : undefined; }
/** The server's grid-size cap (from Welcome; 12 when this build predates the setting). */
export function maxPlayers() { return client && typeof client.max_players === 'function' ? client.max_players() : 12; }
export function room() { const j = client && client.room_json(); return j ? JSON.parse(j) : null; }
export function race() { const j = client && client.race_json(); return j ? JSON.parse(j) : null; }
export function face(player) {
  const b = client && client.face(player);
  return b ? new Blob([b], { type: client.face_mime(player) || 'image/jpeg' }) : null;
}
