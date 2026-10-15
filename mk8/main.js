// MK8 Web front end. Served from crates/mk8-web/ (tools/serve.sh); open /www/.
//
// Normal start: the page loads the romfs from the web (the server that served it) -> the game's
// UI archives are read -> the homemade menu (www/home.js: SINGLEPLAYER -> class, ONLINE rooms via
// www/net.js, face photo) -> the game's own character / kart / cup screens (mk8-ui) -> the race
// with the game's HUD, pause and results. The UI asks for a race (app.load_request), this page
// reads the course / kart files on demand and hands them to wasm (app.finish_load once
// app.load_ready). When the game UI returns to a page the homemade menu replaces (app.at_home),
// the homemade menu comes back. Game files always stream from the page's own server at /romfs/
// into the browser's Cache Storage; there is no folder picker.
//
// URL options:
//   ?lang=USen          UI language (romfs UI/<lang>, default USen)
//   ?romfs=<url>        where the romfs comes from over HTTP (default ../romfs/, i.e. /romfs/ on
//                       the page's own server: mk8-server serves the repo dump by default and
//                       tools/serve.sh links crates/mk8-web/romfs -> romfs-v3). Fetched files are
//                       cached in the browser (Cache Storage); `?clear=1` drops that cache.
//   ?dev=1              legacy spelling (no-op: HTTP is the only mode)
//   ?course=<name>      direct entry for development: skips the menus and starts that course
//                       (HTTP romfs; the game HUD is drawn when the UI files are there). The
//                       temporary HTML kart selection panel exists only in this mode.
//   ?sim=legacy         old APPROXIMATE race instead of the 1:1 simulation (comparison only)
//   ?intro=0            skip the course intro state of the simulation
//   ?autodrive=N        hold A (accelerate) for N seconds once the race runs (smoke tests)
//   ?autopilot=1        the human kart drives itself along the CPU path (development aid)
//   ?timescale=N        run the race simulation N times faster (development aid)
//   ?racers=N           karts in the race (2..255; default 12): you + N-1 CPUs in the direct
//                       ?course= entry, and the default of the menus' Racers selector
//   ?occlusion=0        draw karts hidden behind the course too (comparison; default: only
//                       the karts the camera can see are drawn)
//   ?gpu=webgpu         WebGPU instead of WebGL2
//   ?audio=0            no sound at all (no AudioContext, no sound files)
//   ?ws=ws://host:port/ws  online server when the page comes from elsewhere (default: this host)
//   ?profile=mobile|desktop  device budget (default: mobile on touch devices; docs/MOBILE.md)
//   ?touch=1            show the on-screen controls on any device
//   ?sw=0               do not register the service worker (app shell cache)
//
// Phones / tablets (www/mobile.js, docs/MOBILE.md): on-screen controls and tilt steering are
// merged into the pad every frame, the canvas backing store is capped at the profile's device
// pixel ratio, "30 fps mode" draws every other frame (the sim still steps at 60 Hz). Game files
// stream from the same server as desktop, into Cache Storage.
//
// Sound (www/audio.js): the wasm mixer is pulled every frame into an AudioWorklet; sound files
// are read lazily (optional); volumes are set in the homemade menu (localStorage 'mk8.audio').
//
// Online races (www/net.js): the sim never runs on the local clock. Every 1/60 s tick the local
// controls go to NetClient.tick; the commands it returns (frames to simulate with the server's
// or predicted inputs, rollbacks to re-simulate from a mispredicted frame; docs/NETWORK.md §7)
// run in app.step_net, and the state hash of every 60th confirmed frame is reported back
// (window.__mk8StateHash / __mk8Checksums for tests). Rendering shows the latest sim state,
// with remote karts eased out of rollback corrections.
// The wasm-bindgen glue (pkg/mk8_web.js) is imported in main(): the served build resolves its
// content-hashed name through pkg/manifest.json (www/pkg-manifest.js, docs/NETWORK.md §1).
// www/net.js imports '../pkg/mk8_web.js' statically;
// that file re-exports the hashed module, so both get the same instance.
import { pkgUrl } from './pkg-manifest.js';
import { initHome } from './home.js';
import { initAudio } from './audio.js';
import * as net from './net.js';
import { initMobile } from './mobile.js';
import { initControlsCard } from './controls.js';
import { adFrame } from './ads.js';

let App = null; // the glue's App class, set in main()
let version = () => '?'; // the glue's version(), set in main()

const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const statusEl = $('status');
const hudEl = $('hud');
const courseSel = $('course');
const startBtn = $('start');

const setStatus = (s) => { statusEl.textContent = s; };
// Uncaught page errors are shown in the status line and in a box over the page (phones have no
// console, and the status line is hidden while the game runs): first error wins so the root
// cause is not hidden by follow-up failures. The server is told too (POST /client-error, a few
// per minute per IP) so the admin dashboard's warnings show what broke for whom.
let firstError = null;
const reportError = (kind, e) => {
  const msg = e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' @ ') : String(e && e.message ? e.message : e);
  console.error(`${kind}:`, e);
  window.__mk8LastError = { kind, msg, at: Date.now() };
  if (firstError) return;
  firstError = msg;
  setStatus(`${kind}: ${msg}`);
  try {
    const box = document.createElement('div');
    box.id = 'page-error';
    box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:200;background:#e52521;color:#fff;border:2px solid #fff;border-radius:12px;padding:10px 14px;font:800 14px/1.35 sans-serif;white-space:pre-wrap;word-break:break-word';
    box.textContent = `Something broke (${kind}): ${msg}\nReload the page to continue. This was reported to the server.`;
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
  } catch { /* no DOM yet */ }
  try {
    const body = JSON.stringify({ kind, msg: msg.slice(0, 1500), screen: window.__mk8Screen || '', ua: navigator.userAgent, url: location.href.slice(0, 300) });
    if (!(navigator.sendBeacon && navigator.sendBeacon(new URL('/client-error', location.href), new Blob([body], { type: 'application/json' })))) {
      fetch(new URL('/client-error', location.href), { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch { /* offline */ }
};
window.addEventListener('error', (ev) => reportError('page error', ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => reportError('async error', ev.reason));

const params = new URLSearchParams(location.search);
const LANG = params.get('lang') || 'USen';
const DEV_COURSE = params.get('course');
// Game files always load from the page's own server, at /romfs/ (mk8-server serves the repo dump
// by default; tools/serve.sh links crates/mk8-web/romfs -> romfs-v3) and are cached in the
// browser. There is no folder picker.
const ROMFS_BASE = params.get('romfs') || '../romfs/';
const CLEAR_CACHE = params.get('clear') === '1';
const LEGACY = params.get('sim') === 'legacy';
const SKIP_INTRO = params.get('intro') === '0';
const AUTODRIVE_S = Number(params.get('autodrive') || 0);

let app = null;
/** Where romfs files come from: { list(dir) -> [paths], read(path) -> Uint8Array|null, has?(path) }. */
let source = null;
let menus = false; // the game's menus are running
let home = null; // the homemade menu (initHome)
let audio = null; // game sound (www/audio.js)
let mobile = null; // touch controls, tilt, device profile (www/mobile.js)
let controlsCard = null; // race-start controls card (www/controls.js)
let running = false; // a race exists (dev mode: started)
let autodriveStart = null;
window.__mk8AutodriveDone = false;
window.__mk8Screen = '';
window.__mk8Ready = false;

// Files read for a course (paths relative to Course/<name>/). Missing optional files are skipped.
const COURSE_FILES = ['course_kcl.szs', 'course_model.szs', 'course_muunt.byaml', 'course_maptexture.bntx', 'course.bgenv',
  'course_bglpbd.szs', 'course_mapcamera.bin'];
// Shared files (relative to romfs root) loaded when present. Common/Mush/*.bin are the parameter
// tables of the 1:1 simulation (Performance.bin is required for it).
const COMMON_FILES = ['Data/objflow.byaml',
  'Common/Mush/Performance.bin', 'Common/Mush/Parts.bin', 'Common/Mush/Course.bin',
  'Common/Mush/AIRace.bin', 'Common/Mush/Item.bin', 'Common/Mush/UI.bin'];

// ---- file sources ----

// Romfs files fetched over HTTP are kept in the browser's Cache Storage, so a reload (and the
// game courses loaded later) read from disk instead of re-downloading gigabytes. `?clear=1`
// empties it, e.g. after updating the dump.
const ROMFS_CACHE = 'mk8-romfs-v1';

/** Drop the cached romfs (`?clear=1`, `window.__mk8ClearRomfsCache()`). */
async function clearRomfsCache() {
  try { await caches.delete(ROMFS_CACHE); console.info(`cleared the ${ROMFS_CACHE} browser cache`); }
  catch (e) { console.warn('cache clear', e); }
}
window.__mk8ClearRomfsCache = clearRomfsCache;

/** HTTP romfs served by the page's own server (directory listings of python's http.server and
 *  mk8-server's --dev-romfs both emit `href="name"` links). File reads go through the Cache
 *  Storage API; listings are not cached so newly added dump files show up. */
function httpSource(base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const fileUrl = (p) => root + p.split('/').map(encodeURIComponent).join('/');
  const listingUrl = (dir) => `${root}${dir}${dir && !dir.endsWith('/') ? '/' : ''}`;
  let cache = null;
  const openCache = async () => {
    if (cache !== null) return cache;
    try { cache = typeof caches !== 'undefined' ? await caches.open(ROMFS_CACHE) : null; }
    catch { cache = null; }
    return cache;
  };
  return {
    /** True when `base` really is a romfs directory (not the SPA fallback HTML). */
    available: async () => {
      try {
        const r = await fetch(listingUrl(''));
        if (!r.ok) return false;
        return /href="(Course|UI|Data)\//.test(await r.text());
      } catch { return false; }
    },
    list: async (dir) => {
      const r = await fetch(listingUrl(dir));
      if (!r.ok) return [];
      const out = [];
      for (const m of (await r.text()).matchAll(/href="([^"?#]+)"/g)) {
        const name = decodeURIComponent(m[1]);
        if (!name.endsWith('/') && !name.includes('/')) out.push(`${dir}/${name}`);
      }
      return out;
    },
    /** Immediate subdirectories of `dir` (used to list Course/<name>). */
    dirs: async (dir) => {
      const r = await fetch(listingUrl(dir));
      if (!r.ok) return [];
      const out = [];
      for (const m of (await r.text()).matchAll(/href="([^"?#]+)"/g)) {
        const name = decodeURIComponent(m[1]);
        if (name.endsWith('/') && !name.includes('/')) out.push(name.slice(0, -1));
      }
      return out;
    },
    read: async (p) => {
      const url = fileUrl(p);
      const c = await openCache();
      if (c) {
        try { const hit = await c.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
        catch { /* treat a cache miss/error as a network read */ }
      }
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      if (c) {
        try { await c.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); }
        catch (e) { console.warn('cache put', p, e); }
      }
      return new Uint8Array(buf);
    },
  };
}

/** Read many files with a few requests in flight; `onFile(path, bytes)` for each present one. */
async function readAll(paths, onFile, label) {
  let next = 0; let done = 0;
  const worker = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      let bytes = null;
      try { bytes = await source.read(p); } catch (e) { console.warn(p, e); }
      if (bytes) onFile(p, bytes);
      done++;
      if (label && (done % 8 === 0 || done === paths.length)) setStatus(`${label} ${done}/${paths.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** Files wasm asked for: `.bfres` paths fall back to the `.szs` of the same name (added under
 *  the `.szs` path); `UI/` paths go to the UI store. */
async function readRequired(paths, label) {
  const got = new Set();
  const add = (p, b) => { got.add(p); if (p.startsWith('UI/')) app.add_ui_file(p, b); else app.add_file(p, b); };
  await readAll(paths, add, label);
  const retry = paths.filter((p) => p.endsWith('.bfres') && !got.has(p)).map((p) => p.replace(/\.bfres$/, '.szs'));
  if (retry.length) await readAll(retry, add, label);
}

// ---- menus ----

async function startUi() {
  setStatus('reading the UI files...');
  const dirs = app.ui_dirs(LANG);
  const listed = [];
  for (const d of dirs) listed.push(...await source.list(d));
  const want = app.ui_startup_files(LANG, listed);
  const t0 = performance.now();
  await readAll(want, (p, b) => app.add_ui_file(p, b), 'reading UI files');
  setStatus('building the menus...');
  await new Promise((r) => setTimeout(r, 0));
  app.start_ui(LANG);
  console.info(`UI started in ${((performance.now() - t0) / 1000).toFixed(1)} s (${want.length} files)`);
}

let loadBusy = false;
/** The menus asked for a race: read the course + kart files, wait for the loading screen. */
async function loadRace(name) {
  loadBusy = true;
  try {
    if (app.at_home()) return;
    app.clear_files();
    const base = [...COURSE_FILES.map((f) => `Course/${name}/${f}`), ...COMMON_FILES];
    await readAll(base, (p, b) => app.add_file(p, b));
    // Map objects, skydome, item box models, every racer's kart parts, award picture.
    await readRequired(app.required_files(name));
    while (!app.load_ready()) {
      if (app.at_home()) return; // abandoned
      await new Promise((r) => setTimeout(r, 16));
    }
    const t0 = performance.now();
    app.finish_load();
    console.info(`${name} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s - ${app.backend()} - ${app.is_sim() ? '1:1 sim' : 'legacy race'}`);
    running = true;
    window.__mk8RaceLoaded = name;
  } catch (e) {
    console.error(e);
  } finally {
    loadBusy = false;
  }
}

// ---- dev panel (only for ?course= and as a fallback when the UI files are missing) ----

const SEL_KINDS = ['driver', 'body', 'tire', 'glider'];
function currentCombo() {
  const c = {};
  for (const k of SEL_KINDS) {
    const el = $(`sel-${k}`);
    const fromUrl = Number(params.get(k));
    c[k] = el && el.value !== '' ? Number(el.value) : (Number.isFinite(fromUrl) ? fromUrl : 0);
  }
  return c;
}
function applyRaceOptions() {
  app.set_legacy(LEGACY);
  app.set_skip_intro(SKIP_INTRO);
  const c = currentCombo();
  app.set_player_combo(c.driver, c.body, c.tire, c.glider);
}
function updateStatBars() {
  const bars = $('sel-bars');
  const c = currentCombo();
  const labels = app.stat_labels();
  const vals = app.combo_stats(c.driver, c.body, c.tire, c.glider);
  bars.replaceChildren();
  if (vals.length === 0) return;
  labels.forEach((label, i) => {
    const name = document.createElement('span'); name.textContent = label;
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('div'); fill.style.width = `${Math.max(0, Math.min(20, vals[i])) * 5}%`;
    bar.appendChild(fill);
    const num = document.createElement('span'); num.textContent = String(vals[i]);
    bars.append(name, bar, num);
  });
}
function initKartSelect() {
  for (const k of SEL_KINDS) {
    const el = $(`sel-${k}`);
    const want = params.has(k) ? String(Number(params.get(k))) : '0';
    el.replaceChildren(...app.part_names(k).map((entry) => {
      const i = entry.indexOf(':');
      const o = document.createElement('option');
      o.value = entry.slice(0, i); o.textContent = entry.slice(i + 1);
      return o;
    }));
    if ([...el.options].some((o) => o.value === want)) el.value = want;
    el.addEventListener('change', updateStatBars);
  }
  $('kartsel').classList.remove('hidden');
  updateStatBars();
}
async function loadStatTables() {
  try {
    const perf = await source.read('Common/Mush/Performance.bin');
    if (perf) app.set_stat_tables(perf);
  } catch (e) { console.warn('stat tables', e); }
  updateStatBars();
}

/** Start a course directly (dev panel / ?course=). */
async function startCourseDirect(name) {
  app.clear_files();
  await readAll([...COURSE_FILES.map((f) => `Course/${name}/${f}`), ...COMMON_FILES], (p, b) => app.add_file(p, b), `reading ${name}`);
  applyRaceOptions();
  await readRequired(app.required_files(name).filter((p) => !p.startsWith('UI/')), 'reading models');
  setStatus(`loading ${name}...`);
  await new Promise((r) => setTimeout(r, 0)); // let the status paint before the blocking parse
  const t0 = performance.now();
  applyRaceOptions();
  app.start_course(name);
  app.clear_files();
  setStatus(`${name} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s - ${app.backend()} - ${app.is_sim() ? '1:1 sim' : 'legacy race'}`);
  running = true;
  document.body.classList.add('racing');
  if (app.has_ui_hud()) document.body.classList.add('uihud');
  window.__mk8Ready = true;
}

function listCourses(paths) {
  const names = new Set();
  for (const path of paths) {
    const m = /^Course\/([^/]+)\/course_kcl\.szs$/.exec(path);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

// The romfs is always the HTTP source (Cache Storage) - see httpSource below. There is no folder
// / zip picker and no IndexedDB store; a server that does not serve a dump at /romfs/ is an error.

/** No game UI (missing archives / unsupported language): plain course list + kart select panel. */
function showCourseFallback(courses, message) {
  setStatus(message);
  courseSel.replaceChildren(...courses.map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; return o; }));
  courseSel.classList.remove('hidden');
  startBtn.classList.remove('hidden');
  initKartSelect();
  loadStatTables();
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try { await startCourseDirect(courseSel.value); } catch (e) { console.error(e); setStatus(`failed: ${e}`); }
  startBtn.disabled = false;
});

function enterMenus() {
  menus = true;
  // Space / Enter must reach the game, not whatever had focus.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.classList.add('menus');
  home = initHome(app, audio);
  home.poll();
  window.__mk8Ready = true;
  // The homemade menu keeps the keyboard while it is up (arrows move its focus ring).
  if (!home.shown) canvas.focus();
}

/** Assets over HTTP from the page's own server (already fetched + cached). */
async function enterHttp() {
  if (DEV_COURSE) {
    initKartSelect();
    loadStatTables();
    try { await startUi(); } catch (e) { console.warn('UI unavailable, text HUD only:', e); }
    try { await startCourseDirect(DEV_COURSE); } catch (e) { console.error(e); setStatus(`failed: ${e}`); }
    return;
  }
  try {
    await startUi();
    enterMenus();
  } catch (e) {
    // The server has the romfs but not the UI archives: list the courses it serves.
    console.error(e);
    const courses = await source.dirs('Course').catch(() => []);
    showCourseFallback(courses, `menus unavailable (${e}); ${courses.length} courses`);
  }
}

// ---- input ----
// Pad bits (crates/mk8-web/src/front.rs `pad`).
const P = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, A: 16, B: 32, PLUS: 64, MINUS: 128, L: 256, R: 512, ZL: 1024, ZR: 2048, X: 4096, Y: 8192, ESC: 16384 };
const KEYMAP = {
  ArrowUp: P.UP, KeyW: P.UP, ArrowDown: P.DOWN, KeyS: P.DOWN, ArrowLeft: P.LEFT, KeyA: P.LEFT, ArrowRight: P.RIGHT, KeyD: P.RIGHT,
  Enter: P.A, NumpadEnter: P.A, Space: P.A, Backspace: P.B, Escape: P.ESC,
  Equal: P.PLUS, NumpadAdd: P.PLUS, KeyP: P.PLUS, Minus: P.MINUS, NumpadSubtract: P.MINUS,
  KeyQ: P.L, KeyE: P.R, ShiftLeft: P.R, ShiftRight: P.R, ControlLeft: P.L, ControlRight: P.L,
  KeyZ: P.ZL, KeyC: P.ZR, KeyX: P.X, KeyY: P.Y,
};
// Gamepad API standard mapping: 0 A (bottom), 1 B (right), 2 X, 3 Y, 4/5 L/R, 6/7 ZL/ZR, 8 -, 9 +, 12-15 d-pad.
const PADMAP = [P.A, P.B, P.X, P.Y, P.L, P.R, P.ZL, P.ZR, P.MINUS, P.PLUS, 0, 0, P.UP, P.DOWN, P.LEFT, P.RIGHT];
const keys = new Set();
window.addEventListener('keydown', (e) => {
  // Form controls of the dev panel keep their keys (not while the game's menus run).
  if (!menus && (e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) return;
  if (mobile && !e.repeat && !(e.target instanceof HTMLInputElement)) mobile.noteExternalInput();
  keys.add(e.code);
  if (home && home.shown) return; // the homemade menu uses the keys natively
  if ((menus || running) && KEYMAP[e.code] !== undefined) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function pollPad() {
  let bits = 0;
  for (const k of keys) bits |= KEYMAP[k] || 0;
  let sx = 0; let sy = 0;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    gp.buttons.forEach((b, i) => { if (b && b.pressed && PADMAP[i]) bits |= PADMAP[i]; });
    const x = gp.axes[0] || 0; const y = gp.axes[1] || 0;
    if (mobile && (bits || Math.abs(x) > 0.3 || Math.abs(y) > 0.3)) mobile.noteExternalInput();
    if (Math.abs(x) > 0.15) sx = Math.max(-1, Math.min(1, x));
    if (Math.abs(y) > 0.15) sy = -Math.max(-1, Math.min(1, y));
    if (x < -0.5) bits |= P.LEFT;
    if (x > 0.5) bits |= P.RIGHT;
    if (y < -0.5) bits |= P.UP;
    if (y > 0.5) bits |= P.DOWN;
  }
  // Touch controls / tilt (www/mobile.js): held buttons and the stick, merged with the rest.
  if (mobile) {
    const t = mobile.poll(performance.now());
    if (t.active) {
      bits |= t.bits;
      if (t.sx !== 0) sx = Math.max(-1, Math.min(1, t.sx));
      if (t.sy !== 0) sy = Math.max(-1, Math.min(1, t.sy));
    }
  }
  if (AUTODRIVE_S > 0 && app) {
    if (autodriveStart === null && app.race_phase() === 'racing') autodriveStart = performance.now();
    if (autodriveStart !== null) {
      if (performance.now() - autodriveStart < AUTODRIVE_S * 1000) bits |= P.A;
      else window.__mk8AutodriveDone = true;
    }
  }
  return { bits, sx, sy };
}

/** Race controls for the direct entry without the game UI. */
function raceInput(bits, sx) {
  const b = (m) => (bits & m) !== 0;
  const steer = sx !== 0 ? sx : (b(P.RIGHT) ? 1 : 0) - (b(P.LEFT) ? 1 : 0);
  return { accel: b(P.A) || b(P.UP), brake: b(P.B) || b(P.DOWN), steer, drift: b(P.R) || b(P.ZR), item: b(P.L) || b(P.ZL) };
}

// ---- sizing: 16:9 letterboxed (the layouts are 1280x720), minus the ad gutters ----
function resize() {
  const ww = window.innerWidth; const wh = window.innerHeight;
  // Desktop: the ad ring (www/ads.js) gets a band on each side; the canvas stays centred.
  const ins = adFrame(ww, wh);
  const w = Math.min(ww - ins.l - ins.r, (wh - ins.t - ins.b) * 16 / 9); const h = w * 9 / 16;
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  // Phones: the profile caps the backing store (1.5x: a 2.6x phone screen at 1280 CSS px would
  // be 3300 px wide, more than its GPU fills at 60 fps).
  const dpr = Math.min(window.devicePixelRatio || 1, mobile ? mobile.dprCap : 2);
  const bw = Math.max(1, Math.floor(w * dpr));
  const bh = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw; canvas.height = bh;
    if (app) app.resize(bw, bh);
  }
}
window.addEventListener('resize', resize);

// ---- fullscreen button (index.html #fs-btn) ----
// Toggles the whole page; resizing (and entering/leaving fullscreen) re-fits the letterboxed canvas.
const fsBtn = $('fs-btn');
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function fsSync() {
  const on = !!fsEl();
  fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
  fsBtn.setAttribute('aria-pressed', String(on));
}
if (fsBtn) {
  if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) fsBtn.hidden = true; // unsupported (iOS Safari)
  fsBtn.addEventListener('click', async () => {
    try {
      if (fsEl()) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch (e) { console.info('fullscreen unavailable:', e && e.message ? e.message : e); }
    fsSync();
  });
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { fsSync(); resize(); });
  fsSync();
}

// ---- one-time "what's new" notice (index.html #news): once per browser, per NEWS version ----
const NEWS = 'v4';
const newsEl = $('news');
if (newsEl) {
  let seen = null;
  try { seen = localStorage.getItem('mk8-news'); } catch { /* storage off */ }
  if (seen === NEWS) newsEl.remove();
  else {
    newsEl.hidden = false;
    let closed = false;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => {
      if (closed) return;
      closed = true;
      newsEl.remove();
      document.removeEventListener('keydown', onKey, true);
      try { localStorage.setItem('mk8-news', NEWS); } catch { /* storage off */ }
    };
    const ok = $('news-ok');
    if (ok) ok.addEventListener('click', close);
    newsEl.addEventListener('click', (e) => { if (e.target === newsEl) close(); }); // click the backdrop
    document.addEventListener('keydown', onKey, true);
  }
}

// ---- online lockstep ----
const NET_TICK = 1 / 60;
let netAcc = 0;
window.__mk8StateHash = null;
window.__mk8Checksums = {};
function netStep(dt) {
  if (!app.net_ready() || !net.racing()) { netAcc = 0; return; }
  netAcc += dt;
  let ticks = 0;
  while (netAcc >= NET_TICK && ticks < 8) {
    netAcc -= NET_TICK;
    ticks++;
    const i = app.net_input();
    // Far behind (loading, background tab, rejoin replay): simulate more frames per tick.
    const maxSteps = net.buffered() > 120 ? 30 : 8;
    const cmds = net.tick(i[0], i[1], i[2], maxSteps);
    if (cmds.length === 0) continue;
    const cs = app.step_net(cmds);
    for (let k = 0; k + 1 < cs.length; k += 2) {
      const frame = Number(cs[k]);
      net.reportChecksum(frame, cs[k + 1]);
      const hash = cs[k + 1].toString(16).padStart(16, '0');
      window.__mk8StateHash = { frame, hash };
      window.__mk8Checksums[frame] = hash;
    }
  }
  if (ticks === 8) netAcc = 0; // don't build up a backlog of local ticks
  net.flush();
}

const tagsEl = $('kart-tags');
const tagEls = new Map();
let tagNames = null;
function drawTags() {
  const labels = app && app.net_ready() ? app.kart_labels() : [];
  if (labels.length && !tagNames) { const r = net.race(); tagNames = r ? r.slots.map((sl) => sl.name) : []; }
  if (!app || !app.net_ready()) tagNames = null;
  const seen = new Set();
  const rect = canvas.getBoundingClientRect();
  for (let k = 0; k + 3 < labels.length; k += 4) {
    const kart = labels[k];
    seen.add(kart);
    let el = tagEls.get(kart);
    if (!el) { el = document.createElement('span'); tagsEl.append(el); tagEls.set(kart, el); }
    el.textContent = (tagNames && tagNames[kart]) || '';
    el.style.left = `${rect.left + labels[k + 1] * rect.width}px`;
    el.style.top = `${rect.top + labels[k + 2] * rect.height}px`;
    el.style.opacity = labels[k + 3] > 3000 ? '0' : '1';
  }
  for (const [kart, el] of tagEls) if (!seen.has(kart)) { el.remove(); tagEls.delete(kart); }
}

// ---- main loop ----
// Frame-time metrics (read by tools/web-smoke.mjs): averages over the last 120 frames of the
// requestAnimationFrame interval (window.__mk8FrameMs) and the time spent inside app.frame()
// (window.__mk8CpuMs, CPU side only; GPU work shows up in the interval).
const FRAME_WINDOW = 120;
const frameIntervals = [];
const frameCpu = [];
const pushMetric = (arr, v) => { arr.push(v); if (arr.length > FRAME_WINDOW) arr.shift(); return arr.reduce((a, b) => a + b, 0) / arr.length; };
window.__mk8FrameMs = 0;
window.__mk8CpuMs = 0;
window.__mk8FrameCount = 0;
let last = performance.now();
let halfParity = 0;
function loop(now) {
  // 30 fps mode (www/mobile.js): every other animation frame is skipped; `last` is not moved,
  // so the next frame steps the simulation twice (two 1/60 s ticks) and draws once.
  if (mobile && mobile.halfRate() && (halfParity ^= 1) === 1) { requestAnimationFrame(loop); return; }
  const dt = Math.min((now - last) / 1000, 0.25);
  const active = app && (running || menus);
  if (active) {
    window.__mk8FrameMs = pushMetric(frameIntervals, now - last);
    window.__mk8FrameCount += 1;
  }
  last = now;
  resize();
  if (app) {
    const pad = home && home.shown ? { bits: 0, sx: 0, sy: 0 } : pollPad();
    if (home && home.shown && mobile) mobile.poll(now); // keeps the overlay mode / body classes right
    app.set_pad(pad.bits, pad.sx, pad.sy);
    if (controlsCard) { try { controlsCard.poll(now, pad); } catch (e) { console.warn('controls card:', e); controlsCard = null; } }
    if (running) {
      const i = raceInput(pad.bits, pad.sx);
      app.set_input(i.accel, i.brake, i.steer, i.drift, i.item);
    }
    const c0 = performance.now();
    netStep(dt);
    app.frame(dt);
    if (audio) audio.tick();
    drawTags();
    if (active) window.__mk8CpuMs = pushMetric(frameCpu, performance.now() - c0);
    // Kart scene / draw-call counters for the performance tools (see App::perf_stats).
    if (active && typeof app.perf_stats === 'function' && window.__mk8FrameCount % 30 === 0) window.__mk8Perf = Array.from(app.perf_stats());
    if (menus) {
      home.poll();
      window.__mk8Screen = home.shown ? 'Home' : app.screen_name();
      if (!loadBusy) {
        const req = app.load_request();
        if (req) loadRace(req);
      }
    }
    if (running && !app.has_ui_hud()) hudEl.textContent = app.hud();
  }
  requestAnimationFrame(loop);
}

async function main() {
  // The glue and its wasm. Served build: both names come from pkg/manifest.json, fetched fresh
  // on every load, so this page and the bundle are always from the same build; the wasm URL is
  // passed explicitly (the hashed glue's own default is the same file).
  let init;
  let wasm;
  const pkgMod = await import(await pkgUrl('mk8_web.js'));
  ({ default: init, App, version } = pkgMod);
  // The one initialised glue module: other modules (www/net.js) use it instead of importing the
  // glue themselves, which could resolve to a stale cached copy that was never initialised.
  window.__mk8Pkg = pkgMod;
  wasm = await init({ module_or_path: await pkgUrl('mk8_web_bg.wasm') });
  // Linear memory size for the performance tools (bytes; the wasm heap never shrinks).
  window.__mk8WasmMemory = () => (wasm && wasm.memory ? wasm.memory.buffer.byteLength : -1);
  canvas.tabIndex = 0;
  resize();
  try {
    // WebGL2 by default; ?gpu=webgpu opts into WebGPU (unreliable on Linux browsers today).
    app = await App.new_with_backend(canvas, params.get('gpu') === 'webgpu');
    window.__mk8App = app;
    // Sound: the context starts suspended until the first click / key (autoplay policy).
    if (params.get('audio') !== '0') {
      try { audio = initAudio(app, () => source); } catch (e) { console.warn('audio disabled:', e); audio = null; }
    }
    // Device profile + touch controls (www/mobile.js): before any race loads (texture caps).
    try {
      mobile = initMobile(app, {
        screen: () => (menus ? app.screen_name() : running ? 'InRace' : ''),
        home: () => !!(home && home.shown),
        racing: () => (running && !menus) || (menus && !(home && home.shown) && app.screen_name() === 'InRace'),
        gameMenu: () => menus && !(home && home.shown),
        audio,
      });
      resize();
    } catch (e) { console.warn('mobile support disabled:', e); mobile = null; }
    try { controlsCard = initControlsCard(app, { touch: () => !!(mobile && mobile.isTouch && document.getElementById('touch') && !document.getElementById('touch').hidden) }); } catch (e) { console.warn('controls card disabled:', e); }
    app.set_autopilot(params.get('autopilot') === '1');
    app.set_time_scale(Number(params.get('timescale') || 1));
    // Grid size (feature-detected: older wasm builds race the game's 12).
    const racers = Number(params.get('racers') || 0);
    if (racers >= 2 && typeof app.set_grid_size === 'function') app.set_grid_size(Math.min(255, Math.floor(racers)));
    if (params.get('occlusion') === '0' && typeof app.set_occlusion_culling === 'function') app.set_occlusion_culling(false);
    setStatus(`mk8-web v${version()} - ${app.backend()}`);
    const bv = $('brand-ver');
    const backend = /^gl\b/i.test(app.backend()) ? 'WebGL2' : /gpu/i.test(app.backend()) ? 'WebGPU' : app.backend().split(' ')[0];
    if (bv) bv.textContent = `v${version()} - ${backend}`;
  } catch (e) {
    console.error(e);
    setStatus(`graphics init failed: ${e}`);
    statusEl.parentElement.classList.add('done');
    return;
  }
  requestAnimationFrame(loop);
  // A copy of the site (another domain relaying every request to this server) stops here: the
  // server lists the sites it is served as (/healthz `site`, sha-256 of each origin;
  // --site-origin) and this page's own origin must be one of them. Hashes survive a relay
  // that rewrites the domain in every response; without the setting (local play) anything goes.
  const site = await siteAllowed();
  if (site !== true) {
    const m = `This is a copy of the game on another site${site ? ` - play at ${site}` : ''}.`;
    console.error(m);
    setStatus(m);
    statusEl.parentElement.classList.add('done');
    const box = document.createElement('div');
    box.id = 'wrong-site';
    box.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:#061a44;color:#fff;font:800 22px/1.4 sans-serif;text-align:center;padding:24px';
    const text = document.createElement('div');
    text.textContent = 'You are on a copy of this game on another site.';
    if (site) { const a = document.createElement('a'); a.href = site; a.textContent = `Play at ${site}`; a.style.cssText = 'display:block;margin-top:16px;color:#ffd400'; text.append(a); }
    box.append(text);
    document.body.append(box);
    return;
  }
  registerServiceWorker();
  if (CLEAR_CACHE) { await clearRomfsCache(); }
  // Game files always come from the server that served the page, at /romfs/, streamed into
  // Cache Storage. A server that does not serve a dump there cannot run the game.
  source = httpSource(ROMFS_BASE);
  if (!(await source.available())) {
    const m = `no game files served at ${ROMFS_BASE} - this server must host a romfs dump at /romfs/ (see README §5)`;
    console.error(m);
    setStatus(`mk8-web v${version()} - ${app.backend()} - ${m}`);
    statusEl.parentElement.classList.add('done');
    source = null;
    return;
  }
  await enterHttp();
}
/** True when this page is served from one of the server's own origins (or the server names
 *  none); otherwise the real site's URL (or '' when it is not known). Fails open: no healthz,
 *  no WebCrypto (plain-http LAN play) or no `site` field = allowed. */
async function siteAllowed() {
  try {
    const r = await fetch(new URL('/healthz', location.href), { cache: 'no-store' });
    if (!r.ok) return true;
    const h = await r.json();
    if (!Array.isArray(h.site) || !h.site.length) return true;
    if (!(crypto && crypto.subtle)) return true;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.origin.toLowerCase()));
    const hex = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
    return h.site.includes(hex) ? true : (typeof h.site_url === 'string' ? h.site_url : '');
  } catch { return true; }
}

/** The app shell service worker (www/sw.js): secure served pages only (never file://); it caches
 *  www/ + pkg/ and nothing else. `?sw=0` skips it. */
function registerServiceWorker() {
  if (params.get('sw') === '0') return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext || location.protocol === 'file:') return;
  try {
    const url = new URL('./sw.js', import.meta.url);
    const scope = new URL('./', import.meta.url).pathname;
    navigator.serviceWorker.register(url.href, { scope }).then((r) => console.info(`service worker: ${r.scope}`)).catch((e) => console.warn('service worker:', e && e.message ? e.message : e));
  } catch (e) { console.warn('service worker:', e); }
}

main();
