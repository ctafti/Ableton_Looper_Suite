/**
 * ============================================================================
 * HARNESS SHARED — minimal OSC-over-UDP client (zero dependencies)
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: the harnesses talk to the engine (AbletonOSC) over UDP using
 * the OSC message format. Rather than depend on an npm package, this file
 * implements just enough OSC to send commands and receive replies: encode an
 * address + int/float/string args, and decode replies the same way. It matches
 * AbletonOSC's transport: send to UDP 11000, listen on 11001.
 *
 * GROUNDED IN: OSC 1.0 spec (4-byte-aligned, null-padded strings; typetag
 * string starts with ',') and AbletonOSC's ports/reply model (README).
 *
 * RUNNABLE NOW: this is pure Node (`dgram`), strip-types compatible. Without a
 * rig it simply won't receive replies — the harnesses handle that with clear
 * timeouts and guidance, they don't crash.
 * ============================================================================
 */

import dgram from 'node:dgram';

export const PORTS = { toEngine: 11000, fromEngine: 11001 } as const;

export type OscValue = number | string | boolean;

// --- encoding ---------------------------------------------------------------

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, 'utf8');
  const nul = Buffer.from([0]);
  const withNul = Buffer.concat([raw, nul]);
  const padding = Buffer.alloc(pad4(withNul.length));
  return Buffer.concat([withNul, padding]);
}

/** Is this integer-ish (send as OSC int32 'i') vs float ('f')? */
function isInt(n: number): boolean {
  return Number.isInteger(n);
}

/** Encode an OSC message: address + typetags + args. Supports i/f/s (+ bool as T/F). */
export function encodeOsc(address: string, args: OscValue[] = []): Buffer {
  const parts: Buffer[] = [encodeString(address)];
  let tags = ',';
  const argBufs: Buffer[] = [];
  for (const a of args) {
    if (typeof a === 'string') {
      tags += 's';
      argBufs.push(encodeString(a));
    } else if (typeof a === 'boolean') {
      tags += a ? 'T' : 'F'; // no payload bytes for booleans in OSC
    } else if (isInt(a)) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a, 0);
      argBufs.push(b);
    } else {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a, 0);
      argBufs.push(b);
    }
  }
  parts.push(encodeString(tags));
  return Buffer.concat([...parts, ...argBufs]);
}

// --- decoding ---------------------------------------------------------------

function readString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('utf8', offset, end);
  // OSC strings are null-terminated and padded to the next 4-byte boundary.
  // Length including the null is (end + 1 - offset); round that up to a
  // multiple of 4 and add to offset to get the next field's start.
  const consumed = Math.ceil((end + 1 - offset) / 4) * 4;
  return [s, offset + consumed];
}

export interface OscMessage {
  address: string;
  args: OscValue[];
}

/** Decode a single OSC message (no bundles — AbletonOSC replies are messages). */
export function decodeOsc(buf: Buffer): OscMessage {
  const [address, afterAddr] = readString(buf, 0);
  const [tags, afterTags] = readString(buf, afterAddr);
  const args: OscValue[] = [];
  let off = afterTags;
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    if (t === 'i') {
      args.push(buf.readInt32BE(off));
      off += 4;
    } else if (t === 'f') {
      args.push(buf.readFloatBE(off));
      off += 4;
    } else if (t === 's') {
      const [s, next] = readString(buf, off);
      args.push(s);
      off = next;
    } else if (t === 'T') {
      args.push(true);
    } else if (t === 'F') {
      args.push(false);
    } else if (t === 'd') {
      args.push(buf.readDoubleBE(off));
      off += 8;
    } else {
      // unknown type — stop to avoid misreading
      break;
    }
  }
  return { address, args };
}

// --- client -----------------------------------------------------------------

export interface OscClientOptions {
  host?: string;
  sendPort?: number;
  recvPort?: number;
}

/**
 * A tiny send/receive client. `onMessage` fires for every decoded reply.
 * Call `close()` when done. Designed so a harness can await a specific reply
 * with a timeout (see waitFor()).
 */
export class OscClient {
  private sock: dgram.Socket;
  private host: string;
  private sendPort: number;
  private recvPort: number;
  private listeners: ((m: OscMessage) => void)[] = [];

  constructor(opts: OscClientOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.sendPort = opts.sendPort ?? PORTS.toEngine;
    this.recvPort = opts.recvPort ?? PORTS.fromEngine;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg) => {
      try {
        const decoded = decodeOsc(msg);
        for (const l of this.listeners) l(decoded);
      } catch {
        /* ignore malformed */
      }
    });
  }

  /** Bind the receive port. Resolves when ready (or rejects if port is taken). */
  bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.recvPort, () => resolve());
    });
  }

  send(address: string, args: OscValue[] = []): void {
    const buf = encodeOsc(address, args);
    this.sock.send(buf, this.sendPort, this.host);
  }

  onMessage(fn: (m: OscMessage) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Wait for the first reply matching `predicate`, or reject after `timeoutMs`.
   * The core primitive for "send, then confirm by echo" (Contract 12).
   */
  waitFor(predicate: (m: OscMessage) => boolean, timeoutMs: number): Promise<OscMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(handler);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for a matching reply`));
      }, timeoutMs);
      const handler = (m: OscMessage) => {
        if (predicate(m)) {
          clearTimeout(timer);
          this.off(handler);
          resolve(m);
        }
      };
      this.onMessage(handler);
    });
  }

  private off(fn: (m: OscMessage) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }

  close(): void {
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }
}

/** Print a standard "no rig?" hint used by every harness on timeout. */
export function rigHint(): void {
  console.log('');
  console.log('If this timed out: that is EXPECTED with no rig. To run for real:');
  console.log('  1. On the Mac, open Ableton Live 12.4+ with the engine (AbletonOSC-based) surface selected.');
  console.log('  2. Ensure the engine is listening on UDP 11000 and replies on 11001.');
  console.log('  3. Run this harness on the same machine (or set OSC_HOST to the Mac IP).');
}

/** Read host override from env so harnesses can target a remote Mac. */
export function hostFromEnv(): string {
  return process.env.OSC_HOST ?? '127.0.0.1';
}
