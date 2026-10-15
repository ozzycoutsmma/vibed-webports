// The page's own front menu (styled after the game's menus, see docs/DECISIONS.md and
// www/menu.css): SINGLEPLAYER -> class -> the game's own character / kart / cup screens
// (mk8-ui); ONLINE -> rooms (www/net.js); an Options drawer with the face photo, live camera
// and sound settings. Shown whenever the game UI is back on a page this menu replaces
// (app.at_home()). Keyboard (arrows, Enter, Esc / Backspace) and gamepad (d-pad / stick, A, B)
// move a visible focus ring over the controls; real game art is painted in by www/brand.js.
import * as net from './net.js';
import * as live from './live.js';
import * as voice from './voice.js';
import * as brand from './brand.js';

const $ = (id) => document.getElementById(id);

let onFaceJpeg = () => {};

export function initHome(app, audio = null) {
  const home = $('home');
  initSound(audio);
  brand.initBrand(app);
  let room = null;
  // The largest "Racers" value: the room server's cap (--max-players, learnt on Welcome and
  // shown in every room snapshot), 100 offline.
  let serverCap = 0;
  const cap = () => serverCap || (room && room.max_players) || Number(window.MK8_MAX_PLAYERS) || 100;

  const show = (page) => {
    for (const p of document.querySelectorAll('#home .page')) p.classList.toggle('on', p.id === `pg-${page}`);
    home.dataset.page = page;
    if (page === 'online' || page === 'room') { try { brand.brandOnline(); } catch (e) { console.warn('brand art:', e); } }
    const scroll = $('home-scroll');
    if (scroll) scroll.scrollTop = 0;
    // First control of the page, the big choice first (a selector list would return the first in
    // document order).
    for (const sel of ['button.big:not([hidden]):not(:disabled)', 'input[type=text]', 'button:not([hidden]):not(:disabled)', 'select']) {
      const first = [...document.querySelectorAll(`#pg-${page} ${sel}`)].find((el) => el.offsetParent !== null && !el.closest('[hidden]'));
      if (first) { first.focus({ preventScroll: true }); break; }
    }
  };
  for (const b of document.querySelectorAll('#home [data-go]')) b.addEventListener('click', () => show(b.dataset.go));

  // ---- singleplayer ----
  // "Racers": karts in the race (2..=cap, the game's 12 by default). Needs a build with
  // App.set_grid_size (feature-detected; older builds race 12). The cap is the room server's
  // (--max-players, learnt on Welcome) or 100 offline.
  injectRacerStyles();
  const RACERS_SAVE = 'mk8.racers';
  const singleRacers = racersSelect('single-racers', () => cap());
  singleRacers.value = String(savedRacers());
  const hasGrid = typeof app.set_grid_size === 'function' || typeof app.set_racer_count === 'function';
  const setGridSize = (n) => { if (typeof app.set_grid_size === 'function') app.set_grid_size(n); else if (typeof app.set_racer_count === 'function') app.set_racer_count(n); };
  const classNote = document.querySelector('#pg-class .note');
  if (classNote) {
    const row = document.createElement('div'); row.className = 'row racers-row';
    const label = document.createElement('label'); label.htmlFor = 'single-racers'; label.textContent = 'Racers';
    const note = document.createElement('span'); note.className = 'note'; note.id = 'single-racers-note';
    row.append(label, singleRacers, note);
    classNote.before(row);
    row.hidden = !hasGrid;
    const refresh = () => { const n = Number(singleRacers.value); note.textContent = n === 12 ? 'the game\'s grid: you + 11 CPUs' : `you + ${n - 1} CPUs${n > 12 ? ' (big race: extra grid rows, more work for your machine)' : ''}`; };
    singleRacers.addEventListener('change', () => { try { localStorage.setItem(RACERS_SAVE, singleRacers.value); } catch { /* private mode */ } refresh(); });
    refresh();
  }
  function savedRacers() { try { const n = Number(localStorage.getItem(RACERS_SAVE)); return n >= 2 && n <= 255 ? n : 12; } catch { return 12; } }
  $('btn-single').addEventListener('click', () => { singleRacers.fill(); show('class'); });
  // "Unblocked version": the Google Sites page that embeds this game (for networks that block
  // this domain). Hidden when the page already runs inside an embed; opens in the top window.
  const UNBLOCKED_URL = 'https://sites.google.com/view/mariokart8online/';
  const embedded = (() => { try { return window.top !== window.self; } catch { return true; } })();
  $('btn-unblocked').hidden = embedded;
  $('btn-unblocked').addEventListener('click', () => { try { window.top.location.href = UNBLOCKED_URL; } catch { window.open(UNBLOCKED_URL, '_blank', 'noopener'); } });
  for (const b of document.querySelectorAll('#pg-class [data-cc]')) {
    b.addEventListener('click', () => {
      if (hasGrid) setGridSize(Number(singleRacers.value) || 12);
      app.start_singleplayer(Number(b.dataset.cc));
      hide();
    });
  }

  // ---- online (www/net.js, docs/NETWORK.md) ----
  // Flow: ONLINE -> name -> create a room (you host), join with a code or pick one from the
  // public room list (GET /rooms.json; rooms whose host ticked "public") -> the room page:
  // everybody picks driver / body / tires / glider with the dropdowns and presses "I'm ready";
  // the host picks course + class and starts. The game then loads the race (loading card,
  // intro, HUD, results) and every browser simulates it in lockstep; afterwards the room
  // page comes back. A photo face is sent to the room as a small JPEG.
  const SAVE = 'mk8.online';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(SAVE) || '{}'); } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(SAVE, JSON.stringify({ name: myName(), combo: myCombo() })); } catch { /* private mode */ } };
  const PARTS = ['driver', 'body', 'tire', 'glider'];
  for (const k of PARTS) {
    $(`room-${k}`).replaceChildren(...app.part_names(k).map((e) => {
      const at = e.indexOf(':');
      const o = document.createElement('option'); o.value = e.slice(0, at); o.textContent = e.slice(at + 1); return o;
    }));
  }
  const setCombo = (c) => PARTS.forEach((k, i) => { const el = $(`room-${k}`); if ([...el.options].some((o) => Number(o.value) === c[i])) el.value = String(c[i]); });
  const myCombo = () => PARTS.map((k) => Number($(`room-${k}`).value) || 0);
  const myName = () => ($('room-name').value || $('net-name').value || 'Player').trim().slice(0, 16) || 'Player';
  setCombo(Array.isArray(saved.combo) ? saved.combo : Array.from(app.local_combo()).slice(0, 4));
  $('net-name').value = $('room-name').value = saved.name || '';
  const profile = () => ({ name: myName(), combo: myCombo() });
  const err = (m) => { $('online-err').textContent = m || ''; $('room-err').textContent = m || ''; };
  const banner = (m) => { const b = $('net-banner'); b.textContent = m || ''; b.hidden = !m; };
  const netStatus = (text, state) => { const p = $('net-status'); p.textContent = text; p.classList.toggle('ok', state === 'ok'); p.classList.toggle('bad', state === 'bad'); };
  let ready = false;
  let raceId = null; // race this page is in / was in
  let doneRace = null; // last race this page finished or left (ignored if the server re-sends it)
  let finishedAt = null; // when the local kart crossed the line (race_done goes out a moment later)
  let sentDone = false; // race_done sent for `raceId`
  let afterRace = false; // the room page came back from a race (shown until the next ready / start)
  let desynced = false;

  $('btn-online').addEventListener('click', () => {
    err();
    try { show('online'); } catch (e) { console.error('online page:', e); }
    try { refreshRooms(); } catch (e) { console.warn('room list:', e); }
    try {
      net.connect(profile());
      netStatus(net.isConnected() ? 'connected' : 'connecting...', net.isConnected() ? 'ok' : '');
    } catch (e) {
      console.error('net connect:', e);
      netStatus(`cannot start networking: ${e && e.message ? e.message : e}`, 'bad');
      err(`Networking failed to start: ${e && e.message ? e.message : e}. Reload the page; if it persists, send this message.`);
    }
  });
  const nameSync = (src) => { $('net-name').value = $('room-name').value = src.value; };
  $('net-name').addEventListener('input', () => nameSync($('net-name')));
  $('room-name').addEventListener('input', () => nameSync($('room-name')));
  $('room-name').addEventListener('change', () => { save(); net.setProfile(profile()); });
  for (const k of PARTS) $(`room-${k}`).addEventListener('change', () => { save(); net.setProfile(profile()); });
  $('btn-create').addEventListener('click', () => {
    err(); save(); net.connect(profile());
    $('room-public').checked = $('create-public').checked;
    try { net.setProfile(profile()); net.createRoom(); } catch (e) { err(String(e.message || e)); }
  });
  const join = (code) => {
    err(); save(); net.connect(profile());
    try { net.setProfile(profile()); net.joinRoom(code); } catch (e) { err(String(e.message || e)); }
  };
  $('btn-join').addEventListener('click', () => join($('join-code').value));
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('btn-leave').addEventListener('click', () => { net.leaveRoom(); room = null; ready = false; afterRace = false; show('online'); refreshRooms(); });
  $('btn-copy').addEventListener('click', async () => {
    const code = room ? room.code : '';
    try { await navigator.clipboard.writeText(code); $('btn-copy').textContent = 'Copied!'; } catch {
      const r = document.createRange(); r.selectNodeContents($('room-code')); getSelection().removeAllRanges(); getSelection().addRange(r);
      $('btn-copy').textContent = 'press Ctrl+C';
    }
    setTimeout(() => { $('btn-copy').textContent = 'Copy code'; }, 1500);
  });
  $('btn-ready').addEventListener('click', () => { ready = !ready; afterRace = false; net.setReady(ready); renderRoom(); });
  const courses = app.course_list().map((e) => e.split('|'));
  const courseName = new Map(courses);
  $('room-course').replaceChildren(...courses.map(([dir, name]) => { const o = document.createElement('option'); o.value = dir; o.textContent = name; return o; }));
  if (courses.some(([d]) => d === 'Gu_FirstCircuit')) $('room-course').value = 'Gu_FirstCircuit';
  // Host's "Racers" (grid size) next to course / class; hidden when the build / server predates it.
  const roomRacers = racersSelect('room-racers', () => cap());
  {
    const cls = $('room-class');
    const label = document.createElement('label'); label.htmlFor = 'room-racers'; label.textContent = 'Racers';
    cls.after(label, roomRacers);
    label.hidden = roomRacers.hidden = true;
    roomRacers.dataset.label = 'room-racers-label'; label.id = 'room-racers-label';
  }
  const gridLive = () => !!(room && room.settings && room.settings.grid_size !== undefined);
  const gridSize = () => (gridLive() ? room.settings.grid_size : 12);
  const settings = () => ({
    ...(room ? room.settings : {}),
    course: $('room-course').value,
    engine_class: Number($('room-class').value),
    public: $('room-public').checked,
    rollback: true, // prediction + rollback is always on (lockstep stays available to tests only)
    ...(gridLive() ? { grid_size: Number(roomRacers.value) || gridSize() } : {}),
  });
  const pushSettings = () => { if (room && room.host === net.myId()) { try { net.setSettings(settings()); } catch (e) { err(String(e.message || e)); } } };
  $('room-course').addEventListener('change', pushSettings);
  $('room-class').addEventListener('change', pushSettings);
  roomRacers.addEventListener('change', pushSettings);
  $('room-public').addEventListener('change', pushSettings);
  $('btn-room-start').addEventListener('click', () => {
    if (!room) return;
    err();
    try { net.startRace(settings()); } catch (e) { err(String(e.message || e)); }
  });

  // Public room list: fetched on entering the Online page, then every 5 s while it is shown.
  const CC = ['50cc', '100cc', '150cc', '200cc'];
  let roomsBusy = false;
  async function refreshRooms() {
    if (roomsBusy) return;
    roomsBusy = true;
    try {
      const r = await fetch(net.httpUrl('/rooms.json'), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { rooms } = await r.json();
      $('public-rooms').replaceChildren(...rooms.map((p) => {
        const li = document.createElement('li');
        const full = p.players >= p.max_players;
        const text = document.createElement('span');
        text.textContent = `${p.host_name}'s room - ${courseName.get(p.course) || p.course} ${CC[p.engine_class] || ''} - ${p.players}/${p.max_players}${p.phase === 'lobby' ? '' : ' - racing'}`;
        const b = document.createElement('button');
        b.className = 'small'; b.textContent = p.phase === 'lobby' ? 'Join' : 'Watch'; b.disabled = full;
        b.addEventListener('click', () => join(p.code));
        li.append(text, b);
        return li;
      }));
      $('public-rooms-note').textContent = rooms.length ? '' : 'No public rooms right now - create one and tick "List my room publicly".';
    } catch (e) {
      $('public-rooms-note').textContent = `Cannot load the room list: ${e.message || e}`;
    } finally { roomsBusy = false; }
  }
  $('btn-rooms-refresh').addEventListener('click', refreshRooms);
  setInterval(() => { if (shown && !document.hidden && $('pg-online').classList.contains('on')) refreshRooms(); }, 5000);

  const faceUrls = new Map(); // player -> object URL of the received photo
  const stillFaces = new Map(); // player -> decoded 256x256 RGBA of the photo (live camera fallback)
  // One card per player: face (photo or initial), name, driver, state tags; www/voice.js adds
  // its speaking dot and mute button.
  function renderRoom() {
    if (!room) return;
    const me = net.myId();
    const host = room.host === me;
    $('room-code').textContent = room.code.length === 6 ? `${room.code.slice(0, 3)}-${room.code.slice(3)}` : room.code;
    const grid = gridSize();
    const humans = room.players.filter((p) => p.connected).length;
    // Many players: compact cards (small face + name, state as a dot, scrollable grid).
    const compact = room.players.length > 12;
    // The host may remove somebody - but only while the room waits in the lobby.
    const kickable = host && room.phase === 'lobby';
    const list = $('room-players');
    list.classList.toggle('compact', compact);
    list.replaceChildren(...room.players.map((p) => {
      const li = document.createElement('li');
      if (p.id === me) li.classList.add('me');
      const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text !== undefined) d.textContent = text; return d; };
      const face = el('pface');
      if (faceUrls.has(p.id)) { const img = document.createElement('img'); img.src = faceUrls.get(p.id); img.alt = ''; img.loading = 'lazy'; face.append(img); }
      else face.textContent = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      const tags = el('ptags');
      const tag = (text, cls) => { const t = document.createElement('span'); t.className = `tag ${cls || ''}`.trim(); t.textContent = text; return t; };
      const state = p.host ? 'host' : !p.connected ? 'off' : p.ready ? 'ok' : 'wait';
      const kick = kickable && p.id !== me ? kickButton(p) : null;
      if (compact) {
        li.classList.add(`st-${state}`);
        li.title = `${p.name} - ${app.driver_name(p.combo.driver, 0)} - ${p.host ? 'host' : p.ready ? 'ready' : 'not ready'}${p.connected ? '' : ', disconnected'}${p.spectator ? ', watching' : ''}${p.rtt_ms != null ? ` - ${p.rtt_ms} ms` : ''}`;
        li.append(face, el('pname', `${p.name}${p.id === me ? ' (you)' : ''}`));
      } else {
        if (p.host) tags.append(tag('host', 'host'));
        else tags.append(p.ready ? tag('ready', 'ok') : tag('not ready', 'wait'));
        if (!p.connected) tags.append(tag('disconnected', 'off'));
        if (p.spectator) tags.append(tag('watching'));
        if (p.rtt_ms != null) tags.append(tag(`${p.rtt_ms} ms`));
        li.append(face, el('pname', `${p.name}${p.id === me ? ' (you)' : ''}`), el('pdrv', app.driver_name(p.combo.driver, 0)), tags);
      }
      if (kick) li.append(kick);
      voice.decoratePlayer(li, p.id, p.id === me);
      return li;
    }));
    const pl = document.querySelector('#pg-room .panel h3');
    if (pl) pl.textContent = `Players ${humans}/${grid}`;
    const others = room.players.filter((p) => !p.host && p.connected);
    const waiting = others.filter((p) => !p.ready).length;
    $('room-host').hidden = !host;
    $('room-wait').hidden = host;
    $('room-ready-row').hidden = host;
    const racing = room.phase !== 'lobby';
    $('btn-ready').textContent = ready ? 'NOT READY AFTER ALL' : afterRace ? "READY FOR THE NEXT RACE" : "I'M READY";
    $('btn-ready').classList.toggle('primary', !ready);
    $('room-wait').textContent = racing ? 'The race is still running for the others - they come back here when they finish.'
      : ready ? 'You are ready - waiting for the host to start the race...'
        : afterRace ? 'Race over! Everybody is back in the room - press READY when you want to go again.' : 'Waiting for the host to start the race...';
    $('room-wait').classList.toggle('after', afterRace && !ready && !racing);
    $('btn-room-start').disabled = racing || waiting > 0;
    const racers = Math.min(humans, grid);
    const cpus = room.settings.fill_cpus === false ? 0 : Math.max(0, grid - racers);
    $('btn-room-start').textContent = afterRace && !racing ? `RACE AGAIN - ${racers} human${racers === 1 ? '' : 's'} + ${cpus} CPU${cpus === 1 ? '' : 's'}` : `START RACE - ${racers} human${racers === 1 ? '' : 's'} + ${cpus} CPU${cpus === 1 ? '' : 's'}`;
    $('room-start-note').textContent = racing ? 'The race is still running for the others - they come back here when they finish.'
      : waiting > 0 ? `${afterRace ? 'Race over! ' : ''}Waiting for ${waiting} player${waiting > 1 ? 's' : ''} to be ready${afterRace ? ' for the next race' : ''}.`
        : others.length ? 'Everyone is ready!' : 'You can start alone, or wait for friends to join with the code.';
    if (host && document.activeElement !== $('room-course') && room.settings.course && $('room-course').value !== room.settings.course) $('room-course').value = room.settings.course;
    // Racers (grid size): the host's selector mirrors the room; guests only see the number.
    const showRacers = host && gridLive();
    roomRacers.hidden = !showRacers;
    const racersLabel = $('room-racers-label'); if (racersLabel) racersLabel.hidden = !showRacers;
    if (showRacers) { roomRacers.fill(); if (document.activeElement !== roomRacers && Number(roomRacers.value) !== grid) roomRacers.value = String(grid); }
    // The host's checkbox is the source of truth; everyone else mirrors the room (so it is right
    // if they become host).
    if (!host) $('room-public').checked = !!room.settings.public;
    const cc = CC[room.settings.engine_class] || '';
    $('room-settings').textContent = `${courseName.get(room.settings.course) || room.settings.course} ${cc} - ${grid} racers (${racers} human${racers === 1 ? '' : 's'}${cpus ? ` + ${cpus} CPU${cpus === 1 ? '' : 's'}` : ''})${racing ? ' (running - you join the next one)' : ''} - ${room.settings.public ? 'public room' : 'private room (code only)'}`;
  }

  net.on('connection', (e) => {
    const connected = !!e.connected;
    const why = !connected && e && e.code ? ` (code ${e.code}${e.reason ? ': ' + e.reason : ''})` : '';
    const d = window.__mk8Net;
    const never = !connected && d && d.failedOpens > 0 && d.closes === d.failedOpens;
    netStatus(connected ? 'connected' : `${never ? 'cannot reach the room server' : 'connection lost'}${why} - retrying...`, connected ? 'ok' : 'bad');
    if (!connected && net.started()) banner(room ? 'Connection lost - reconnecting...' : '');
    else banner(desynced ? $('net-banner').textContent : '');
  });
  net.on('welcome', (ev) => { netStatus('connected', 'ok'); serverCap = Number(ev && ev.max_players) || net.maxPlayers() || 0; });
  net.on('joined', () => {
    ready = false;
    err();
    if (localFace) { try { net.setFace(localFace); } catch (e) { console.warn('face', e); } }
    show('room');
  });
  net.on('room', (ev) => {
    const first = !room;
    room = ev.room;
    const mine = room.players.find((p) => p.id === net.myId());
    if (mine && !mine.host) ready = mine.ready;
    if (first && room.host === net.myId()) pushSettings();
    renderRoom();
  });
  net.on('left', () => {
    room = null;
    if (app.net_active()) app.abort_net_race();
    if (shown) { show('online'); refreshRooms(); }
  });
  net.on('kicked', (ev) => {
    // The host removed us from the room; the connection itself stays open, so there is no
    // reconnect to explain it - say why and go back to the room list. The banner is temporary
    // (the next connection event clears it), the error line on that page is not.
    room = null;
    ready = false;
    afterRace = false;
    if (app.net_active()) app.abort_net_race();
    const msg = (ev && ev.message) || 'The host kicked you out of the room.';
    err(msg);
    banner(msg);
    if (shown) { show('online'); refreshRooms(); }
  });
  net.on('face', async (ev) => {
    if (faceUrls.has(ev.player)) { URL.revokeObjectURL(faceUrls.get(ev.player)); faceUrls.delete(ev.player); }
    const blob = ev.has_face ? net.face(ev.player) : null;
    if (!blob) { stillFaces.delete(ev.player); app.set_player_face(ev.player, new Uint8Array(0), 0, 0); renderRoom(); return; }
    faceUrls.set(ev.player, URL.createObjectURL(blob));
    try {
      // JPEG has no alpha: re-apply the circle crop the face texture expects.
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = 256; c.height = 256;
      const g = c.getContext('2d');
      g.beginPath(); g.arc(128, 128, 128, 0, Math.PI * 2); g.clip();
      g.drawImage(bmp, 0, 0, 256, 256);
      const rgba = new Uint8Array(g.getImageData(0, 0, 256, 256).data.buffer);
      stillFaces.set(ev.player, rgba.slice());
      app.set_player_face(ev.player, rgba, 256, 256);
    } catch (e) { console.warn('face of player', ev.player, e); }
    renderRoom();
  });
  net.on('race_start', (ev) => {
    const id = ev.start.race_id;
    if (id === doneRace) return; // this page already left that race
    try {
      const fresh = app.start_net_race(net.raceBytes(), ev.kart ?? -1);
      if (fresh) { raceId = id; finishedAt = null; sentDone = false; afterRace = false; desynced = false; banner(''); window.__mk8Checksums = {}; window.__mk8Desync = null; }
      hide();
    } catch (e) { console.error(e); err(String(e.message || e)); }
  });
  net.on('race_ended', () => {
    // Everybody finished (or the host ended it). Racers still driving / spectators go back
    // to the room; a finished racer stays on the results until they leave them (the game
    // then returns to the room, not to its own menus - Front::tick).
    if (app.net_active() && !app.net_local_finished()) {
      banner('The race was ended.');
      setTimeout(() => { if (!desynced) banner(''); }, 3000);
      app.abort_net_race();
    } else if (app.net_ready() && typeof app.detach_net_race === 'function') {
      // Finished: no more bundles will come, so the sim finishes the race on the local clock
      // (otherwise the finish logo froze, waiting for steps that never came).
      app.detach_net_race();
    }
    doneRace = raceId;
  });
  net.on('desync', (ev) => {
    desynced = true;
    window.__mk8Desync = ev;
    banner(`Desync at frame ${ev.frame}: the players' races differ (positions may not match).`);
  });
  net.on('error', (ev) => {
    err(ev.message || ev.code);
    if (ev.code === 'room_not_found' && room) { room = null; if (app.net_active()) app.abort_net_race(); if (shown) show('online'); }
  });
  /** The local face photo as a JPEG for the room (<= 128 KB), or null. */
  let localFace = null;
  onFaceJpeg = (bytes) => {
    localFace = bytes;
    if (room) { try { net.setFace(bytes); } catch (e) { console.warn('face', e); } }
  };

  const face = initFace(app);

  // ---- live camera face (www/live.js): opt-in, clearly shown while on, one tap off ----
  live.initLive(app, {
    commitStill: (c) => face.setImage(c),
    localStill: () => face.stillRgba(),
    remoteStill: (id) => stillFaces.get(id) || null,
    changed: (on) => {
      for (const b of [$('face-live'), $('room-live')]) { b.textContent = on ? 'Live camera face: ON (turn off)' : 'Live camera face: off'; b.setAttribute('aria-pressed', String(on)); }
      $('live-indicator').hidden = !on;
    },
  });
  const toggleLive = async () => {
    $('face-err').textContent = '';
    try { await live.setLive(!live.isLive()); } catch (e) { const m = `camera unavailable: ${e.message || e}`; $('face-err').textContent = m; $('room-err').textContent = m; }
  };
  $('face-live').addEventListener('click', toggleLive);
  $('room-live').addEventListener('click', toggleLive);
  $('live-indicator').addEventListener('click', () => { live.setLive(false); });
  // ---- proximity voice chat (www/voice.js): opt-in, in the room's Options drawer ----
  voice.initVoice(app);
  // One AudioContext: the voices play through the game audio's chat path (limiter, ducking),
  // never straight into the device next to the game mix (that clipped).
  if (audio && audio.available && typeof audio.chat === 'function' && typeof voice.attachAudio === 'function') {
    const chat = audio.chat();
    if (chat) voice.attachAudio(chat);
  }

  // ---- navigation: keyboard + gamepad over the visible controls, with a focus ring ----
  // Arrows / d-pad / stick pick the nearest control in that direction (falling back to document
  // order), Enter / A press it, Esc / Backspace / B go back. The `kb` class shows the ring for
  // focus moved this way; a pointer press hides it again.
  const nav = initNav(home, { back, show });
  function back() {
    const page = home.dataset.page;
    const open = document.querySelector('#home .page.on details[open]');
    if (open && (open.contains(document.activeElement) || page === 'main')) { open.open = false; open.querySelector('summary').focus(); return true; }
    if (page === 'room') { $('btn-leave').click(); return true; }
    const b = document.querySelector('#home .page.on button.back');
    if (b) { b.click(); return true; }
    return false;
  }

  let shown = false;
  function hide() { shown = false; document.body.classList.remove('home'); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }
  return {
    /** Called every frame: show the menu when the game UI went back to a replaced page. */
    poll() {
      // A finished racer tells the server once the results board is up (not only when they
      // leave it): the room goes back to the lobby when the last racer reaches the results,
      // whoever is still reading them. Not earlier: the finish logo and the results need sim
      // steps, and none come once the server ends the race (App.detach_net_race covers a
      // race another player's race_done ended meanwhile).
      if (raceId !== null && raceId !== doneRace && !sentDone && net.racing() && app.net_local_finished()) {
        finishedAt ??= performance.now();
        const board = /^(Results|RaceNext|GpResults)$/.test(app.screen_name());
        if (board || performance.now() - finishedAt > 15000) { sentDone = true; try { net.raceDone(); } catch (e) { console.warn('race_done', e); } }
      }
      if (app.at_home() && !shown) {
        shown = true;
        document.body.classList.add('home');
        if (raceId !== null && raceId !== doneRace && !sentDone && net.racing()) { sentDone = true; net.raceDone(); }
        if (raceId !== null) { afterRace = !!room; doneRace = raceId; }
        if (!desynced) banner('');
        if (room) { show('room'); renderRoom(); } else show('main');
        brand.brandStart();
      }
      if (shown) nav.pollGamepad(performance.now());
    },
    get shown() { return shown; },
  };
}

/**
 * The host's "kick" control on one player card (the lobby only): press once to arm it, once
 * more within a few seconds to actually remove that player - one press is never enough.
 */
function kickButton(p) {
  const b = document.createElement('button');
  b.className = 'small kick';
  b.type = 'button';
  let timer = 0;
  const rest = () => {
    b.dataset.armed = '';
    b.classList.remove('armed');
    b.textContent = 'KICK';
    b.title = `Kick ${p.name} out of the room`;
  };
  rest();
  b.addEventListener('click', () => {
    if (b.dataset.armed === '1') { clearTimeout(timer); net.kick(p.id); return; }
    b.dataset.armed = '1';
    b.classList.add('armed');
    b.textContent = 'SURE?';
    b.title = `Kick ${p.name} out of the room? Press again to confirm.`;
    clearTimeout(timer);
    timer = setTimeout(rest, 4000); // they thought better of it
  });
  return b;
}

// ---- "Racers" selector (2..=cap) and the compact player grid for big rooms ----
/** A <select> of 2..=cap() with a `fill()` that rebuilds the options when the cap changes. */
function racersSelect(id, cap) {
  const sel = document.createElement('select');
  sel.id = id;
  let built = 0;
  sel.fill = () => {
    const n = Math.max(2, Math.min(255, Math.round(cap())));
    if (n === built) return;
    const keep = sel.value || '12';
    sel.replaceChildren(...Array.from({ length: n - 1 }, (_, i) => {
      const o = document.createElement('option'); o.value = String(i + 2); o.textContent = i + 2 === 12 ? '12 (the game)' : String(i + 2); return o;
    }));
    sel.value = Number(keep) <= n ? keep : String(n);
    built = n;
  };
  sel.fill();
  sel.value = '12';
  if (!sel.value) sel.value = String(built);
  return sel;
}
/** Styles for the selector row and the compact player grid (kept here so www/menu.css stays untouched). */
function injectRacerStyles() {
  if (document.getElementById('racers-style')) return;
  const st = document.createElement('style');
  st.id = 'racers-style';
  st.textContent = `
#home .racers-row { margin: 10px 0 4px; gap: 10px; }
#home .racers-row label { font-weight: 900; }
#home .racers-row .note { margin: 0; }
#home ul.players.compact { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; max-height: 46vh; overflow-y: auto; padding: 4px; }
#home ul.players.compact li { min-height: 0; padding: 6px 4px 5px; gap: 2px; border-width: 2px; border-radius: 12px; grid-template-rows: auto auto; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3); }
#home ul.players.compact .pface { width: 36px; height: 36px; font-size: 16px; border-width: 2px; }
#home ul.players.compact .pname { font-size: 11px; line-height: 1.1; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#home ul.players.compact li::after { content: ""; position: absolute; top: 5px; right: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--mk-yellow); box-shadow: 0 0 0 2px #fff; }
#home ul.players.compact li.st-ok::after { background: var(--mk-green); }
#home ul.players.compact li.st-host::after { background: var(--mk-red); }
#home ul.players.compact li.st-off::after { background: #666; }
#home ul.players.compact .voice-dot { top: 3px; left: 3px; }
#home ul.players.compact .voice-mute { top: auto; bottom: 2px; right: 2px; padding: 0 5px; font-size: 9px; }
#home ul.players.compact .kick { justify-self: start; padding: 1px 8px; font-size: 10px; }
`;
  document.head.append(st);
}

// ---- keyboard / gamepad navigation of the menu's controls ----
function initNav(home, { back }) {
  const SEL = '#home .page.on button:not([hidden]):not(:disabled), #home .page.on select, #home .page.on input:not([type=hidden]):not([type=file]), #home .page.on summary';
  const visible = (el) => el.offsetParent !== null && !el.closest('[hidden]');
  const focusables = () => [...document.querySelectorAll(SEL)].filter(visible);
  const typing = (el) => el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search' || el.type === 'number');
  const kb = () => home.classList.add('kb');
  home.addEventListener('pointerdown', () => home.classList.remove('kb'));

  function focusEl(el) {
    if (!el) return;
    kb();
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  /** Move the focus in `dir` ('up' | 'down' | 'left' | 'right'). */
  function move(dir) {
    const items = focusables();
    if (!items.length) return;
    const cur = document.activeElement;
    const ci = items.indexOf(cur);
    if (ci < 0) { focusEl(items[0]); return; }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    let best = null; let bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2; const y = b.top + b.height / 2;
      const dx = x - cx; const dy = y - cy;
      let primary; let overlap;
      if (dir === 'down') { primary = dy; overlap = b.left < r.right && b.right > r.left; }
      else if (dir === 'up') { primary = -dy; overlap = b.left < r.right && b.right > r.left; }
      else if (dir === 'right') { primary = dx; overlap = b.top < r.bottom && b.bottom > r.top; }
      else { primary = -dx; overlap = b.top < r.bottom && b.bottom > r.top; }
      if (primary < 4) continue;
      const secondary = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const score = primary + (overlap ? 0 : 2 * secondary + 400);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) {
      // Nothing that way: document order (lists keep working, left / right at an edge go on).
      const step = dir === 'down' || dir === 'right' ? 1 : -1;
      best = items[(ci + step + items.length) % items.length];
    }
    focusEl(best);
  }
  /** Left / right on a select or slider changes its value instead of moving. */
  function adjust(el, delta) {
    if (el instanceof HTMLSelectElement) {
      const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + delta));
      if (i !== el.selectedIndex) { el.selectedIndex = i; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    }
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const step = Number(el.step) || 1;
      el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + delta * step)));
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }
  function activate() {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !home.contains(el)) { focusEl(focusables()[0]); return; }
    if (el instanceof HTMLSelectElement) { adjust(el, 1); return; }
    if (typing(el)) return;
    el.click();
  }

  // On the window: the focus may sit on the game canvas or the body (after a race, after a
  // click on the backdrop); the first arrow then enters the menu.
  window.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('home')) return;
    const t = e.target;
    const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (!(t instanceof Node) || !home.contains(t)) {
      if (dirs[e.key] || e.key === 'Enter') { focusEl(focusables()[0]); e.preventDefault(); }
      else if (e.key === 'Escape' || e.key === 'Backspace') { if (back()) e.preventDefault(); }
      return;
    }
    if (dirs[e.key]) {
      // Selects and sliders use the arrows themselves; text inputs keep left / right.
      if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'range')) return;
      if (typing(t) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      move(dirs[e.key]); e.preventDefault(); return;
    }
    if (e.key === 'Escape' || (e.key === 'Backspace' && !typing(t))) { if (back()) e.preventDefault(); return; }
    if (e.key === 'Enter' && typing(t) && t.id !== 'join-code') { move('down'); e.preventDefault(); }
  });

  // Gamepad (standard mapping): d-pad 12-15 / left stick, A = 0, B = 1. Edge-triggered, with
  // key repeat while a direction is held. Button 11 (right stick) belongs to push-to-talk.
  const gp = { prev: 0, dirs: 0, repeatAt: 0 };
  function pollGamepad(now) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let bits = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const on = (i) => p.buttons[i] && p.buttons[i].pressed;
      if (on(12)) bits |= 1; if (on(13)) bits |= 2; if (on(14)) bits |= 4; if (on(15)) bits |= 8;
      if (on(0)) bits |= 16; if (on(1)) bits |= 32;
      const x = p.axes[0] || 0; const y = p.axes[1] || 0;
      if (y < -0.5) bits |= 1; if (y > 0.5) bits |= 2; if (x < -0.5) bits |= 4; if (x > 0.5) bits |= 8;
    }
    const pressed = bits & ~gp.prev;
    const dirs = bits & 15;
    let fire = pressed & 15;
    if (dirs && dirs === gp.dirs) { if (now >= gp.repeatAt) { fire |= dirs; gp.repeatAt = now + 120; } }
    else gp.repeatAt = now + 380;
    gp.dirs = dirs; gp.prev = bits;
    if (fire) {
      const el = document.activeElement;
      const horizontal = (fire & 4 ? -1 : 0) + (fire & 8 ? 1 : 0);
      if (horizontal && home.contains(el) && adjust(el, horizontal)) { kb(); }
      else if (fire & 1) move('up'); else if (fire & 2) move('down'); else if (fire & 4) move('left'); else if (fire & 8) move('right');
    }
    if (pressed & 16) activate();
    if (pressed & 32) back();
  }
  return { pollGamepad, move, activate };
}

// ---- sound: the game's menu sounds on hover / click, volume settings (www/audio.js) ----
function initSound(audio) {
  const box = $('sound-box');
  if (!audio || !audio.available) { if (box) box.hidden = true; return; }
  const home = $('home');
  let lastCursor = 0;
  const cursor = () => {
    const t = performance.now();
    if (t - lastCursor < 60) return; // one tick per move, not per pixel
    lastCursor = t;
    audio.ui('SE_SYS_CURSOR');
  };
  const control = (t) => t instanceof Element && t.closest('#home button, #home select, #home summary, #home input[type=checkbox], #home input[type=range]');
  home.addEventListener('focusin', (e) => { if (control(e.target)) cursor(); });
  home.addEventListener('pointerover', (e) => { const c = control(e.target); if (c && c !== document.activeElement && !(e.relatedTarget && c.contains(e.relatedTarget))) cursor(); });
  home.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('#home button, #home summary') : null;
    if (!b) return;
    audio.ui(b.classList.contains('back') || b.id === 'btn-leave' ? 'SE_SYS_CANCEL_M' : (b.classList.contains('big') ? 'SE_SYS_DECIDE_L' : 'SE_SYS_DECIDE_M'));
  });
  if (!box) return;
  const s = audio.settings();
  const sliders = { music: $('vol-music'), sfx: $('vol-sfx'), voice: $('vol-voice') };
  for (const [k, el] of Object.entries(sliders)) {
    el.value = String(Math.round(s[k] * 100));
    el.addEventListener('input', () => audio.setSettings({ [k]: Number(el.value) / 100 }));
    el.addEventListener('change', () => { if (k !== 'music') audio.ui(k === 'voice' ? 'SE_SYS_DECIDE_S' : 'SE_SYS_CURSOR'); });
  }
  const mute = $('vol-mute');
  mute.checked = s.mute;
  mute.addEventListener('change', () => audio.setSettings({ mute: mute.checked }));
}

// ---- face photo: camera / upload, circle crop, 256x256 RGBA to wasm ----
function initFace(app) {
  const cv = $('face-preview');
  const ctx = cv.getContext('2d');
  const video = $('face-video');
  let img = null; // ImageBitmap / canvas with the source picture
  let still = null; // committed 256x256 RGBA
  let stream = null;
  let crop = { x: 128, y: 128, r: 100 }; // circle in preview pixels
  let view = { scale: 1, ox: 0, oy: 0 }; // source -> preview fit
  const err = (m) => { $('face-err').textContent = m || ''; };

  function fit() {
    if (!img) return;
    const s = Math.min(256 / img.width, 256 / img.height);
    view = { scale: s, ox: (256 - img.width * s) / 2, oy: (256 - img.height * s) / 2 };
  }
  function draw() {
    ctx.fillStyle = '#0e2a66'; ctx.fillRect(0, 0, 256, 256);
    const src = stream ? video : img;
    if (stream && video.videoWidth) {
      const s = Math.min(256 / video.videoWidth, 256 / video.videoHeight);
      ctx.drawImage(video, (256 - video.videoWidth * s) / 2, (256 - video.videoHeight * s) / 2, video.videoWidth * s, video.videoHeight * s);
    } else if (img) {
      ctx.drawImage(img, view.ox, view.oy, img.width * view.scale, img.height * view.scale);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(128, 104, 44, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(128, 236, 80, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '800 15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('no photo yet', 128, 200);
      ctx.textAlign = 'start';
    }
    if (src && !stream) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.rect(0, 0, 256, 256); ctx.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2, true); ctx.fill('evenodd');
      ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (stream) requestAnimationFrame(draw);
  }
  /** Crop to 256x256 RGBA (outside the circle transparent) and hand it to wasm. */
  function commit() {
    if (!img) { still = null; app.set_face_image(new Uint8Array(0), 0, 0); onFaceJpeg(null); return; }
    const out = document.createElement('canvas'); out.width = 256; out.height = 256;
    const o = out.getContext('2d');
    o.beginPath(); o.arc(128, 128, 128, 0, Math.PI * 2); o.clip();
    // Preview circle -> source rectangle.
    const sx = (crop.x - crop.r - view.ox) / view.scale; const sy = (crop.y - crop.r - view.oy) / view.scale;
    const sw = (crop.r * 2) / view.scale;
    o.drawImage(img, sx, sy, sw, sw, 0, 0, 256, 256);
    const data = o.getImageData(0, 0, 256, 256).data;
    still = new Uint8Array(data.buffer.slice(0));
    app.set_face_image(new Uint8Array(data.buffer.slice(0)), 256, 256);
    // Online rooms get a JPEG (the server takes <= 128 KB); white outside the circle.
    const j = document.createElement('canvas'); j.width = 256; j.height = 256;
    const jg = j.getContext('2d'); jg.fillStyle = '#fff'; jg.fillRect(0, 0, 256, 256); jg.drawImage(out, 0, 0);
    const encode = (q) => j.toBlob(async (b) => {
      if (!b) return;
      if (b.size > 128 * 1024 && q > 0.3) { encode(q - 0.2); return; }
      onFaceJpeg(new Uint8Array(await b.arrayBuffer()));
    }, 'image/jpeg', q);
    encode(0.85);
  }
  function setImage(source) {
    img = source; fit();
    crop = { x: 128, y: 128, r: Math.min(img.width, img.height) * view.scale * 0.45 };
    $('face-zoom').value = '1';
    draw(); commit();
  }
  function stopCam() {
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    $('face-shoot').hidden = true;
  }

  $('face-cam').addEventListener('click', async () => {
    err();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      video.srcObject = stream; await video.play();
      $('face-shoot').hidden = false;
      draw();
    } catch (e) { err(`camera unavailable: ${e.message || e}`); stopCam(); }
  });
  $('face-shoot').addEventListener('click', () => {
    if (!stream || !video.videoWidth) return;
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    stopCam();
    setImage(c);
  });
  $('face-upload').addEventListener('click', () => $('face-file').click());
  $('face-file').addEventListener('change', async () => {
    const f = $('face-file').files[0];
    if (!f) return;
    err();
    try { stopCam(); setImage(await createImageBitmap(f)); } catch (e) { err(`cannot read that image: ${e.message || e}`); }
    $('face-file').value = '';
  });
  $('face-clear').addEventListener('click', () => { stopCam(); img = null; draw(); commit(); err(); });
  $('face-zoom').addEventListener('input', () => {
    if (!img) return;
    const base = Math.min(img.width, img.height) * view.scale * 0.45;
    crop.r = Math.max(12, Math.min(128, base / Number($('face-zoom').value)));
    draw();
  });
  $('face-zoom').addEventListener('change', commit);
  let drag = null;
  // Pointer position in preview pixels (the canvas is displayed smaller than 256).
  const at = (e) => ({ x: e.offsetX * 256 / cv.clientWidth, y: e.offsetY * 256 / cv.clientHeight });
  cv.addEventListener('pointerdown', (e) => { if (!img || stream) return; const p = at(e); drag = { x: p.x - crop.x, y: p.y - crop.y }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => { if (!drag) return; const p = at(e); crop.x = p.x - drag.x; crop.y = p.y - drag.y; draw(); });
  cv.addEventListener('pointerup', () => { if (drag) { drag = null; commit(); } });
  cv.addEventListener('wheel', (e) => {
    if (!img) return;
    e.preventDefault();
    crop.r = Math.max(12, Math.min(160, crop.r * (e.deltaY > 0 ? 1.06 : 0.94)));
    draw(); commit();
  }, { passive: false });
  draw();
  return { setImage: (c) => { stopCam(); const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height; copy.getContext('2d').drawImage(c, 0, 0); setImage(copy); }, stillRgba: () => still };
}
