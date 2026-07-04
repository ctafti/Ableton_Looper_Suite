/**
 * MIRROR + DELTA ENGINE — Contract 3's state channel, both sides:
 *   MirrorStore  (hub): holds the snapshot, mutates via typed setters, emits
 *                 rev-stamped deltas using the FROZEN path grammar.
 *   MirrorClient (tablet): applies snapshot/delta messages, detects rev gaps,
 *                 reports when a resync is needed.
 * Both live here so one test suite proves they round-trip; the tablet skeleton
 * ships a plain-JS mirror of MirrorClient (no build step) tested against the
 * same vectors.
 *
 * PATH GRAMMAR (frozen in ws.ts): stable-ID-keyed segments only —
 *   chains/<ChainID>/<field>
 *   chains/<ChainID>/cells/<Slot>/<field>
 *   chains/<ChainID>/looper/<field>
 *   chains/<ChainID>/devices/<DeviceRole>/params/<paramName>/value
 *   scenes/<SceneID>/<field>
 *   <topLevelField>
 */
import type {
  MirrorSnapshot,
  ChainMirror,
  CellMirror,
  StateMessage,
  MirrorDelta,
} from '../../../contracts/types/ws.ts';

export type DeltaChange = { path: string; value: unknown };

export class MirrorStore {
  private rev: number;
  private snap: MirrorSnapshot;

  constructor(initial: MirrorSnapshot, startRev = 0) {
    this.snap = structuredClone(initial) as MirrorSnapshot;
    this.rev = startRev;
  }

  snapshotMessage(): StateMessage {
    return { channel: 'state', type: 'snapshot', rev: this.rev, payload: structuredClone(this.snap) as MirrorSnapshot };
  }

  get snapshot(): MirrorSnapshot {
    return this.snap;
  }
  get revision(): number {
    return this.rev;
  }

  /** Replace the snapshot wholesale (hub reconcile) — bumps rev; caller pushes a snapshot message. */
  replace(next: MirrorSnapshot): void {
    this.snap = structuredClone(next) as MirrorSnapshot;
    this.rev += 1;
  }

  /**
   * Apply a batch of changes as ONE delta message (rev increments by exactly 1
   * per MESSAGE, per Contract 3 — a multi-field change is one delta).
   */
  apply(changes: readonly DeltaChange[]): StateMessage {
    for (const c of changes) applyPath(this.snap, c.path, c.value);
    this.rev += 1;
    const payload: MirrorDelta = { changes: changes.map((c) => ({ path: c.path, value: c.value })) };
    return { channel: 'state', type: 'delta', rev: this.rev, payload };
  }

  // --- typed setters for the common mutations (path strings live HERE only) --
  setCell(chain: string, slot: number, field: keyof CellMirror, value: unknown): StateMessage {
    return this.apply([{ path: `chains/${chain}/cells/${slot}/${String(field)}`, value }]);
  }
  setChainField(chain: string, field: keyof ChainMirror, value: unknown): StateMessage {
    return this.apply([{ path: `chains/${chain}/${String(field)}`, value }]);
  }
  setParamValue(chain: string, role: string, param: string, value: number): StateMessage {
    return this.apply([{ path: `chains/${chain}/devices/${role}/params/${param}/value`, value }]);
  }
  setTop(field: keyof MirrorSnapshot, value: unknown): StateMessage {
    return this.apply([{ path: String(field), value }]);
  }
}

/** Tablet-side applier: returns 'ok' | 'resync' (rev gap or unknown key). */
export class MirrorClient {
  snap: MirrorSnapshot | null = null;
  rev = -1;

  applyMessage(msg: StateMessage): 'ok' | 'resync' {
    if (msg.type === 'snapshot') {
      this.snap = structuredClone(msg.payload) as MirrorSnapshot;
      this.rev = msg.rev;
      return 'ok';
    }
    if (msg.type === 'delta') {
      if (this.snap === null || msg.rev !== this.rev + 1) return 'resync'; // gap detected
      try {
        for (const c of msg.payload.changes) applyPath(this.snap, c.path, c.value);
      } catch {
        return 'resync'; // unknown key = missed structural change (Contract 3)
      }
      this.rev = msg.rev;
      return 'ok';
    }
    return 'ok'; // command_status doesn't mutate the mirror
  }
}

// ---------------------------------------------------------------------------
// The path grammar interpreter — shared by both sides.
// ---------------------------------------------------------------------------
export function applyPath(snap: MirrorSnapshot, path: string, value: unknown): void {
  const seg = path.split('/');
  const fail = (): never => {
    throw new Error(`unknown mirror path: ${path}`);
  };
  if (seg.length === 1) {
    if (!(seg[0] in snap)) fail();
    (snap as unknown as Record<string, unknown>)[seg[0]] = value;
    return;
  }
  if (seg[0] === 'chains') {
    const chain = snap.chains.find((c) => (c.id as string) === seg[1]) ?? fail();
    if (seg.length === 3) {
      (chain as unknown as Record<string, unknown>)[seg[2]] = value;
      return;
    }
    if (seg[2] === 'cells' && seg.length === 5) {
      const cell = chain.cells.find((cl) => (cl.slot as number) === Number(seg[3])) ?? fail();
      (cell as unknown as Record<string, unknown>)[seg[4]] = value;
      return;
    }
    if (seg[2] === 'looper' && seg.length === 4) {
      if (chain.looper === null) fail();
      (chain.looper as unknown as Record<string, unknown>)[seg[3]] = value;
      return;
    }
    if (seg[2] === 'devices' && seg[4] === 'params' && seg[6] === 'value' && seg.length === 7) {
      const dev = chain.devices.find((d) => (d.role as string) === seg[3]) ?? fail();
      const param = dev.params.find((p) => p.name === seg[5]) ?? fail();
      (param as unknown as Record<string, unknown>).value = value;
      return;
    }
    fail();
  }
  if (seg[0] === 'scenes' && seg.length === 3) {
    const scene = snap.scenes.find((s) => (s.id as string) === seg[1]) ?? fail();
    (scene as unknown as Record<string, unknown>)[seg[2]] = value;
    return;
  }
  fail();
}
