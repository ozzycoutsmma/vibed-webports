// Live camera face (opt-in) and the WebRTC links for proximity voice chat (www/voice.js).
//
// Camera: the local camera drives this player's kart face texture, and in an online room it is
// streamed to the other members peer-to-peer (WebRTC, ~256x256 at 15 fps) so their copy of
// your kart shows you driving. Voice: while the mic is on (www/voice.js -> setMicTrack) the
// same links also carry it (Opus, <= 32 kbps). Signaling goes through the room's WebSocket
// (NetClient.send_signal, relayed by the server to members of the same room only, never
// stored); ICE servers come from the server's /ice.json (public STUN by default, TURN if
// configured). Without the camera (or when a peer's stream fails) the still photo is used.
//
// One one-directional RTCPeerConnection per (sender, receiver) pair: "out:<id>" carries my
// camera and / or mic to member <id>, "in:<id>" receives member <id>'s. It exists while the
// sender has the camera or the mic on. Messages (JSON):
//   {t:'offer'|'answer', sdp, g}  g = id of the sender's connection: an offer with the g of
//                                 the existing "in" link renegotiates it (track added), any
//                                 other offer replaces the link (older pages send no g)
//   {t:'ice', d:'s'|'r', c}       (d = which side sent the candidate)
//   {t:'cam', on}                 the sender's camera went off / on while the link stays (mic)
//   {t:'bye'}                     the sender's camera and mic are both off: link closed
// Turning a track off keeps its transceiver (replaceTrack(null), no renegotiation); turning it
// on again reuses it, so only the first camera / mic track of a link renegotiates.
import * as net from './net.js';

const FPS = 15;
const SIZE = 256;
const VOICE_BITRATE = 32000; // Opus, speech
let app = null;
let hooks = null; // { commitStill(canvas), localStill() -> Uint8Array|null, remoteStill(id) -> Uint8Array|null, changed(live) }
let stream = null; // local camera
let micTrack = null; // local mic (www/voice.js)
let onAudio = () => {}; // (id, MediaStreamTrack | null): a member's voice track arrived / ended
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
const peers = new Map(); // key -> { pc, id, dir, g, video?, audio?, camOff?, busy?, again?, retries }
let ice = null;
const canvas = document.createElement('canvas');
canvas.width = SIZE; canvas.height = SIZE;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let timer = null;
window.__mk8LiveFrames = { local: 0, remote: {} };

export function initLive(theApp, theHooks) {
  app = theApp;
  hooks = theHooks;
  net.on('signal', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onSignal(ev.from, m).catch((e) => console.warn('live: signal', e)); });
  net.on('room', (ev) => syncPeers(ev.room));
  net.on('left', () => closeAll());
  net.on('connection', ({ connected }) => { if (!connected) closeAll(); });
}

export const isLive = () => stream !== null;

/** Voice (www/voice.js): `cb(id, track | null)` when member `id`'s voice track arrives / ends. */
export function onRemoteAudio(cb) { onAudio = cb; }

/** Voice (www/voice.js): send this mic track to the room's members (null = mic off). Toggling
 *  `track.enabled` (push-to-talk) needs no call. */
export function setMicTrack(track) {
  if (track === micTrack) return;
  micTrack = track;
  updateOut();
}

/** Turn the camera on (true) or off. Resolves to the new state. */
export async function setLive(on) {
  if (on && !stream) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: FPS, max: 30 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    // A still from the first frame: puts the face decal on the kart, is sent as the photo
    // (everyone's fallback) and stays when the camera goes off.
    if (drawSquare(video)) hooks.commitStill(canvas);
    startPump();
    updateOut();
  } else if (!on && stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
    updateOut();
    const still = hooks.localStill();
    if (still) app.update_face_frame(-1, still.slice());
  }
  hooks.changed(isLive());
  return isLive();
}

/** Centre-square crop of a video into the 256x256 canvas; false before the first frame. */
function drawSquare(v) {
  const w = v.videoWidth; const h = v.videoHeight;
  if (!w || !h || v.readyState < 2) return false;
  const s = Math.min(w, h);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(v, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SIZE, SIZE);
  return true;
}
const pixels = () => new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);

function startPump() {
  if (timer) return;
  timer = setInterval(() => {
    const racing = app.race_phase() !== '';
    if (stream && racing && drawSquare(video) && app.update_face_frame(-1, pixels())) window.__mk8LiveFrames.local++;
    for (const p of peers.values()) {
      if (p.dir !== 'in' || !p.video || p.camOff || !racing) continue;
      if (drawSquare(p.video) && app.update_face_frame(p.id, pixels())) {
        window.__mk8LiveFrames.remote[p.id] = (window.__mk8LiveFrames.remote[p.id] || 0) + 1;
      }
    }
    if (!stream && ![...peers.values()].some((p) => p.dir === 'in' && p.video)) { clearInterval(timer); timer = null; }
  }, 1000 / FPS);
}

async function iceServers() {
  if (ice) return ice;
  ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const r = await fetch(net.httpUrl('/ice.json'));
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.iceServers)) ice = j.iceServers; }
  } catch { /* default STUN */ }
  return ice;
}

function send(id, msg) { try { net.sendSignal(id, JSON.stringify(msg)); } catch (e) { console.warn('live: send', e); } }

/** Close a link (and tell voice when a received voice ends). */
function drop(key) {
  const p = peers.get(key);
  if (!p) return;
  peers.delete(key);
  p.pc.close();
  if (p.dir === 'in' && p.audio) { p.audio = null; onAudio(p.id, null); }
}

async function newPc(id, dir, g) {
  const key = `${dir}:${id}`;
  drop(key);
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const p = { pc, id, dir, g, video: null, audio: null, camOff: false, busy: false, again: false, retries: 0 };
  drop(key); // a concurrent call may have created one while awaiting the ICE list
  peers.set(key, p);
  pc.onicecandidate = (e) => { if (e.candidate) send(id, { t: 'ice', d: dir === 'out' ? 's' : 'r', c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
    if (peers.get(key) !== p) return;
    drop(key);
    if (dir === 'in') fallback(id);
    if (pc.connectionState === 'failed') {
      console.warn(`live: link ${key} failed (a TURN server may be needed); using the still photo`);
      // My side: try again a few times while the member is still here.
      if (dir === 'out' && p.retries < 3) setTimeout(() => { const r = net.room(); if (r && wantOut() && !peers.has(key) && r.players.some((m) => m.id === id && m.connected)) offerTo(id, p.retries + 1).catch((e) => console.warn('live: offer', e)); }, 2000);
    }
  };
  return p;
}

/** A peer's stream ended or failed: their still photo again. */
function fallback(id) {
  const still = hooks.remoteStill(id);
  if (still) app.update_face_frame(id, still.slice());
}

const wantOut = () => stream !== null || micTrack !== null;
const camTrack = () => (stream ? stream.getVideoTracks()[0] || null : null);

/** Put the current camera / mic tracks on an out link; true when it needs a new offer. */
function attachTracks(p) {
  let renegotiate = false;
  const kinds = [['video', camTrack()], ['audio', micTrack]];
  for (const [kind, track] of kinds) {
    const tr = p.pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
    if (tr) {
      if (tr.sender.track !== track) tr.sender.replaceTrack(track).catch((e) => console.warn('live: replaceTrack', e));
    } else if (track) {
      // One stream per link (older pages play e.streams[0] in their face video element).
      p.pc.addTrack(track, p.ms);
      renegotiate = true;
    }
  }
  return renegotiate;
}

/** Offer (again) on an out link; serialised (one offer / answer round at a time). */
async function negotiate(p) {
  if (p.busy) { p.again = true; return; }
  p.busy = true;
  p.again = false;
  try {
    await p.pc.setLocalDescription(await p.pc.createOffer());
  } catch (e) { p.busy = false; throw e; }
  send(p.id, { t: 'offer', sdp: p.pc.localDescription.sdp, g: p.g });
}

/** Opus at speech bitrate on the out link's mic sender. */
async function limitAudio(p) {
  for (const s of p.pc.getSenders()) {
    if (!s.track || s.track.kind !== 'audio') continue;
    const params = s.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    if (params.encodings[0].maxBitrate === VOICE_BITRATE) continue;
    params.encodings[0].maxBitrate = VOICE_BITRATE;
    await s.setParameters(params).catch(() => {});
  }
}

const offering = new Set(); // members an out link is being created for
async function offerTo(id, retries = 0) {
  if (offering.has(id)) return;
  offering.add(id);
  let p;
  try { p = await newPc(id, 'out', Math.random().toString(36).slice(2, 10)); } finally { offering.delete(id); }
  if (!wantOut()) { drop(`out:${id}`); return; }
  p.retries = retries;
  p.ms = new MediaStream();
  attachTracks(p);
  await negotiate(p);
}

/** Camera / mic changed: update every out link (close them all when both are off). */
function updateOut() {
  if (!wantOut()) {
    for (const [key, p] of [...peers]) if (p.dir === 'out') { send(p.id, { t: 'bye' }); drop(key); }
    return;
  }
  for (const p of peers.values()) {
    if (p.dir !== 'out') continue;
    const camOn = camTrack() !== null;
    if (p.camOn !== undefined && p.camOn !== camOn) send(p.id, { t: 'cam', on: camOn });
    p.camOn = camOn;
    if (attachTracks(p)) negotiate(p).catch((e) => console.warn('live: renegotiate', e));
    else limitAudio(p);
  }
  const r = net.room();
  if (r) syncPeers(r);
}

async function onSignal(from, m) {
  if (m.t === 'offer') {
    const old = peers.get(`in:${from}`);
    const p = old && m.g && old.g === m.g ? old : await newPc(from, 'in', m.g);
    p.pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        p.audio = e.track;
        e.track.addEventListener('ended', () => { if (p.audio === e.track) { p.audio = null; onAudio(from, null); } });
        onAudio(from, e.track);
        return;
      }
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.srcObject = new MediaStream([e.track]);
      v.play().catch(() => {});
      p.video = v;
      p.camOff = false;
      startPump();
    };
    await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    send(from, { t: 'answer', sdp: p.pc.localDescription.sdp, g: m.g });
  } else if (m.t === 'answer') {
    const p = peers.get(`out:${from}`);
    if (!p || (m.g && p.g !== m.g) || p.pc.signalingState !== 'have-local-offer') return;
    await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    p.busy = false;
    p.camOn = camTrack() !== null;
    await limitAudio(p);
    if (p.again && peers.get(`out:${from}`) === p) await negotiate(p);
  } else if (m.t === 'ice') {
    const p = peers.get(`${m.d === 's' ? 'in' : 'out'}:${from}`);
    if (p && m.c) await p.pc.addIceCandidate(m.c).catch(() => {});
  } else if (m.t === 'cam') {
    const p = peers.get(`in:${from}`);
    if (p) { p.camOff = !m.on; if (!m.on) fallback(from); else startPump(); }
  } else if (m.t === 'bye') {
    drop(`in:${from}`);
    fallback(from);
  }
}

/** Room changed: offer my camera / mic to new members, drop links to members who left. */
function syncPeers(room) {
  const me = net.myId();
  const here = new Set(room.players.filter((p) => p.connected).map((p) => p.id));
  for (const [key, p] of [...peers]) if (!here.has(p.id)) drop(key);
  if (!wantOut()) return;
  for (const id of here) {
    if (id !== me && !peers.has(`out:${id}`)) offerTo(id).catch((e) => console.warn('live: offer', e));
  }
}

function closeAll() {
  for (const key of [...peers.keys()]) drop(key);
}
