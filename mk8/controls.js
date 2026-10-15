// Race-start controls card: while a race starts (the course intro and the 3-2-1 countdown) a
// card in the lower middle of the screen shows the race controls for the device in use -
// keyboard, gamepad (when one is connected) or the touch layout - with big key caps. It fades
// out a few seconds after GO, or as soon as the player has used both accelerate and steer
// once the race runs. It never takes input (pointer-events: none). Keys match main.js KEYMAP /
// PADMAP and the touch overlay of mobile.js.

const KEYBOARD = [
  ['Accelerate', ['Space', 'W']],
  ['Steer', ['←', '→']],
  ['Brake / reverse', ['S']],
  ['Hop & drift', ['Shift', 'E']],
  ['Use item', ['Ctrl', 'Q']],
  ['Pause', ['Esc']],
];
const GAMEPAD = [
  ['Accelerate', ['A']],
  ['Steer', ['Left stick']],
  ['Brake / reverse', ['B']],
  ['Hop & drift', ['R', 'ZR']],
  ['Use item', ['L', 'ZL']],
  ['Pause', ['+']],
];
const TOUCH = [
  ['Steer', ['Slide on the left half']],
  ['Accelerate', ['A']],
  ['Brake / reverse', ['B']],
  ['Hop & drift', ['R']],
  ['Use item', ['L']],
];
const CSS = `
#race-controls { position: fixed; left: 50%; bottom: 9%; transform: translateX(-50%); z-index: 30; pointer-events: none;
  background: rgba(6, 26, 68, 0.86); border: 3px solid #fff; border-radius: 18px; padding: 12px 18px 14px; color: #fff;
  font: 800 15px/1.2 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); opacity: 0; transition: opacity 0.5s ease;
  max-width: calc(100vw - 32px); box-sizing: border-box; }
#race-controls.on { opacity: 1; }
#race-controls h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #ffd400; text-align: center; }
#race-controls ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, auto); gap: 8px 22px; }
#race-controls li { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
#race-controls .keys { display: flex; gap: 4px; }
#race-controls kbd { display: inline-block; min-width: 26px; padding: 3px 8px; border-radius: 7px; background: #fff; color: #061a44;
  border-bottom: 3px solid #b8c4dc; font: 900 14px/1.2 system-ui, sans-serif; text-align: center; }
#race-controls .what { color: #d7e3fb; font-size: 14px; }
@media (max-width: 760px) { #race-controls ul { grid-template-columns: repeat(2, auto); } }
body.touch-race #race-controls { top: 12px; bottom: auto; }
`;

/** `app`: the wasm App (race_phase, net_ready); `opts.touch()`: the on-screen controls are up. */
export function initControlsCard(app, opts = {}) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const card = document.createElement('div');
  card.id = 'race-controls';
  card.setAttribute('aria-live', 'polite');
  document.body.append(card);

  let shownFor = ''; // layout drawn into the card ('keyboard' | 'gamepad' | 'touch' + pause flag)
  let visible = false;
  let goAt = null; // when the race went from the countdown to racing
  let used = { accel: false, steer: false };
  let lastPhase = '';

  const gamepad = () => [...(navigator.getGamepads ? navigator.getGamepads() : [])].some((p) => p && p.connected);
  function render(kind, pause) {
    const rows = (kind === 'gamepad' ? GAMEPAD : kind === 'touch' ? TOUCH : KEYBOARD).filter(([what]) => pause || what !== 'Pause');
    const h = document.createElement('h3');
    h.textContent = kind === 'gamepad' ? 'Controls - gamepad' : kind === 'touch' ? 'Controls - touch' : 'Controls - keyboard';
    const ul = document.createElement('ul');
    for (const [what, keys] of rows) {
      const li = document.createElement('li');
      const k = document.createElement('span'); k.className = 'keys';
      for (const key of keys) { const kb = document.createElement('kbd'); kb.textContent = key; k.append(kb); }
      const w = document.createElement('span'); w.className = 'what'; w.textContent = what;
      li.append(k, w);
      ul.append(li);
    }
    card.replaceChildren(h, ul);
  }
  function setVisible(on) {
    if (on === visible) return;
    visible = on;
    card.classList.toggle('on', on);
  }

  /** Every frame. `pad`: this frame's pad bits + stick (main.js pollPad). */
  function poll(now, pad) {
    const phase = typeof app.race_phase === 'function' ? app.race_phase() : '';
    if (phase !== lastPhase) {
      if (phase === 'intro' || (phase === 'countdown' && lastPhase !== 'intro')) { goAt = null; used = { accel: false, steer: false }; }
      if (phase === 'racing' && (lastPhase === 'countdown' || lastPhase === 'intro')) goAt = now;
      lastPhase = phase;
    }
    let want = phase === 'intro' || phase === 'countdown';
    if (phase === 'racing' && goAt !== null) {
      if (pad) {
        if (pad.bits & 16) used.accel = true; // A
        if (pad.sx !== 0 || pad.bits & (4 | 8)) used.steer = true;
      }
      want = now - goAt < 4000 && !(used.accel && used.steer);
    }
    if (want) {
      const touch = !!(opts.touch && opts.touch());
      const kind = touch ? 'touch' : gamepad() ? 'gamepad' : 'keyboard';
      const pause = !(typeof app.net_ready === 'function' && app.net_ready()); // online races cannot pause
      const key = `${kind}|${pause}`;
      if (key !== shownFor) { render(kind, pause); shownFor = key; }
      document.body.classList.toggle('touch-race', touch);
    }
    setVisible(want);
  }
  return { poll };
}
