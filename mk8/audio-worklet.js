// AudioWorklet side of the game audio (www/audio.js, docs/AUDIO.md §5).
//
// Two modes, decided by the page:
// * engine (preferred): the mk8-audio mixer itself runs here. The page posts the dependency-free
//   wasm module of crates/mk8-audio-worklet as bytes ({ cmd: 'init', wasm, rate, cache }); every
//   render quantum then pulls its 128 frames straight from the mixer, so a late animation frame
//   (course loading, WebRTC encode / decode, camera frames) can no longer starve the output.
//   The page sends command batches ({ cmds: Uint8Array }, mk8_audio::cmd::encode), sound files
//   ({ cmd: 'file', path: Uint8Array (UTF-8), bytes }) and unloads ({ cmd: 'unload', path }).
//   They are applied in arrival order; a file is copied into the wasm memory at most CHUNK bytes
//   per quantum so a 41 MB bank never blocks the audio thread (commands behind it wait).
//   Input 0 is the voice chat bus: the mixer limits it, ducks the game while somebody speaks and
//   limits the sum (mk8-audio `render_with_chat`); { cmd: 'chat', volume } sets its level.
// * push (fallback: no worklet wasm, or an older game wasm): the page renders on the main thread
//   and posts planar blocks ({ pcm: Float32Array(2 * frames) [left.., right..], frames }); they
//   play behind a small jitter buffer (`prebuffer` frames before starting, and again after
//   running dry, so a late frame does not click). { cmd: 'reset' }, { cmd: 'config', prebuffer }.
//
// Messages out: { engine: 'ready', version } / { engine: 'error', message } after 'init' (or when
// the engine fails later: output is silence then), and every ~50 ms a report
// { played, received, buffered, underruns, rms, peak, playing, engine, voices, streams, started,
//   chatDuck, chatPeak, limiter, files, playErrors, loadErrors, inbox }
// (`received` = frames of all pushed blocks so far: the page subtracts it from what it posted to
// know what is still in flight; the engine fields come from the mixer's counters).
//
// This file is both the worklet module (served build: addModule('audio-worklet.js')) and an ES
// module the page imports for WORKLET_SOURCE, its inline copy added from a Blob / data: URL
// (the fallback when the file fails to load). Keep the processor inside `workletMain`; a
// worklet scope has no fetch / TextDecoder / document, hence bytes everywhere.

function workletMain() {
  const CHUNK = 1 << 20; // file bytes copied into the wasm memory per render quantum
  const VERSION = 1; // crates/mk8-audio-worklet `mk8_version`

  class Mk8AudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      // push mode
      this.queue = []; // [{ pcm, frames, at }]
      this.buffered = 0;
      this.prebuffer = Math.round(sampleRate * 0.05);
      this.playing = false;
      this.received = 0;
      // engine mode
      this.ex = null; // wasm exports
      this.engine = false;
      this.inbox = []; // files / command batches, applied in order
      this.job = null; // file copy in progress: { ptr, done }
      this.loadErrors = 0;
      this.playErrors = 0;
      // meters / counters
      this.underruns = 0;
      this.played = 0;
      this.sum2 = 0;
      this.n = 0;
      this.peak = 0;
      this.sinceReport = 0;
      this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
      if (!m) return;
      if (m.pcm) {
        this.queue.push({ pcm: m.pcm, frames: m.frames, at: 0 });
        this.buffered += m.frames;
        this.received += m.frames;
        // Never let the queue grow unbounded (main thread far ahead): drop the oldest.
        while (this.buffered > sampleRate && this.queue.length > 1) {
          const d = this.queue.shift();
          this.buffered -= d.frames - d.at;
        }
        return;
      }
      switch (m.cmd) {
        case 'init': this.initEngine(m.wasm, m.rate, m.cache); break;
        case 'reset': this.queue = []; this.buffered = 0; this.playing = false; this.received = 0; break;
        case 'config': if (m.prebuffer > 0) this.prebuffer = Math.round(m.prebuffer); break;
        case 'chat': if (this.ex) this.ex.mk8_set_chat_volume(Math.max(0, Math.min(1, Number(m.volume) || 0))); break;
        case 'file': case 'unload': this.inbox.push(m); break;
        default: if (m.cmds) this.inbox.push(m);
      }
    }

    initEngine(bytes, rate, cache) {
      WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
        const ex = instance.exports;
        if (typeof ex.mk8_render !== 'function' || typeof ex.mk8_version !== 'function' || ex.mk8_version() !== VERSION) {
          throw new Error(`unexpected mk8_audio_worklet module (version ${typeof ex.mk8_version === 'function' ? ex.mk8_version() : '?'})`);
        }
        ex.mk8_engine_new(rate > 0 ? rate : sampleRate, cache > 0 ? cache : 0);
        this.ex = ex;
        this.engine = true;
        this.port.postMessage({ engine: 'ready', version: VERSION });
      }).catch((e) => {
        this.port.postMessage({ engine: 'error', message: String(e && e.message ? e.message : e) });
      });
    }

    /** Copies `bytes` into a fresh wasm buffer (ownership passes with the next call). */
    put(bytes) {
      if (!bytes.length) return 0;
      const p = this.ex.mk8_alloc(bytes.length);
      if (!p) throw new Error('mk8_alloc failed');
      new Uint8Array(this.ex.memory.buffer, p, bytes.length).set(bytes);
      return p;
    }

    /** Applies the inbox in order; one file copy may span several quanta. */
    pump() {
      const ex = this.ex;
      let budget = CHUNK;
      while (this.inbox.length && budget > 0) {
        const m = this.inbox[0];
        if (m.cmds) {
          const rc = ex.mk8_apply(this.put(m.cmds), m.cmds.length);
          if (rc > 0) this.playErrors += rc; else if (rc < 0) this.loadErrors++;
          this.inbox.shift();
        } else if (m.cmd === 'unload') {
          ex.mk8_unload_file(this.put(m.path), m.path.length);
          this.inbox.shift();
        } else if (m.cmd === 'file') {
          const bytes = m.bytes;
          if (!this.job) {
            const ptr = bytes.length ? ex.mk8_alloc(bytes.length) : 0;
            if (bytes.length && !ptr) { this.loadErrors++; this.inbox.shift(); continue; }
            this.job = { ptr, done: 0 };
          }
          const n = Math.min(budget, bytes.length - this.job.done);
          if (n > 0) {
            new Uint8Array(ex.memory.buffer, this.job.ptr + this.job.done, n).set(bytes.subarray(this.job.done, this.job.done + n));
            this.job.done += n;
            budget -= n;
          }
          if (this.job.done >= bytes.length) {
            if (ex.mk8_load_file(this.put(m.path), m.path.length, this.job.ptr, bytes.length) !== 0) this.loadErrors++;
            this.job = null;
            this.inbox.shift();
          }
        } else {
          this.inbox.shift();
        }
      }
    }

    meter(l, r, n) {
      for (let k = 0; k < n; k++) {
        const a = l[k]; const b = r ? r[k] : a;
        this.sum2 += a * a + b * b;
        const p = Math.max(Math.abs(a), Math.abs(b));
        if (p > this.peak) this.peak = p;
      }
      this.n += 2 * n;
    }

    process(inputs, outputs) {
      const out = outputs[0];
      const l = out[0];
      const r = out.length > 1 ? out[1] : null;
      const n = l.length;
      let i = 0;
      if (this.engine) {
        try {
          this.pump();
          const ex = this.ex;
          const cp = ex.mk8_chat_ptr(n);
          const inp = inputs[0];
          if (cp && inp && inp.length) {
            const chat = new Float32Array(ex.memory.buffer, cp, 2 * n);
            chat.set(inp[0], 0);
            chat.set(inp.length > 1 ? inp[1] : inp[0], n);
          }
          const p = ex.mk8_render(n);
          if (!p) throw new Error('mk8_render: no engine');
          const pcm = new Float32Array(ex.memory.buffer, p, 2 * n);
          l.set(pcm.subarray(0, n));
          if (r) r.set(pcm.subarray(n, 2 * n));
          this.meter(l, r, n);
          this.played += n;
          i = n;
        } catch (e) {
          this.engine = false;
          this.ex = null;
          this.port.postMessage({ engine: 'error', message: String(e && e.message ? e.message : e) });
        }
      } else {
        if (!this.playing && this.buffered >= this.prebuffer) this.playing = true;
        if (this.playing) {
          while (i < n && this.queue.length) {
            const c = this.queue[0];
            const take = Math.min(n - i, c.frames - c.at);
            const L = c.pcm.subarray(c.at, c.at + take);
            const R = c.pcm.subarray(c.frames + c.at, c.frames + c.at + take);
            l.set(L, i);
            if (r) r.set(R, i);
            this.meter(L, R, take);
            c.at += take; i += take; this.buffered -= take; this.played += take;
            if (c.at >= c.frames) this.queue.shift();
          }
          if (i < n) {
            // Ran dry: count it, wait for the jitter buffer to refill.
            this.underruns++;
            this.playing = false;
          }
        }
      }
      for (; i < n; i++) { l[i] = 0; if (r) r[i] = 0; }
      this.sinceReport += n;
      if (this.sinceReport >= sampleRate * 0.05) {
        this.sinceReport = 0;
        const rms = this.n ? Math.sqrt(this.sum2 / this.n) : 0;
        const rep = { played: this.played, received: this.received, buffered: this.buffered, underruns: this.underruns, rms, peak: this.peak, playing: this.engine || this.playing, engine: this.engine, loadErrors: this.loadErrors, playErrors: this.playErrors, inbox: this.inbox.length };
        if (this.engine) {
          const s = (k) => this.ex.mk8_stat(k);
          rep.voices = s(0); rep.streams = s(1); rep.started = s(2); rep.limiter = s(7); rep.chatDuck = s(8); rep.chatPeak = s(9); rep.files = s(11);
        }
        this.port.postMessage(rep);
        this.sum2 = 0; this.n = 0; this.peak = 0;
      }
      return true;
    }
  }
  registerProcessor('mk8-audio', Mk8AudioProcessor);
}

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') workletMain();

/** Source of the worklet for a Blob / data: URL fallback. */
export const WORKLET_SOURCE = `(${workletMain.toString()})();\n`;
