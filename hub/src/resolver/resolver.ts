/**
 * RESOLVER — Contract 1's single translator between stable IDs and whatever
 * indices Live is using right now. "The most pervasive rework trap in the
 * whole project" (BUILD-PLAN) lives and dies here: nothing above this module
 * ever sees a raw index; nothing below it ever sees a ChainID.
 *
 * Input is a LiveSnapshot — the plain data a real hub assembles from stock
 * AbletonOSC reads (track_names, num_scenes, per-track device names). The
 * simulator produces the same shape, so this exact resolver runs unchanged
 * against fake Live today and real Live later.
 *
 * DEVICE→ROLE MAPPING: roles are assigned by walking each chain's devices in
 * order and matching Contract 7's CHAIN_DEVICE_ORDER using name hints
 * (ROLE_MATCHERS). Unmatched devices keep their own name as an open role (how
 * AI-added devices are addressed, Contract 1 DeviceRole note). The concrete
 * hint strings are Contract 7's "verify at first boot" item — a boot scan
 * against the real .als confirms them; they are data, not architecture.
 */
import {
  ChainID,
  Slot,
  SceneID,
  LiveTrackIndex,
  LiveClipSlotIndex,
  LiveDeviceIndex,
  LiveParameterIndex,
  LiveSceneIndex,
  type CellRef,
  type ParamRef,
  type DeviceRole,
  type IdResolver,
  type ResolvedCell,
  type ResolvedDevice,
  type ResolvedParameter,
} from '../../../contracts/types/ids.ts';
import { chainTagFromTrackName } from '../../../contracts/types/template.ts';

export interface LiveDeviceInfo {
  readonly name: string;
  /** parameter names in Live's current order (ParamRef resolves by NAME). */
  readonly paramNames: readonly string[];
}
export interface LiveTrackInfo {
  readonly name: string;
  readonly devices: readonly LiveDeviceInfo[];
}
export interface LiveSnapshot {
  readonly tracks: readonly LiveTrackInfo[];
  readonly numScenes: number;
}

/** Name hints per fixed role — Contract 7 fixtures. Verify at first boot. */
export const ROLE_MATCHERS: Record<'amp' | 'looper' | 'inline_fx' | 'eq' | 'spectral', RegExp> = {
  amp: /nam|gateway/i, // matches our NAM_A2_Amp.amxd (rev 2026-07-03) and the Gateway stopgap
  looper: /looper/i,
  inline_fx: /^$/, // never name-matched: inline_fx is "everything unclaimed between looper and eq"
  eq: /eq eight|eq8/i,
  spectral: /spectral|fft|nam_a2_spec/i,
};

interface ChainEntry {
  id: ChainID;
  tag: string;
  track: LiveTrackIndex;
  roleToDevice: Map<DeviceRole, LiveDeviceIndex>;
  deviceParams: Map<number, readonly string[]>; // device index -> param names
}

export class Resolver implements IdResolver {
  private chains = new Map<string, ChainEntry>(); // key: ChainID as string
  private trackToChain = new Map<number, ChainID>();
  private scenes = new Map<string, LiveSceneIndex>();
  private sceneIds: SceneID[] = [];

  /** Chain IDs in track order (what the mirror builder iterates). */
  chainIds(): readonly ChainID[] {
    return [...this.chains.values()].map((c) => c.id);
  }
  sceneIdList(): readonly SceneID[] {
    return this.sceneIds;
  }
  tagFor(chain: ChainID): string | undefined {
    return this.chains.get(chain as string)?.tag;
  }
  chainForTag(tag: string): ChainID | undefined {
    for (const c of this.chains.values()) if (c.tag === tag) return c.id;
    return undefined;
  }

  resolveChain(chain: ChainID): LiveTrackIndex | undefined {
    return this.chains.get(chain as string)?.track;
  }

  resolveCell(ref: CellRef): ResolvedCell | undefined {
    const track = this.resolveChain(ref.chain);
    if (track === undefined) return undefined;
    // Slot IS the clip-slot index on the chain's track in v1 (slots are our
    // logical columns; the template lays them out 1:1). The mapping is
    // centralised HERE so a future non-1:1 layout touches one line.
    return { track, clipSlot: LiveClipSlotIndex(ref.slot as number) };
  }

  resolveDevice(chain: ChainID, role: DeviceRole): ResolvedDevice | undefined {
    const entry = this.chains.get(chain as string);
    const device = entry?.roleToDevice.get(role);
    if (entry === undefined || device === undefined) return undefined;
    return { track: entry.track, device };
  }

  resolveParam(ref: ParamRef): ResolvedParameter | undefined {
    const dev = this.resolveDevice(ref.chain, ref.device);
    if (dev === undefined) return undefined;
    const entry = this.chains.get(ref.chain as string)!;
    const names = entry.deviceParams.get(dev.device as number) ?? [];
    const idx = names.findIndex((n) => n.toLowerCase() === ref.param.toLowerCase());
    if (idx < 0) return undefined;
    return { ...dev, parameter: LiveParameterIndex(idx) };
  }

  resolveScene(scene: SceneID): LiveSceneIndex | undefined {
    return this.scenes.get(scene as string);
  }

  chainForTrack(track: LiveTrackIndex): ChainID | undefined {
    return this.trackToChain.get(track as number);
  }

  cellForTrackSlot(track: LiveTrackIndex, clipSlot: LiveClipSlotIndex): CellRef | undefined {
    const chain = this.chainForTrack(track);
    if (chain === undefined) return undefined;
    return { chain, slot: Slot(clipSlot as number) };
  }

  rebuildFromSnapshot(snapshot: unknown): void {
    const snap = snapshot as LiveSnapshot;
    const oldByTag = new Map([...this.chains.values()].map((c) => [c.tag, c.id]));
    this.chains.clear();
    this.trackToChain.clear();
    this.scenes.clear();
    this.sceneIds = [];

    snap.tracks.forEach((track, ti) => {
      const tag = chainTagFromTrackName(track.name);
      if (!tag) return; // not a chain track (returns/master have no [[tag]])
      // STABILITY: same tag => same ChainID across rebuilds. This is the whole
      // point — reorder tracks in Live and every saved reference still works.
      const id = oldByTag.get(tag) ?? ChainID(`chain_${tag}`);
      const entry: ChainEntry = {
        id,
        tag,
        track: LiveTrackIndex(ti),
        roleToDevice: new Map(),
        deviceParams: new Map(),
      };
      assignRoles(track.devices, entry);
      this.chains.set(id as string, entry);
      this.trackToChain.set(ti, id);
    });

    for (let s = 0; s < snap.numScenes; s++) {
      const id = SceneID(`scene_${s}`);
      this.sceneIds.push(id);
      this.scenes.set(id as string, LiveSceneIndex(s));
    }
  }
}

function assignRoles(devices: readonly LiveDeviceInfo[], entry: ChainEntry): void {
  const claimed = new Set<number>();
  const claim = (role: DeviceRole, di: number) => {
    entry.roleToDevice.set(role, LiveDeviceIndex(di));
    entry.deviceParams.set(di, devices[di].paramNames);
    claimed.add(di);
  };
  // 1) fixed roles by name hint, in template order
  for (const role of ['amp', 'looper', 'eq', 'spectral'] as const) {
    const di = devices.findIndex((d, i) => !claimed.has(i) && ROLE_MATCHERS[role].test(d.name));
    if (di >= 0) claim(role, di);
  }
  // 2) inline_fx = first unclaimed device between looper and eq (Contract 7)
  const looper = entry.roleToDevice.get('looper') as number | undefined;
  const eq = entry.roleToDevice.get('eq') as number | undefined;
  if (looper !== undefined && eq !== undefined) {
    for (let di = looper + 1; di < eq; di++) {
      if (!claimed.has(di)) {
        claim('inline_fx', di);
        break;
      }
    }
  }
  // 3) everything else keeps its own name as an open role (AI-added devices)
  devices.forEach((d, di) => {
    if (!claimed.has(di)) claim(d.name, di);
  });
}
