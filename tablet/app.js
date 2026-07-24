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
const pendingByCmd = new Map();
const pendingDeleteRows = new Map(); // commandId -> hidden row (optimistic delete revert)
const pendingAddRows = new Map(); // commandId -> placeholder row (optimistic add) // commandId -> {el, revertClass}

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
  if ((st.phase === 'failed' || st.phase === 'confirmed') && pendingAddRows.has(st.commandId)) {
    if (st.phase === 'failed') pendingAddRows.get(st.commandId).remove(); // snapshot wipes it on success
    pendingAddRows.delete(st.commandId);
  }
  if (st.phase === 'failed' && pendingDeleteRows.has(st.commandId)) {
    pendingDeleteRows.get(st.commandId).style.display = ''; // revert the optimistic removal
    pendingDeleteRows.delete(st.commandId);
  }
  if (st.phase === 'confirmed') pendingDeleteRows.delete(st.commandId);
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

// ---- shared touch-picker chrome + tone tree (Phase 5a; owner design revs) ----
function openPickerUI() {
  const overlay = document.createElement('div');
  overlay.className = 'pickwrap';
  const panel = document.createElement('div');
  panel.className = 'pickpanel';
  overlay.appendChild(panel);
  overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  const ui = {
    overlay, panel,
    close: () => overlay.remove(),
    header(title, backFn) {
      panel.innerHTML = '';
      const h = document.createElement('div'); h.className = 'pickhead';
      if (backFn) { const b = document.createElement('button'); b.className = 'pickback silk'; b.textContent = '‹'; b.onclick = backFn; h.appendChild(b); }
      const t = document.createElement('div'); t.className = 'picktitle silk'; t.textContent = title; h.appendChild(t);
      panel.appendChild(h);
    },
    bigRow(items) {
      const g = document.createElement('div'); g.className = 'pickgrid';
      for (const it of items) {
        const b = document.createElement('button'); b.className = 'pickbig' + (it.dim ? ' dim' : '');
        b.innerHTML = `<div class="glyph">${it.glyph}</div><div class="cap silk">${it.label}</div>`;
        b.onclick = it.go; g.appendChild(b);
      }
      panel.appendChild(g);
    },
    listCol(items) {
      const c = document.createElement('div'); c.className = 'picklist';
      for (const it of items) {
        const b = document.createElement('button'); b.className = 'pickbtn silk'; b.textContent = it.label; b.onclick = it.go; c.appendChild(b);
      }
      panel.appendChild(c);
    },
    note(text) { const n = document.createElement('div'); n.className = 'picknote'; n.textContent = text; panel.appendChild(n); },
    cancel() { const b = document.createElement('button'); b.className = 'pickbtn cancel silk'; b.textContent = 'CANCEL'; b.onclick = () => overlay.remove(); panel.appendChild(b); },
  };
  return ui;
}
const cleanToneName = (x) => String(x).replace(/\.nam$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
async function fetchTones() { try { return await (await fetch('/tones.json')).json(); } catch { return []; } }
/** Capture tree: gear -> pack -> capture, single-child levels auto-descend;
 *  a pack holding ONE capture loads from the pack button (owner rules). */
function toneTree(ui, tones, back, onPick, extras) {
  const seg = (t) => (t.file || '').split('/');
  const gearOf = (t) => (seg(t).length >= 2 ? seg(t)[0] : 'OTHER');
  const packOf = (t) => (seg(t).length >= 3 ? seg(t)[1] : '—');
  const stepGear = () => {
    const gears = [...new Set(tones.map(gearOf))];
    if (gears.length === 1) return stepPack(gears[0], back);
    ui.header('CAPTURE TYPE', back);
    ui.listCol(gears.map((g) => ({ label: g.toUpperCase(), go: () => stepPack(g, stepGear) })));
    if (gears.length === 0) ui.note('the manifest has no captures yet');
    if (extras) extras(ui);
    ui.cancel();
  };
  const stepPack = (gear, backFn) => {
    const ts = tones.filter((t) => gearOf(t) === gear);
    const packs = [...new Set(ts.map(packOf))];
    if (packs.length === 1) return stepCapture(gear, packs[0], backFn);
    ui.header(gear.toUpperCase(), backFn);
    ui.listCol(packs.map((pk) => {
      const caps = ts.filter((t) => packOf(t) === pk);
      return caps.length === 1
        ? { label: pk.toUpperCase() + ' · ' + caps[0].name.toUpperCase(), go: () => onPick(caps[0].index, cleanToneName(pk)) }
        : { label: pk.toUpperCase() + ` (${caps.length})`, go: () => stepCapture(gear, pk, () => stepPack(gear, backFn)) };
    }));
    ui.cancel();
  };
  const stepCapture = (gear, pack, backFn) => {
    const caps = tones.filter((t) => gearOf(t) === gear && packOf(t) === pack);
    if (caps.length === 1) return onPick(caps[0].index, cleanToneName(pack === '—' ? caps[0].name : pack));
    ui.header(pack === '—' ? gear.toUpperCase() : pack.toUpperCase(), backFn);
    ui.listCol(caps.map((t) => ({ label: t.name.toUpperCase(), go: () => onPick(t.index, cleanToneName(t.name)) })));
    ui.cancel();
  };
  stepGear();
}
const FIXTURE_RE = /nam_a2|eq eight|looper|spectral/i;
/** FX side panel: the chain's smart defaults + any extra devices, as touch
 *  toggles. Present device -> Device On toggle; absent default -> "+ ADD"
 *  (inserts via the frozen Phase-1 browser path). */
async function openFxPanel(chainId, hintEl) {
  const ui = openPickerUI();
  ui.header('LOADING FX…');
  let data;
  try { data = await (await fetch(`/fx.json?chain=${encodeURIComponent(chainId)}`)).json(); }
  catch { ui.header('FX — hub unreachable'); ui.cancel(); return; }
  const render = () => {
    ui.header(`FX — ${currentChain(chainId)?.name ?? ''}`.trim());
    const rows = [];
    // curated defaults first: match by catalog label against device names
    for (const cat of data.catalog) {
      const dev = data.devices.find((d) => d.name.toLowerCase().includes(cat.id === 'pedal' ? 'pedal' : cat.label.toLowerCase()) && !FIXTURE_RE.test(d.name));
      if (dev) rows.push({ label: `${cat.label.toUpperCase()}  ${dev.on ? '●' : '○'}`, go: () => toggle(dev) });
      else rows.push({ label: `+ ADD ${cat.label.toUpperCase()}`, go: () => addFx(cat.id, cat.label) });
    }
    // any other non-fixture, non-catalog devices get plain toggles
    for (const dev of data.devices) {
      if (FIXTURE_RE.test(dev.name)) continue;
      if (data.catalog.some((c) => dev.name.toLowerCase().includes(c.id === 'pedal' ? 'pedal' : c.label.toLowerCase()))) continue;
      rows.push({ label: `${dev.name.toUpperCase()}  ${dev.on ? '●' : '○'}`, go: () => toggle(dev) });
    }
    ui.listCol(rows);
    ui.note('● on · ○ bypassed · editing comes later (per-device UI + AI)');
    ui.cancel();
  };
  const refetch = async () => {
    try { data = await (await fetch(`/fx.json?chain=${encodeURIComponent(chainId)}`)).json(); render(); } catch {}
  };
  const toggle = (dev) => {
    sendCommand('set_device_on', { chain: chainId, device: dev.index, on: !dev.on }, { el: hintEl });
    dev.on = !dev.on; render(); // optimistic; refetch corrects if refused
    setTimeout(refetch, 900);
  };
  const addFx = (id, label) => {
    ui.header(`ADDING ${label.toUpperCase()}…`);
    sendCommand('add_fx', { chain: chainId, fx: id }, { el: hintEl });
    let ticks = 0;
    const before = data.devices.length;
    const poll = setInterval(async () => {
      if (!document.contains(ui.overlay)) return void clearInterval(poll);
      await refetch(); // re-renders with fresh truth every tick
      if (data.devices.length > before || ++ticks > 14) clearInterval(poll); // failure toast already showed
    }, 1200);
  };
  render();
}

/** Per-chain tone change (owner ask 2026-07-24): existing set_param vocabulary,
 *  zero new commands. Includes the BROWSE TONE3000 door (the bridge web UI). */
async function openToneChanger(chainId, hintEl) {
  const tones = await fetchTones();
  const ui = openPickerUI();
  // DOWNLOAD WATCHER (owner report: the picker sat there while a TONE3000
  // download landed + auto-loaded Live-side). Poll the manifest while this
  // picker is open; growth = the download landed and the hub auto-selected —
  // close with a receipt instead of sitting stale.
  const baseCount = tones.length;
  const watch = setInterval(async () => {
    if (!document.contains(ui.overlay)) return void clearInterval(watch);
    const fresh = await fetchTones();
    if (fresh.length > baseCount) {
      clearInterval(watch);
      const newest = fresh.reduce((a, b) => (b.index > a.index ? b : a));
      toast(`downloaded: ${newest.name} — loaded onto this chain`);
      ui.close();
    }
  }, 3000);
  toneTree(ui, tones, null, (model, name) => {
    clearInterval(watch);
    ui.close();
    sendCommand('set_param', { chain: chainId, device: 'amp', param: 'Model', value: model }, { el: hintEl });
    toast(`loading tone: ${name}`);
  }, (u) => {
    const b = document.createElement('button');
    b.className = 'pickbtn silk';
    b.textContent = '⇲ BROWSE TONE3000';
    b.onclick = () => {
      fetch(`/browse-intent?chain=${encodeURIComponent(chainId)}`).catch(() => {});
      window.open(`http://${location.hostname}:7333`, '_blank');
    };
    u.panel.appendChild(b);
  });
}

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
    // IO subtitle (owner 2026-07-24): Mono/Stereo (Midi later) instead of the
    // raw physical-input name — pairs (synth 3/4) read STEREO, singles MONO.
    const ioLabel = chain.inputName == null ? '' : (chain.inputName === 'synth' || /\//.test(chain.inputName)) ? 'Stereo' : 'Mono';
    head.innerHTML = `<div class="name">${chain.name}</div><div class="input">${ioLabel}</div><div class="livebadge">● LIVE</div>`;
    head.onclick = () => {
      // UI toggle, absolute commands: live chain -> stand_down; else go_live.
      const kind = currentChain(chain.id).live ? 'stand_down' : 'go_live';
      sendCommand(kind, { chain: chain.id }, { el: root });
    };
    // FX panel (owner decision 2026-07-24: stock-Live FX chain, smart-default
    // toggles; editing deferred to per-device UI + AI later).
    const fxBtn = document.createElement('div');
    fxBtn.className = 'tonechip';
    fxBtn.textContent = 'FX';
    fxBtn.onclick = (ev) => { ev.stopPropagation(); openFxPanel(chain.id, root); };
    head.appendChild(fxBtn);
    // Tone chip (owner ask 2026-07-24): change this chain's amp tone any time.
    const toneBtn = document.createElement('div');
    toneBtn.className = 'tonechip';
    toneBtn.textContent = '⌁';
    toneBtn.onclick = (ev) => { ev.stopPropagation(); openToneChanger(chain.id, root); };
    head.appendChild(toneBtn);
    // Chain delete (Phase 5a work item 3): small ✕, native confirm step —
    // this destroys a Live track. Hub re-guards (last chain / recording).
    const delBtn = document.createElement('div');
    delBtn.className = 'chaindel';
    delBtn.textContent = '✕';
    delBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete chain "${currentChain(chain.id).name}"? This removes its Live track and clips.`)) return;
      // OPTIMISTIC removal (arch §12): the row vanishes NOW; the snapshot after
      // the observed delete makes it real. On failure it comes back + toast.
      root.style.display = 'none';
      const cmdId = sendCommand('delete_chain', { chain: chain.id }, { el: root });
      pendingDeleteRows.set(cmdId, root);
    };
    head.appendChild(delBtn);
    // Tap the NAME itself to rename (rename_chain, __provisional 2026-07-23).
    // The hub owns the [TN] marker — we only ever send the human label.
    head.querySelector('.name').onclick = (ev) => {
      ev.stopPropagation(); // don't toggle go_live/stand_down
      const cur = currentChain(chain.id).name;
      const next = prompt('Rename chain', cur);
      if (next === null) return;
      const label = next.trim();
      if (!label || label === cur) return;
      sendCommand('rename_chain', { chain: chain.id, name: label }, { el: root });
    };
    root.appendChild(head);

    const cellsEl = document.createElement('div');
    cellsEl.className = 'cells';
    const cellRefs = [];
    for (let s = 0; s < SLOTS; s++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.chain = chain.id;
      cell.dataset.slot = String(s);
      cell.innerHTML = `<canvas class="cym"></canvas><span class="loopbtn">↻</span>`;
      cell.onclick = () => {
        if (dragState.suppressClick) { dragState.suppressClick = false; return; } // the drag consumed this press
        const mirror = currentChain(chain.id).cells.find((c) => c.slot === s);
        // recording cell: fire again = FINISH the take and loop it (Live behavior);
        // playing cell: stop; empty cell: fire = record promotion (hub policy).
        const kind = mirror.recording ? 'fire_clip' : mirror.playing ? 'stop_clip' : 'fire_clip';
        sendCommand(kind, { cell: { chain: chain.id, slot: s } }, { el: cell });
      };
      // HERO DRAG (Phase 5a work item 4; retires the DUP scaffolding): HOLD an
      // occupied cell ~300ms to LIFT it (native scroll wins before that), drag
      // the ghost — a live snapshot of the cell's cymatic — onto any cell, drop
      // to duplicate there (existing STATEFUL duplicate_clip_to: the hub's
      // delete-then-dup + self-dup guards apply unchanged).
      cell.onpointerdown = (ev) => {
        if (ev.target.closest('.loopbtn')) return; // ↻ keeps its own gestures
        const mirror = currentChain(chain.id).cells.find((c) => c.slot === s);
        if (!mirror.hasClip) return; // only clips lift
        heroDragArm(ev, cell, chain.id, s);
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
    canvas.onclick = () => openEqEditor(chain.id); // §16b: tap spectrum -> EQ pop-up
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

  // "+ ADD CHAIN" row (Phase 5a work item 2): opens the amp picker (P5-a) —
  // stock tones from the hub-served manifest (/tones.json) plus DI/no-amp.
  const addRow = document.createElement('div');
  addRow.className = 'addchain silk';
  addRow.textContent = '+ ADD CHAIN';
  addRow.onclick = async () => {
    // Root order rev (owner 2026-07-24b): MONO / STEREO / MIDI first, then
    // DI / AMP within the audio flavors. Tree + auto-descend rules unchanged.
    const tones = await fetchTones();
    const ui = openPickerUI();
    const fire = (amp, input, name) => {
      ui.close();
      // OPTIMISTIC placeholder (owner report: adds took a while to show): a
      // temporary row appears NOW; the confirming snapshot rebuilds the DOM
      // (wiping it), and a failure removes it alongside the toast.
      const ph = document.createElement('div');
      ph.className = 'addchain silk adding';
      ph.textContent = `ADDING ${name ? name.toUpperCase() : 'CHAIN'}…`;
      host.insertBefore(ph, addRow);
      const cmdId = sendCommand('add_chain', { amp, input, name }, { el: addRow });
      pendingAddRows.set(cmdId, ph);
    };
    const stepRoot = () => {
      ui.header('NEW CHAIN');
      ui.bigRow([
        { glyph: '🎸', label: 'MONO', go: () => stepKind('mono') },
        { glyph: '🎹', label: 'STEREO', go: () => stepKind('stereo') },
        { glyph: '♪', label: 'MIDI', dim: true, go: () => toast('MIDI chains: future workstream (template + contract) — flagged') },
      ]);
      ui.cancel();
    };
    const stepKind = (input) => {
      ui.header(input.toUpperCase(), stepRoot);
      ui.bigRow([
        { glyph: '⎓', label: 'DI', go: () => fire({ kind: 'di' }, input) },
        { glyph: '⌁', label: 'AMP', go: () => toneTree(ui, tones, () => stepKind(input), (model, name) => fire({ kind: 'tone', model }, input, name)) },
      ]);
      ui.cancel();
    };
    stepRoot();
  };
  host.appendChild(addRow);
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
    const nameEl = els.root.querySelector('.name'); // live rename flow (P5-e self-healing)
    if (nameEl && nameEl.textContent !== chain.name) nameEl.textContent = chain.name;
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
      // Cymatic tile faces (owner design 2026-07-23): stopped clip = static B/W
      // figure; playing = live spectrum-driven figure in the centroid color
      // (drawn per-frame in drawSpectrum). No clip-name labels on tiles.
      cymRenderStatic(el, chain.id, cellMirror);
      // loop button always shows the tablet's BELIEVED looper state
      const lb = el.querySelector('.loopbtn');
      lb.textContent = GLYPH[lst] ?? '↻';
      lb.className = 'loopbtn st' + lst;
    });
  }
  if (eqUi.chain) drawEqEditor(); // confirmed deltas move the curve/handles
}

// ---------- spectra + beat -----------------------------------------------------
// Display mapping (Phase 4 rig finding 2026-07-21): the WIRE is linear-honest
// (full-scale sine ~= 1.0), but real DI guitar through the chain peaks around
// 0.05 — invisible on a linear scale. Map linear magnitude to dB for DISPLAY
// only: -60 dB .. 0 dB onto 0..1 bar height. Telemetry stays untouched.
const DB_FLOOR = -60;
function magToDb01(m) {
  if (m <= 0.001) return 0;                       // at/below the floor
  const db = 20 * Math.log10(m);                  // 0.001 -> -60, 1.0 -> 0
  return Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
}

// Frequency rainbow (owner decision 2026-07-22): bars are hued by band
// frequency (bass=red -> treble=violet) and a smoothed SPECTRAL CENTROID
// marker shows at a glance where the chain's energy currently lives.
// Chain identity color stays on cells/mixer; the spectrum speaks frequency.
const bandHue = (i) => (i / (BANDS - 1)) * 285; // 0=red (bass) .. 285=violet (treble)
const lastFrameByChain = new Map(); // chainId -> latest SpectralFrame (for the EQ editor)

// ---------- cymatics tiles (owner design 2026-07-23; rev 2026-07-24) ----------
// Chladni plate figures. Basis pool: cos(n pi X)cos(m pi Y) +/- cos(m pi X)cos(n pi Y)
// for 1<=n<m<=7 -> 21 pairs x 2 signs = 42 basis figures; each tile mixes a
// seeded weighted subset, so distinct figures number in the thousands.
// CENTERED by construction: coordinates X=|2x-1| give 4-fold mirror symmetry
// (compute one quadrant, mirror the rest) — and full-resolution rendering
// (dpr-aware, no upscale blur). Bright nodal lines + powder speckle.
const CYM = (() => {
  const POOL = [];
  // sparse rev (owner 2026-07-24b): orders capped at 4 — the figure should read
  // at tile size in a glance. 6 pairs x signs/blends; variety now also comes
  // from per-mode PHASE DRIFT (playing tiles morph like a swept plate).
  for (let n = 1; n <= 4; n++) for (let m = n + 1; m <= 4; m++) POOL.push([n, m]);
  const tables = new Map(); // `${qw}x${qh}` -> {cx: cosT per n over x, cy: per y}
  function tab(qw, qh) {
    const key = qw + 'x' + qh;
    let t = tables.get(key);
    if (t) return t;
    const mk = (q) => {
      const a = [];
      for (let n = 0; n <= 7; n++) {
        const row = new Float32Array(q);
        for (let i = 0; i < q; i++) row[i] = Math.cos(n * Math.PI * (1 - i / (q - 1))); // edge->center
        a.push(row);
      }
      return a;
    };
    t = { cx: mk(qw), cy: mk(qh) };
    tables.set(key, t);
    return t;
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  /** Seeded mode subset: k modes from the pool, each with a sign. */
  function pickModes(seed, k) {
    const r = mulberry32(seed);
    const idx = POOL.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx.slice(0, k).map((i) => ({ n: POOL[i][0], m: POOL[i][1], sign: r() < 0.5 ? -1 : 1, rate: 0.05 + r() * 0.15, phase0: r() * Math.PI * 2 }));
  }
  function seedWeights(seed, k) { const r = mulberry32(seed ^ 0x5bd1e995); return Array.from({ length: k }, () => Math.pow(r(), 1.5) + 0.05); }
  function paint(canvas, modes, weights, hue, rng, phases) {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const qw = Math.ceil(W / 2), qh = Math.ceil(H / 2);
    const { cx, cy } = tab(qw, qh);
    let norm = 0; for (const wk of weights) norm += wk * wk;
    norm = Math.sqrt(norm) || 1;
    const ctx = canvas.getContext('2d');
    if (!canvas._cymImg || canvas._cymImg.width !== W || canvas._cymImg.height !== H)
      canvas._cymImg = ctx.createImageData(W, H); // reuse: no per-frame 200KB alloc
    const img = canvas._cymImg;
    const d = img.data;
    let cr = 255, cg = 255, cb = 255, base = 18;
    if (hue !== null) {
      const c = (1 - Math.abs(2 * 0.6 - 1)) * 0.95, hp = hue / 60, xx = c * (1 - Math.abs(hp % 2 - 1));
      const [r, g, b] = hp < 1 ? [c, xx, 0] : hp < 2 ? [xx, c, 0] : hp < 3 ? [0, c, xx] : hp < 4 ? [0, xx, c] : hp < 5 ? [xx, 0, c] : [c, 0, xx];
      const m = 0.6 - c / 2;
      cr = (r + m) * 245; cg = (g + m) * 245; cb = (b + m) * 245; base = 14;
    } else { cr = cg = cb = 225; }
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        let u = 0;
        for (let k = 0; k < modes.length; k++) {
          const mo = modes[k];
          const blend = phases ? Math.cos(phases[k]) * mo.sign : mo.sign; // swept-plate morph
          u += weights[k] * (cx[mo.n][x] * cy[mo.m][y] + blend * cx[mo.m][x] * cy[mo.n][y]);
        }
        const au = Math.abs(u);
        let core = 1 - Math.min(1, au / (0.46 * norm)); core = core > 0 ? core * core : 0;
        let halo = 1 - Math.min(1, au / (1.15 * norm)); halo = halo > 0 ? halo * halo * 0.20 : 0;
        let b = Math.min(1, core + halo + rng() * 0.03); // hot core + soft glow
        const R = base + b * cr, G = base + b * cg, B = base + b * cb;
        const xs = [x, W - 1 - x], ys = [y, H - 1 - y]; // 4-fold mirror
        for (const yy of ys) for (const xx2 of xs) {
          const o = (yy * W + xx2) << 2;
          d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return { paint, pickModes, seedWeights, mulberry32, hash };
})();

/** Static/cleared tile faces, called from render() on every state pass.
 *  Playing/recording cells are skipped here — drawSpectrum overdraws them live. */
function cymRenderStatic(el, chainId, cellMirror) {
  const canvas = el.querySelector('.cym');
  if (!canvas) return;
  if (!cellMirror.hasClip) {
    if (el.dataset.cymKey) { delete el.dataset.cymKey; const c = canvas.getContext('2d'); c && c.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  if (cellMirror.playing || cellMirror.recording) { delete el.dataset.cymKey; return; }
  // CLIP-FINGERPRINT seed (owner 2026-07-24: a duplicated clip must LOOK the
  // same wherever it lands). Identity = the clip's own name + length — Live
  // copies the name on duplicate, so copies match; fresh takes get Live's own
  // distinct auto-names. Chain/slot only breaks ties for nameless clips.
  const key = cellMirror.name
    ? `c:${cellMirror.name}:${cellMirror.lengthBeats ?? 0}`
    : `s:${chainId}:${cellMirror.slot}:${cellMirror.lengthBeats ?? 0}`;
  if (el.dataset.cymKey === key && canvas.width) return; // cached
  el.dataset.cymKey = key;
  const seed = CYM.hash(key);
  const k = 2 + (seed % 3); // 2-4 modes per static tile
  const modes = CYM.pickModes(seed, k);
  // seeded FIXED phases: statics sample the CONTINUOUS blend family (not just
  // the +/- endpoints) -> far wider variety, still fully deterministic — the
  // same clip in the same cell always draws the same figure (owner: keep that).
  CYM.paint(canvas, modes, CYM.seedWeights(seed, k), null, CYM.mulberry32(seed ^ 0x9e3779b9), modes.map((mo) => mo.phase0));
}

function drawSpectrum(frame) {
  const chainId = tagToChain.get(frame.chainTag);
  const els = chainId && chainEls.get(chainId);
  if (!els) return;
  lastFrameByChain.set(chainId, frame);
  const linear = collapse(frame.magnitudes);
  const bands = linear.map(magToDb01);
  const now = frame.tMs;
  const dt = els.lastT ? Math.min(0.2, (now - els.lastT) / 1000) : 0;
  els.lastT = now;
  for (let i = 0; i < BANDS; i++) els.peak[i] = Math.max(bands[i], els.peak[i] - 0.22 * dt); // slow decay (owner 2026-07-22)

  // spectral centroid over the display bands, EMA-smoothed. Weighted by the
  // SAME dB-mapped values the bars are drawn from (owner finding 2026-07-22:
  // linear weighting pegged the color bassward — raw linear energy lives in
  // the low fundamentals, so the chip disagreed with the visible dB picture;
  // matching scales makes the color agree with the bars by construction).
  let lin = 0, e = 0, we = 0;
  for (let i = 0; i < BANDS; i++) { lin += linear[i]; e += bands[i]; we += i * bands[i]; }
  const audible = lin > 0.003;
  if (audible && e > 0) {
    const idx = we / e;
    els.centroid = els.centroid === undefined ? idx : els.centroid * 0.85 + idx * 0.15;
    // clip-character accumulator (~8s memory, weighted by true loudness `lin`)
    els.tileHueAcc = (els.tileHueAcc ?? idx * lin) * 0.995 + idx * lin;
    els.tileHueW = (els.tileHueW ?? lin) * 0.995 + lin;
  } else { els.tileHueAcc = (els.tileHueAcc ?? 0) * 0.995; els.tileHueW = (els.tileHueW ?? 0) * 0.995; }

  const ctx = els.canvas.getContext('2d');
  const W = els.canvas.width, H = els.canvas.height, bw = W / BANDS;
  ctx.fillStyle = '#10150f'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < BANDS; i++) {
    ctx.fillStyle = `hsl(${bandHue(i)} 85% 55%)`;
    const h = bands[i] * (H - 4);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
    ctx.globalAlpha = 1;
    const ph = els.peak[i] * (H - 4);
    ctx.fillRect(i * bw + 0.5, H - ph - 1.5, bw - 1.5, 1.5); // falling caps
  }
  // chip envelope (owner 2026-07-24b): INSTANT attack, ~350ms release. The
  // hard audible threshold chattered frame-to-frame at the sound boundary and
  // the chip strobed; the release envelope both smooths the exit AND bridges
  // the boundary chatter (a re-trigger mid-fade just snaps back to full).
  // Zero added latency on onset — sound in = chip on, same frame.
  els.chipA = audible ? 1 : Math.max(0, (els.chipA ?? 0) - dt / 0.35);
  if (els.chipA > 0 && els.tileHueW > 0.001) {
    ctx.fillStyle = `hsl(${bandHue(els.tileHueAcc / els.tileHueW)} 95% 60%)`;
    ctx.globalAlpha = 0.95 * els.chipA;
    ctx.fillRect(0, 0, W, 3);
    ctx.globalAlpha = 1;
  }
  // playing/recording cells on this chain: live cymatic figure, centroid-tinted
  // (weights = the SAME dB-mapped display bands, grouped 48 -> 8; EMA-smoothed
  // so the figure breathes with the music instead of strobing)
  const chainMirror = snap && snap.chains.find((c) => c.id === chainId);
  if (chainMirror) {
    let updated = false;
    for (const cm of chainMirror.cells) {
      if (!cm.hasClip || !(cm.playing || cm.recording)) continue;
      // playing mode-family follows the CLIP too (same clip = same figure
      // family on any chain), re-picked when a different clip starts playing
      const clipKey = cm.name ? `c:${cm.name}:${cm.lengthBeats ?? 0}` : 'c:' + chainId;
      if (els.cymModesKey !== clipKey) {
        els.cymModesKey = clipKey;
        const cseed = CYM.hash(clipKey);
        els.cymModes = CYM.pickModes(cseed, 4); // sparse rev: 4 live modes
        els.cymW = CYM.seedWeights(cseed, 4); // figure exists even before sound
      }
      if (!updated) {
        updated = true;
        if (audible) { // SILENCE-FREEZE: never wash out / never drop the color
          for (let g = 0; g < 4; g++) { // 48 bands -> 4 groups of 12
            let s2 = 0; for (let j = 0; j < 12; j++) s2 += bands[g * 12 + j];
            els.cymW[g] = els.cymW[g] * 0.7 + (s2 / 12 + 0.02) * 0.3;
          }
        }
      }
      const cellEl = els.cells[cm.slot];
      const canvas = cellEl && cellEl.querySelector('.cym');
      if (!canvas) continue;
      // CLIP-CHARACTER hue (owner finding 2026-07-24: every sound's tail is
      // bass-heavy, so the INSTANTANEOUS centroid paints every ending red).
      // The tile uses a LOUDNESS-WEIGHTED running average of the centroid —
      // loud passages dominate, quiet tails barely move it. The strip's chip
      // stays instantaneous: chip = live meter, tile = the clip's character.
      const hue = bandHue(els.tileHueW > 0.001 ? els.tileHueAcc / els.tileHueW : (els.centroid ?? BANDS / 2));
      const phases = els.cymModes.map((mo) => mo.phase0 + (now / 1000) * mo.rate);
      CYM.paint(canvas, els.cymModes, els.cymW, hue, Math.random, phases);
    }
  }
  if (eqUi.chain === chainId) drawEqEditor(); // live spectrum behind the curve
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

// ---------- HERO DRAG engine (work item 4; the DUP scaffolding this replaces
// was retired with it — work item 5) ------------------------------------------
const dragState = { armed: false, dragging: false, suppressClick: false };
function heroDragArm(ev, cellEl, chainId, slot) {
  const startX = ev.clientX, startY = ev.clientY;
  let ghost = null, lastTarget = null, lifted = false;
  const lift = () => {
    lifted = true;
    dragState.dragging = true;
    ghost = document.createElement('canvas');
    ghost.className = 'dragghost';
    const src = cellEl.querySelector('.cym');
    ghost.width = 120; ghost.height = 68;
    const g = ghost.getContext('2d');
    g.fillStyle = '#14100b'; g.fillRect(0, 0, 120, 68);
    try { if (src && src.width) g.drawImage(src, 0, 0, 120, 68); } catch { /* blank ghost is fine */ }
    document.body.appendChild(ghost);
    move(startX, startY);
    cellEl.classList.add('dupsrc');
  };
  const holdTimer = setTimeout(lift, 300);
  const move = (x, y) => {
    if (!ghost) return;
    ghost.style.left = (x - 60) + 'px';
    ghost.style.top = (y - 80) + 'px'; // above the finger, not under it
    const under = document.elementFromPoint(x, y - 8);
    const target = under && under.closest ? under.closest('.cell') : null;
    if (lastTarget && lastTarget !== target) lastTarget.classList.remove('dragtarget');
    if (target && target !== cellEl) target.classList.add('dragtarget');
    lastTarget = target;
  };
  const onMove = (e) => {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!lifted) {
      if (Math.hypot(dx, dy) > 10) { clearTimeout(holdTimer); cleanup(false); } // it was a scroll
      return;
    }
    e.preventDefault();
    move(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    clearTimeout(holdTimer);
    if (lifted) {
      dragState.suppressClick = true; // the click after this pointerup is the drag's, not a tap
      const target = lastTarget;
      cleanup(true);
      if (target && target !== cellEl) {
        sendCommand('duplicate_clip_to', {
          from: { chain: chainId, slot },
          to: { chain: target.dataset.chain, slot: Number(target.dataset.slot) },
        }, { el: target });
      }
    } else cleanup(false);
  };
  const cleanup = (wasDrag) => {
    dragState.dragging = false;
    cellEl.classList.remove('dupsrc');
    if (lastTarget) lastTarget.classList.remove('dragtarget');
    if (ghost) ghost.remove();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Transport (Phase 3): ABSOLUTE states — ▶ always means "playing = true".
document.getElementById('play').onclick = () =>
  sendCommand('set_playing', { playing: true }, { el: document.getElementById('play') });
document.getElementById('stop').onclick = () =>
  sendCommand('set_playing', { playing: false }, { el: document.getElementById('stop') });

// ---------- EQ editor (§16b — Phase 4 session 2) ------------------------------
// Tap a chain's spectrum -> this pop-up: big live spectrum + EQ Eight's 8-band
// curve with draggable handles. THE CURVE RENDERS CONFIRMED MIRROR STATE ONLY;
// the finger shows as a hollow ghost until echoes land. Drags write Contract-3
// set_param (throttled 80 ms trailing, the Phase-3 slider pattern).
//
// OBSERVED param reality (probes 06/07, 2026-07-22): names "N Filter On A",
// "N Filter Type A", "N Frequency A", "N Gain A", "N Q A"; Frequency and Q are
// normalized 0..1 with Hz = 10*2200^v and Q = 0.1*180^v; Gain is raw dB ±15;
// Filter Type enum 0..7 (0 HP48, 1 HP12, 2 LoShelf, 3 Bell, 4 Notch,
// 5 HiShelf, 6 LP12, 7 LP48) — types {0,1,4,6,7} have NO gain: vertical drag
// adjusts Q on those (exactly EQ Eight's own behavior). Filter Type itself is
// READ-ONLY in the mirror scope (owner decision 2026-07-21).
// The drawn curve is an RBJ-biquad approximation of EQ Eight's response
// (48 dB/oct types as the 12 dB section to the 4th power) — a visual guide,
// not sample-accurate DSP.

const EQ_FS = 48000;
const GAINLESS_TYPES = new Set([0, 1, 4, 6, 7]);
const vToHz = (v) => 10 * Math.pow(2200, v);
const hzToV = (hz) => Math.min(1, Math.max(0, Math.log(hz / 10) / Math.log(2200)));
const vToQ = (v) => 0.1 * Math.pow(180, v);
// editor x-axis: 20 Hz .. 20 kHz log (wider than the strip's 40..16k so the
// 30 Hz default low shelf is on-canvas); spectrum bands map onto their true
// frequency spans within it.
const AX_LO = 20, AX_HI = 20000;
const hzToX = (hz, W) => (Math.log(hz / AX_LO) / Math.log(AX_HI / AX_LO)) * W;
const xToHz = (x, W) => AX_LO * Math.pow(AX_HI / AX_LO, x / W);
const SPEC_LO = 40, SPEC_HI = 16000; // the strip renderer's band span (bands.ts)
const EQ_DB_SPAN = 18; // curve/handle vertical range: ±18 dB around center
const dbToY = (db, H) => H / 2 - (db / EQ_DB_SPAN) * (H / 2 - 10);
const qvToY = (qv, H) => H - 12 - qv * (H - 24); // Q handles: bottom=0.1, top=18

// RBJ biquad magnitude (Audio EQ Cookbook), evaluated straight from coeffs.
function biquadDb(f, k) {
  const w = (2 * Math.PI * f) / EQ_FS, c1 = Math.cos(w), c2 = Math.cos(2 * w);
  const num = k.b0 * k.b0 + k.b1 * k.b1 + k.b2 * k.b2 + 2 * (k.b0 * k.b1 + k.b1 * k.b2) * c1 + 2 * k.b0 * k.b2 * c2;
  const den = k.a0 * k.a0 + k.a1 * k.a1 + k.a2 * k.a2 + 2 * (k.a0 * k.a1 + k.a1 * k.a2) * c1 + 2 * k.a0 * k.a2 * c2;
  return 10 * Math.log10(Math.max(1e-12, num) / Math.max(1e-12, den));
}
function rbj(type, f0, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / EQ_FS, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(0.05, Q));
  const sqA = Math.sqrt(A);
  switch (type) {
    case 'peak': return { b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A };
    case 'notch': return { b0: 1, b1: -2 * cw, b2: 1, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 'lp': return { b0: (1 - cw) / 2, b1: 1 - cw, b2: (1 - cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 'hp': return { b0: (1 + cw) / 2, b1: -(1 + cw), b2: (1 + cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 'lowshelf': return {
      b0: A * ((A + 1) - (A - 1) * cw + 2 * sqA * alpha), b1: 2 * A * ((A - 1) - (A + 1) * cw), b2: A * ((A + 1) - (A - 1) * cw - 2 * sqA * alpha),
      a0: (A + 1) + (A - 1) * cw + 2 * sqA * alpha, a1: -2 * ((A - 1) + (A + 1) * cw), a2: (A + 1) + (A - 1) * cw - 2 * sqA * alpha };
    case 'highshelf': return {
      b0: A * ((A + 1) + (A - 1) * cw + 2 * sqA * alpha), b1: -2 * A * ((A - 1) + (A + 1) * cw), b2: A * ((A + 1) + (A - 1) * cw - 2 * sqA * alpha),
      a0: (A + 1) - (A - 1) * cw + 2 * sqA * alpha, a1: 2 * ((A - 1) - (A + 1) * cw), a2: (A + 1) - (A - 1) * cw - 2 * sqA * alpha };
  }
}
/** dB response of one EQ Eight band at frequency f (approximation). */
function bandDb(f, type, f0, Q, gainDb) {
  switch (type) {
    case 0: return 4 * biquadDb(f, rbj('hp', f0, Q, 0));   // High Pass 48dB
    case 1: return biquadDb(f, rbj('hp', f0, Q, 0));       // High Pass 12dB
    case 2: return biquadDb(f, rbj('lowshelf', f0, Q, gainDb));
    case 3: return biquadDb(f, rbj('peak', f0, Q, gainDb));
    case 4: return biquadDb(f, rbj('notch', f0, Q, 0));
    case 5: return biquadDb(f, rbj('highshelf', f0, Q, gainDb));
    case 6: return biquadDb(f, rbj('lp', f0, Q, 0));       // Low Pass 12dB
    case 7: return 4 * biquadDb(f, rbj('lp', f0, Q, 0));   // Low Pass 48dB
  }
  return 0;
}

const eqUi = { chain: null, drag: null, ghost: null, secondPointer: false, lastTap: { band: -1, t: 0 } };
const eqSenders = new Map(); // `${chain}|${param}` -> throttled sender

function eqParam(chainId, name) {
  const dev = currentChain(chainId)?.devices.find((d) => d.role === 'eq');
  return dev?.params.find((p) => p.name === name) ?? null;
}
function eqBand(chainId, b) {
  return {
    on: eqParam(chainId, `${b} Filter On A`),
    type: eqParam(chainId, `${b} Filter Type A`),
    freq: eqParam(chainId, `${b} Frequency A`),
    gain: eqParam(chainId, `${b} Gain A`),
    q: eqParam(chainId, `${b} Q A`),
  };
}
function eqSend(chainId, name, value) {
  const key = chainId + '|' + name;
  if (!eqSenders.has(key))
    eqSenders.set(key, throttleSend((v) => sendCommand('set_param', { chain: chainId, device: 'eq', param: name, value: v }), 80));
  eqSenders.get(key)(value);
}

function openEqEditor(chainId) {
  const chain = currentChain(chainId);
  if (!chain || !chain.devices.some((d) => d.role === 'eq')) { toast('no EQ on this chain'); return; }
  eqUi.chain = chainId;
  document.getElementById('eqtitle').textContent = chain.name + ' — EQ';
  const modal = document.getElementById('eqmodal');
  modal.classList.remove('hidden');
  const canvas = document.getElementById('eqcanvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  drawEqEditor();
}
function closeEqEditor() {
  eqUi.chain = null; eqUi.drag = null; eqUi.ghost = null;
  document.getElementById('eqmodal').classList.add('hidden');
}
document.getElementById('eqclose').onclick = closeEqEditor;
document.getElementById('eqmodal').onclick = (ev) => { if (ev.target.id === 'eqmodal') closeEqEditor(); };

function drawEqEditor() {
  if (!eqUi.chain) return;
  const canvas = document.getElementById('eqcanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#10150f'; ctx.fillRect(0, 0, W, H);

  // grid: decades + dB lines
  ctx.strokeStyle = 'rgba(216,205,184,.12)'; ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(216,205,184,.35)'; ctx.font = `${11 * dpr}px "DM Mono", monospace`;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = hzToX(f, W);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 3 * dpr, H - 5 * dpr);
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = dbToY(db, H);
    ctx.globalAlpha = db === 0 ? 0.35 : 0.15;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // live spectrum backdrop (rainbow, its own -60..0 dB height mapping)
  const frame = lastFrameByChain.get(eqUi.chain);
  if (frame) {
    // a touch of temporal smoothing (owner 2026-07-22) — EMA per band,
    // integrated once per frame (seq-gated so mirror-delta redraws don't
    // double-integrate); display-only, the wire stays raw.
    const raw = collapse(frame.magnitudes).map(magToDb01);
    let sm = eqUi.smooth && eqUi.smooth.chain === eqUi.chain ? eqUi.smooth : null;
    if (!sm) sm = eqUi.smooth = { chain: eqUi.chain, seq: -1, bands: raw.slice() };
    if (frame.seq !== sm.seq) {
      for (let i = 0; i < BANDS; i++) sm.bands[i] = sm.bands[i] * 0.65 + raw[i] * 0.35;
      sm.seq = frame.seq;
    }
    const bands = sm.bands;
    for (let i = 0; i < BANDS; i++) {
      const fA = SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, i / BANDS);
      const fB = SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, (i + 1) / BANDS);
      const xA = hzToX(fA, W), xB = hzToX(fB, W);
      const h = bands[i] * (H - 8);
      ctx.fillStyle = `hsl(${bandHue(i)} 80% 50%)`;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(xA + 0.5, H - h, Math.max(1, xB - xA - 1.5), h);
    }
    ctx.globalAlpha = 1;
  }

  // curves: solid amber = CONFIRMED truth; while dragging, a dashed lighter
  // INTENT preview follows the finger instantly (kills perceived lag without
  // weakening the truth principle — the solid curve still only moves on echo).
  const b8 = Array.from({ length: 8 }, (_, i) => eqBand(eqUi.chain, i + 1));
  const STEP = Math.max(2, Math.floor(W / 300));
  const sumDb = (f, override) => {
    let db = 0;
    b8.forEach((bp, i) => {
      if (!bp.on || !bp.type || !bp.freq || !bp.gain || !bp.q || bp.on.value === 0) return;
      let f0 = vToHz(bp.freq.value), Q = vToQ(bp.q.value), g = bp.gain.value;
      if (override && override.band === i + 1) {
        if (override.hz !== undefined) f0 = override.hz;
        if (override.qv !== undefined) Q = vToQ(override.qv);
        if (override.gainDb !== undefined) g = override.gainDb;
      }
      db += bandDb(f, bp.type.value, f0, Q, g);
    });
    return db;
  };
  const strokeCurve = (override) => {
    ctx.beginPath();
    for (let x = 0; x <= W; x += STEP) {
      const y = Math.min(H - 2, Math.max(2, dbToY(sumDb(xToHz(x, W), override), H)));
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  // Owner rev 2026-07-22: the UI follows the DRAG directly (solid curve
  // renders pending intent while a finger is down); on release the mirror's
  // confirmed truth takes over — trailing throttle guarantees the final value
  // lands, so any reconciliation snap is within float noise. Tablet still
  // holds no authority; this is presentation only.
  ctx.strokeStyle = '#e8a33d'; ctx.lineWidth = 2.5 * dpr;
  strokeCurve(eqUi.pending || null);

  // handles: color = the band's frequency hue (matches the rainbow); off = gray
  const R = 15 * dpr;
  eqUi.handlePos = []; // hit-test cache, refreshed every draw
  b8.forEach((bp, i) => {
    if (!bp.freq || !bp.type || !bp.q || !bp.gain) return;
    const on = bp.on && bp.on.value !== 0;
    const pend = eqUi.pending && eqUi.pending.band === i + 1 ? eqUi.pending : null;
    const f0 = pend && pend.hz !== undefined ? pend.hz : vToHz(bp.freq.value);
    const x = hzToX(f0, W);
    const gainless = GAINLESS_TYPES.has(bp.type.value);
    const qv = pend && pend.qv !== undefined ? pend.qv : bp.q.value;
    const gdb = pend && pend.gainDb !== undefined ? pend.gainDb : bp.gain.value;
    const y = gainless ? qvToY(qv, H) : dbToY(gdb, H);
    eqUi.handlePos[i] = { x, y };
    const hue = (Math.log(f0 / SPEC_LO) / Math.log(SPEC_HI / SPEC_LO)) * 285;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = on ? `hsl(${Math.min(285, Math.max(0, hue))} 80% 52%)` : '#3a3226';
    ctx.globalAlpha = on ? 0.95 : 0.7; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0b0906'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    ctx.fillStyle = '#10150f'; ctx.font = `bold ${13 * dpr}px "DM Mono", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + dpr);
  });

}

// ---- pointer interaction on the editor canvas --------------------------------
(() => {
  const canvas = document.getElementById('eqcanvas');
  const pos = (ev) => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (ev.clientX - r.left) * dpr, y: (ev.clientY - r.top) * dpr };
  };
  const activePointers = new Set();

  canvas.onpointerdown = (ev) => {
    if (!eqUi.chain) return;
    activePointers.add(ev.pointerId);
    if (activePointers.size >= 2) { eqUi.secondPointer = true; return; } // finger #2 = Q modifier
    const p = pos(ev);
    let best = -1, bestD = Infinity;
    (eqUi.handlePos || []).forEach((hp, i) => {
      if (!hp) return;
      const d = Math.hypot(hp.x - p.x, hp.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    const dpr = window.devicePixelRatio || 1;
    if (best < 0 || bestD > 26 * dpr) return;
    const band = best + 1;
    const now = Date.now();
    if (eqUi.lastTap.band === band && now - eqUi.lastTap.t < 350) {
      // double-tap: toggle Filter On (absolute value, confirmed by echo)
      const on = eqBand(eqUi.chain, band).on;
      if (on) eqSend(eqUi.chain, `${band} Filter On A`, on.value === 0 ? 1 : 0);
      eqUi.lastTap = { band: -1, t: 0 };
      return;
    }
    eqUi.lastTap = { band, t: now };
    eqUi.drag = { band };
    eqUi.secondPointer = false;
    canvas.setPointerCapture(ev.pointerId);
  };

  canvas.onpointermove = (ev) => {
    if (!eqUi.chain || !eqUi.drag) return;
    if (activePointers.size >= 2 && !activePointers.has(ev.pointerId)) return; // only the first finger steers
    const p = pos(ev);
    const canvasW = canvas.width, canvasH = canvas.height;
    const band = eqUi.drag.band;
    const bp = eqBand(eqUi.chain, band);
    if (!bp.freq || !bp.type) return;
    eqUi.ghost = { x: Math.min(canvasW, Math.max(0, p.x)), y: Math.min(canvasH, Math.max(0, p.y)) };

    // horizontal -> frequency, always
    const hz = Math.min(AX_HI, Math.max(AX_LO, xToHz(eqUi.ghost.x, canvasW)));
    eqSend(eqUi.chain, `${band} Frequency A`, hzToV(hz));
    eqUi.pending = { band, hz };

    // vertical -> Q on gain-less types or with a second finger; gain otherwise
    const gainless = GAINLESS_TYPES.has(bp.type.value);
    if (gainless || eqUi.secondPointer) {
      const qv = Math.min(1, Math.max(0, (canvasH - 12 - eqUi.ghost.y) / (canvasH - 24)));
      eqSend(eqUi.chain, `${band} Q A`, qv);
      eqUi.pending.qv = qv;
    } else {
      const db = Math.min(15, Math.max(-15, ((canvasH / 2 - eqUi.ghost.y) / (canvasH / 2 - 10)) * EQ_DB_SPAN));
      eqSend(eqUi.chain, `${band} Gain A`, db);
      eqUi.pending.gainDb = db;
    }
    drawEqEditor(); // instant: the dashed intent curve tracks the finger
  };

  const endPointer = (ev) => {
    activePointers.delete(ev.pointerId);
    if (activePointers.size < 2) eqUi.secondPointer = false;
    if (activePointers.size === 0) { eqUi.drag = null; eqUi.ghost = null; eqUi.pending = null; drawEqEditor(); }
  };
  canvas.onpointerup = endPointer;
  canvas.onpointercancel = endPointer;
})();

connect();
