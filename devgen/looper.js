/* ============================================================================
 * NAM_A2_Looper — v8 brain + js2max source  (Seam 3, arch §15, LOOPER-HANDOFF)
 * ----------------------------------------------------------------------------
 * `// @ui` lines drive js2max to build the scaffold (plugin~->plugout~, this v8,
 * live.thisdevice, params "State" and "State Out"). Run amxd_setnames.py after
 * compiling so Live reads the Long Names.
 *
 *   `State`      = COMMAND the hub writes (engine: looper_set_state).
 *   `State Out`  = OBSERVED state, written back as a real Live parameter (the
 *                  durable receipt the mirror reads). Kept, but NOT on the latency
 *                  path.
 *
 * ECHO = FAST OSC PUSH (2026-07-05, latency-first design):
 *   Reading a device-authored parameter back over the LOM has real, variable
 *   latency (~tens of ms, UI-thread bound). So the receipt does NOT wait on that.
 *   On every transition the device pushes its state straight to the engine over
 *   OSC — `/live/looper/report <track> <device> <state>` via a [udpsend 127.0.0.1
 *   11000] wired to OUTLET 2. That's localhost, sub-ms, and — because outlet() is
 *   not a Live-set change — it's allowed directly from the observer notification
 *   (no Task needed). The engine caches it (instant get_state) and forwards it as
 *   the looper_state up-event. `State Out` is still written (deferred Task) for
 *   the mirror, but the hub learns the state from the push, not the parameter.
 *
 * INPUT: a LiveAPI observer on `State` fires on the main thread within a couple ms
 * of the engine's set (proven on rig). The dial cords remain harmless fallbacks.
 *
 * AUDIO DSP IS NOT HERE. v8/JS is control-rate; the record~/buffer~/groove~ loop
 * is wired in Max and driven by the transport intents on OUTLET 0.
 *
 * WIRING (in Max, one object): connect OUTLET 2 -> [udpsend 127.0.0.1 11000].
 * ============================================================================ */

// @device audio-effect
// @ui live.dial "State" inlet=0 min=0 max=3
// @ui live.dial "State Out" outlet=1 min=0 max=3

autowatch = 1;
inlets = 1;
outlets = 3;  // 0: DSP transport intents  1: State Out dial (fallback)  2: OSC push -> udpsend

var STOP = 0, PLAY = 1, RECORD = 2, OVERDUB = 3;
var REPORT_ADDR = "/live/looper/report";

var current = STOP;
var stateWatcher = null;     // LiveAPI observing "State" value
var stateOutApi = null;      // LiveAPI writing "State Out" value
var pendingOut = -1;         // state queued for the deferred State Out write
var writeTask = null;        // defers the LiveAPI .set out of the notification
var myTrack = -1, myDevice = -1;   // this device's own indices, for the push

function bang() { init(); }
function loadbang() { init(); }

function init() {
  current = STOP;
  if (!writeTask) writeTask = new Task(flushStateOut, this);
  emitTransport(STOP);
  setupApis();
  report(STOP);
}

function setupApis() {
  try {
    if (stateWatcher) { try { stateWatcher.property = ""; } catch (e) {} stateWatcher = null; }
    stateOutApi = null;
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
  if (v === current) { report(current); return; }
  transition(v);
}

function clampState(v) {
  v = (v | 0);
  if (v < STOP) return STOP;
  if (v > OVERDUB) return OVERDUB;
  return v;
}

function transition(target) {
  emitTransport(target);
  current = target;
  report(current);
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
