// Phones and tablets (docs/MOBILE.md): on-screen controls, tilt steering, the touch mapping of
// the game's own menus, landscape / fullscreen handling, haptics, the device profile and the
// "Phone & tablet" options. Desktop pages are unaffected: the overlay only shows on a coarse
// pointer (or `?touch=1`), the profile only switches on a touch device (or `?profile=mobile`).
//
// Controls (markup in www/index.html `#touch`, styles in www/mobile.css):
// * race: the left half of the screen is a floating stick (steer; up / down = accelerate /
//   brake when that option is on), the right side has A (accelerate), B (brake / reverse),
//   R (hop / drift), L (item) and a look-back button; pause at the top. Multi-touch: every
//   pointer is tracked by id, a finger may slide from one button to the next.
// * the game's menus (character / kart / cup select, pause, results): a d-pad with A / B on
//   the right, and gestures on the canvas (`App.touch_nav_*`, crates/mk8-web/src/mobile.rs):
//   swipe = cursor step, tap = A, long press = B.
// * the page's own menu (www/home.js) is plain HTML: nothing to add.
// * tilt steering: `deviceorientation` -> `App.tilt_sample` (iOS asks permission on the first
//   touch after it is turned on); "Calibrate" takes the current attitude as straight.
// The overlay hides when a keyboard or gamepad is used (`noteExternalInput`) and comes back
// on the next touch. `poll()` merges everything into pad bits + stick for main.js every frame.
//
// Settings (localStorage 'mk8.mobile'): controls auto / on / off, tilt, stickAccel, halfRate
// (draw every other frame; the sim still steps 60 Hz), haptics, fullscreen (on race start).

const SAVE = 'mk8.mobile';
const P = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, A: 16, B: 32, PLUS: 64, MINUS: 128, L: 256, R: 512 };
const STICK_RADIUS = 60; // px of travel for full lock
const STICK_DEAD = 0.12;
const DEFAULTS = { controls: 'auto', tilt: false, stickAccel: true, halfRate: false, haptics: true, fullscreen: true };

const $ = (id) => document.getElementById(id);

export function loadMobileSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SAVE) || '{}') }; } catch { return { ...DEFAULTS }; }
}

/** Device facts shared with main.js before the App exists. */
export function deviceInfo() {
  const params = new URLSearchParams(location.search);
  const ua = navigator.userAgent || '';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touchPoints = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  const mobileUa = /Android|iP(hone|ad|od)|Mobile|Silk/.test(ua) || isIOS;
  const touch = params.get('touch') === '1' || (coarse && touchPoints);
  const forced = params.get('profile');
  const profile = forced === 'mobile' || forced === 'desktop' ? forced : (touch || mobileUa ? 'mobile' : 'desktop');
  const standalone = window.navigator.standalone === true || (typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches));
  return { coarse, touchPoints, isIOS, mobileUa, touch, profile, standalone };
}

/**
 * @param app the wasm App (feature-detected: older builds lack the mobile exports)
 * @param hooks { screen() -> string, home() -> bool, racing() -> bool, gameMenu() -> bool, audio }
 */
export function initMobile(app, hooks) {
  const info = deviceInfo();
  let settings = loadMobileSettings();
  const save = () => { try { localStorage.setItem(SAVE, JSON.stringify(settings)); } catch { /* private mode */ } };
  const has = (f) => typeof app[f] === 'function';
  const debug = { profile: 'desktop', shown: false, mode: 'none', bits: 0, sx: 0, sy: 0, tilt: false, tiltSteer: 0, tiltSamples: 0, fullscreen: false, haptics: 0 };
  window.__mk8Mobile = debug;

  // ---- device profile (crates/mk8-web/src/mobile.rs) ----
  let profile = 'desktop';
  if (has('set_device_profile')) {
    profile = app.set_device_profile(info.profile) || 'desktop';
    if (profile !== info.profile) console.warn(`device profile ${info.profile} unknown to this build; ${profile}`);
    console.info(`device profile: ${app.device_profile ? app.device_profile() : profile}`);
  }
  debug.profile = profile;
  const dprCap = has('device_dpr_cap') ? Number(app.device_dpr_cap()) || 2 : (profile === 'mobile' ? 1.5 : 2);

  // ---- overlay ----
  const root = $('touch');
  if (!root) {
    return { profile, dprCap, isTouch: info.touch, poll: () => ({ bits: 0, sx: 0, sy: 0, active: false }), halfRate: () => settings.halfRate, noteExternalInput() {}, settings: () => settings, setSettings() {} };
  }
  const zone = $('t-zone');
  const knob = $('t-knob');
  const base = $('t-base');
  const gesture = $('t-gesture');
  const hasNav = ['touch_nav_begin', 'touch_nav_move', 'touch_nav_end', 'touch_nav_cancel', 'touch_nav_poll'].every(has);
  let shown = false;
  let mode = 'none';
  const pressed = new Map(); // pointerId -> button element
  let stick = null; // { id, ox, oy, x, y }
  let mstick = null; // menu joystick: { id, cx, cy, x, y } (fixed base, #t-mstick)
  const mstickEl = document.getElementById('t-mstick'); const mknob = document.getElementById('t-mknob');
  const MSTICK_RADIUS = 48;
  let navId = null;
  let look = false;
  const vibrate = (ms) => {
    if (!settings.haptics || typeof navigator.vibrate !== 'function') return;
    try { if (navigator.vibrate(ms)) debug.haptics++; } catch { /* blocked */ }
  };

  function setShown(on) {
    if (shown === on) return;
    shown = on;
    debug.shown = on;
    document.body.classList.toggle('touch-on', on);
    root.hidden = !on;
    if (!on) releaseAll();
  }
  function releaseAll() {
    for (const el of pressed.values()) el.classList.remove('on');
    pressed.clear();
    stick = null;
    mstickUp();
    base.hidden = true;
    if (navId !== null && hasNav) app.touch_nav_cancel();
    navId = null;
    if (look) { look = false; if (has('set_rear_view')) app.set_rear_view(false); }
  }
  function press(id, el) {
    const prev = pressed.get(id);
    if (prev === el) return;
    if (prev) { prev.classList.remove('on'); if (prev.dataset.look !== undefined) setLook(false); }
    pressed.set(id, el);
    el.classList.add('on');
    if (el.dataset.look !== undefined) setLook(true);
  }
  function release(id) {
    const el = pressed.get(id);
    if (!el) return;
    el.classList.remove('on');
    if (el.dataset.look !== undefined) setLook(false);
    pressed.delete(id);
  }
  function setLook(on) {
    if (look === on) return;
    look = on;
    if (has('set_rear_view')) app.set_rear_view(on);
  }
  function stickDown(e) {
    const r = zone.getBoundingClientRect();
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
    base.hidden = false;
    base.style.left = `${e.clientX - r.left}px`; base.style.top = `${e.clientY - r.top}px`;
    knob.style.transform = 'translate(-50%, -50%)';
  }
  function stickMove(e) {
    let dx = (e.clientX - stick.ox) / STICK_RADIUS; let dy = (e.clientY - stick.oy) / STICK_RADIUS;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    knob.style.transform = `translate(calc(-50% + ${dx * STICK_RADIUS}px), calc(-50% + ${dy * STICK_RADIUS}px))`;
    const dead = (v) => (Math.abs(v) < STICK_DEAD ? 0 : (v - Math.sign(v) * STICK_DEAD) / (1 - STICK_DEAD));
    stick.x = dead(dx); stick.y = -dead(dy);
  }
  function mstickDown(e) {
    const r = mstickEl.getBoundingClientRect();
    mstick = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: 0, y: 0 };
  }
  function mstickMove(e) {
    let dx = (e.clientX - mstick.cx) / MSTICK_RADIUS; let dy = (e.clientY - mstick.cy) / MSTICK_RADIUS;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    if (mknob) mknob.style.transform = `translate(${dx * MSTICK_RADIUS}px, ${dy * MSTICK_RADIUS}px)`;
    mstick.x = dx; mstick.y = -dy;
  }
  function mstickUp() { mstick = null; if (mknob) mknob.style.transform = ''; }
  const targetButton = (x, y) => { const el = document.elementFromPoint(x, y); return el ? el.closest('#touch .tb') : null; };

  root.addEventListener('pointerdown', (e) => {
    if (!shown) return;
    e.preventDefault();
    try { root.setPointerCapture(e.pointerId); } catch { /* fine */ }
    const t = e.target instanceof Element ? e.target.closest('.tb') : null;
    if (t) { press(e.pointerId, t); return; }
    if (mode === 'race' && e.target instanceof Element && e.target.closest('#t-zone')) { stickDown(e); stickMove(e); return; }
    if (mode === 'menu' && mstickEl && e.target instanceof Element && e.target.closest('#t-mstick')) { mstickDown(e); mstickMove(e); return; }
    if (mode === 'menu' && hasNav && e.target instanceof Element && e.target.closest('#t-gesture')) {
      navId = e.pointerId;
      app.touch_nav_begin(e.clientX, e.clientY, e.timeStamp);
    }
  });
  root.addEventListener('pointermove', (e) => {
    if (stick && e.pointerId === stick.id) { stickMove(e); return; }
    if (mstick && e.pointerId === mstick.id) { mstickMove(e); return; }
    if (e.pointerId === navId && hasNav) { app.touch_nav_move(e.clientX, e.clientY, e.timeStamp); return; }
    const cur = pressed.get(e.pointerId);
    if (cur) {
      const el = targetButton(e.clientX, e.clientY);
      if (el && el !== cur && el.closest('.cluster') === cur.closest('.cluster')) press(e.pointerId, el);
    }
  });
  const up = (e) => {
    if (stick && e.pointerId === stick.id) { stick = null; base.hidden = true; }
    if (mstick && e.pointerId === mstick.id) mstickUp();
    if (e.pointerId === navId && hasNav) {
      if (e.type === 'pointercancel') app.touch_nav_cancel(); else app.touch_nav_end(e.clientX, e.clientY, e.timeStamp);
      navId = null;
    }
    release(e.pointerId);
    maybeEnableTiltFromGesture();
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('lostpointercapture', (e) => {
    if (pressed.has(e.pointerId) || (stick && stick.id === e.pointerId) || navId === e.pointerId) up({ pointerId: e.pointerId, type: 'pointercancel', clientX: 0, clientY: 0, timeStamp: e.timeStamp });
  });
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- show / hide ----
  const autoShow = () => settings.controls === 'on' || (settings.controls === 'auto' && info.touch);
  setShown(autoShow());
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && settings.controls === 'auto') setShown(true);
  }, { capture: true, passive: true });
  // Fullscreen needs a user activation: the release of a touch (pointerdown is not one).
  document.addEventListener('pointerup', () => { if (wantFs) requestFullscreen(); }, { capture: true, passive: true });
  // iOS: no pinch zoom / double-tap zoom while the game is up (the home menu may scroll).
  document.addEventListener('gesturestart', (e) => { if (document.body.classList.contains('ingame')) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('ingame') || e.target === root || root.contains(e.target)) e.preventDefault(); }, { passive: false });
  // The overlay is not clickable for mice (a desktop with a touch screen still gets it).
  root.addEventListener('dblclick', (e) => e.preventDefault());

  // ---- fullscreen + orientation ----
  let wantFs = false;
  let lastScreen = '';
  async function requestFullscreen() {
    wantFs = false;
    if (!settings.fullscreen || document.fullscreenElement || document.webkitFullscreenElement) return;
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else return;
      debug.fullscreen = true;
      if (screen.orientation && typeof screen.orientation.lock === 'function') screen.orientation.lock('landscape').catch(() => {});
    } catch (e) { console.info('fullscreen unavailable:', e && e.message ? e.message : e); }
  }
  document.addEventListener('fullscreenchange', () => { debug.fullscreen = !!document.fullscreenElement; });

  // ---- tilt ----
  let tiltListening = false;
  let tiltPending = false; // enable on the next user gesture (iOS permission prompt)
  const screenAngle = () => (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (typeof window.orientation === 'number' ? window.orientation : 0);
  const onOrient = (e) => {
    if (e.beta === null || e.beta === undefined) return;
    if (has('tilt_sample')) debug.tiltSteer = app.tilt_sample(e.beta, e.gamma, screenAngle());
    debug.tiltSamples++;
  };
  async function setTilt(on, fromGesture) {
    if (!has('set_tilt_enabled')) return false;
    if (on) {
      const DOE = window.DeviceOrientationEvent;
      if (!DOE) { note('This browser has no orientation sensor.'); return false; }
      if (typeof DOE.requestPermission === 'function') {
        if (!fromGesture) { tiltPending = true; settings.tilt = true; save(); return true; }
        try {
          const r = await DOE.requestPermission();
          if (r !== 'granted') { note('Tilt steering needs the motion permission (Settings > Safari > Motion & Orientation Access).'); settings.tilt = false; save(); syncOptions(); return false; }
        } catch (e) { note(`Tilt permission: ${e && e.message ? e.message : e}`); settings.tilt = false; save(); syncOptions(); return false; }
      }
      tiltPending = false;
      if (!tiltListening) { window.addEventListener('deviceorientation', onOrient); tiltListening = true; }
      app.set_tilt_enabled(true);
      debug.tilt = true;
    } else {
      tiltPending = false;
      app.set_tilt_enabled(false);
      debug.tilt = false;
    }
    settings.tilt = on; save(); syncOptions();
    return on;
  }
  function maybeEnableTiltFromGesture() {
    if (tiltPending) setTilt(true, true);
  }
  if (settings.tilt) setTilt(true, false);

  // ---- haptics from the race state (hits, boosts, mini-turbo charge) ----
  let hap = { damage: -1, boost: false, tier: 0, trick: 0 };
  let hapTick = 0;
  function pollHaptics() {
    if (!settings.haptics || typeof navigator.vibrate !== 'function' || !has('debug_kart_anim')) return;
    if ((hapTick++ & 3) !== 0) return;
    let a;
    try { a = JSON.parse(app.debug_kart_anim(-1) || 'null'); } catch { a = null; }
    if (!a) return;
    if (a.damage >= 0 && hap.damage < 0) vibrate(45);
    if (a.boost && !hap.boost) vibrate(18);
    if (a.tier > hap.tier) vibrate(10);
    if (a.trickKind !== hap.trick && a.tricks) vibrate(12);
    hap = { damage: a.damage, boost: !!a.boost, tier: a.tier || 0, trick: a.trickKind };
  }

  // ---- per frame ----
  function poll(now) {
    const home = hooks.home();
    const racing = hooks.racing();
    const next = home ? 'home' : racing ? 'race' : hooks.gameMenu() ? 'menu' : 'none';
    if (next !== mode) {
      mode = next;
      debug.mode = mode;
      root.dataset.mode = mode;
      releaseAll();
    }
    const screen = hooks.screen();
    if (screen !== lastScreen) {
      if (screen === 'Loading' && settings.fullscreen && info.touch) wantFs = true;
      lastScreen = screen;
    }
    document.body.classList.toggle('ingame', mode === 'race' || mode === 'menu');
    if (!shown || mode === 'home' || mode === 'none') return { bits: 0, sx: 0, sy: 0, active: false };
    let bits = 0; let sx = 0; let sy = 0;
    for (const el of pressed.values()) bits |= Number(el.dataset.bits) || 0;
    if (mode === 'race') {
      if (stick) {
        sx = stick.x; sy = stick.y;
        if (settings.stickAccel) { if (sy > 0.55) bits |= P.A; if (sy < -0.55) bits |= P.B; }
      } else if (settings.tilt && has('tilt_steer')) {
        sx = app.tilt_steer();
      }
      pollHaptics();
    } else if (mode === 'menu') {
      if (hasNav) bits |= app.touch_nav_poll(now);
      // Menu joystick: deflection past the dead zone holds the matching d-pad direction (the
      // game's own menus do their own edge detection and auto-repeat, exactly like a held key).
      if (mstick) {
        const ax = Math.abs(mstick.x); const ay = Math.abs(mstick.y);
        if (Math.max(ax, ay) > 0.45) {
          if (ax >= ay) bits |= mstick.x > 0 ? P.RIGHT : P.LEFT; else bits |= mstick.y > 0 ? P.UP : P.DOWN;
        }
      }
    }
    debug.bits = bits; debug.sx = sx; debug.sy = sy;
    return { bits, sx, sy, active: true };
  }

  // ---- options (injected into the home menu's Options drawer) ----
  let optionEls = null;
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (optionEls) optionEls.install.hidden = false; });
  function note(m) { if (optionEls) optionEls.note.textContent = m || ''; else if (m) console.info(m); }
  function syncOptions() {
    if (!optionEls) return;
    optionEls.controls.value = settings.controls;
    optionEls.tilt.checked = !!settings.tilt;
    optionEls.stickAccel.checked = !!settings.stickAccel;
    optionEls.halfRate.checked = !!settings.halfRate;
    optionEls.haptics.checked = !!settings.haptics;
    optionEls.fullscreen.checked = !!settings.fullscreen;
  }
  // The persistent file store opens after the App (main.js): wired when it is there.
  function injectOptions() {
    const grid = document.querySelector('#options .opt-grid');
    if (!grid || $('mobile-box')) return;
    const fs = document.createElement('fieldset');
    fs.id = 'mobile-box';
    fs.innerHTML = `
      <legend>Phone &amp; tablet</legend>
      <div class="row"><label for="mob-controls">On-screen controls</label>
        <select id="mob-controls"><option value="auto">auto (touch screens)</option><option value="on">always</option><option value="off">off</option></select></div>
      <div class="row"><label><input type="checkbox" id="mob-tilt"> Tilt steering</label> <button class="small" id="mob-cal">Calibrate</button></div>
      <div class="row"><label><input type="checkbox" id="mob-stickaccel"> Stick up / down = accelerate / brake</label></div>
      <div class="row"><label><input type="checkbox" id="mob-half"> 30 fps mode (saves battery; the race still runs at 60 Hz)</label></div>
      <div class="row"><label><input type="checkbox" id="mob-haptics"> Vibration on hits and boosts</label></div>
      <div class="row"><label><input type="checkbox" id="mob-fs"> Fullscreen when a race starts</label></div>
      <div class="row"><button class="small" id="mob-install" hidden>Install as an app</button></div>
      <p class="note" id="mob-note"></p>
      <p class="note">${profile === 'mobile' ? 'Mobile graphics profile: no anti-aliasing, smaller textures, fewer animated drivers, big optional sound files skipped.' : 'Desktop graphics profile.'} Race: left half = steering stick, right side = buttons. Menus: joystick or swipe = move, tap = OK, hold = back.</p>`;
    grid.append(fs);
    optionEls = { controls: $('mob-controls'), tilt: $('mob-tilt'), stickAccel: $('mob-stickaccel'), halfRate: $('mob-half'), haptics: $('mob-haptics'), fullscreen: $('mob-fs'), install: $('mob-install'), note: $('mob-note') };
    syncOptions();
    optionEls.controls.addEventListener('change', () => { settings.controls = optionEls.controls.value; save(); setShown(autoShow()); });
    optionEls.tilt.addEventListener('change', () => { setTilt(optionEls.tilt.checked, true); });
    $('mob-cal').addEventListener('click', () => {
      if (has('calibrate_tilt')) app.calibrate_tilt();
      note(has('tilt_samples') && app.tilt_samples() === 0 ? 'No sensor data yet: turn tilt steering on (and allow motion access) first.' : 'Calibrated: hold the phone like this to drive straight.');
      vibrate(10);
    });
    optionEls.stickAccel.addEventListener('change', () => { settings.stickAccel = optionEls.stickAccel.checked; save(); });
    optionEls.halfRate.addEventListener('change', () => { settings.halfRate = optionEls.halfRate.checked; save(); });
    optionEls.haptics.addEventListener('change', () => { settings.haptics = optionEls.haptics.checked; save(); if (settings.haptics) vibrate(15); });
    optionEls.fullscreen.addEventListener('change', () => { settings.fullscreen = optionEls.fullscreen.checked; save(); });
    optionEls.install.hidden = !installPrompt;
    optionEls.install.addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); try { await installPrompt.userChoice; } catch { /* dismissed */ } installPrompt = null; optionEls.install.hidden = true; });
    if (info.isIOS && !info.standalone) {
      const p = document.createElement('p'); p.className = 'note';
      p.textContent = 'iPhone / iPad: for a fullscreen app add this page to the Home Screen (Share > Add to Home Screen).';
      fs.append(p);
    }
  }
  injectOptions();

  return {
    profile,
    dprCap,
    isTouch: info.touch,
    info,
    poll,
    halfRate: () => !!settings.halfRate,
    /** A keyboard or gamepad was used: hide the overlay (auto mode). */
    noteExternalInput() { if (settings.controls === 'auto') setShown(false); },
    settings: () => ({ ...settings }),
    setSettings(s) { settings = { ...settings, ...s }; save(); syncOptions(); setShown(autoShow()); },
    requestFullscreen,
    setTilt: (on) => setTilt(on, true),
  };
}
