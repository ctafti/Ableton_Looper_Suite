/* ============================================================================
 * NAM_A2_Amp — v8 brain + js2max source  (AMP-HOST-HANDOFF, arch §6/§10/§15)
 * ----------------------------------------------------------------------------
 * Wraps `neural~` (github.com/apresta/neural_tilde) into the contract amp host
 * from AMP-HOST-HANDOFF.md + contracts/types/template.ts (AMP_PARAMS). This is
 * the CONTROL BRAIN only; the audio graph (Input Trim → neural~ → Output Trim →
 * crossfade → out) and the six live.* params are authored in Max per
 * NAM_A2_Amp.build.md. Structured to mirror the PROVEN looper.js patterns.
 *
 * PATTERN PARITY WITH looper.js (the reference that closed Seam 3):
 *   - autowatch + LiveAPI OBSERVERS are the real input path (not dial cords):
 *     the hub sets a param over the LOM and an observer fires on the main thread
 *     within a couple ms (proven on rig). Dial cords are harmless fallbacks.
 *   - Resolve params by walking `this_device`'s "parameters" and matching the
 *     Long Name (lowercased), exactly as looper.js finds "state"/"state out".
 *   - The receipt (Load OK) is written with a DEFERRED LiveAPI.set on a Task —
 *     a set inside a notification is forbidden ("v8liveapi: Changes cannot be
 *     triggered by notifications"), so it's queued to the next scheduler tick,
 *     same as looper.js's flushStateOut.
 *   - Init from live.thisdevice / loadbang, resolving indices from this_device.
 *
 * WHY NO OSC PUSH (unlike looper.js outlet 2 → udpsend): the looper needed a
 * sub-ms receipt because a transport flip is instant. A model LOAD is not — the
 * LOM readback lag on Load OK is negligible next to the load itself (handoff
 * §1.5). So Load OK rides the ordinary parameter path; no udpsend/udpreceive.
 *
 * LOAD TRUTH IS OBSERVED (handoff §4): we do NOT set Load OK from having sent
 * `load`; we wait for neural~'s info outlet to say `loaded` (→1) or `error`
 * (→0). `queued` keeps us pending. A timeout fails open so audio never hangs
 * ducked.
 *
 * PROVISIONAL / VERIFY-ON-RIG (golden rule §0): QUALITY_MSG — the exact neural~
 * A2-quality (0..1) attr/message name is UNVERIFIED (handoff §9). One constant;
 * rebind on rig with a `quality_msg <name>` message. See build spec §"Quality".
 *
 * Pure functions are exported for Node tests via a `typeof module` guard at the
 * bottom (Max's v8 leaves module undefined, so the guard is inert in Live).
 * ============================================================================ */

// @device audio-effect
// NOTE: js2max only emits a Live parameter for live.dial / live.toggle (verified
// on the rig 2026-07-05: live.numbox produced NO parameter). So Model and Load OK
// are a dial and a toggle, NOT numboxes. Object type is cosmetic here — the hub
// drives these over OSC by name; amp.js resolves them by Long Name, any type.
// @ui live.dial   "Model"       inlet=0 min=0 max=127
// @ui live.toggle "Rescan"      inlet=0
// @ui live.dial   "Input Trim"  inlet=0 min=-24 max=24
// @ui live.dial   "Output Trim" inlet=0 min=-24 max=24
// @ui live.dial   "Quality"     inlet=0 min=0 max=1
// @ui live.toggle "Load OK"     outlet=2

'use strict';

if (typeof autowatch !== 'undefined') autowatch = 1;
if (typeof inlets !== 'undefined') { inlets = 1; outlets = 9; }
// inlet  0: neural~ info outlet (loaded/error/queued/...) + live.thisdevice bang
// outlet 0: -> neural~     (prewarm / load <abspath> / clear / <QUALITY_MSG> v)
// outlet 1: -> line~       (crossfade ramps: [target rampMs])
// outlet 2: -> Load OK live obj inlet (visible fallback; JS also LiveAPI.sets it)
var OUT_NEURAL = 0, OUT_XFADE = 1, OUT_LOADOK = 2, OUT_NAME = 3,
    OUT_GEARMENU = 4, OUT_TONEMENU = 5, OUT_DRY = 6, OUT_GAINUI = 7, OUT_PACKMENU = 8;

/** Push the current tone name to the display (comment/textedit via `prepend set`).
 *  Called with the manifest entry's name on `loaded`, and status text otherwise. */
function _setName(text) {
  if (typeof outlet !== 'undefined') outlet(OUT_NAME, String(text));
}

// ---- tunables (handoff §5: ~5–20 ms) ----------------------------------------
var DUCK_MS = 8;            // output ramp-down before a swap
var UNDUCK_MS = 12;         // output ramp-up after `loaded` observed
var LOAD_TIMEOUT_MS = 4000; // no loaded/error by now -> fail open (un-duck, OK=0)

// ---- provisional neural~ quality control name (VERIFY on rig, handoff §9) ----
var QUALITY_MSG = ''; // neural~ (this build) exposes NO quality control — verified
// via its help/reference (messages: bang/prewarm/clear/load only). Empty = inert
// (device sends nothing). Rebind with a `quality_msg <name>` message if a future
// neural build adds A2 quality scaling. Quality stays a real contract param.

// ---- models folder (handoff §3). Default absolute; override with a
//      `modelsdir <abspath>` message (patcherargs / saved path). A set-relative
//      option using this_device's path is available (see setModelsDirFromDevice).
// NOTE: Max's File object does NOT expand '~'. Use an ABSOLUTE path (this rig's
// home is /Users/cyrustafti). Change this one line per machine, or override at
// runtime with a `modelsdir <abspath>` message (from patcherargs / a message box).
var MODELS_DIR = '/Users/cyrustafti/Aibleton/Aibleton/models';
var MANIFEST_FILENAME = 'models.json'; // template.ts TONE_MANIFEST_FILENAME

// =============================================================================
// PURE LOGIC (no Max globals — unit-tested in Node via amp-core.test.mjs)
// =============================================================================

function parseManifest(text) {
  try { return JSON.parse(text); }
  catch (e) { throw new Error('models.json is not valid JSON: ' + e.message); }
}

function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('manifest is not an object');
  if (obj.version !== 1) throw new Error('manifest version must be 1, got ' + obj.version);
  if (!Array.isArray(obj.entries)) throw new Error('manifest.entries must be an array');
  for (var i = 0; i < obj.entries.length; i++) {
    var e = obj.entries[i];
    if (!e || typeof e !== 'object') throw new Error('entry ' + i + ' is not an object');
    if (typeof e.index !== 'number') throw new Error('entry ' + i + ' has non-number index');
    if (!(e.file === null || typeof e.file === 'string'))
      throw new Error('entry index ' + e.index + ' has bad file (must be string or null)');
  }
  return obj;
}

/** Model int -> entry. { ok:true, entry } | { ok:false, reason:'tombstone'|'missing' }.
 *  Matches on the `index` FIELD (append-only), never on array position. */
function resolveEntry(manifest, modelIndex) {
  var entry = null;
  for (var i = 0; i < manifest.entries.length; i++) {
    if (manifest.entries[i].index === modelIndex) { entry = manifest.entries[i]; break; }
  }
  if (!entry) return { ok: false, reason: 'missing', index: modelIndex };
  if (entry.file === null) return { ok: false, reason: 'tombstone', entry: entry };
  return { ok: true, entry: entry };
}

function joinModelPath(dir, rel) {
  return String(dir).replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '');
}

/** Classify a neural~ info message by selector. Verified vocab (handoff §9):
 *  loaded/error/queued/cleared/latency/loudness/bang. */
function classifyInfo(atoms) {
  if (!atoms || !atoms.length) return { kind: 'unknown', selector: '', rest: [] };
  var selector = String(atoms[0]);
  var known = ['loaded', 'error', 'queued', 'cleared', 'latency', 'loudness', 'bang'];
  return { kind: known.indexOf(selector) >= 0 ? selector : 'unknown',
           selector: selector, rest: atoms.slice(1) };
}

/** loaded→1 ; error→0 ; anything else→null (no Load OK change; queued stays pending). */
function loadOkFromSelector(selector) {
  if (selector === 'loaded') return 1;
  if (selector === 'error') return 0;
  return null;
}

function isNam(file) { return typeof file === 'string' && /\.nam$/i.test(file); }

/** HIERARCHY (pure): where an entry's file lives.
 *  'Gear/Pack/file.nam' -> {gear, pack}; legacy 'Pack/file.nam' -> gear 'Other';
 *  bare 'file.nam' (loose) -> null (hidden from the UI, hub-reachable by index). */
function splitEntryPath(file) {
  if (typeof file !== 'string') return null;
  var parts = file.split('/');
  if (parts.length >= 3) return { gear: parts[0], pack: parts[1] };
  if (parts.length === 2) return { gear: 'Other', pack: parts[0] };
  return null;
}

/** HIERARCHY (pure): ordered unique gear labels (by first appearance index). */
function gearsFrom(entries) {
  var order = [], seen = {};
  var sorted = entries.slice().sort(function (a, b) { return a.index - b.index; });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    if (e.file === null) continue;
    var p = splitEntryPath(e.file);
    if (!p) continue;
    if (!seen[p.gear]) { seen[p.gear] = true; order.push({ label: p.gear, firstIndex: e.index }); }
  }
  return order;
}

/** HIERARCHY (pure): packs within one gear, ordered by first index. */
function packsInGear(entries, gear) {
  var order = [], seen = {};
  var sorted = entries.slice().sort(function (a, b) { return a.index - b.index; });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    if (e.file === null) continue;
    var p = splitEntryPath(e.file);
    if (!p || p.gear !== gear) continue;
    if (!seen[p.pack]) { seen[p.pack] = true; order.push({ label: p.pack, firstIndex: e.index }); }
  }
  return order;
}

/** HIERARCHY (pure): tones within (gear, pack), ordered by index. */
function tonesIn(entries, gear, pack) {
  var out = [];
  var sorted = entries.slice().sort(function (a, b) { return a.index - b.index; });
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    if (e.file === null) continue;
    var p = splitEntryPath(e.file);
    if (p && p.gear === gear && p.pack === pack) out.push({ index: e.index, name: e.name || e.file });
  }
  return out;
}

/** HIERARCHY (pure): {gear, pack} of a manifest index, or null (loose/tombstone/missing). */
function entryPlace(entries, modelIndex) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].index === modelIndex) {
      return entries[i].file === null ? null : splitEntryPath(entries[i].file);
    }
  }
  return null;
}

/** ADOPTION (pure): given manifest entries and the .nam filenames found in the
 *  models-folder ROOT, return the new entries to append — files not already
 *  referenced (by exact relative path), indexed append-only from max(index)+1,
 *  toneId:null (the hub remains ToneID authority). Deterministic: sorted by name. */
function planAdoptions(entries, rootNamFiles) {
  var known = {};
  var maxIdx = -1;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].file !== null) known[entries[i].file] = true;
    if (entries[i].index > maxIdx) maxIdx = entries[i].index;
  }
  var fresh = [];
  for (var j = 0; j < rootNamFiles.length; j++) {
    var f = rootNamFiles[j];
    if (isNam(f) && !known[f]) fresh.push(f);
  }
  fresh.sort();
  var out = [];
  for (var k = 0; k < fresh.length; k++) {
    out.push({
      index: maxIdx + 1 + k,
      file: fresh[k],
      name: fresh[k].replace(/\.nam$/i, '').replace(/^.*\//, ''),  // stem only (no pack prefix)
      toneId: null,
    });
  }
  return out;
}

// =============================================================================
// MAX GLUE (runs only inside Max's v8)
// =============================================================================

var _manifest = null;      // last good manifest
var _lastModel = null;     // last Model int we acted on
var _pending = null;       // { index, abspath } awaiting loaded/error
var _timeoutTask = null;   // guards a stuck load
var _writeTask = null;     // defers the Load OK LiveAPI.set out of notifications
var _pendingLoadOk = -1;   // value queued for the deferred set
var _watch = { model: null, rescan: null, quality: null }; // observers
var _rescanApi = null, _rescanClearTask = null; // momentary-Rescan auto-clear
var _modelApi = null, _modelSetTask = null, _pendingModelSet = -1; // pack-jump writes
var _menuPack = null;        // which pack the tone umenu currently lists
var _gears = [];             // [{label, firstIndex}] gear layer (DI at menu slot 0)
var _gearPacks = [];         // packs within the selected gear
var _menuGear = null;        // selected gear label
var _di = false;             // DI/bypass engaged (UI-only state; hub params untouched)
var _lastGood = null;        // last index that reached 'loaded' (failure revert target)
var _loadTask = null, _loadTarget = -1; // DEBOUNCE: rapid Model changes (dial
// sweeps, hub automation) collapse to ONE neural~ load after 150 ms of quiet.
// Rapid successive loads into neural~ are the prime suspect for the Live
// crashes observed on the rig 2026-07-06 (dial drag across 0..127).
var LOAD_DEBOUNCE_MS = 150;
var _loadOkApi = null;     // write handle for the Load OK param

function _post() {
  if (typeof post === 'undefined') return;
  post('[amp] ' + Array.prototype.slice.call(arguments).join(' ') + '\n');
}

// ---- lifecycle --------------------------------------------------------------
function bang() { init(); }       // from live.thisdevice (device ready) or manual
function loadbang() { init(); }

function init() {
  _pending = null;
  if (!_writeTask && typeof Task !== 'undefined') _writeTask = new Task(flushLoadOk);
  _unduck();                       // wet open by default
  if (typeof outlet !== 'undefined') {
    outlet(OUT_DRY, [0, 5]);             // dry closed by default
    outlet(OUT_GAINUI, ['active', 1]);   // Gain enabled by default
  }
  reloadManifest();
  setupApis();                     // observers + Load OK write handle
  _scheduleSettle();               // late menu re-sync (startup display race)
}

/** Resolve this_device, wire observers on Model/Rescan/Quality, grab Load OK. */
function setupApis() {
  if (typeof LiveAPI === 'undefined') return;
  try {
    _clearWatch('model'); _clearWatch('rescan'); _clearWatch('quality');
    _loadOkApi = null;
    var dev = new LiveAPI(null, 'this_device');
    var params = dev.get('parameters');            // ["id", n, "id", m, ...]
    var ids = {};
    for (var i = 0; i + 1 < params.length; i += 2) {
      if (String(params[i]) !== 'id') continue;
      var pid = params[i + 1];
      var nm = _paramName(new LiveAPI(null, 'id ' + pid));
      ids[nm] = pid;
    }
    if (ids['model'] != null) {
      _watch.model = new LiveAPI(_onModelValue, 'id ' + ids['model']);
      _watch.model.property = 'value';
      // apply the RESTORED Model on open (reopened Set reloads its saved tone)
      var cur = new LiveAPI(null, 'id ' + ids['model']).get('value');
      _lastModel = null; onModel(_numOf(cur), true);
    } else _post("no 'Model' param found — did amxd_setnames.py run? (names read as live.*)");
    if (ids['rescan'] != null) {
      _watch.rescan = new LiveAPI(_onRescanValue, 'id ' + ids['rescan']);
      _watch.rescan.property = 'value';
      _rescanApi = new LiveAPI(null, 'id ' + ids['rescan']); // for the auto-clear
    }
    if (ids['quality'] != null) {
      _watch.quality = new LiveAPI(_onQualityValue, 'id ' + ids['quality']);
      _watch.quality.property = 'value';
    }
    if (ids['model'] != null) _modelApi = new LiveAPI(null, 'id ' + ids['model']);
    if (ids['load ok'] != null) _loadOkApi = new LiveAPI(null, 'id ' + ids['load ok']);
    else _post("no 'Load OK' param found to write the receipt into");
    _post('observers set:', Object.keys(ids).join(', '));
  } catch (e) { _post('setupApis failed:', String(e && e.message || e)); }
}

function _clearWatch(key) {
  if (_watch[key]) { try { _watch[key].property = ''; } catch (e) {} }
  _watch[key] = null;
}
function _paramName(api) {
  var n = api.get('name');
  return (n instanceof Array ? n.join(' ') : String(n)).toLowerCase();
}
function _numOf(v) { return (v instanceof Array) ? Number(v[v.length - 1]) : Number(v); }

// ---- observer callbacks (fire on the main thread; outlet() is allowed here,
//      LiveAPI.set is NOT — that's why Load OK is deferred) --------------------
function _onModelValue(args)  { if (args) onModel(_valueFromArgs(args)); }
// Rescan is MOMENTARY: act on the rising edge (value >= 1), then auto-clear the
// param back to 0 via a deferred write (a set inside a notification is forbidden).
// The 0 that our own clear produces is ignored here, so no rescan loop. The hub
// just sets Rescan=1 whenever it wants a re-read — it always registers.
function _onRescanValue(args) {
  if (!args) return;
  var v = _valueFromArgs(args);
  if (v >= 1) {
    reloadManifest();
    adoptDroppedFiles();   // Reload also adopts .nam files dropped into the folder root
    if (!_rescanClearTask && typeof Task !== 'undefined') _rescanClearTask = new Task(_clearRescan);
    if (_rescanClearTask) _rescanClearTask.schedule(150); // brief flash, then clear
  }
}

// ---- drop-and-Reload adoption (REV 2026-07-05: device may APPEND to the
// ---- manifest for user-dropped files; hub stays ToneID authority) -----------
function _listRootNam(dir) {
  // root .nam files PLUS one level of subfolders ("packs": <sub>/<file>.nam)
  var out = [];
  if (typeof Folder === 'undefined') return out;
  var subs = [];
  try {
    var f = new Folder(dir);
    f.reset();
    while (!f.end) {
      if (f.filename) {
        if (isNam(f.filename)) out.push(f.filename);
        else if (f.filetype === 'fold') subs.push(f.filename);
      }
      f.next();
    }
    f.close();
  } catch (e) { _post('folder scan failed:', String(e && e.message || e)); return out; }
  for (var i = 0; i < subs.length; i++) {
    var subsubs = [];
    try {
      var sf = new Folder(dir + '/' + subs[i]);
      sf.reset();
      while (!sf.end) {
        if (sf.filename) {
          if (isNam(sf.filename)) out.push(subs[i] + '/' + sf.filename);
          else if (sf.filetype === 'fold') subsubs.push(sf.filename);
        }
        sf.next();
      }
      sf.close();
    } catch (e2) { _post('subfolder scan failed:', subs[i], String(e2 && e2.message || e2)); }
    for (var j = 0; j < subsubs.length; j++) {         // depth 2: Gear/Pack/*.nam
      try {
        var ssf = new Folder(dir + '/' + subs[i] + '/' + subsubs[j]);
        ssf.reset();
        while (!ssf.end) {
          if (ssf.filename && isNam(ssf.filename))
            out.push(subs[i] + '/' + subsubs[j] + '/' + ssf.filename);
          ssf.next();
        }
        ssf.close();
      } catch (e3) { _post('depth-2 scan failed:', subs[i] + '/' + subsubs[j], String(e3 && e3.message || e3)); }
    }
  }
  return out;
}

/** Write the in-memory manifest back to disk. Dict.export_json is the M4L-safe
 *  writer (Dict.import_json is our PROVEN reader on this rig); File is the
 *  fallback. Logs which method worked. Returns true on success. */
function _writeManifest() {
  var path = joinModelPath(MODELS_DIR, MANIFEST_FILENAME);
  var text = JSON.stringify(_manifest, null, 2);
  if (typeof Dict !== 'undefined') {
    try {
      var dd = new Dict('nam_amp_manifest_w');
      dd.clear();
      dd.parse(text);
      dd.export_json(path);
      _post('manifest written via Dict:', path);
      return true;
    } catch (e) { _post('Dict write failed:', String(e && e.message || e)); }
  }
  if (typeof File !== 'undefined') {
    var f;
    try {
      f = new File(path, 'write', 'TEXT');
      if (f.isopen) {
        f.eof = 0;
        f.writestring(text);
        f.close();
        _post('manifest written via File:', path);
        return true;
      }
    } catch (e2) { if (f && f.isopen) f.close(); _post('File write failed:', String(e2 && e2.message || e2)); }
  }
  _post('MANIFEST WRITE FAILED — adoption not persisted');
  return false;
}

function adoptDroppedFiles() {
  if (!_manifest) return;
  var found = _listRootNam(MODELS_DIR);
  var fresh = planAdoptions(_manifest.entries, found);
  if (!fresh.length) return;
  for (var i = 0; i < fresh.length; i++) {
    _manifest.entries.push(fresh[i]);
    _post('adopted [' + fresh[i].index + ']', fresh[i].name);
  }
  _scheduleMenuRebuild();  // BUG FIX 2026-07-06 (v2): rebuild AFTER adoption,
                           // DEFERRED onto a Task — adoption runs inside a
                           // LiveAPI observer notification, and deferring the
                           // umenu outlet traffic out of that context is the
                           // robust path (same reasoning as all our param sets)
  if (_writeManifest()) {
    _setName('added ' + fresh.length + ' new tone(s)');
  } else {
    _setName('-- adopt failed (write) --');
  }
}
/** Populate the GEAR umenu (slot 0 = DI) from the manifest. */
function _rebuildMenu() {
  if (typeof outlet === 'undefined' || !_manifest) return;
  _gears = gearsFrom(_manifest.entries);
  outlet(OUT_GEARMENU, 'clear');
  outlet(OUT_GEARMENU, ['append', 'DI - bypass']);   // gear slot 0
  for (var i = 0; i < _gears.length; i++) outlet(OUT_GEARMENU, ['append', _gears[i].label]);
  _menuGear = null;            // force pack+tone menus to repopulate on sync
  _menuPack = null;            // (Reload previously left them stale)
  if (_di) { _showDIMenus(); return; }
  if (!_syncMenuTo(_lastModel)) _enterDI();   // truthful: no home -> real DI
}
function _showDIMenus() {
  outlet(OUT_GEARMENU, ['set', 0]);
  outlet(OUT_PACKMENU, 'clear');
  outlet(OUT_PACKMENU, ['append', '-']);
  outlet(OUT_PACKMENU, ['set', 0]);
  outlet(OUT_TONEMENU, 'clear');
  outlet(OUT_TONEMENU, ['append', 'direct input']);
  outlet(OUT_TONEMENU, ['set', 0]);
}
function _populatePackMenu(gear) {
  if (typeof outlet === 'undefined' || !_manifest) return;
  _menuGear = gear;
  _gearPacks = packsInGear(_manifest.entries, gear);
  outlet(OUT_PACKMENU, 'clear');
  for (var i = 0; i < _gearPacks.length; i++) outlet(OUT_PACKMENU, ['append', _gearPacks[i].label]);
}
function _populateToneMenu(gear, pack) {
  if (typeof outlet === 'undefined' || !_manifest) return;
  _menuPack = pack;
  var tones = tonesIn(_manifest.entries, gear, pack);
  outlet(OUT_TONEMENU, 'clear');
  for (var i = 0; i < tones.length; i++) outlet(OUT_TONEMENU, ['append', tones[i].name]);
}
/** Sync all three menus to a loaded model. Returns true iff representable
 *  (has a gear/pack home); false for loose/tombstone/missing. */
function _syncMenuTo(modelIndex) {
  if (typeof outlet === 'undefined' || !_manifest || modelIndex === null) return false;
  var place = entryPlace(_manifest.entries, modelIndex);
  if (!place) return false;
  var gi = -1;
  for (var k = 0; k < _gears.length; k++) if (_gears[k].label === place.gear) { gi = k; break; }
  if (gi < 0) return false;
  outlet(OUT_GEARMENU, ['set', gi + 1]);            // +1: slot 0 is DI
  if (place.gear !== _menuGear) _populatePackMenu(place.gear);
  var pi = -1;
  for (var m = 0; m < _gearPacks.length; m++) if (_gearPacks[m].label === place.pack) { pi = m; break; }
  if (pi >= 0) outlet(OUT_PACKMENU, ['set', pi]);
  if (place.pack !== _menuPack || place.gear !== _menuGear) _populateToneMenu(place.gear, place.pack);
  var tones = tonesIn(_manifest.entries, place.gear, place.pack);
  for (var t = 0; t < tones.length; t++) {
    if (tones[t].index === modelIndex) { outlet(OUT_TONEMENU, ['set', t]); break; }
  }
  return true;
}

// ---- DI / bypass (UI-only; Model & Load OK semantics untouched) --------------
function _enterDI() {
  _di = true;
  _menuGear = null;
  _menuPack = null;
  if (typeof outlet !== 'undefined') {
    outlet(OUT_DRY, [1, UNDUCK_MS]);   // dry up
    outlet(OUT_XFADE, [0, DUCK_MS]);   // wet down (model stays loaded/warm)
    _showDIMenus();
    outlet(OUT_GAINUI, ['active', 0]);   // grey out Gain: only Volume acts in DI
  }
  _setName('DI - direct input');
  _post('DI engaged (bypass)');
}
function _exitDI() {
  if (!_di) return;
  _di = false;
  if (typeof outlet !== 'undefined') {
    outlet(OUT_DRY, [0, DUCK_MS]);       // dry down
    outlet(OUT_GAINUI, ['active', 1]);   // Gain back in play
  }
  // wet comes back via the normal duck/unduck around the (re)load
}
/** From the umenu (via [prepend pack]): jump Model to the pack's first index.
 *  The param write is DEFERRED (sets are forbidden inside notifications; and the
 *  umenu click arrives on the UI thread — defer to be uniformly safe). */
function gear(i) {
  i = Math.round(Number(i));
  if (isNaN(i) || i < 0) return;
  if (i === 0) { _enterDI(); return; }            // gear slot 0 = DI - bypass
  var g = _gears[i - 1];
  if (!g) return;
  _exitDI();
  _populatePackMenu(g.label);
  if (typeof outlet !== 'undefined') outlet(OUT_PACKMENU, ['set', 0]);
  var pk = _gearPacks[0];
  if (!pk) return;
  _populateToneMenu(g.label, pk.label);
  if (typeof outlet !== 'undefined') outlet(OUT_TONEMENU, ['set', 0]);
  _requestModel(pk.firstIndex);
}
function pack(i) {
  i = Math.round(Number(i));
  if (isNaN(i) || _menuGear === null) return;      // (DI placeholder: no-op)
  var pk = _gearPacks[i];
  if (!pk) return;
  _exitDI();
  _populateToneMenu(_menuGear, pk.label);
  if (typeof outlet !== 'undefined') outlet(OUT_TONEMENU, ['set', 0]);
  _requestModel(pk.firstIndex);
}
/** From the tone umenu (via [prepend tone]): position i within (gear, pack). */
function tone(i) {
  i = Math.round(Number(i));
  if (isNaN(i) || !_manifest || _menuGear === null || _menuPack === null) return;
  var tones = tonesIn(_manifest.entries, _menuGear, _menuPack);
  if (i < 0 || i >= tones.length) return;
  _requestModel(tones[i].index);
}
/** Deferred Model-param write (sets are forbidden inside notifications; the
 *  observer then fires -> debounced load). */
function _requestModel(idx) {
  _pendingModelSet = idx;
  if (!_modelSetTask && typeof Task !== 'undefined') _modelSetTask = new Task(_flushModelSet);
  if (_modelSetTask) _modelSetTask.schedule(0);
  else onModel(_pendingModelSet);
}
function _flushModelSet() {
  if (_modelApi && _pendingModelSet >= 0) {
    try { _modelApi.set('value', _pendingModelSet); }
    catch (e) { _post('Model set failed:', String(e && e.message || e)); }
  }
  // INDEX-0 TRAP FIX (2026-07-06d): setting a param to its CURRENT value emits
  // no observer event (and de-dupe ate the rest), so menu clicks could vanish —
  // e.g. a fresh manifest's first pack (index 0) with Model restored at 0.
  // Load directly too; the debounce collapses this with any observer echo.
  if (_pendingModelSet >= 0) onModel(_pendingModelSet, true);
}

var _menuRebuildTask = null;
function _scheduleMenuRebuild() {
  if (!_menuRebuildTask && typeof Task !== 'undefined') _menuRebuildTask = new Task(_rebuildMenu);
  if (_menuRebuildTask) _menuRebuildTask.schedule(50);
  else _rebuildMenu();
}

// SETTLE PASS: the pack umenu displays its first item ('DI - bypass') until told
// otherwise, and the restore-time sync can race menu population at device load —
// which read as "device starts on DI" (without real DI state; Gain not greyed).
// A late re-sync makes the displayed selection truthful.
var _settleTask = null;
function _settle() {
  if (_di) return;                        // real DI: menus already showing it
  // TRUTHFUL-DI RULE: if what's loaded has no menu home (loose legacy file,
  // tombstone, nothing restored), the menus would misleadingly display the DI
  // slot — so make DI REAL (greyed Gain, dry path). Fresh devices therefore
  // boot into genuine DI.
  if (_lastModel === null || !_syncMenuTo(_lastModel)) _enterDI();
}
function _scheduleSettle() {
  if (!_settleTask && typeof Task !== 'undefined') _settleTask = new Task(_settle);
  if (_settleTask) _settleTask.schedule(600);
}

function _clearRescan() {
  if (_rescanApi) {
    try { _rescanApi.set('value', 0); }
    catch (e) { _post('Rescan clear failed:', String(e && e.message || e)); }
  }
}
function _onQualityValue(args){ if (args) onQuality(_valueFromArgs(args)); }
function _valueFromArgs(a) {
  if (a[0] === 'value') return Number(a[a.length - 1]);
  return Number(a[a.length - 1]);
}

// ---- manifest ---------------------------------------------------------------
// M4L sandboxes JS File access, so reading models.json can fail via File even when
// the file exists. Try Dict (the M4L-blessed JSON reader) then File, across POSIX
// and Max-style ("Macintosh HD:/...") paths, and LOG which combination worked so we
// learn the right method. Any success returns the JSON text.
function _tryDict(path) {
  if (typeof Dict === 'undefined') return null;
  try {
    var d = new Dict('nam_amp_manifest');
    d.clear();
    d.import_json(path);
    var s = d.stringify();
    return (s && s.indexOf('entries') >= 0) ? s : null;
  } catch (e) { return null; }
}
function _tryFile(path) {
  if (typeof File === 'undefined') return null;
  var f;
  try {
    f = new File(path, 'read', 'TEXT');
    if (!f.isopen) return null;
    var chunks = [];
    while (f.position < f.eof) chunks.push(f.readline(20000));
    f.close();
    var s = chunks.join('\n');
    return (s && s.indexOf('entries') >= 0) ? s : null;
  } catch (e) { if (f && f.isopen) f.close(); return null; }
}
function _readManifestText(dir) {
  var path = joinModelPath(dir, MANIFEST_FILENAME);
  var candidates = [path];
  if (path.charAt(0) === '/') candidates.push('Macintosh HD:' + path); // Max-style
  for (var i = 0; i < candidates.length; i++) {
    var t = _tryDict(candidates[i]);
    if (t) { _post('manifest read via Dict:', candidates[i]); return t; }
  }
  for (var j = 0; j < candidates.length; j++) {
    var t2 = _tryFile(candidates[j]);
    if (t2) { _post('manifest read via File:', candidates[j]); return t2; }
  }
  _post('manifest UNREADABLE; tried:', candidates.join('  |  '));
  return null;
}

function reloadManifest() {
  var text = _readManifestText(MODELS_DIR);
  if (text === null) {
    if (_manifest) { _post('manifest read failed; keeping previous'); return false; }
    // BOOTSTRAP (2026-07-06 fix): no models.json on disk AND none in memory —
    // fresh install, or the user deleted the manifest. Start EMPTY so Reload's
    // adoption can scan the folders and WRITE a fresh manifest from zero.
    // (Nothing else in the system creates models.json; without this, Reload was
    // a guarded no-op and the file never regenerated.)
    _manifest = { version: 1, entries: [] };
    _post('no models.json - bootstrapping empty manifest; Reload will adopt files');
    return true;
  }
  try {
    _manifest = validateManifest(parseManifest(text));
    _post('manifest:', _manifest.entries.length, 'entries from', MODELS_DIR);
    _rebuildMenu();
    return true;
  } catch (e) {
    _post('MANIFEST INVALID:', String(e && e.message || e), '— keeping previous');
    return false;
  }
}

// ---- crossfade + receipt ----------------------------------------------------
function _duck()   { if (typeof outlet !== 'undefined') outlet(OUT_XFADE, [0, DUCK_MS]); }
function _unduck() { if (typeof outlet !== 'undefined') outlet(OUT_XFADE, [1, UNDUCK_MS]); }

/** Write the OBSERVED receipt into Load OK: visible fallback via outlet now,
 *  durable value via a Task-deferred LiveAPI.set (looper flushStateOut pattern). */
function _setLoadOk(v) {
  if (typeof outlet !== 'undefined') outlet(OUT_LOADOK, v);   // fallback display
  _pendingLoadOk = v;
  if (_writeTask) _writeTask.schedule(0);
}
function flushLoadOk() {
  if (_loadOkApi && _pendingLoadOk >= 0) {
    try { _loadOkApi.set('value', _pendingLoadOk); }
    catch (e) { _post('Load OK set failed:', String(e && e.message || e)); }
  }
}

/** FAILURE COHERENCE (2026-07-06d): on error/timeout/missing, UI+param+audio
 *  must not disagree. Revert everything to the last-good model (brief re-duck),
 *  or drop to REAL DI if there is no good model (or it itself just failed). */
function _handleLoadFailure(label, failedIdx) {
  _setLoadOk(0);
  _unduck();
  _clearPending();
  if (_lastGood !== null && _lastGood !== failedIdx) {
    _setName('-- ' + label + ' - reverting --');
    _post(label, '-> reverting to last good model', _lastGood);
    _requestModel(_lastGood);      // sets param + menus + reloads: all coherent
  } else {
    _post(label, '-> no good model to revert to; entering DI');
    _enterDI();
  }
}

function _clearPending() {
  _pending = null;
  if (_timeoutTask) { _timeoutTask.cancel(); _timeoutTask = null; }
}

// ---- the load state machine -------------------------------------------------
/** Model changed (observer / restore / menus). DEBOUNCED: rapid successive
 *  values (a dial sweep, hub automation ramp) collapse to ONE load of the LAST
 *  value after LOAD_DEBOUNCE_MS of quiet — rapid load-storms into neural~ are
 *  the prime suspect for the rig's Live crashes (2026-07-06). */
function onModel(index, force) {
  index = Math.round(Number(index));
  if (isNaN(index)) return;
  if (!force && index === _lastModel && !_pending && _loadTarget < 0) return; // de-dupe
  _lastModel = index;
  _loadTarget = index;
  if (typeof Task === 'undefined') { _doLoad(index); return; }  // Node/test env
  if (!_loadTask) _loadTask = new Task(_fireLoad);
  _loadTask.cancel();
  _loadTask.schedule(LOAD_DEBOUNCE_MS);
}
function _fireLoad() {
  var t = _loadTarget;
  _loadTarget = -1;
  if (t >= 0) _doLoad(t);
}
function _doLoad(index) {
  if (!_manifest && !reloadManifest()) { _setLoadOk(0); return; }

  var r = resolveEntry(_manifest, index);
  if (!r.ok) {
    _post('Model', index, r.reason === 'tombstone'
      ? '-> tombstoned (file:null); not loading'
      : '-> no manifest entry; not loading');
    _handleLoadFailure(r.reason === 'tombstone' ? 'removed tone' : 'no tone at ' + index, index);
    return;
  }

  _exitDI();
  var abspath = joinModelPath(MODELS_DIR, r.entry.file);
  _pending = { index: index, abspath: abspath, name: r.entry.name || ('tone ' + index) };
  _syncMenuTo(index);
  _setName('loading...');
  _duck();                                                   // owned crossfade
  if (isNam(r.entry.file)) outlet(OUT_NEURAL, 'prewarm');    // NAM-only (§9)
  outlet(OUT_NEURAL, ['load', abspath]);
  _post('load →', abspath);

  if (_timeoutTask) _timeoutTask.cancel();
  if (typeof Task !== 'undefined') {
    _timeoutTask = new Task(function () {
      if (_pending) {
        _post('load TIMEOUT after', LOAD_TIMEOUT_MS, 'ms - failing open');
        _handleLoadFailure('load timeout', _pending.index);
      }
    });
    _timeoutTask.schedule(LOAD_TIMEOUT_MS);
  }
}

function onQuality(v) {
  v = Number(v);
  if (isNaN(v)) return;
  if (v < 0) v = 0; if (v > 1) v = 1;
  // Quality is a real contract param, but neural~ has no quality control, so we
  // send nothing unless QUALITY_MSG is rebound to a real message name.
  if (QUALITY_MSG && typeof outlet !== 'undefined') outlet(OUT_NEURAL, [QUALITY_MSG, v]);
}

/** One neural~ info message (atoms already split). */
function onInfo(atoms) {
  var info = classifyInfo(atoms);
  if (info.selector === 'queued') { _post('queued — waiting for loaded'); return; }
  if (info.selector === 'loaded') {
    if (_pending) _lastGood = _pending.index;
    if (_pending && _pending.name) _setName(_pending.name);
    _setLoadOk(1); _unduck(); _clearPending(); _post('loaded ✓'); return;
  }
  if (info.selector === 'error') {
    _post('error:', info.rest.join(' '));
    _handleLoadFailure('load failed', _pending ? _pending.index : null);
    return;
  }
  if (info.kind !== 'unknown') _post(info.selector, info.rest.join(' '));
  else _post('unrecognized info:', info.selector, info.rest.join(' '));
}

// ---- neural~ info arrives at inlet 0 as selector-led messages ---------------
function loaded()   { onInfo(['loaded'].concat(_args(arguments))); }
function error()    { onInfo(['error'].concat(_args(arguments))); }
function queued()   { onInfo(['queued'].concat(_args(arguments))); }
function cleared()  { onInfo(['cleared']); }
function latency()  { onInfo(['latency'].concat(_args(arguments))); }
function loudness() { onInfo(['loudness'].concat(_args(arguments))); }
function anything() {
  if (typeof messagename !== 'undefined') onInfo([messagename].concat(_args(arguments)));
}
function _args(a) { return Array.prototype.slice.call(a); }

// bare numbers at inlet 0 are ambiguous dial fallbacks (3 params share it) → ignore.
function msg_int() {}
function msg_float() {}

// ---- control messages -------------------------------------------------------
function rescan() { reloadManifest(); }
function modelsdir(p) { MODELS_DIR = expandHome(String(p)); reloadManifest(); if (_lastModel !== null) onModel(_lastModel, true); }
function quality_msg(name) { QUALITY_MSG = String(name); }
function dump() {
  _post('MODELS_DIR', MODELS_DIR, '| QUALITY_MSG', QUALITY_MSG);
  _post('entries', _manifest ? _manifest.entries.length : 'none',
        '| lastModel', _lastModel, '| pending', _pending ? _pending.index : 'none');
}

/** Optional: derive MODELS_DIR relative to the Live set from this_device path
 *  (handoff §3 alternative). Left available; not called by default. */
function setModelsDirFromDevice(subfolder) {
  if (typeof LiveAPI === 'undefined') return;
  try {
    var dev = new LiveAPI(null, 'this_device');
    var p = String(dev.unquotedpath || dev.path).replace(/"/g, '');
    _post('this_device path:', p);
    // callers map the Live-set folder → models dir; kept explicit on purpose.
  } catch (e) { _post('setModelsDirFromDevice failed:', String(e && e.message || e)); }
  void subfolder;
}

function expandHome(p) {
  p = String(p);
  if (p.charAt(0) === '~') {
    var home = '';
    try { if (typeof max !== 'undefined' && max.env) home = max.env.HOME || ''; } catch (e) {}
    if (!home && typeof process !== 'undefined' && process.env) home = process.env.HOME || '';
    if (home) return home + p.slice(1);
  }
  return p;
}

// instantiate-time manifest load (guarded; observers wait for live.thisdevice)
if (typeof File !== 'undefined') { try { reloadManifest(); } catch (e) {} }

// =============================================================================
// Node test hook — invisible to Max (module is undefined in v8/JSCore).
// =============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseManifest: parseManifest, validateManifest: validateManifest,
    resolveEntry: resolveEntry, joinModelPath: joinModelPath,
    classifyInfo: classifyInfo, loadOkFromSelector: loadOkFromSelector, isNam: isNam,
    planAdoptions: planAdoptions,
    reloadManifest: reloadManifest,   // exported for the bootstrap regression test
    _getManifest: function () { return _manifest; },
    splitEntryPath: splitEntryPath, gearsFrom: gearsFrom,
    packsInGear: packsInGear, tonesIn: tonesIn, entryPlace: entryPlace,
  };
}
