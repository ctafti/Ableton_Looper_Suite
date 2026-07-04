/**
 * MIRROR DELTA ENGINE — Contract 3's pinned path grammar, both directions.
 *
 * produceDelta(prev, next): field-level diff of two MirrorSnapshots, emitting
 *   stable-ID-keyed paths (chains/<ChainID>/cells/<Slot>/<field>, ...).
 * applyDelta(snapshot, delta): the tablet side — returns a NEW snapshot, or
 *   throws UnknownPathError, which the tablet answers with resync_request
 *   (an unknown key means it missed a structural change).
 *
 * Structural changes (chain/cell/scene/device added or removed) are NOT
 * expressed as deltas — the hub pushes a fresh snapshot for those (arch §4
 * "deltas for speed, snapshots for correctness"). produceDelta enforces that
 * by returning null when structure differs.
 */
import type { MirrorSnapshot, MirrorDelta } from '../../contracts/types/ws.ts';

export class UnknownPathError extends Error {}

type Change = { path: string; value: unknown };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** null ⇒ structure changed ⇒ send a snapshot instead. */
export function produceDelta(prev: MirrorSnapshot, next: MirrorSnapshot): MirrorDelta | null {
  const changes: Change[] = [];

  // top-level scalars
  for (const k of ['tempoBpm', 'isPlaying', 'metronome', 'globalQuantization', 'linkEnabled'] as const) {
    if (prev[k] !== next[k]) changes.push({ path: k, value: next[k] });
  }

  // chains — keyed by ChainID; structure change if the ID sets differ
  const prevChains = new Map(prev.chains.map((c) => [c.id as string, c]));
  const nextChains = new Map(next.chains.map((c) => [c.id as string, c]));
  if (prevChains.size !== nextChains.size) return null;
  for (const [id, nc] of nextChains) {
    const pc = prevChains.get(id);
    if (!pc) return null;
    for (const k of ['name', 'color', 'toneId', 'volume01', 'panMinus1to1', 'sendA01', 'sendB01', 'muted', 'armed', 'live', 'inputName'] as const) {
      if (pc[k] !== nc[k]) changes.push({ path: `chains/${id}/${k}`, value: nc[k] });
    }
    // cells — keyed by Slot VALUE (never array position; Contract 1 applies)
    const prevCells = new Map(pc.cells.map((c) => [c.slot as number, c]));
    for (const cell of nc.cells) {
      const pcell = prevCells.get(cell.slot as number);
      if (!pcell) return null;
      for (const k of ['hasClip', 'name', 'lengthBeats', 'playing', 'recording', 'isLooper'] as const) {
        if (pcell[k] !== cell[k]) changes.push({ path: `chains/${id}/cells/${cell.slot}/${k}`, value: cell[k] });
      }
    }
    if (nc.cells.length !== pc.cells.length) return null;
    // looper block
    if ((pc.looper === null) !== (nc.looper === null)) return null; // promotion = structural
    if (pc.looper && nc.looper) {
      for (const k of ['state', 'layers', 'speed'] as const) {
        if (pc.looper[k] !== nc.looper[k]) changes.push({ path: `chains/${id}/looper/${k}`, value: nc.looper[k] });
      }
    }
    // device params — keyed by DeviceRole + param NAME
    const prevDevs = new Map(pc.devices.map((d) => [d.role as string, d]));
    if (pc.devices.length !== nc.devices.length) return null;
    for (const dev of nc.devices) {
      const pdev = prevDevs.get(dev.role as string);
      if (!pdev) return null;
      const prevParams = new Map(pdev.params.map((p) => [p.name, p]));
      if (pdev.params.length !== dev.params.length) return null;
      for (const p of dev.params) {
        const pp = prevParams.get(p.name);
        if (!pp) return null;
        if (pp.value !== p.value) {
          changes.push({ path: `chains/${id}/devices/${dev.role}/params/${p.name}/value`, value: p.value });
        }
      }
    }
  }

  // scenes — keyed by SceneID
  const prevScenes = new Map(prev.scenes.map((s) => [s.id as string, s]));
  if (prev.scenes.length !== next.scenes.length) return null;
  for (const s of next.scenes) {
    const ps = prevScenes.get(s.id as string);
    if (!ps) return null;
    for (const k of ['name', 'triggered'] as const) {
      if (ps[k] !== s[k]) changes.push({ path: `scenes/${s.id}/${k}`, value: s[k] });
    }
  }

  return { changes };
}

/** Deep-clone + apply. Throws UnknownPathError on any unresolvable key. */
export function applyDelta(snapshot: MirrorSnapshot, delta: MirrorDelta): MirrorSnapshot {
  const out = structuredClone(snapshot) as unknown as Record<string, unknown>;

  for (const { path, value } of delta.changes) {
    const seg = path.split('/');
    if (seg.length === 1) {
      if (!(seg[0] in out)) throw new UnknownPathError(path);
      out[seg[0]] = value;
      continue;
    }
    if (seg[0] === 'chains') {
      const chains = out.chains as Record<string, unknown>[];
      const chain = chains.find((c) => c.id === seg[1]);
      if (!chain) throw new UnknownPathError(path);
      if (seg.length === 3) {
        if (!(seg[2] in chain)) throw new UnknownPathError(path);
        chain[seg[2]] = value;
      } else if (seg[2] === 'cells' && seg.length === 5) {
        const cell = (chain.cells as Record<string, unknown>[]).find((c) => String(c.slot) === seg[3]);
        if (!cell || !(seg[4] in cell)) throw new UnknownPathError(path);
        cell[seg[4]] = value;
      } else if (seg[2] === 'looper' && seg.length === 4) {
        if (!isObj(chain.looper) || !(seg[3] in chain.looper)) throw new UnknownPathError(path);
        (chain.looper as Record<string, unknown>)[seg[3]] = value;
      } else if (seg[2] === 'devices' && seg.length === 7 && seg[4] === 'params' && seg[6] === 'value') {
        const dev = (chain.devices as Record<string, unknown>[]).find((d) => d.role === seg[3]);
        const param = dev && (dev.params as Record<string, unknown>[]).find((p) => p.name === seg[5]);
        if (!param) throw new UnknownPathError(path);
        param.value = value;
      } else {
        throw new UnknownPathError(path);
      }
    } else if (seg[0] === 'scenes' && seg.length === 3) {
      const scene = (out.scenes as Record<string, unknown>[]).find((s) => s.id === seg[1]);
      if (!scene || !(seg[2] in scene)) throw new UnknownPathError(path);
      scene[seg[2]] = value;
    } else {
      throw new UnknownPathError(path);
    }
  }
  return out as unknown as MirrorSnapshot;
}
