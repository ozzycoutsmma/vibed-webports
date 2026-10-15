// Proximity voice chat for online rooms (docs/VOICE.md).
//
// "Voice chat: off / push-to-talk / open mic" in the room page; joining a room turns the mic on
// in push-to-talk unless the player picked otherwise (remembered in localStorage). The mic
// (getUserMedia with echo cancellation, noise suppression, auto gain) goes peer-to-peer to the
// room's members over the WebRTC links of www/live.js (Opus <= 32 kbps); the server only relays
// the signaling and never sees or stores the audio. Push-to-talk: hold V (keyboard) or press
// the right stick (R3, Gamepad API standard mapping button 11; unused by the game).
// While the mic sends, a "MIC LIVE" badge shows (click = voice chat off).
//
// Playback, per remote member: remote track -> MediaStreamAudioSourceNode -> mono -> left /
// right GainNode -> ChannelMerger -> mute GainNode -> voice bus GainNode -> the game audio's
// chat input (attachAudio, www/audio.js: the sound engine limits the chat, ducks the game while
// someone speaks and limits the sum so nothing clips; the chat volume 0..1 is applied there) or,
// without game audio, this module's own AudioContext destination. Every 33 ms the left / right
// gains follow app.voice_spatial_all() (crates/mk8-web/src/voice.rs: distance falloff between
// the local kart and the speaker's kart, full within 300 units, -26 dB at 2500, silent from
// 3500, plus an equal-power pan from the race camera's heading; full volume and centred in the
// lobby / menus, for spectators and finished players), smoothed with setTargetAtTime (0.08 s,
// never a click). The "Proximity falloff" checkbox (default on, remembered) turns the whole
// spatialization off: everyone at full volume, centred. Read-only: nothing here touches the
// lockstep simulation. Without app.voice_spatial_all (older wasm) everyone plays at full volume.
//
// Interface (home.js): initVoice(app), decoratePlayer(li, id, isMe) for the room list.
// Sound integration: attachAudio({ context, destination, setVolume?, onSpeaking? }),
// setVolume(v), getVolume() (0..1), setFalloff(on), getFalloff().
// Tests: window.__mk8Voice.
import * as net from './net.js';
import * as live from './live.js';

const SMOOTH = 0.08; // s, setTargetAtTime time constant (no zipper noise, no clicks)
const SPEAK_RMS = 0.01; // analyser RMS above which a player counts as speaking
const SPEAK_HOLD = 300; // ms
const PTT_KEY = 'KeyV';
const PTT_PAD_BUTTON = 11; // R3 (standard mapping)
const SAVE = 'mk8.voice';
const MAX_VOLUME = 1; // the chat path normalises voices; more only clipped the game mix
const DEFAULT_VOLUME = 0.8;
const FULL = [1, 0, 1, 1, 0]; // [gain, pan, left, right, distance]: full volume, centred

let app = null;
let mode = 'off'; // 'off' | 'ptt' | 'open'
let preferred = 'ptt'; // what joining a room turns on: push-to-talk unless the player picked otherwise (remembered)
let mic = null; // MediaStream
let micAnalyser = null;
let pttKey = false;
let pttPad = false;
let ctx = null;
let ownCtx = true;
let out = null; // where the voice bus goes (destination or the sound engine's node)
let bus = null; // master voice volume
let sink = null; // silent sink keeping analysers pulled
let hook = null; // attachAudio options: { setVolume?, onSpeaking? }
let speakingCount = -1; // last count reported through hook.onSpeaking
let volume = DEFAULT_VOLUME;
let falloff = true; // distance falloff + pan during races (off = everyone at full volume)
const remotes = new Map(); // id -> { track, el, nodes, rms, speakingUntil }
const muted = new Set();
const status = { mode: 'off', sending: false, micRms: 0, remote: {}, spatial: false, falloff: true };
window.__mk8Voice = status;

try {
  const saved = JSON.parse(localStorage.getItem(SAVE) || '{}');
  const v = Number(saved.volume);
  if (Number.isFinite(v)) volume = Math.max(0, Math.min(MAX_VOLUME, v));
  if (saved.falloff === false) falloff = false;
  if (['off', 'ptt', 'open'].includes(saved.mode)) preferred = saved.mode;
} catch { /* private mode */ }
status.falloff = falloff;
function save() { try { localStorage.setItem(SAVE, JSON.stringify({ volume, falloff, mode: preferred })); } catch { /* private mode */ } }

const STYLE = `
#voice-box { margin: 6px 0; }
#voice-box .row { margin: 4px 0; }
#voice-box input[type=range] { width: 160px; }
#voice-indicator { position: fixed; top: 46px; right: 10px; z-index: 30; padding: 6px 12px; background: #555; color: #fff;
  font: 800 14px system-ui, sans-serif; border: 2px solid #fff; border-radius: 16px; cursor: pointer; }
#voice-indicator.live { background: #d00; animation: livepulse 1.2s infinite; }
#voice-indicator[hidden] { display: none; }
.voice-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #999; margin: 0 6px; vertical-align: middle; opacity: 0.35; }
.voice-dot.on { opacity: 1; }
.voice-dot.speaking { background: #2c2; opacity: 1; box-shadow: 0 0 6px #2c2; }
.voice-dot.muted { background: #c22; opacity: 1; }
#voice-karts { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
#voice-karts span { position: fixed; transform: translate(-50%, -100%); margin-top: -16px; font: 800 13px system-ui, sans-serif;
  color: #fff; background: #2a2; border: 2px solid #fff; border-radius: 10px; padding: 0 6px; }
`;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

export function initVoice(theApp) {
  app = theApp;
  document.head.append(el('style', { textContent: STYLE }));

  // ---- room page box, mounted after the player list ----
  const sel = el('select', { id: 'voice-mode' },
    el('option', { value: 'off', textContent: 'off' }),
    el('option', { value: 'ptt', textContent: 'push-to-talk (hold V / right stick)' }),
    el('option', { value: 'open', textContent: 'open mic' }));
  const vol = el('input', { id: 'voice-volume', type: 'range', min: '0', max: String(MAX_VOLUME), step: '0.01', value: String(volume) });
  const prox = el('input', { id: 'voice-falloff', type: 'checkbox', checked: falloff });
  const box = el('fieldset', { id: 'voice-box' }, el('legend', { textContent: 'Voice chat' }),
    el('div', { className: 'row' }, el('label', { htmlFor: 'voice-mode', textContent: 'Voice chat' }), sel),
    el('div', { className: 'row' }, el('label', { htmlFor: 'voice-volume', textContent: 'Voice volume' }), vol),
    el('div', { className: 'row' }, prox, el('label', { htmlFor: 'voice-falloff', textContent: 'Proximity falloff', title: 'During a race, a player gets quieter the farther their kart is from yours (full volume within 3 kart lengths, silent beyond 35). Off: everyone at full volume.' })),
    el('p', { className: 'note', textContent: 'Voice is sent directly to the players in your room while your mic is on (never through or stored on the server). During a race, players sound quieter the farther their kart is from yours.' }),
    el('p', { className: 'err', id: 'voice-err' }));
  // Mounted in the room page's Options drawer (#voice-mount); older pages: after the player list.
  const mount = $('voice-mount');
  const anchor = $('room-players');
  if (mount) mount.append(box); else if (anchor) anchor.after(box); else document.body.append(box);
  sel.addEventListener('change', () => { preferred = sel.value; save(); setMode(sel.value); });
  vol.addEventListener('input', () => setVolume(Number(vol.value)));
  prox.addEventListener('change', () => setFalloff(prox.checked));

  const badge = el('button', { id: 'voice-indicator', hidden: true, title: 'Your microphone is sent to the players in your room. Click to turn voice chat off.' });
  badge.addEventListener('click', () => setMode('off'));
  document.body.append(badge);
  document.body.append(el('div', { id: 'voice-karts' }));

  // ---- push-to-talk ----
  const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
  window.addEventListener('keydown', (e) => { if (e.code === PTT_KEY && !typing(e.target)) pttKey = true; });
  window.addEventListener('keyup', (e) => { if (e.code === PTT_KEY) pttKey = false; });
  window.addEventListener('blur', () => { pttKey = false; });
  // Autoplay policy: a context made before any gesture starts suspended.
  const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);

  live.onRemoteAudio((id, track) => (track ? addRemote(id, track) : removeRemote(id)));
  // Joining a room turns the mic on in the remembered mode (push-to-talk by default: the
  // browser asks for the microphone once); leaving turns it off, the preference stays.
  net.on('joined', () => { if (preferred !== 'off' && mode === 'off') setMode(preferred); });
  net.on('left', () => { setMode('off'); for (const id of [...remotes.keys()]) removeRemote(id); });

  setInterval(tick, 33);
}

/** off / ptt / open. Resolves when the mic is on (or off). */
export async function setMode(m) {
  if (!['off', 'ptt', 'open'].includes(m)) m = 'off';
  const err = $('voice-err');
  if (err) err.textContent = '';
  mode = m;
  if (m !== 'off' && !mic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
      mode = 'off';
      if (err) err.textContent = `microphone unavailable: ${e.message || e}`;
    }
    if (mode === 'off' && mic) { for (const t of mic.getTracks()) t.stop(); mic = null; }
    if (mic) {
      ensureCtx();
      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      ctx.createMediaStreamSource(mic).connect(micAnalyser);
      micAnalyser.connect(sink);
    }
  } else if (m === 'off' && mic) {
    for (const t of mic.getTracks()) t.stop();
    mic = null;
    if (micAnalyser) { micAnalyser.disconnect(); micAnalyser = null; }
  }
  const sel = $('voice-mode');
  if (sel) sel.value = mode;
  applyMic();
  live.setMicTrack(mic ? mic.getAudioTracks()[0] || null : null);
  return mode;
}
export const getMode = () => mode;

/** Voice chat volume (0..1): applied by the game audio's chat path when attached, else here. */
export function setVolume(v) {
  volume = Math.max(0, Math.min(MAX_VOLUME, Number(v) || 0));
  if (hook && typeof hook.setVolume === 'function') hook.setVolume(volume);
  else if (bus) bus.gain.setTargetAtTime(volume, ctx.currentTime, SMOOTH);
  save();
  const s = $('voice-volume');
  if (s && Number(s.value) !== volume) s.value = String(volume);
}
export const getVolume = () => volume;

/** Distance falloff (and pan) during races on / off; off = everyone at full volume, centred.
 *  Takes effect on the next tick (the gains glide over SMOOTH seconds). Remembered. */
export function setFalloff(on) {
  falloff = !!on;
  status.falloff = falloff;
  save();
  const c = $('voice-falloff');
  if (c && c.checked !== falloff) c.checked = falloff;
}
export const getFalloff = () => falloff;

/** Sound integration hook (docs/VOICE.md §4): play the voices in this AudioContext (the game's
 *  one: one context, one output stream) into `destination` (the game audio's chat input).
 *  `setVolume(v)` takes over the chat volume (the bus then stays at 1), `onSpeaking(n)` gets the
 *  number of unmuted remote players speaking whenever it changes. Existing voices move over. */
export function attachAudio({ context, destination, setVolume: setVol, onSpeaking }) {
  const ids = [...remotes.entries()].map(([id, r]) => [id, r.track]);
  for (const [id] of ids) removeRemote(id, true);
  if (micAnalyser) { micAnalyser.disconnect(); micAnalyser = null; }
  if (ctx && ownCtx) ctx.close().catch(() => {});
  ctx = context; ownCtx = false; out = destination || context.destination; bus = null; sink = null;
  hook = { setVolume: typeof setVol === 'function' ? setVol : null, onSpeaking: typeof onSpeaking === 'function' ? onSpeaking : null };
  speakingCount = -1;
  ensureCtx();
  if (hook.setVolume) hook.setVolume(volume);
  if (mic) { micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 512; ctx.createMediaStreamSource(mic).connect(micAnalyser); micAnalyser.connect(sink); }
  for (const [id, track] of ids) addRemote(id, track);
}

function ensureCtx() {
  if (!ctx) { ctx = new AudioContext(); ownCtx = true; out = ctx.destination; }
  if (!bus) {
    bus = ctx.createGain();
    bus.gain.value = hook && hook.setVolume ? 1 : volume;
    bus.connect(out);
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/** Is the mic sending right now (open mic, or push-to-talk held)? */
const sending = () => !!mic && (mode === 'open' || (mode === 'ptt' && (pttKey || pttPad)));
function applyMic() {
  const on = sending();
  if (mic) for (const t of mic.getAudioTracks()) t.enabled = on;
  const b = $('voice-indicator');
  if (b) {
    b.hidden = !mic;
    b.classList.toggle('live', on);
    b.textContent = on ? '● MIC LIVE - tap to turn off' : 'mic: hold V / right stick to talk';
  }
  status.mode = mode;
  status.sending = on;
}

function addRemote(id, track) {
  removeRemote(id, true);
  ensureCtx();
  const stream = new MediaStream([track]);
  // Chrome only feeds a remote WebRTC track into WebAudio while a media element plays it.
  const audioEl = new Audio();
  audioEl.muted = true;
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const mono = ctx.createGain();
  mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const gl = ctx.createGain(); const gr = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const mute = ctx.createGain();
  mute.gain.value = muted.has(id) ? 0 : 1;
  src.connect(mono);
  mono.connect(analyser); analyser.connect(sink);
  mono.connect(gl); mono.connect(gr);
  gl.connect(merger, 0, 0); gr.connect(merger, 0, 1);
  merger.connect(mute); mute.connect(bus);
  remotes.set(id, { track, el: audioEl, nodes: { src, mono, analyser, gl, gr, merger, mute }, buf: new Float32Array(analyser.fftSize), rms: 0, speakingUntil: 0, spatial: FULL });
}

function removeRemote(id, quiet) {
  const r = remotes.get(id);
  if (!r) return;
  remotes.delete(id);
  for (const n of Object.values(r.nodes)) { try { n.disconnect(); } catch { /* already */ } }
  r.el.srcObject = null;
  if (!quiet) delete status.remote[id];
}

const rmsOf = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
const micBuf = new Float32Array(512);

function tick() {
  // Push-to-talk on the gamepad.
  let pad = false;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) if (gp && gp.connected && gp.buttons[PTT_PAD_BUTTON] && gp.buttons[PTT_PAD_BUTTON].pressed) pad = true;
  pttPad = pad;
  if (mic) {
    const want = sending();
    if (want !== status.sending || (mic.getAudioTracks()[0] && mic.getAudioTracks()[0].enabled !== want)) applyMic();
    status.micRms = micAnalyser ? rmsOf(micAnalyser, micBuf) : 0;
  } else if (status.sending || status.mode !== mode) applyMic();

  // Where every remote voice sits (read-only wasm query; full volume when unavailable, when the
  // falloff is off, outside races and for speakers without a kart in this race).
  const spatial = new Map();
  status.spatial = !!app && typeof app.voice_spatial_all === 'function';
  if (status.spatial && falloff && remotes.size) {
    const a = app.voice_spatial_all();
    for (let k = 0; k + 5 < a.length; k += 6) spatial.set(a[k], [a[k + 1], a[k + 2], a[k + 3], a[k + 4], a[k + 5]]);
  }
  const now = performance.now();
  const t = ctx ? ctx.currentTime : 0;
  for (const [id, r] of remotes) {
    const s = spatial.get(id) || FULL;
    r.spatial = s;
    r.nodes.gl.gain.setTargetAtTime(s[2], t, SMOOTH);
    r.nodes.gr.gain.setTargetAtTime(s[3], t, SMOOTH);
    r.nodes.mute.gain.setTargetAtTime(muted.has(id) ? 0 : 1, t, SMOOTH);
    r.rms = rmsOf(r.nodes.analyser, r.buf);
    if (r.rms > SPEAK_RMS) r.speakingUntil = now + SPEAK_HOLD;
    status.remote[id] = { rms: r.rms, gain: s[0], pan: s[1], left: s[2], right: s[3], distance: s[4], track: r.track.readyState, muted: muted.has(id), speaking: now < r.speakingUntil, ctx: ctx.state };
  }
  for (const id of Object.keys(status.remote)) if (!remotes.has(Number(id))) delete status.remote[id];
  // Tell the game audio who speaks (it ducks the game mix in the modes that cannot hear the chat).
  if (hook && hook.onSpeaking) {
    let n = 0;
    for (const [id, r] of remotes) if (now < r.speakingUntil && !muted.has(id)) n++;
    if (n !== speakingCount) { speakingCount = n; hook.onSpeaking(n); }
  }

  // Room list dots.
  const me = net.myId();
  for (const d of document.querySelectorAll('.voice-dot')) {
    const id = Number(d.dataset.id);
    const r = remotes.get(id);
    const speaking = id === me ? sending() && status.micRms > SPEAK_RMS : !!r && now < r.speakingUntil && !muted.has(id);
    d.classList.toggle('on', id === me ? !!mic : !!r);
    d.classList.toggle('speaking', speaking);
    d.classList.toggle('muted', muted.has(id));
  }
  drawKartIcons(now);
}

/** Small "talking" badges over the karts of players who speak (over the name tags). */
const kartIcons = new Map();
function drawKartIcons(now) {
  const host = $('voice-karts');
  if (!host) return;
  const seen = new Set();
  if (app && remotes.size && app.net_ready() && typeof app.kart_labels === 'function') {
    const race = net.race();
    const labels = app.kart_labels();
    const rect = $('gl') ? $('gl').getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    for (let k = 0; k + 3 < labels.length; k += 4) {
      const slot = race && race.slots[labels[k]];
      const r = slot && slot.player != null ? remotes.get(slot.player) : null;
      if (!r || now >= r.speakingUntil || muted.has(slot.player) || labels[k + 3] > 3000) continue;
      seen.add(labels[k]);
      let e = kartIcons.get(labels[k]);
      if (!e) { e = el('span', { textContent: '♪ talking' }); host.append(e); kartIcons.set(labels[k], e); }
      e.style.left = `${rect.left + labels[k + 1] * rect.width}px`;
      e.style.top = `${rect.top + labels[k + 2] * rect.height}px`;
    }
  }
  for (const [k, e] of kartIcons) if (!seen.has(k)) { e.remove(); kartIcons.delete(k); }
}

/** Room list entry: speaking dot, and a mute button for other players. */
export function decoratePlayer(li, id, isMe) {
  const dot = el('span', { className: 'voice-dot', title: isMe ? 'your mic' : 'voice' });
  dot.dataset.id = String(id);
  li.prepend(dot);
  if (isMe) return;
  const b = el('button', { className: 'small voice-mute', textContent: muted.has(id) ? 'unmute' : 'mute' });
  b.addEventListener('click', () => {
    if (muted.has(id)) muted.delete(id); else muted.add(id);
    b.textContent = muted.has(id) ? 'unmute' : 'mute';
  });
  li.append(b);
}
