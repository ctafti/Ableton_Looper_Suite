/* ============================================================================
 * NAM_A2_Spectral — v8 brain + js2max source  (Contract 6, arch §3, Phase 4)
 * ----------------------------------------------------------------------------
 * The per-chain FFT tap. Sits LAST on every chain (Contract 7 device order) so
 * the spectrum is the post-EQ chain the listener hears. The device:
 *
 *   signal graph (injected by amxd_wire_spectral.py — this v8 does NO audio):
 *     plugin~ L+R -> mono sum -> 4x [Hann window -> fft~ 4096, phase-
 *     staggered] -> sqrt(re^2+im^2) -> poke~ (x4) into ONE [buffer~ ---spec]
 *     indexed by each fft~'s sync (4x overlap, rev 2026-07-22)
 *     (dry passthrough plugin~ -> plugout~ is untouched; we only tap)
 *   this v8 (control rate only):
 *     - resolves the chain tag by reading its OWN track's name and parsing the
 *       Contract-7 [TN] marker (CHAIN_TAG.pattern verbatim; P5-e). Duplication-proof by
 *       construction: whatever the track is named, the device reports.
 *       Observes the name property so a rename re-tags live. (Owner decision b,
 *       2026-07-21.)
 *     - every ~33 ms (SPECTRAL.fps = 30): peeks the magnitude buffer, collapses
 *       the 0..16 kHz fft bins into 256 LINEAR output bins (mean), normalizes
 *       0..1, emits `frame <256 floats>` out outlet 0.
 *     - outlet 0 feeds [node.script spectral-sender.js] which builds the FROZEN
 *       SPC1 binary datagram (raw bytes — Max's udpsend can only emit OSC
 *       packets, hence Node for Max; owner decision 2026-07-21) and sends it to
 *       127.0.0.1:SPECTRAL_UDP_PORT (11003).
 *
 * NO Live parameters — the device is a pure telemetry tap; its frozen surface
 * is "Device On" only, machine-gated by amxd_check_spectral.py.
 *
 * DATA REFRESH vs EMISSION RATE (rev 2026-07-22 — work-item-4 verdict came
 * back "laggy", so the anticipated upgrade landed): the graph now runs FOUR
 * phase-staggered fft~ instances (offsets 0/1024/2048/3072) all poking the
 * SAME buffer, so every bin refreshes every 1024 samples (~21 ms, ~47 Hz)
 * with the window/resolution unchanged at 4096. Emission stays ~30 fps —
 * every emitted frame now carries fresh data. Device-internal only; zero
 * contract movement.
 *
 * VERIFY-ON-RIG flags (bench harness + first template load):
 *   - `---` unique-name substitution in the "setbuf ---spec" MESSAGE box (the
 *     M4L per-instance namespace). Failure mode is loud: multiple chains would
 *     report IDENTICAL spectra (all instances sharing one buffer).
 *   - v8 LiveAPI + Buffer availability in Max 9 (both documented; unproven on
 *     this rig in v8 — the looper used LiveAPI in v8 successfully).
 *   - Window alignment: the Hann is cycle-broken via send~/receive~ (one
 *     64-sample vector offset at 4096 — visually negligible).
 *
 * INLET 0 messages: bang (live.thisdevice, on load) · setbuf <name> (from the
 * ---substituted loadbang message) · sr <hz> (rig standard 48000; override if
 * the rig ever changes) · gain <g> (normalization trim; default compensates
 * fft size + Hann coherent gain) · retag (force re-resolve).
 * OUTLET 0: `frame <chainTag> <256 floats>` at fps (tag in-band, v3).
 * ============================================================================ */

// @device audio-effect

'use strict';

// Max provides these as globals; guard so a Node pure-logic test can require
// this file without a strict-mode ReferenceError (same idiom as looper.js).
if (typeof autowatch !== 'undefined') autowatch = 1;
if (typeof inlets !== 'undefined') { inlets = 1; outlets = 1; }

// --- Contract 6 constants (spectral.ts SPECTRAL — keep in sync by eye; the
// --- bench harness cross-checks the produced bytes against the real contract).
var FFT_N = 4096;
var OUT_BINS = 256;
var F_HIGH_HZ = 16000;
var FPS = 30;

// Contract 7 CHAIN_TAG.pattern, verbatim (template.ts; REV 2026-07-23 P5-e:
// [TN] marker scheme — captured tag includes the T, e.g. "T1").
var TAG_PATTERN = /\[(T\d+)\]/;

var srHz = 48000;            // rig standard (48 kHz enforced — API-REALITY)
// Normalization: |X[k]| for a full-scale sine ~= A*N/2; Hann coherent gain is
// 0.5 -> peak ~= A*N/4. Divide by N/4 so a full-scale sine peaks near 1.0.
var normGain = 4.0 / FFT_N;

var buf = null;              // v8 Buffer over [buffer~ ---spec]
var bufName = null;
var chainTag = null;
var trackApi = null;         // LiveAPI observing our track's "name"
var tickTask = null;
var announced = false;

// ---------------------------------------------------------------------------
// entry points (Max)
// ---------------------------------------------------------------------------

var myTrack = null;          // parsed track index (setupTag)

function bang() {            // live.thisdevice: device fully loaded
  setupTag();
  setupBuffer();
  startTick();
}

/** RIG FINDING 2026-07-21: `---` does NOT namespace per instance in
 *  js2max-generated devices (two live instances shared one buffer — identical
 *  spectra on both chains). Deterministic fix, no substitution to trust:
 *  create a RUNTIME buffer~ with a unique name via patcher scripting and
 *  retarget the poke~ (varname spec_poke) onto it. Falls back LOUDLY to the
 *  shared literal buffer if scripting fails (degraded single-instance mode). */
function setupBuffer() {
  var unique = 'spec_' + (myTrack === null ? 'x' : myTrack) + '_' + Math.floor(Math.random() * 1000000);
  // 'use strict' makes `this` undefined in plain calls — resolve the patcher
  // handle defensively (v8 global `patcher`, else the legacy jsthis binding).
  var pat = null;
  try { if (typeof patcher !== 'undefined') pat = patcher; } catch (e) {}
  if (!pat) { try { if (this && this.patcher) pat = this.patcher; } catch (e) {} }
  try {
    if (!pat) throw new Error('no patcher handle in this JS context');
    pat.getnamed('spec_poke').message('set', unique);   // retarget FIRST — proves the hook exists
    // rev 2026-07-22 (4x overlap): retarget the staggered instances' poke~s
    // too. Tolerate absence (an older 1x graph has only spec_poke) — but if
    // present they MUST move with the buffer or stale writes corrupt it.
    for (var pi = 1; pi < 8; pi++) {
      var extra = null;
      try { extra = pat.getnamed('spec_poke' + pi); } catch (e3) {}
      if (!extra) break;
      extra.message('set', unique);
    }
    pat.newdefault(940, 40, 'buffer~', unique, 100);
    buf = new Buffer(unique);
    bufName = unique;
    post('NAM_A2_Spectral: private buffer "' + unique + '"\n');
  } catch (e) {
    post('NAM_A2_Spectral: self-namespacing FAILED (' + e + ') — falling back to shared "---spec" (multi-instance will collide)\n');
    try { pat.getnamed('spec_poke').message('set', '---spec'); } catch (e2) {}
    try { for (var pj = 1; pj < 8; pj++) { var ex2 = pat.getnamed('spec_poke' + pj); if (!ex2) break; ex2.message('set', '---spec'); } } catch (e4) {}
    setbuf('---spec');
  }
}

function setbuf(name) {      // from the ---substituted loadbang message box
  bufName = String(name);
  try {
    buf = new Buffer(bufName);
    post('NAM_A2_Spectral: buffer "' + bufName + '"\n');
  } catch (e) {
    buf = null;
    post('NAM_A2_Spectral: Buffer("' + bufName + '") failed: ' + e + '\n');
  }
}

function sr(hz) {
  if (hz > 0) { srHz = hz; post('NAM_A2_Spectral: sr ' + hz + '\n'); }
}

function gain(g) {
  if (g > 0) normGain = g;
}

function retag() { setupTag(); }

// ---------------------------------------------------------------------------
// chain tag — read our own track's name, parse [[tag]], observe renames
// ---------------------------------------------------------------------------

var tagRetryTask = null;
var tagRetries = 0;

function setupTag() {
  try {
    var dev = new LiveAPI(null, 'this_device');
    // Template puts devices directly on the chain track:
    // "live_set tracks T devices D". (If a future template nests devices in a
    // rack this parse needs a canonical_parent walk — flag, don't guess.)
    var m = String(dev.unquotedpath).match(/^live_set tracks (\d+)/);
    if (!m) {
      // RIG FINDING 2026-07-21: LiveAPI can answer "undefined" at load-time
      // (init race — observed once amid device churn). Retry, don't die.
      if (tagRetries++ < 20) {
        if (!tagRetryTask) tagRetryTask = new Task(setupTag, this);
        tagRetryTask.schedule(300);
        return;
      }
      post('NAM_A2_Spectral: unexpected device path "' + dev.unquotedpath + '" (gave up after retries)\n');
      return;
    }
    tagRetries = 0;
    myTrack = Number(m[1]);
    // Observing "name" also delivers the current value immediately.
    trackApi = new LiveAPI(onTrackName, 'live_set tracks ' + m[1]);
    trackApi.property = 'name';
  } catch (e) {
    post('NAM_A2_Spectral: setupTag failed: ' + e + '\n');
  }
}

function onTrackName(args) { // ["name", "<track name>"]
  if (!args || String(args[0]) !== 'name') return;
  var name = '';
  for (var i = 1; i < args.length; i++) name += (i > 1 ? ' ' : '') + args[i];
  var m = String(name).match(TAG_PATTERN);
  if (!m) {
    post('NAM_A2_Spectral: no [TN] marker in track name "' + name + '" — not sending\n');
    chainTag = null;
    return;
  }
  if (m[1] !== chainTag) {
    chainTag = m[1];
    post('NAM_A2_Spectral: chainTag = ' + chainTag + '\n');
  }
}

// ---------------------------------------------------------------------------
// the 30 fps tick — peek, collapse, normalize, emit
// ---------------------------------------------------------------------------

function startTick() {
  if (tickTask) return;
  tickTask = new Task(tick, this);
  tickTask.interval = 1000.0 / FPS;
  tickTask.repeat();
  if (!announced) { announced = true; post('NAM_A2_Spectral: ticking at ' + FPS + ' fps\n'); }
}

function tick() {
  if (!buf || !chainTag) return;   // wait until both the buffer and tag exist
  var binHz = srHz / FFT_N;
  var maxBin = Math.floor(F_HIGH_HZ / binHz);          // 1365 @ 48 k
  if (maxBin > FFT_N / 2) maxBin = FFT_N / 2;
  var vals;
  try {
    vals = buf.peek(1, 0, maxBin);                     // channel 1, from 0
  } catch (e) { return; }
  if (!vals || vals.length === undefined) return;
  // v3 (2026-07-21 rig finding): the tag rides INSIDE every frame message.
  // A one-shot 'tag' message at load lost a boot race against the node
  // process; stateless frames have no ordering to lose.
  var out = new Array(OUT_BINS + 2);
  out[0] = 'frame';
  out[1] = chainTag;
  for (var i = 0; i < OUT_BINS; i++) {
    var a = Math.floor(i * maxBin / OUT_BINS);
    var b = Math.floor((i + 1) * maxBin / OUT_BINS);
    if (b <= a) b = a + 1;
    var sum = 0;
    for (var k = a; k < b && k < vals.length; k++) sum += vals[k];
    var mag = (sum / (b - a)) * normGain;
    out[i + 2] = mag < 0 ? 0 : (mag > 1 ? 1 : mag);
  }
  outlet.apply(null, [0].concat(out));
}

// =============================================================================
// Node test hook — invisible to Max (module is undefined in v8/JSCore).
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FFT_N: FFT_N, OUT_BINS: OUT_BINS, F_HIGH_HZ: F_HIGH_HZ, FPS: FPS, TAG_PATTERN: TAG_PATTERN };
}
