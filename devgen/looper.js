/* ============================================================================
 * NAM_A2_Looper — v8 brain + js2max source  (Seam 3, arch §15, LOOPER-HANDOFF)
 * v2 (REV 2026-07-06): in-Live usability — transport buttons, truthful status
 * readout, Clear, AND the actual audio loop core (see "V2 REALITY NOTE" below).
 * ----------------------------------------------------------------------------
 * `// @ui` lines drive js2max to build the scaffold (plugin~->plugout~, this v8,
 * live.thisdevice, params "State" and "State Out"). Run amxd_setnames.py after
 * compiling so Live reads the Long Names. Then amxd_wire_udpsend.py (echo I/O),
 * amxd_wire_looper.py (audio core + UI objects), amxd_style_looper.py (faceplate).
 *
 *   `State`      = COMMAND the hub writes (engine: looper_set_state).
 *   `State Out`  = OBSERVED state, written back as a real Live parameter (the
 *                  durable receipt the mirror reads). Kept, NOT on the latency path.
 *
 * V2 REALITY NOTE (golden rule §0 — record, don't paper over): the v1 device
 * that closed Seam 3 was a pure state-echo machine — v8 outlet 0's transport
 * intents were wired to NOTHING and audio was a plugin~->plugout~ passthrough.
 * The v1 header's "the record~/buffer~/groove~ loop is wired in Max" described
 * an intention, not the shipped device. v2 builds the loop core for real:
 * a phasor~/count~-indexed poke~/index~ mono loop (perfect overdub alignment by
 * construction — write and read share one index signal), injected entirely by
 * amxd_wire_looper.py. v8 stays control-rate: it plans gate/index-source/length
 * messages (outlet 0, route-dispatched); the signal graph does the audio.
 *
 * FROZEN (R1 — do not touch): the ECHO PATH is v1's, verbatim:
 *   observer on `State` -> setState -> transition -> report():
 *     OSC push outlet 2 -> [udpsend 127.0.0.1 11000]  (/live/looper/report t d s)
 *     deferred Task LiveAPI.set on `State Out`
 *     outlet 1 dial fallback
 * Buttons/status are ADDITIVE. Param surface unchanged: two int params only.
 *
 * BUTTONS (index-0 trap, API-REALITY finding 7): setting a param to its current
 * value emits NO observer event, so buttons do BOTH: call setState() directly
 * (the action) AND queue a deferred LiveAPI.set on `State` (the mirror/dial sync;
 * skipped if the state moved on meanwhile). Re-sends are idempotent by contract;
 * a press for the CURRENT state still visibly "takes" (status readout flashes).
 *
 * TRUTHFUL UI RULE (R3): the status readout + button highlights are fed ONLY
 * from transition()/report() — the same moment the echo fires — never from the
 * button press itself. Hub-driven changes therefore move the buttons too.
 *
 * OUTLETS:
 *   0: DSP control -> [route srcsel freq phase len wgate wminus ovd play snap
 *      cnt clear usave uswap pmet]  (plus the v1 "transport <verb>" trace,
 *      routed last). v2.1: usave = shadow-snapshot the loop (undo save),
 *      uswap = 3-way live<->shadow swap (undo/redo), pmet = position metro on/off.
 *   1: State Out dial (fallback)                                   [v1, frozen]
 *   2: OSC push -> [udpsend 127.0.0.1 11000]                       [v1, frozen]
 *   3: UI -> [route ledrec ledplay ledstop leddub status pos uact ract uind]
 *      v2.1: pos = playhead fraction 0..1 -> position bar. v2.2: uact/ract =
 *      Undo/Redo button active/grey; uind = take indicator ("take: current" /
 *      "take: undone").
 * INLET 0 messages (all additive): v1's int/float/list(/cmd) + live.thisdevice
 *   bang; NEW: samps <n> (snapshot~ length capture), pos <n> (position ticker),
 *   btnrec/btnplay/btndub/btnstop/btnclear/btnundo/btnredo <v> (buttons),
 *   sr <hz> (sample-rate override).
 *
 * SAMPLE RATE: 48 kHz assumed (rig standard, LOOPER-HANDOFF §7). Override with
 * an `sr <hz>` message if the rig ever changes.
 * ============================================================================ */

// @device audio-effect
// @ui live.dial "State" inlet=0 min=0 max=3
// @ui live.dial "State Out" outlet=1 min=0 max=3

'use strict';

// Max provides these as globals; guard so the Node pure-logic test can require
// this file without a strict-mode ReferenceError (same idiom as amp.js). In Max
// the guards are true and run normally; the box's numoutlets=4 (set by the wirer)
// is authoritative for the outlet count regardless.
if (typeof autowatch !== 'undefined') autowatch = 1;
if (typeof inlets !== 'undefined') { inlets = 1; outlets = 4; }
// 0: DSP control  1: State Out dial  2: OSC push  3: UI (leds/status)

var STOP = 0, PLAY = 1, RECORD = 2, OVERDUB = 3;
var REPORT_ADDR = "/live/looper/report";

var OUT_DSP = 0, OUT_STATEOUT = 1, OUT_OSC = 2, OUT_UI = 3;

// =============================================================================
// PURE LOGIC (no Max globals — unit-tested in Node via looper-core.test.mjs)
// =============================================================================

var BUF_MS = 60000;                       // buffer~ nam_loop allocation
var STATE_NAMES = ["STOPPED", "PLAYING", "RECORDING", "OVERDUB"];
var BTN_TO_STATE = { btnstop: STOP, btnplay: PLAY, btnrec: RECORD, btndub: OVERDUB };

function clampState(v) {
  v = (v | 0);
  if (v < STOP) return STOP;
  if (v > OVERDUB) return OVERDUB;
  return v;
}

function stateName(s) { return STATE_NAMES[clampState(s)]; }

/** Max samples the loop buffer can hold at a given sample rate. */
function bufCapSamps(sr) { return Math.floor(BUF_MS / 1000 * sr); }

/** Sanitize a snapshot~ length capture into loop-length samples. */
function clampLen(n, sr) {
  n = Math.round(Number(n) || 0);
  if (n < 0) n = 0;
  var cap = bufCapSamps(sr);
  if (n > cap) n = cap;
  return n;
}

/** True iff this state change ends a fresh recording (=> capture loop length). */
function needSnap(prev, target) { return prev === RECORD && target !== RECORD; }

/** Loop phasor frequency for a loop of lenSamps at sr (0 = hold/no loop). */
function loopFreq(lenSamps, sr) { return lenSamps > 0 ? sr / lenSamps : 0; }

/**
 * The DSP control plan for entering `target` from `prev` with loop length
 * `lenSamps` at rate `sr`. Returns an array of messages for OUT_DSP, each an
 * array [selector, ...args] consumed by the wirer's [route ...].
 *
 * Index-source contract (the wirer's graph):
 *   srcsel 1 = count~ (fresh-record running index, bang-reset via "cnt")
 *   srcsel 2 = phasor~ * len (looping index; freq/phase set here)
 * Write gate: poke~ ignores negative indices, so wgate/wminus implement
 *   idx*w + (w-1)  ->  idx when w=1, -1 (no write) when w=0.
 * Play gate: line~ ramp [target, ms] (click-free).
 *
 * Phase policy (human-looper convention):
 *   - PLAY/OVERDUB entered from STOP or RECORD restart the loop at phase 0.
 *     (From RECORD this is seamless: recording ended exactly at len ≡ 0.)
 *   - PLAY<->OVERDUB keep the loop running (no phase/freq touch): overdub
 *     punches in wherever the loop is, exactly like hardware loopers.
 *   - STOP pauses (freq 0) and mutes; it does not lose loop content.
 */
function dspPlan(prev, target, lenSamps, sr) {
  var m = [];
  var f = loopFreq(lenSamps, sr);
  var fromDead = (prev === STOP || prev === RECORD);
  switch (target) {
    case RECORD: // fresh loop: reset counter, count-index, write raw input, mute loop
      m.push(["cnt"]);
      m.push(["srcsel", 1]);
      m.push(["ovd", 0]);
      m.push(["wgate", 1], ["wminus", 0]);
      m.push(["play", 0, 10]);
      break;
    case PLAY:
      m.push(["srcsel", 2]);
      m.push(["ovd", 0]);
      m.push(["wgate", 0], ["wminus", -1]);
      if (fromDead) m.push(["freq", f], ["phase", 0]);
      m.push(["play", lenSamps > 0 ? 1 : 0, 10]);
      break;
    case OVERDUB: // layer input onto the running loop (write = input + read)
      m.push(["srcsel", 2]);
      m.push(["ovd", 1]);
      if (lenSamps > 0) m.push(["wgate", 1], ["wminus", 0]);
      else m.push(["wgate", 0], ["wminus", -1]);   // empty loop: truthful silence
      if (fromDead) m.push(["freq", f], ["phase", 0]);
      m.push(["play", lenSamps > 0 ? 1 : 0, 10]);
      break;
    case STOP: default: // pause: hold phasor, close gates; content kept
      m.push(["wgate", 0], ["wminus", -1]);
      m.push(["ovd", 0]);
      m.push(["freq", 0]);
      m.push(["play", 0, 10]);
      break;
  }
  return m;
}

/** Messages that wipe the loop (buffer clear + zero length). State change is
 *  handled separately through the NORMAL transition so the echo fires (R3). */
function clearPlan() { return [["clear"], ["len", 0], ["freq", 0]]; }

/** Playhead fraction 0..1 for the position bar, from the shared index signal.
 *  RECORD: buffer filling against the 60 s capacity. Loop exists: position in
 *  the loop. Empty: 0. Truthful by construction — the tap IS the audio index. */
function posFrac(idxSamps, state, lenSamps, capSamps) {
  idxSamps = Number(idxSamps) || 0;
  if (clampState(state) === RECORD)
    return Math.min(1, Math.max(0, capSamps > 0 ? idxSamps / capSamps : 0));
  if (lenSamps > 0) return Math.min(1, Math.max(0, idxSamps / lenSamps));
  return 0;
}

/** True iff this transition must snapshot the live buffer to the undo shadow
 *  BEFORE any writing starts: entering OVERDUB (a dub pass will layer onto the
 *  loop) or re-RECORD over an existing loop. Nothing to save when no loop. */
function needUndoSave(prev, target, lenSamps) {
  if (lenSamps <= 0) return false;
  if (target === OVERDUB && prev !== OVERDUB) return true;
  if (target === RECORD && prev !== RECORD) return true;
  return false;
}

/** Single-level history reducer. hist = {u: canUndo, r: canRedo}; exactly one
 *  (or neither) is true. Events: "save" (a destructive pass snapshotted the
 *  shadow — any redo history is invalidated, standard), "undo", "redo".
 *  Undo and redo are the SAME buffer swap; only the bookkeeping differs. */
function histNext(hist, event) {
  if (event === "save") return { u: true, r: false };
  if (event === "undo" && hist.u) return { u: false, r: true };
  if (event === "redo" && hist.r) return { u: true, r: false };
  return { u: !!hist.u, r: !!hist.r };
}

/** A swap (undo or redo) is offered only when its flag is set and the loop is
 *  not being written (PLAY/STOP): swapping under an open write gate is
 *  undefined-feeling audio. Greyed, not hidden (visible affordance). */
function swapOffered(flag, state) {
  state = clampState(state);
  return !!flag && (state === STOP || state === PLAY);
}

/** Take indicator: what the loop content IS right now, relative to history.
 *  canRedo means the rolled-back take is live ("undone"); canUndo means the
 *  newest take is live ("current"); no history -> blank. */
function takeText(hist) {
  if (hist.r) return "take: undone";
  if (hist.u) return "take: current";
  return " ";
}

/** UI plan for OUT_UI on every observed state: exclusive button highlight,
 *  status text (with loop length once one exists), undo/redo availability,
 *  take indicator. Fed ONLY from the transition/report path — truthful. */
function uiPlan(state, lenSamps, sr, hist) {
  state = clampState(state);
  sr = sr || 48000;
  hist = hist || { u: false, r: false };
  var text = stateName(state);
  if (state === STOP && lenSamps === 0) text = "STOPPED \u00b7 empty";
  else if (state !== RECORD && lenSamps > 0)
    text = text + " \u00b7 " + (lenSamps / sr).toFixed(1) + " s";
  return [
    ["ledstop", state === STOP ? 1 : 0],
    ["ledplay", state === PLAY ? 1 : 0],
    ["ledrec", state === RECORD ? 1 : 0],
    ["leddub", state === OVERDUB ? 1 : 0],
    ["status", text],
    ["uact", swapOffered(hist.u, state) ? 1 : 0],
    ["ract", swapOffered(hist.r, state) ? 1 : 0],
    ["uind", takeText(hist)],
  ];
}

/** Button selector -> intended state (or "clear"/"undo"/"redo"), else null.
 *  Any value counts as a press for the transport toggles (a click on the lit
 *  current-state button arrives as 0 — still an intent; re-sends are idempotent
 *  by contract). Clear/Undo/Redo act on nonzero only (live.text button mode
 *  sends press AND release). */
function btnIntent(selector, value) {
  if (selector === "btnclear") return (Number(value) !== 0) ? "clear" : null;
  if (selector === "btnundo") return (Number(value) !== 0) ? "undo" : null;
  if (selector === "btnredo") return (Number(value) !== 0) ? "redo" : null;
  if (Object.prototype.hasOwnProperty.call(BTN_TO_STATE, selector))
    return BTN_TO_STATE[selector];
  return null;
}

// =============================================================================
// v8 RUNTIME (Max-only from here down)
// =============================================================================

var current = STOP;
var stateWatcher = null;     // LiveAPI observing "State" value
var stateOutApi = null;      // LiveAPI writing "State Out" value
var stateApi = null;         // LiveAPI writing "State" (button -> param sync)
var pendingOut = -1;         // state queued for the deferred State Out write
var writeTask = null;        // defers the LiveAPI .set out of the notification
var myTrack = -1, myDevice = -1;   // this device's own indices, for the push

var SR = 48000;              // rig standard (§7); override with `sr <hz>`
var loopLen = 0;             // loop length in samples (0 = no loop recorded)
var undoLen = 0;             // loop length saved with the undo shadow buffer
var hist = { u: false, r: false };  // single-level history (see histNext)
var pendingState = -1;       // button intent queued for the deferred State write
var stateSetTask = null;
var flashTask = null;

function bang() { init(); }
function loadbang() { init(); }

function init() {
  current = STOP;
  loopLen = 0;
  undoLen = 0;
  hist = { u: false, r: false };
  if (!writeTask) writeTask = new Task(flushStateOut, this);
  if (!stateSetTask) stateSetTask = new Task(flushStateSet, this);
  if (!flashTask) flashTask = new Task(unflash, this);
  emitTransport(STOP);
  sendDsp(clearPlan());
  sendDsp(dspPlan(STOP, STOP, 0, SR));
  sendDsp([["pmet", 1]]);    // start the 50 ms position ticker
  setupApis();
  report(STOP);
  updateUi(STOP);
}

function setupApis() {
  try {
    if (stateWatcher) { try { stateWatcher.property = ""; } catch (e) {} stateWatcher = null; }
    stateOutApi = null;
    stateApi = null;
    var dev = new LiveAPI(null, "this_device");
    resolveMyIndices(dev);
    var params = dev.get("parameters");            // ["id", n, "id", m, ...]
    var stateId = null, stateOutId = null;
    for (var i = 0; i + 1 < params.length; i += 2) {
      if (String(params[i]) !== "id") continue;
      var pid = params[i + 1];
      var nm = paramName(new LiveAPI(null, "id " + pid));
      if (nm === "state") stateId = pid;
      else if (nm === "state out") stateOutId = pid;
    }
    if (stateId !== null) {
      stateWatcher = new LiveAPI(onStateValue, "id " + stateId);
      stateWatcher.property = "value";
      stateApi = new LiveAPI(null, "id " + stateId);
      post("NAM_A2_Looper: observing State (id " + stateId + ")\n");
    } else post("NAM_A2_Looper: no 'State' param found to observe\n");
    if (stateOutId !== null) stateOutApi = new LiveAPI(null, "id " + stateOutId);
    post("NAM_A2_Looper: reporting as track " + myTrack + " device " + myDevice + "\n");
  } catch (e) {
    post("NAM_A2_Looper: setupApis failed: " + e + "\n");
  }
}

// Parse "live_set tracks T devices D" from this_device's path.
function resolveMyIndices(dev) {
  myTrack = -1; myDevice = -1;
  try {
    var p = String(dev.unquotedpath || dev.path).replace(/"/g, "");
    var mt = p.match(/tracks\s+(\d+)/);
    var md = p.match(/devices\s+(\d+)/);
    if (mt) myTrack = Number(mt[1]);
    if (md) myDevice = Number(md[1]);
  } catch (e) { post("NAM_A2_Looper: index resolve failed: " + e + "\n"); }
}

function paramName(api) {
  var n = api.get("name");
  return (n instanceof Array ? n.join(" ") : String(n)).toLowerCase();
}

function onStateValue(args) {
  if (!args) return;
  if (args[0] === "value") { setState(args[args.length - 1]); return; }
  if (args.length === 1 && typeof args[0] === "number") setState(args[0]);
}

function msg_int(v) { setState(v); }
function msg_float(v) { setState(Math.round(v)); }

// FAST COMMAND IN: the engine pushes `/cmd <track> <device> <state>` over OSC to
// this device's udpreceive (wired to inlet 0 via [route /cmd]). Arrives as a list.
// We act only on commands addressed to OUR indices (so multiple loopers can share
// the command port); if our indices didn't resolve, act anyway (lone-device safe).
function list(t, d, s) {
  if (myTrack < 0 || (t === myTrack && d === myDevice)) setState(clampState(s));
}

function setState(v) {
  v = clampState(v);
  if (v === current) { report(current); flashStatus(); return; }
  transition(v);
}

function transition(target) {
  var prev = current;
  emitTransport(target);
  if (needSnap(prev, target)) outlet(OUT_DSP, "snap");  // -> snapshot~ -> samps(n)
  if (needUndoSave(prev, target, loopLen)) doUndoSave(); // BEFORE any write gate opens
  sendDsp(dspPlan(prev, target, loopLen, SR));          // runs AFTER samps() set loopLen
  current = target;
  report(current);
  updateUi(current);
}

function emitTransport(state) {
  switch (state) {
    case STOP:    outlet(0, "transport", "stop"); break;
    case PLAY:    outlet(0, "transport", "play"); break;
    case RECORD:  outlet(0, "transport", "record"); break;
    case OVERDUB: outlet(0, "transport", "overdub"); break;
  }
}

// Receipt. PRIMARY (fast): OSC push -> udpsend -> engine, immediately (outlet is
// not a Live-set change, so it's allowed from the observer notification).
// DURABLE: deferred LiveAPI .set on "State Out" for the mirror. UI: dial fallback.
function report(state) {
  if (myTrack >= 0 && myDevice >= 0) outlet(2, REPORT_ADDR, myTrack, myDevice, state);
  pendingOut = state;
  if (writeTask) writeTask.schedule(0);
  outlet(1, state);
}

function flushStateOut() {
  if (stateOutApi && pendingOut >= 0) {
    try { stateOutApi.set("value", pendingOut); }
    catch (e) { post("NAM_A2_Looper: State Out set failed: " + e + "\n"); }
  }
}

// ---- DSP control helpers ----------------------------------------------------

function sendDsp(msgs) {
  for (var i = 0; i < msgs.length; i++) outlet.apply(null, [OUT_DSP].concat(msgs[i]));
}

/** snapshot~ length capture arrives here (synchronously, mid-transition: Max
 *  message passing is depth-first, so this runs BEFORE transition() continues). */
function samps(n) {
  loopLen = clampLen(n, SR);
  outlet(OUT_DSP, "len", loopLen);
  post("NAM_A2_Looper: loop length " + loopLen + " samples ("
       + (loopLen / SR).toFixed(2) + " s)\n");
}

/** 50 ms position ticker (metro -> snapshot~ on the shared index signal). */
function pos(n) {
  outlet(OUT_UI, "pos", posFrac(n, current, loopLen, bufCapSamps(SR)));
}

function sr(hz) {
  hz = Number(hz) || 0;
  if (hz > 0) { SR = hz; post("NAM_A2_Looper: sample rate set to " + SR + "\n"); }
}

// ---- UNDO / REDO (single-level, content-only — State is never touched) -------
// Shadow snapshot BEFORE a destructive pass (dub entry, re-record, Clear) via
// buffer~'s `duplicate` message; undo/redo are the SAME 3-way buffer swap
// (uswap) + length swap — only the history bookkeeping differs. Every press is
// post()ed to the Max console (value, state, history, verdict) so any press
// anomaly is observable there instead of guessed at.

function doUndoSave() {
  sendDsp([["usave"]]);      // nam_loop_undo duplicate nam_loop (instant copy)
  undoLen = loopLen;
  hist = histNext(hist, "save");
  post("NAM_A2_Looper: undo-save (len " + undoLen + ")\n");
}

function doUndo(v) { doSwap("undo", v); }
function doRedo(v) { doSwap("redo", v); }

function doSwap(kind, v) {
  var flag = (kind === "undo") ? hist.u : hist.r;
  post("NAM_A2_Looper: " + kind + " press (v=" + v + " state=" + stateName(current)
       + " u=" + hist.u + " r=" + hist.r + ") -> "
       + (swapOffered(flag, current) ? "PERFORM" : "refused") + "\n");
  if (!swapOffered(flag, current)) { flashStatus(" "); return; }
  sendDsp([["uswap"]]);      // tmp<-live, live<-shadow, shadow<-tmp
  var t = loopLen; loopLen = undoLen; undoLen = t;
  sendDsp([["len", loopLen]]);
  if (current === PLAY) sendDsp([["freq", loopFreq(loopLen, SR)]]);
  sendDsp(dspPlan(current, current, loopLen, SR));  // re-assert gates for new len
  hist = histNext(hist, kind);
  updateUi(current);
  flashStatus("\u00b7 " + kind + " \u00b7");
}

// ---- BUTTONS (index-0-trap double path) --------------------------------------
// Direct action now + deferred `State` param sync. The param observer will fire
// for a CHANGED value and re-enter setState with the same state — harmless
// (idempotent: redundant report + flash). For the CURRENT state the param write
// emits no event at all (the trap) — the direct call already did the work.

function btnrec(v)   { handleButton("btnrec", v); }
function btnplay(v)  { handleButton("btnplay", v); }
function btndub(v)   { handleButton("btndub", v); }
function btnstop(v)  { handleButton("btnstop", v); }
function btnclear(v) { handleButton("btnclear", v); }
function btnundo(v)  { handleButton("btnundo", v); }
function btnredo(v)  { handleButton("btnredo", v); }

function handleButton(sel, v) {
  var intent = btnIntent(sel, v);
  if (intent === null) return;
  if (intent === "clear") { clearLoop(); return; }
  if (intent === "undo") { doUndo(v); return; }
  if (intent === "redo") { doRedo(v); return; }
  setState(intent);            // the action, immediately
  syncStateParam(intent);      // the mirror/dial, deferred
}

/** Clear (UI-only, R3): snapshot to the undo shadow FIRST (Clear is undoable),
 *  wipe the buffer, then force Stop through the NORMAL transition so the echo
 *  fires and the hub sees Stop. If already stopped, setState's redundant-path
 *  still reports + flashes (the press "takes"). */
function clearLoop() {
  if (loopLen > 0) doUndoSave();     // Undo un-clears
  sendDsp(clearPlan());
  loopLen = 0;
  setState(STOP);
  syncStateParam(STOP);
  updateUi(current);           // refresh "STOPPED · empty" after len change
}

function syncStateParam(v) {
  pendingState = v;
  if (stateSetTask) stateSetTask.schedule(0);
}

function flushStateSet() {
  if (!stateApi || pendingState < 0) return;
  if (pendingState !== current) { pendingState = -1; return; } // stale (hub moved on)
  try { stateApi.set("value", pendingState); }
  catch (e) { post("NAM_A2_Looper: State set failed: " + e + "\n"); }
  pendingState = -1;
}

// ---- UI (truthful: fed only from transition/report path) ---------------------

function updateUi(state) {
  var msgs = uiPlan(state, loopLen, SR, hist);
  for (var i = 0; i < msgs.length; i++) outlet.apply(null, [OUT_UI].concat(msgs[i]));
}

/** Redundant command/press: no transition, but the press must visibly take —
 *  blink the readout (120 ms), then restore the observed state text. Undo/redo
 *  reuse the blink with their own text. */
function flashStatus(txt) {
  outlet(OUT_UI, "status", txt || " ");
  if (flashTask) { flashTask.cancel(); flashTask.schedule(120); }
}

function unflash() { updateUi(current); }

// =============================================================================
// Node test hook — invisible to Max (module is undefined in v8/JSCore).
// =============================================================================
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STOP: STOP, PLAY: PLAY, RECORD: RECORD, OVERDUB: OVERDUB,
    BUF_MS: BUF_MS,
    clampState: clampState, stateName: stateName,
    bufCapSamps: bufCapSamps, clampLen: clampLen,
    needSnap: needSnap, loopFreq: loopFreq,
    dspPlan: dspPlan, clearPlan: clearPlan,
    uiPlan: uiPlan, btnIntent: btnIntent,
    posFrac: posFrac, needUndoSave: needUndoSave,
    histNext: histNext, swapOffered: swapOffered, takeText: takeText,
  };
}
