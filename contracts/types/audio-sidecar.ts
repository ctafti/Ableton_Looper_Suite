/**
 * ============================================================================
 * CONTRACT 5 — AUDIO SIDECAR → HUB  (PCM transport)
 *                                       (arch §8, §14 · BUILD-PLAN Phase 6/7)
 * TAG: FREEZE-NOW.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS, IN PLAIN LANGUAGE
 *   The tablet needs to HEAR the rig while you roam the house. A tiny native
 *   "sidecar" process sits next to Live, receives Live's audio (via Ableton
 *   Link Audio), and streams raw PCM samples to the hub over a local socket.
 *   The hub then packetises those samples into WebRTC/Opus for the tablet.
 *   THIS contract is only the first hop: sidecar → hub, as raw PCM. Freezing it
 *   lets us build the hub's receiver and the sidecar independently, and lets us
 *   SWAP the capture source (real Link Audio vs. a virtual-device fallback)
 *   without the hub noticing — the swap hides entirely behind this seam.
 *
 * WHY THESE EXACT NUMBERS (all grounded — see API-REALITY.md)
 *   - Ableton Link Audio delivers "interleaved, 16-bit signed integer" samples
 *     with an Info block {numChannels, numFrames, sampleRate, count,
 *     sessionBeatTime, tempo, sessionId} (from LinkAudio.hpp,
 *     LinkAudioSource::BufferHandle). We mirror that block below so the sidecar
 *     can forward it verbatim with zero reinterpretation.
 *   - @roamhq/wrtc's RTCAudioSource.onData wants Int16Array samples, a
 *     sampleRate, channelCount, and 10 ms per frame (48 kHz mono => 480
 *     samples). So the HUB reslices whatever chunk sizes the sidecar sends into
 *     exact 10 ms frames before calling onData. The sidecar is NOT required to
 *     honour 10 ms — it sends natural Link buffer sizes; the hub does the
 *     reslicing. (Frame count is therefore informational, not a contract of 480.)
 *
 * ENDIANNESS: little-endian, because both the sidecar host (Apple Silicon) and
 *   the hub (Node on the same/like machine) are LE. Documented explicitly so a
 *   future big-endian reader converts.
 *
 * BINARY, NOT JSON: audio is hot-path; every packet is a fixed binary header
 *   followed by the raw int16 sample block. The header layout is frozen below
 *   and mirrored in contracts/schemas/audio-sidecar.descriptor.json (that JSON
 *   is a human/tooling DESCRIPTOR of the byte layout, not the wire format).
 * ============================================================================
 */

/**
 * Socket for the sidecar→hub hop. A local TCP stream (loopback) carrying a
 * sequence of [header][payload] records. Frozen default port; overridable by
 * config, but the shape is fixed.
 */
export const AUDIO_SIDECAR = {
  /** loopback host — sidecar and hub run on the same machine as Live. */
  host: '127.0.0.1',
  /** default TCP port for the PCM stream. */
  port: 47615,
  /** 4-byte magic at the start of every record: ASCII "APC1" (Audio PCM v1). */
  magic: 0x41504331,
  /** contract/header version. Bump only on a breaking header change. */
  version: 1,
  /** bytes per sample (signed 16-bit LE). */
  bytesPerSample: 2,
  /** sample format, for readers. */
  sampleFormat: 'int16le' as const,
  /** interleaving: L,R,L,R,... matches Link Audio "interleaved". */
  interleaved: true as const,
  /**
   * Expected capture format from the rig. Stereo @ 48 kHz is our target; the
   * header still carries the ACTUAL values each packet, so the hub trusts the
   * header, not this constant. These are documentation defaults only.
   */
  expectedSampleRate: 48000,
  expectedChannels: 2,
} as const;

/**
 * FROZEN HEADER LAYOUT (little-endian). Fixed size = 40 bytes, then payload.
 * Field order and offsets are the contract. Mirrors the Link Audio Info block
 * so the sidecar forwards it without loss; the hub uses sampleRate/numChannels/
 * numFrames to reslice into 10 ms WebRTC frames and uses count/sessionBeatTime/
 * tempo only for diagnostics + drift handling.
 *
 *   offset  size  type      field         meaning
 *   ------  ----  --------  ------------  -----------------------------------
 *      0     4    uint32    magic         AUDIO_SIDECAR.magic ("APC1")
 *      4     2    uint16    version       AUDIO_SIDECAR.version
 *      6     2    uint16    numChannels   e.g. 2  (from Link Info.numChannels)
 *      8     4    uint32    sampleRate    e.g. 48000 (Link Info.sampleRate)
 *     12     4    uint32    numFrames     samples PER CHANNEL in this packet
 *     16     4    uint32    sequence      our monotonic packet counter (drops)
 *     20     8    float64   sessionBeatTime  Link Info.sessionBeatTime
 *     28     8    float64   tempo            Link Info.tempo (BPM)
 *     36     2    uint16    flags         bit0=discontinuity/xrun before this
 *     38     2    uint16    reserved      0 (pad to 40; future use)
 *   ------  ----
 *     40   = HEADER_BYTES
 *
 *   payload: numChannels * numFrames * 2 bytes of interleaved int16 LE.
 */
export const AUDIO_HEADER = {
  BYTES: 40,
  offsets: {
    magic: 0,
    version: 4,
    numChannels: 6,
    sampleRate: 8,
    numFrames: 12,
    sequence: 16,
    sessionBeatTime: 20,
    tempo: 28,
    flags: 36,
    reserved: 38,
  },
} as const;

/** flags bitfield. */
export const AUDIO_FLAGS = {
  /** set when a gap/xrun/underrun happened just before this packet. */
  DISCONTINUITY: 0x0001,
} as const;

/**
 * The decoded header the hub works with after reading the 40 bytes. This is the
 * in-memory twin of the binary layout above — the payload length is derived:
 * numChannels * numFrames * 2.
 */
export interface AudioPacketHeader {
  readonly magic: number;
  readonly version: number;
  readonly numChannels: number;
  readonly sampleRate: number;
  /** samples per channel in this packet. */
  readonly numFrames: number;
  readonly sequence: number;
  readonly sessionBeatTime: number;
  readonly tempo: number;
  readonly flags: number;
}

/** A full decoded packet: header + the interleaved int16 sample view. */
export interface AudioPacket {
  readonly header: AudioPacketHeader;
  /** interleaved signed-16 samples, length = numChannels * numFrames. */
  readonly samples: Int16Array;
}

/**
 * WebRTC hand-off target (informational, from @roamhq/wrtc). The hub reslices
 * the PCM stream into frames of exactly 10 ms before onData. At 48 kHz that is
 * 480 samples per channel. These constants document the reslice target; they
 * are NOT imposed on the sidecar.
 */
export const WEBRTC_FRAME = {
  /** WebRTC/Opus wants 10 ms frames. */
  frameMs: 10,
  /** samples PER CHANNEL per 10 ms frame at 48 kHz = 480. */
  framesPerChannelAt48k: 480,
  bitsPerSample: 16,
} as const;

/**
 * Helper: how many bytes of payload a header implies. The hub uses this to know
 * how many bytes to read after the 40-byte header.
 */
export function payloadBytes(h: AudioPacketHeader): number {
  return h.numChannels * h.numFrames * AUDIO_SIDECAR.bytesPerSample;
}

/**
 * Helper: samples-per-channel in one 10 ms WebRTC frame at a given rate.
 * (rate / 100). Kept here so the hub's resliceer and any test agree.
 */
export function framesPerChannel10ms(sampleRate: number): number {
  return Math.round(sampleRate / 100);
}
