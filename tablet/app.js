/* =============================================================================
NAM A2 TABLET SKELETON — plain JS, no build step.
Speaks Contract 3 verbatim. Two pieces are hand-mirrored from the TESTED TS
reference modules (keep them in sync if either changes):
  - applyPath / rev-gap logic  <- hub/src/mirror/mirror.ts (MirrorClient)
  - band collapse + peak hold  <- hub/src/math/bands.ts
The tablet holds NO authority (Contract 3): it renders the mirror it is told
and shows optimistic hints that only SOLIDIFY when confirmation arrives.
============================================================================= */
'use strict';

const WS_PROTOCOL_VERSION = 1;
const SLOTS = 6;
const BANDS = 48;
const BIN_COUNT = 256;

// ---------- mirror client (mirror of MirrorClient in mirror.ts) -------------
let snap = null;
let rev = -1;

function applyPath(s, path, value) {
  const seg = path.split('/');
  const fail = () => { throw new Error('unknown path ' + path); };
  if (seg.length === 1) { if (!(seg[0] in s)) fail(); s[seg[0]] = value; return; }
  if (seg[0] === 'chains') {
    const chain = s.chains.find((c) => c.id === seg[1]); if (!chain) fail();
    if (seg.length === 3) { chain[seg[2]] = value; return; }
    if (seg[2] === 'cells' && seg.length === 5) {
      const cell = chain.cells.find((cl) => cl.slot === Number(seg[3])); if (!cell) fail();
      cell[seg[4]] = value; return;
    }
    if (seg[2] === 'looper' && seg.length === 4) { if (!chain.looper) fail(); chain.looper[seg[3]] = value; return; }
    if (seg[2] === 'devices' && seg[4] === 'params' && seg[6] === 'value' && seg.length === 7) {
      const dev = chain.devices.find((d) => d.role === seg[3]); if (!dev) fail();
      const p = dev.params.find((pp) => pp.name === seg[5]); if (!p) fail();
      p.value = value; return;
    }
    fail();
  }
  if (seg[0] === 'scenes' && seg.length === 3) {
    const sc = s.scenes.find((x) => x.id === seg[1]); if (!sc) fail();
    sc[seg[2]] = value; return;
  }
  fail();
}

// ---------- band math (mirror of bands.ts) -----------------------------------
function makeBandMap() {
  const fHigh = 16000, fLow = 40, binHz = fHigh / BIN_COUNT;
  const ranges = [];
  let prevEnd = Math.max(0, Math.floor(fLow / binHz));
  for (let b = 0; b < BANDS; b++) {
    let end = Math.ceil((fLow * Math.pow(fHigh / fLow, (b + 1) / BANDS)) / binHz);
    if (end <= prevEnd) end = prevEnd + 1;
    if (end > BIN_COUNT) end = BIN_COUNT;
    ranges.push([prevEnd, end]); prevEnd = end;
  }
  ranges[BANDS - 1][1] = BIN_COUNT;
  return ranges;
}
const BAND_MAP = makeBandMap();
function collapse(mags) {
  return BAND_MAP.map(([a, b]) => { let s = 0; for (let i = a; i < b; i++) s += mags[i]; return b > a ? s / (b - a) : 0; });
}

// ---------- command lifecycle (tablet side: optimistic hints) ----------------
let cmdSeq = 0;
const pendingByCmd = new Map(); // commandId -> {el, revertClass}

/** Throttle for CONTINUOUS controls (sliders): at most one command per `ms`,
 *  trailing edge guaranteed so the FINAL value always lands. Without this a
 *  single drag emits ~70 commands (observed 2026-07-19) — supersession copes,
 *  but the wire shouldn't have to. */
function throttleSend(fn, ms) {
  let last = 0, timer = null, pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    pendingArgs = args;
    if (now - last >= ms) { last = now; fn(...pendingArgs); pendingArgs = null; }
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null; last = Date.now();
        if (pendingArgs) { fn(...pendingArgs); pendingArgs = null; }
      }, ms - (now - last));
    }
  };
}
function sendCommand(kind, fields, hint) {
  const commandId = 'c' + (++cmdSeq) + '_' + Date.now();
  const semantics = { absolute: true, mutation: kind === 'duplicate_clip_to' ? 'stateful' : 'idempotent' };
  send({ channel: 'control', type: 'command', payload: { kind, commandId, semantics, ...fields } });
  if (hint) pendingByCmd.set(commandId, hint);
  return commandId;
}
function onCommandStatus(st) {
  const hint = pendingByCmd.get(st.commandId);
  if (!hint) return;
  const { el } = hint;
  if (st.phase === 'sent') { el && el.classList.add('intent'); }
  if (st.phase === 'queued' && el) {
    el.classList.remove('intent'); el.classList.add('queued');
    let remaining = st.queuedForMs || 0;
    el.dataset.count = (remaining / 1000).toFixed(1);
    const iv = setInterval(() => {
      remaining -= 100;
      if (remaining <= 0 || !el.classList.contains('queued')) { clearInterval(iv); return; }
      el.dataset.count = (remaining / 1000).toFixed(1);
    }, 100);
  }
  if (st.phase === 'confirmed') {
    // the hint dissolves; TRUTH arrived via deltas and render() shows it
    el && el.classList.remove('intent', 'queued');
    pendingByCmd.delete(st.commandId);
  }
  if (st.phase === 'failed') {
    // revert to real prior state + calm notice (arch §12) — render() already
    // shows the untouched mirror, we just drop the hint and flash
    el && el.classList.remove('intent', 'queued');
    el && el.classList.add('failed');
    el && setTimeout(() => el.classList.remove('failed'), 400);
    toast(st.reason || "didn't take — retry");
    pendingByCmd.delete(st.commandId);
  }
}

// ---------- websocket ---------------------------------------------------------
let ws;
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => {
    setConn(true);
    // Contract 3: on (re)connect discard optimistic hints, await a snapshot
    pendingByCmd.clear();
    send({ channel: 'control', type: 'hello', payload: { protocol: WS_PROTOCOL_VERSION, client: 'tablet', resumeFromRev: rev >= 0 ? rev : null } });
  };
  ws.onclose = () => { setConn(false); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.channel === 'state') {
      if (msg.type === 'snapshot') { snap = msg.payload; rev = msg.rev; buildDom(); render(); }
      else if (msg.type === 'delta') {
        if (snap === null || msg.rev !== rev + 1) return resync();
        try { for (const c of msg.payload.changes) applyPath(snap, c.path, c.value); }
        catch { return resync(); }
        rev = msg.rev; render();
      } else if (msg.type === 'command_status') onCommandStatus(msg.payload);
      document.getElementById('rev').textContent = 'rev ' + rev;
    } else if (msg.channel === 'telemetry') {
      if (msg.type === 'spectra') drawSpectrum(msg.payload);
      if (msg.type === 'beat') pulseBeat();
    }
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function resync() { send({ channel: 'control', type: 'resync_request', payload: { haveRev: rev } }); }
function setConn(ok) {
  const el = document.getElementById('conn');
  el.textContent = ok ? 'linked' : 'reconnecting…';
  el.classList.toggle('ok', ok);
}

// ---------- DOM ----------------------------------------------------------------
const chainEls = new Map(); // chainId -> {root, cells[], canvas, peak[], vol, mute, tagToId}
const tagToChain = new Map();

function buildDom() {
  const host = document.getElementById('chains');
  host.innerHTML = '';
  chainEls.clear(); tagToChain.clear();
  for (const chain of snap.chains) {
    tagToChain.set(chain.id.replace(/^chain_/, ''), chain.id);
    const root = document.createElement('div');
    root.className = 'chain';
    root.style.setProperty('--chaincolor', chain.color);

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<div class="name">${chain.name}</div><div class="input">${chain.inputName ?? ''} · in</div><div class="livebadge">● LIVE</div>`;
    head.onclick = () => {
      // UI toggle, absolute commands: live chain -> stand_down; else go_live.
      const kind = currentChain(chain.id).live ? 'stand_down' : 'go_live';
      sendCommand(kind, { chain: chain.id }, { el: root });
    };
    root.appendChild(head);

    const cellsEl = document.createElement('div');
    cellsEl.className = 'cells';
    const cellRefs = [];
    for (let s = 0; s < SLOTS; s++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = `<span class="label"></span><span class="loopbtn">↻</span>`;
      cell.onclick = () => {
        if (dupMode) return cellTapDup(chain.id, s, cell);
        const mirror = currentChain(chain.id).cells.find((c) => c.slot === s);
        // recording cell: fire again = FINISH the take and loop it (Live behavior);
        // playing cell: stop; empty cell: fire = record promotion (hub policy).
        const kind = mirror.recording ? 'fire_clip' : mirror.playing ? 'stop_clip' : 'fire_clip';
        sendCommand(kind, { cell: { chain: chain.id, slot: s } }, { el: cell });
      };
      const lb = cell.querySelector('.loopbtn');
      let holdTimer = null, held = false;
      lb.oncontextmenu = (ev) => ev.preventDefault();
      lb.onpointerdown = () => {
        held = false;
        holdTimer = setTimeout(() => {
          held = true;
          toast('looper: STOP (hold)');
          sendCommand('looper_state', { chain: chain.id, state: 0 }, { el: cell });
        }, 500); // hold ↻ half a second = looper Stop (the tap cycle has no Stop)
      };
      lb.onpointerup = lb.onpointerleave = () => clearTimeout(holdTimer);
      lb.onclick = (ev) => {
        ev.stopPropagation();
        if (held) { held = false; return; } // the hold already sent Stop
        // §15 pedal-style tap cycle: Stop(0)→Record(2), Record(2)→Play(1)
        // (closes the take), Play(1)→Overdub(3), Overdub(3)→Play(1).
        const looperState = currentChain(chain.id).devices.find((d) => d.role === 'looper')?.params.find((p) => p.name === 'State');
        const cur = looperState ? looperState.value : 0;
        const next = cur === 0 ? 2 : cur === 2 ? 1 : cur === 1 ? 3 : 1;
        const NAMES = ['Stop', 'Play', 'REC', 'OVERDUB'];
        toast('looper: ' + NAMES[cur] + ' → ' + NAMES[next]); // DEBUG (rig sprint) — visible evidence of the tablet's belief at tap time
        sendCommand('looper_state', { chain: chain.id, state: next }, { el: cell });
      };
      cellsEl.appendChild(cell);
      cellRefs.push(cell);
    }
    root.appendChild(cellsEl);

    const strip = document.createElement('div');
    strip.className = 'strip';
    const canvas = document.createElement('canvas');
    canvas.className = 'spec'; canvas.width = 190; canvas.height = 44;
    const mixer = document.createElement('div');
    mixer.className = 'mixer';
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01;
    const volSend = throttleSend((v) => sendCommand('set_volume', { chain: chain.id, value01: v }), 80);
    vol.oninput = () => volSend(Number(vol.value));
    const mute = document.createElement('button');
    mute.className = 'silk mute'; mute.textContent = 'M';
    mute.onclick = () => sendCommand('set_mute', { chain: chain.id, muted: !currentChain(chain.id).muted });
    mixer.append(vol, mute);
    // sends row (Phase 3 item 6): A = shared reverb, B = shared delay
    const sends = document.createElement('div');
    sends.className = 'sends';
    const mkSend = (bus) => {
      const wrap = document.createElement('label');
      wrap.className = 'sendctl';
      wrap.textContent = bus;
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 1; r.step = 0.01;
      const push = throttleSend((v) => sendCommand('set_send', { chain: chain.id, send: bus, value01: v }), 80);
      r.oninput = () => push(Number(r.value));
      wrap.appendChild(r);
      sends.appendChild(wrap);
      return r;
    };
    const sendA = mkSend('A');
    const sendB = mkSend('B');
    strip.append(canvas, mixer, sends);
    root.appendChild(strip);

    host.appendChild(root);
    chainEls.set(chain.id, { root, cells: cellRefs, canvas, peak: new Array(BANDS).fill(0), lastT: 0, vol, mute, sendA, sendB });
  }
  // scenes bar
  const scenes = document.getElementById('scenes');
  scenes.innerHTML = '<div class="label">Scenes</div>';
  snap.scenes.forEach((sc) => {
    const b = document.createElement('button');
    b.className = 'silk'; b.textContent = sc.name;
    b.onclick = () => sendCommand('launch_scene', { scene: sc.id }, { el: b });
    scenes.appendChild(b);
  });
  scenes.appendChild(document.createElement('div'));
}

function currentChain(id) { return snap.chains.find((c) => c.id === id); }

function render() {
  document.getElementById('tempo').textContent = snap.tempoBpm.toFixed(1) + ' BPM';
  document.getElementById('metro').classList.toggle('on', snap.metronome);
  document.getElementById('play').classList.toggle('on', snap.isPlaying);
  document.getElementById('stop').classList.toggle('on', !snap.isPlaying);
  for (const chain of snap.chains) {
    const els = chainEls.get(chain.id);
    if (!els) continue;
    els.root.classList.toggle('live', chain.live);
    els.root.style.opacity = chain.muted ? 0.45 : 1;
    if (document.activeElement !== els.vol) els.vol.value = chain.volume01;
    if (document.activeElement !== els.sendA) els.sendA.value = chain.sendA01;
    if (document.activeElement !== els.sendB) els.sendB.value = chain.sendB01;
    els.mute.classList.toggle('on', chain.muted);
    const looper = chain.devices.find((d) => d.role === 'looper')?.params.find((p) => p.name === 'State');
    const lst = looper ? looper.value : -1;
    const GLYPH = ['↻', '↻', '●', '◉'];
    chain.cells.forEach((cellMirror) => {
      const el = els.cells[cellMirror.slot];
      el.classList.toggle('hasclip', cellMirror.hasClip);
      el.classList.toggle('playing', cellMirror.playing);
      el.classList.toggle('recording', cellMirror.recording);
      el.classList.toggle('looping', !!looper && looper.value >= 2 && cellMirror.playing);
      el.querySelector('.label').textContent = cellMirror.name ?? '';
      // loop button always shows the tablet's BELIEVED looper state
      const lb = el.querySelector('.loopbtn');
      lb.textContent = GLYPH[lst] ?? '↻';
      lb.className = 'loopbtn st' + lst;
    });
  }
}

// ---------- spectra + beat -----------------------------------------------------
function drawSpectrum(frame) {
  const chainId = tagToChain.get(frame.chainTag);
  const els = chainId && chainEls.get(chainId);
  if (!els) return;
  const chain = currentChain(chainId);
  const bands = collapse(frame.magnitudes);
  const now = frame.tMs;
  const dt = els.lastT ? Math.min(0.2, (now - els.lastT) / 1000) : 0;
  els.lastT = now;
  for (let i = 0; i < BANDS; i++) els.peak[i] = Math.max(bands[i], els.peak[i] - 0.6 * dt);

  const ctx = els.canvas.getContext('2d');
  const W = els.canvas.width, H = els.canvas.height, bw = W / BANDS;
  ctx.fillStyle = '#10150f'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = chain.color;
  for (let i = 0; i < BANDS; i++) {
    const h = bands[i] * (H - 4);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
    ctx.globalAlpha = 1;
    const ph = els.peak[i] * (H - 4);
    ctx.fillRect(i * bw + 0.5, H - ph - 1.5, bw - 1.5, 1.5); // falling caps
  }
}

let beatOff;
function pulseBeat() {
  const lamp = document.getElementById('beatlamp');
  lamp.classList.remove('off');
  clearTimeout(beatOff);
  beatOff = setTimeout(() => lamp.classList.add('off'), 90);
}

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

document.getElementById('metro').onclick = () =>
  sendCommand('set_metronome', { on: !snap.metronome });

// ---------- DUP mode (TEMPORARY test affordance for duplicate_clip_to; the
// real interaction is the hero drag — this stands in until it's built) ------
let dupMode = false, dupFrom = null;
function exitDup() {
  dupMode = false;
  if (dupFrom) dupFrom.el.classList.remove('dupsrc');
  dupFrom = null;
  document.getElementById('dup').classList.remove('on');
}
function cellTapDup(chainId, s, el) {
  const cellMirror = currentChain(chainId).cells.find((c) => c.slot === s);
  if (!dupFrom) {
    if (!cellMirror.hasClip) { toast('pick a cell WITH a clip as the source'); return; }
    dupFrom = { chain: chainId, slot: s, el };
    el.classList.add('dupsrc');
    toast('source picked — now tap the target cell');
  } else {
    sendCommand('duplicate_clip_to', { from: { chain: dupFrom.chain, slot: dupFrom.slot }, to: { chain: chainId, slot: s } }, { el });
    exitDup();
  }
}
document.getElementById('dup').onclick = () => {
  if (dupMode) { exitDup(); toast('dup cancelled'); return; }
  dupMode = true;
  document.getElementById('dup').classList.add('on');
  toast('DUP: tap the source cell');
};

// Transport (Phase 3): ABSOLUTE states — ▶ always means "playing = true".
document.getElementById('play').onclick = () =>
  sendCommand('set_playing', { playing: true }, { el: document.getElementById('play') });
document.getElementById('stop').onclick = () =>
  sendCommand('set_playing', { playing: false }, { el: document.getElementById('stop') });

connect();
