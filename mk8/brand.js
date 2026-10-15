// Real game art for the page's own menu (www/menu.css draws a CSS-only stand-in until this runs).
//
// Once the romfs is loaded, wasm decodes a few of the game's UI textures on request
// (`App.ui_image(name, package)`, crates/mk8-web/src/brand.rs: `[w][h][RGBA top-down]`) and
// this module paints them into the menu's canvases: the title logo, the Toad icons of the two
// big choices, the class shields, the checker / monogram masks behind everything, and the
// title backgrounds + character art of `UI/cmn/menu_title`. Nothing is stored or downloaded:
// the art comes from the user's own files, in their browser, every time. Feature-detected:
// an older wasm without `ui_image` simply keeps the CSS look.
//
// Work is spread over animation frames (one texture each) so the menu never stutters; the two
// 1920x1080 backgrounds come last and fade in when ready.

const $ = (id) => document.getElementById(id);
let app = null;
const queue = [];
let running = false;
let started = false;
let onlineLoaded = false;

/** True when this wasm can hand out game textures. */
export const available = () => !!app && typeof app.ui_image === 'function';

export function initBrand(theApp) {
  app = theApp;
}

/** Decode one texture: ImageData or null. */
function image(name, pkg = '') {
  if (!available()) return null;
  try {
    const b = app.ui_image(name, pkg);
    if (!b || b.length < 8) return null;
    const dv = new DataView(b.buffer, b.byteOffset, 8);
    const w = dv.getUint32(0, true); const h = dv.getUint32(4, true);
    if (!w || !h || b.length < 8 + w * h * 4) return null;
    return new ImageData(new Uint8ClampedArray(b.buffer, b.byteOffset + 8, w * h * 4), w, h);
  } catch (e) {
    console.warn('brand: texture', name, e);
    return null;
  }
}

function paint(canvas, img) {
  canvas.width = img.width; canvas.height = img.height;
  canvas.getContext('2d').putImageData(img, 0, 0);
  canvas.hidden = false;
  canvas.classList.add('ready');
}

/** Single-channel textures (`...^s`) carry their shape in alpha: white with that alpha. */
function maskUrl(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return `url("${c.toDataURL('image/png')}")`;
}

function step() {
  const job = queue.shift();
  if (!job) { running = false; return; }
  try { job(); } catch (e) { console.warn('brand', e); }
  requestAnimationFrame(step);
}
function enqueue(job) {
  queue.push(job);
  if (!running) { running = true; requestAnimationFrame(step); }
}

/** The menu is up: paint the logo, icons and backgrounds (once). */
export function brandStart() {
  if (started || !available()) return;
  started = true;
  // Logo (mn_TitleScene_00 / TitleLogoDX_00^l).
  enqueue(() => {
    const img = image('TitleLogoDX_00^l', 'mn_TitleScene_00');
    if (!img) return;
    paint($('brand-logo'), img);
    $('logo-css').hidden = true;
  });
  // Icons: every <canvas data-tex data-pkg> replaces its CSS / SVG stand-in.
  for (const c of document.querySelectorAll('#home canvas[data-tex]')) {
    enqueue(() => {
      const img = image(c.dataset.tex, c.dataset.pkg || '');
      if (!img) return;
      paint(c, img);
      for (const sib of c.parentElement.children) if (sib !== c) sib.hidden = true;
    });
  }
  // Masks behind everything: the checker tile and the MARIO KART monogram.
  enqueue(() => {
    const img = image('tc_MtCheck_64x64^s', 'mn_Background_00');
    if (!img) return;
    document.documentElement.style.setProperty('--check-url', maskUrl(img));
    for (const el of document.querySelectorAll('.mk-bg .check')) el.classList.add('real');
  });
  enqueue(() => {
    const img = image('ym_ModeMonogramGp_00^s', 'mn_Background_00');
    if (img) document.documentElement.style.setProperty('--mono-url', maskUrl(img));
  });
  // The Single Player title background and Mario (loose textures of UI/cmn/menu_title).
  enqueue(() => { const img = image('TitleBGSingle_00^u'); if (img) paint($('bg-single'), img); });
  enqueue(() => { const img = image('MnSingle_Mario^l'); if (img) paint($('hero-single'), img); });
  if (onlineLoaded) { onlineLoaded = false; brandOnline(); }
}

/** The online pages are shown: their background + art, once. */
export function brandOnline() {
  if (onlineLoaded) return;
  onlineLoaded = true;
  if (!started) return; // brandStart loads them afterwards
  if (!available()) return;
  enqueue(() => { const img = image('TitleBGMulti_00^u'); if (img) paint($('bg-online'), img); });
  enqueue(() => { const img = image('MnMulti_Mario^l'); if (img) paint($('hero-online'), img); });
}

/** For tests: which canvases got real art. */
export function paintedCount() {
  return document.querySelectorAll('#home canvas.ready').length;
}
