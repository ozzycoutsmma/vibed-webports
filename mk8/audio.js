// Game audio, main-thread side (docs/AUDIO.md §5). One AudioContext (latencyHint 'interactive',
// a fixed 48 kHz like the mixer: the browser resamples to the device, and the voice chat's
// WebRTC tracks join the same context), created at boot and resumed on the first user gesture
// (autoplay policy). Three output modes, best first:
// * 'engine': the mk8-audio mixer runs inside the AudioWorklet (www/audio-worklet.js +
//   pkg/mk8_audio_worklet.wasm, crates/mk8-audio-worklet; the served build takes its
//   content-hashed name from pkg/manifest.json, www/pkg-manifest.js). Every frame `tick()` posts the
//   frame's commands (app.audio_take_wire) and the sound files (app.audio_next_file*) to it; the
//   audio thread renders 128-frame quanta itself, so main-thread hitches (course loading, WebRTC
//   encode / decode of the voice chat, camera frames) cannot starve the output. Voice chat goes
//   into the worklet node's input: the mixer limits it, ducks the game by 3 dB while someone
//   speaks and limits the sum (never clips at the device). Needs a wasm with the remote exports;
//   older builds fall back to:
// * 'worklet': the wasm App renders on the main thread every animation frame, ~100 ms queued in
//   the worklet behind a jitter buffer (planar blocks over the MessagePort; no
//   SharedArrayBuffer, so plain HTTP and file:// work);
// * 'buffer': without AudioWorklet, AudioBufferSourceNodes scheduled ~100 ms ahead.
// In the last two the voice chat gets a WebAudio chat path (DynamicsCompressor limiter -> chat
// volume) summed with the game under a transparent safety compressor, and the game output is
// ducked while voice.js reports a speaking player.
//
// Sound files are optional and read lazily through the page's romfs source (app.audio_wanted);
// a missing file is silence. Settings (Music / SFX / Voice volume, mute) are stored in
// localStorage 'mk8.audio'. Voice chat attaches with `chat()` (see voice.attachAudio).
// Debug: window.__mk8Audio = { mode ('engine' | 'worklet' | 'buffer' | 'off'), state
// (AudioContext), sampleRate, voices, streams, started, active, rms / peak (output, last
// ~50 ms), underruns, bufferedMs, files (sound files loaded), errors (play errors), renderMs
// (main-thread mixer ms per 1/60 s; 'worklet' / 'buffer' modes), race (a race director runs),
// chatDuck (game gain under voice chat, engine mode), chatPeak, limiter (lowest limiter gain),
// speaking (voice.js reports a speaking player), engineError }.
import { WORKLET_SOURCE } from './audio-worklet.js';
import { pkgUrl } from './pkg-manifest.js';

const SAVE = 'mk8.audio';
const RATE = 48_000; // mixer / context rate (the browser resamples to the device)
const TARGET_S = 0.1; // jitter buffer kept queued (push modes)
const MAX_BLOCK_S = 0.15; // most rendered in one tick (after a hitch)
const QUANTUM = 128;
const DUCK_GAIN = 0.708; // -3 dB on the game while a voice chat player speaks (push modes)
const ENGINE_CACHE = 64 << 20; // decoded-wave cache of the worklet's mixer (bytes)

export const DEFAULT_SETTINGS = { music: 0.8, sfx: 0.8, voice: 0.8, mute: false };

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) || '{}');
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
    return { music: num(s.music, DEFAULT_SETTINGS.music), sfx: num(s.sfx, DEFAULT_SETTINGS.sfx), voice: num(s.voice, DEFAULT_SETTINGS.voice), mute: s.mute === true };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SAVE, JSON.stringify(s)); } catch { /* private mode / blocked storage */ }
}

/** A no-op controller (old wasm without the audio exports, or no WebAudio). */
const NONE = { tick() {}, ui() {}, settings: () => loadSettings(), setSettings() {}, available: false, chat: () => null };

/**
 * @param app the wasm App
 * @param getSource () => romfs source ({ read(path) -> Promise<Uint8Array|null> }) or null
 */
export function initAudio(app, getSource) {
  const debug = { mode: 'off', state: 'none', sampleRate: 0, voices: 0, streams: 0, started: 0, active: false, rms: 0, peak: 0, underruns: 0, bufferedMs: 0, files: 0, errors: 0, chatDuck: 1, chatPeak: 0, limiter: 1, speaking: false, engineError: null };
  window.__mk8Audio = debug;
  if (typeof app.audio_init !== 'function' || typeof app.audio_render !== 'function') return NONE;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return NONE;
  let ctx;
  try { ctx = new Ctx({ latencyHint: 'interactive', sampleRate: RATE }); } catch {
    try { ctx = new Ctx({ latencyHint: 'interactive' }); } catch (e) { console.warn('audio: no AudioContext', e); return NONE; }
  }
  const rate = ctx.sampleRate;
  debug.sampleRate = rate;
  // The mixer in the worklet needs the wasm's remote exports (feature-detected: an older live
  // wasm keeps the main-thread mixer).
  const remoteCapable = ['audio_init_remote', 'audio_take_wire', 'audio_next_file', 'audio_next_file_bytes'].every((f) => typeof app[f] === 'function');
  let settings = loadSettings();
  app.audio_settings(settings.music, settings.sfx, settings.voice, settings.mute);

  // ---- graph ----
  // game: out -> (master) -> destination.  chat (voice.js bus): chatIn -> worklet input (engine)
  // or chatIn -> chatLim -> chatVol -> master (push modes).
  const out = ctx.createGain();
  const chatIn = ctx.createGain();
  let chatVolume = 0.8;
  let speaking = false;
  let node = null; // AudioWorkletNode
  let mode = 'pending';
  let written = 0; // push: frames posted to the worklet
  // Last worklet report: frames received, frames queued there, whether it plays, ctx time.
  let rep = { received: 0, buffered: 0, playing: false, at: 0 };
  let nextTime = 0; // buffer fallback: when the next block starts
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function onReport(m) {
    rep = { received: m.received, buffered: m.buffered, playing: m.playing, at: ctx.currentTime };
    debug.underruns = m.underruns; debug.rms = m.rms; debug.peak = m.peak;
    debug.bufferedMs = Math.round((m.buffered / rate) * 1000);
    if (m.engine) {
      debug.voices = m.voices; debug.streams = m.streams; debug.started = m.started;
      debug.chatDuck = m.chatDuck; debug.chatPeak = m.chatPeak; debug.limiter = m.limiter;
      debug.workletFiles = m.files; debug.workletErrors = m.playErrors + m.loadErrors; debug.inbox = m.inbox;
    }
  }

  /** Push modes: the voice chat path in WebAudio and a transparent safety compressor on the sum. */
  function routeChatJs() {
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = 0; master.knee.value = 0; master.ratio.value = 20; master.attack.value = 0.001; master.release.value = 0.1;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -10; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.15;
    const vol = ctx.createGain();
    vol.gain.value = chatVolume;
    chatIn.connect(lim); lim.connect(vol); vol.connect(master);
    out.connect(master); master.connect(ctx.destination);
    chatVolNode = vol;
    applyDuck();
  }
  let chatVolNode = null;
  function applyDuck() {
    if (mode === 'engine') return; // the mixer ducks from the chat signal itself
    const t = ctx.currentTime;
    out.gain.setTargetAtTime(speaking ? DUCK_GAIN : 1, t, speaking ? 0.02 : 0.2);
  }

  async function addWorkletModule() {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') throw new Error('no AudioWorklet');
    let url = null;
    try { url = new URL('./audio-worklet.js', import.meta.url).href; } catch { url = null; }
    // Inline copy: a Blob URL, or (file://, where Chrome refuses blob: worklet modules from the
    // page's opaque origin) a data: URL.
    const fromBlob = async () => {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
    };
    const fromData = () => ctx.audioWorklet.addModule(`data:text/javascript;charset=utf-8,${encodeURIComponent(WORKLET_SOURCE)}`);
    if (url) {
      try { await ctx.audioWorklet.addModule(url); } catch (e) { console.warn('audio worklet file failed, using the inline copy', e); await fromBlob(); }
    } else if (location.protocol === 'file:') {
      try { await fromData(); } catch { await fromBlob(); }
    } else {
      try { await fromBlob(); } catch { await fromData(); }
    }
  }

  /** Bytes of the worklet's wasm (next to the game's). */
  async function loadWorkletWasm() {
    const url = await pkgUrl('mk8_audio_worklet.wasm');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url.pathname}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Preferred: the mixer in the worklet. Throws (before touching the App) when unavailable. */
  async function setupEngine() {
    const wasm = await loadWorkletWasm();
    const n = new AudioWorkletNode(ctx, 'mk8-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worklet engine init timed out')), 8000);
      n.port.onmessage = (e) => {
        const m = e.data;
        if (!m || !m.engine || typeof m.engine !== 'string') return;
        clearTimeout(timer);
        if (m.engine === 'ready') resolve(m); else reject(new Error(m.message || 'worklet engine failed'));
      };
    });
    n.port.postMessage({ cmd: 'init', wasm, rate, cache: ENGINE_CACHE }, [wasm.buffer]);
    try { await ready; } catch (e) { try { n.disconnect(); } catch { /* not connected */ } throw e; }
    node = n;
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.engine === 'error') {
        // The mixer trapped: silence until a reload (its files are gone with it).
        debug.engineError = m.message; console.error('audio: worklet engine failed:', m.message);
        return;
      }
      if (m && typeof m.engine === 'string') return;
      onReport(m);
    };
    chatIn.connect(node, 0, 0);
    node.connect(out);
    out.connect(ctx.destination);
    node.port.postMessage({ cmd: 'chat', volume: chatVolume });
    app.audio_init_remote(rate);
    mode = 'engine';
  }

  /** Fallback: the App renders on the main thread, the worklet plays the blocks. */
  function setupPush() {
    node = new AudioWorkletNode(ctx, 'mk8-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.postMessage({ cmd: 'config', prebuffer: Math.round(rate * 0.06) });
    node.port.onmessage = (e) => { if (e.data && typeof e.data.engine !== 'string') onReport(e.data); };
    node.connect(out);
    routeChatJs();
    app.audio_init(rate);
    mode = 'worklet';
  }

  (async () => {
    try {
      await addWorkletModule();
    } catch (e) {
      console.warn('audio: AudioWorklet unavailable, using buffer scheduling:', e && e.message ? e.message : e);
      routeChatJs();
      app.audio_init(rate);
      mode = 'buffer';
      return;
    }
    if (remoteCapable) {
      try { await setupEngine(); return; } catch (e) { console.warn('audio: mixer in the worklet unavailable, rendering on the main thread:', e && e.message ? e.message : e); }
    }
    setupPush();
  })();

  // ---- autoplay: resume on the first gesture ----
  // touchstart / touchend count on iOS (a tap on the on-screen controls is the first gesture
  // there); an 'interrupted' context (phone call, another app's audio) resumes the same way.
  let hiddenSuspended = false; // suspended by us because the tab is hidden
  const resume = () => { if (ctx.state !== 'running' && !hiddenSuspended) ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'pointerup', 'keydown', 'touchstart', 'touchend', 'mousedown', 'click']) window.addEventListener(ev, resume, { capture: true, passive: true });
  ctx.addEventListener('statechange', () => { debug.state = ctx.state; });
  debug.state = ctx.state;
  // ---- hidden tab: silence (the worklet keeps rendering otherwise), back on return ----
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (ctx.state === 'running') { hiddenSuspended = true; ctx.suspend().catch(() => { hiddenSuspended = false; }); }
    } else if (hiddenSuspended) {
      hiddenSuspended = false;
      // May be refused until the next gesture (iOS): the gesture handlers above retry.
      ctx.resume().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => { if (ctx.state === 'running') { hiddenSuspended = true; ctx.suspend().catch(() => { hiddenSuspended = false; }); } });
  window.addEventListener('pageshow', () => { if (hiddenSuspended) { hiddenSuspended = false; ctx.resume().catch(() => {}); } });

  // ---- lazy sound files ----
  let loading = 0;
  async function pumpFiles() {
    const src = getSource();
    if (!src || loading > 0) return;
    const want = Array.from(app.audio_wanted());
    if (want.length === 0) return;
    loading = want.length;
    let next = 0;
    const worker = async () => {
      while (next < want.length) {
        const p = want[next++];
        let bytes = null;
        try { bytes = await src.read(p); } catch { bytes = null; }
        if (bytes) { try { app.add_file(p, bytes); } catch (e) { console.warn('audio file', p, e); } }
        loading--;
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    loading = 0;
  }

  let active = false;
  let ticks = 0;
  let underrunsBuffer = 0;
  let renderMs = 0;
  function render(frames) {
    const t0 = performance.now();
    const pcm = app.audio_render(frames);
    // Mixer cost per rendered 1/60 s (exponential average), for the debug counters.
    renderMs += ((performance.now() - t0) * (rate / 60 / frames) - renderMs) * 0.05;
    debug.renderMs = Math.round(renderMs * 1000) / 1000;
    return pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
  }

  /** Engine mode: forward the frame's sound files (first: commands may refer to them) and commands. */
  function forward() {
    let path;
    let guard = 0;
    while (guard++ < 64 && (path = app.audio_next_file()) != null) {
      const bytes = app.audio_next_file_bytes();
      const pb = encoder ? encoder.encode(path) : Uint8Array.from(path, (c) => c.charCodeAt(0) & 0x7f);
      if (bytes) node.port.postMessage({ cmd: 'file', path: pb, bytes }, [bytes.buffer]);
      else node.port.postMessage({ cmd: 'unload', path: pb });
    }
    const wire = app.audio_take_wire();
    if (wire && wire.length) node.port.postMessage({ cmds: wire }, [wire.buffer]);
  }

  function tick() {
    ticks++;
    if ((ticks & 7) === 0) pumpFiles();
    const running = ctx.state === 'running' && (mode === 'engine' || mode === 'worklet' || mode === 'buffer');
    if (running !== active) {
      active = running;
      app.audio_set_active(running);
      if (running && mode !== 'engine') {
        nextTime = 0;
        if (node) node.port.postMessage({ cmd: 'reset' });
        written = 0; rep = { received: 0, buffered: 0, playing: false, at: ctx.currentTime };
      }
    }
    debug.mode = mode; debug.active = active;
    if (mode === 'engine') forward(); // files / commands flow whatever the context state
    if (!active) return;
    const now = ctx.currentTime;
    if (mode === 'engine') {
      // Nothing to render here: the worklet pulls the mixer itself.
    } else if (mode === 'worklet') {
      // Frames queued in the worklet: its last report, plus blocks still in flight, minus what
      // it played since the report.
      const drained = rep.playing ? Math.max(0, now - rep.at) * rate : 0;
      const buffered = Math.max(0, rep.buffered - drained) + Math.max(0, written - rep.received);
      const need = TARGET_S * rate - buffered;
      if (need > 0) {
        const frames = Math.min(Math.ceil(need / QUANTUM) * QUANTUM, Math.round(MAX_BLOCK_S * rate / QUANTUM) * QUANTUM);
        const pcm = render(frames);
        node.port.postMessage({ pcm, frames }, [pcm.buffer]);
        written += frames;
      }
    } else {
      // Fallback: AudioBufferSourceNodes scheduled back to back ~TARGET_S ahead.
      if (nextTime < now) { if (nextTime > 0) underrunsBuffer++; nextTime = now + 0.02; }
      const lead = nextTime - now;
      if (lead < TARGET_S) {
        const frames = Math.min(Math.ceil(((TARGET_S - lead) * rate) / QUANTUM) * QUANTUM, Math.round(MAX_BLOCK_S * rate));
        const pcm = render(frames);
        const buf = ctx.createBuffer(2, frames, rate);
        buf.copyToChannel(pcm.subarray(0, frames), 0);
        buf.copyToChannel(pcm.subarray(frames, 2 * frames), 1);
        const s = ctx.createBufferSource();
        s.buffer = buf; s.connect(out); s.start(nextTime);
        nextTime += frames / rate;
        let sum = 0; for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        debug.rms = Math.sqrt(sum / Math.max(1, pcm.length));
      }
      debug.underruns = underrunsBuffer;
      debug.bufferedMs = Math.round((nextTime - now) * 1000);
    }
    if ((ticks & 15) === 0 && typeof app.audio_stats === 'function') {
      const st = app.audio_stats();
      if (mode !== 'engine') { debug.voices = st[0]; debug.streams = st[1]; debug.started = st[2]; debug.mixRms = st[4]; }
      debug.files = st[7]; debug.errors = st[8]; debug.race = st[9] === 1;
    }
  }

  return {
    available: true,
    tick,
    /** Homemade-menu sound by SLink key. */
    ui(key) { if (active && typeof app.audio_ui === 'function') app.audio_ui(key); },
    settings: () => ({ ...settings }),
    setSettings(s) {
      settings = { ...settings, ...s };
      app.audio_settings(settings.music, settings.sfx, settings.voice, settings.mute);
      saveSettings(settings);
    },
    context: ctx,
    /** Voice chat hook for voice.attachAudio: play the voices in this context into `destination`
     *  (the chat path: limiter, chat volume, game ducking, final limiter), report speakers. */
    chat() {
      return {
        context: ctx,
        destination: chatIn,
        setVolume(v) {
          chatVolume = Math.max(0, Math.min(1, Number(v) || 0));
          if (mode === 'engine' && node) node.port.postMessage({ cmd: 'chat', volume: chatVolume });
          if (chatVolNode) chatVolNode.gain.setTargetAtTime(chatVolume, ctx.currentTime, 0.05);
        },
        onSpeaking(n) {
          speaking = n > 0;
          debug.speaking = speaking;
          applyDuck();
        },
      };
    },
  };
}
