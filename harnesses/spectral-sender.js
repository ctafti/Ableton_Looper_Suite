/* ============================================================================
 * spectral-sender.js — Node for Max side of NAM_A2_Spectral (Contract 6). v3.
 * ----------------------------------------------------------------------------
 * v2 (2026-07-21, rig finding): v1 never registered its handlers on the rig —
 * Node for Max ran the script but every `frame` message came back "Unhandled
 * Message" and no `up` post appeared. v1's silent try/catch around
 * require('max-api') (an offline-unit-test convenience) could swallow the real
 * startup error. v2 is built to be INCAPABLE of failing quietly:
 *   - stdout/stderr diagnostics at every stage (Node for Max pipes these to
 *     the Max console independently of max-api)
 *   - process-level crash hooks -> stderr (red in the console)
 *   - ONE catch-all handler (MESSAGE_TYPES.ALL) with manual routing — no
 *     selector-matching to go wrong, and no double-delivery risk
 *
 * Wire: receives `tag <chainTag>` + `frame <256 floats>` from the device's v8,
 * builds the FROZEN SPC1 datagram (little-endian, 22-byte fixed header + UTF-8
 * chainTag + 256 x uint16 — byte-for-byte the hub codec's encode) and sends
 * RAW UDP to 127.0.0.1:11003 (SPECTRAL_UDP_PORT). Node for Max exists because
 * Max's udpsend can only emit OSC packets.
 * DEPLOYMENT: this file sits NEXT TO NAM_A2_Spectral.amxd.
 * ============================================================================ */

'use strict';

console.log('spectral-sender: boot (node ' + process.version + ', cwd ' + process.cwd() + ')');
process.on('uncaughtException', (e) => console.error('spectral-sender CRASH: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => console.error('spectral-sender REJECTION: ' + (e && e.stack || e)));

// --- Contract 6 constants (spectral.ts SPECTRAL / SPECTRAL_BINARY) ----------
const MAGIC = 0x53504331;        // "SPC1"
const VERSION = 1;
const BIN_COUNT = 256;
const HEADER_FIXED = 22;
const MAG_MAX = 65535;
const HOST = '127.0.0.1';
const PORT = 11003;              // SPECTRAL_UDP_PORT

/** Build one SPC1 datagram. Mirrors spectral-codec.ts encodeSpectralFrame. */
function buildDatagram(tag, seqNo, tMs, mags) {
  if (mags.length !== BIN_COUNT) {
    throw new Error('frame must carry exactly ' + BIN_COUNT + ' bins, got ' + mags.length);
  }
  const tagBytes = Buffer.from(tag, 'utf8');
  const buf = Buffer.alloc(HEADER_FIXED + tagBytes.length + BIN_COUNT * 2);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt8(VERSION, 4);
  buf.writeUInt8(0, 5);                       // flags reserved
  buf.writeUInt16LE(BIN_COUNT, 6);
  buf.writeUInt32LE(seqNo >>> 0, 8);
  buf.writeDoubleLE(tMs, 12);
  buf.writeUInt16LE(tagBytes.length, 20);
  tagBytes.copy(buf, 22);
  let off = 22 + tagBytes.length;
  for (let i = 0; i < BIN_COUNT; i++) {
    let m = Number(mags[i]);
    if (!(m >= 0)) m = 0;                     // NaN-safe clamp
    if (m > 1) m = 1;
    buf.writeUInt16LE(Math.round(m * MAG_MAX), off);
    off += 2;
  }
  return buf;
}

// --- Max wiring -------------------------------------------------------------
let maxApi = null;
try {
  maxApi = require('max-api');
  console.log('spectral-sender: max-api loaded');
} catch (e) {
  // Outside Max (plain-Node unit test) this is expected. INSIDE Max it is the
  // v1 failure mode — say so in red instead of dying quietly.
  console.error('spectral-sender: require("max-api") FAILED: ' + (e && e.message));
  console.error('spectral-sender: (expected under plain Node; a REAL error inside Max)');
}

if (maxApi) {
  const dgram = require('dgram');
  const sock = dgram.createSocket('udp4');
  const seqs = new Map();                     // chainTag -> next seq
  let sent = 0;
  let ignored = 0;

  // v3: STATELESS — the tag arrives inside every frame message:
  //   frame <chainTag> <256 floats>
  // (v2's separate one-shot 'tag' lost a boot race against this process.)
  // Catch-all handler, robust to BOTH possible max-api ALL signatures
  // ((selector, ...args) or (...args)) — normalize, then length-check.
  maxApi.addHandler(maxApi.MESSAGE_TYPES.ALL, (...raw) => {
    let a = raw;
    if (a[0] === 'frame') a = a.slice(1);     // strip selector if present
    if (typeof a[0] === 'string' && a.length === 1 + BIN_COUNT) {
      const tag = a[0];
      const seq = seqs.get(tag) ?? 0;
      let dg;
      try {
        dg = buildDatagram(tag, seq, Date.now(), a.slice(1));
      } catch (e) {
        maxApi.post('spectral-sender: ' + e.message, maxApi.POST_LEVELS.ERROR);
        return;
      }
      seqs.set(tag, seq + 1);
      sock.send(dg, PORT, HOST);
      sent++;
      if (seq === 0) maxApi.post('spectral-sender: first frame sent (' + tag + ', ' + dg.length + ' bytes -> ' + HOST + ':' + PORT + ')');
      else if (sent % 900 === 0) maxApi.post('spectral-sender: ' + sent + ' frames sent');
      return;
    }
    if (ignored++ < 3) maxApi.post('spectral-sender: ignoring message [' + raw.slice(0, 3).join(', ') + (raw.length > 3 ? ', …' : '') + '] (' + raw.length + ' atoms)');
  });

  maxApi.post('spectral-sender: up v3 (SPC1 -> ' + HOST + ':' + PORT + ')');
}

// --- Node test hook ---------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildDatagram, MAGIC, VERSION, BIN_COUNT, MAG_MAX, PORT, HOST };
}
