/**
 * THE RESOLVER — Contract 1's IdResolver, implemented.
 *
 * The single translator between stable IDs (ChainID / Slot / DeviceRole /
 * SceneID) and whatever raw indices Live is using right now. BUILD-PLAN calls
 * raw-index leakage "the most pervasive rework trap in the whole project";
 * this file is the only place (besides the OSC layer) allowed to mint Live*
 * index types.
 *
 * IDENTITY RULES (Contract 7):
 *  - A chain track is any track whose name carries a [[tag]]; the tag IS the
 *    stable identity, so REORDERING/renaming-around-the-tag never breaks IDs.
 *  - Device roles resolve by walking the track's devices against
 *    CHAIN_DEVICE_ORDER with per-role name matchers (defaults below; the exact
 *    strings are pinned by the first boot scan against the real .als).
 *  - Slots: our logical column N == Live clip-slot N (v1 grid is direct).
 *  - Scenes: columns of the grid — scene identity is positional by design
 *    (scene K = column K), so SceneIDs re-mint on rebuild. Hub-owned.
 *  - Params: resolved by NAME against the device's parameter list (order can
 *    differ across device versions — same trap as track indices).
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
} from '../../contracts/types/ids.ts';
import { chainTagFromTrackName, CHAIN_DEVICE_ORDER } from '../../contracts/types/template.ts';

/** The boot-scan input: what one snapshot read of Live gives us. */
export interface LiveScan {
  /** every track, in Live order */
  readonly tracks: readonly {
    readonly name: string;
    readonly devices: readonly { readonly name: string; readonly params: readonly string[] }[];
  }[];
  readonly numScenes: number;
}

/** Default role matchers — pinned against the real .als at first boot (Contract 7). */
export const DEFAULT_ROLE_MATCHERS: Record<string, (deviceName: string) => boolean> = {
  amp: (n) => /nam|gateway/i.test(n),
  looper: (n) => /looper/i.test(n),
  eq: (n) => /eq eight/i.test(n),
  spectral: (n) => /spectral|fft|nam_a2_spec/i.test(n),
};

export class Resolver implements IdResolver {
  private chainToTrack = new Map<string, number>();
  private trackToChain = new Map<number, string>();
  private deviceIndex = new Map<string, Map<string, number>>(); // chain -> role -> device idx
  private paramIndex = new Map<string, Map<number, Map<string, number>>>(); // chain -> device idx -> param name -> idx
  private sceneCount = 0;

  private readonly matchers: Record<string, (n: string) => boolean>;

  constructor(matchers: Record<string, (n: string) => boolean> = DEFAULT_ROLE_MATCHERS) {
    this.matchers = matchers;
  }

  rebuildFromSnapshot(snapshot: unknown): void {
    const scan = snapshot as LiveScan;
    this.chainToTrack.clear();
    this.trackToChain.clear();
    this.deviceIndex.clear();
    this.paramIndex.clear();
    this.sceneCount = scan.numScenes;

    scan.tracks.forEach((track, trackIdx) => {
      const tag = chainTagFromTrackName(track.name);
      if (tag === null) return; // returns/master/non-chain tracks
      this.chainToTrack.set(tag, trackIdx);
      this.trackToChain.set(trackIdx, tag);

      // Role -> device index. Walk CHAIN_DEVICE_ORDER; each role claims the
      // first unclaimed device its matcher accepts. inline_fx (no matcher) =
      // the unclaimed device sitting between looper and eq, if any.
      const roles = new Map<string, number>();
      const claimed = new Set<number>();
      for (const role of CHAIN_DEVICE_ORDER) {
        const match = this.matchers[role as string];
        if (!match) continue; // inline_fx handled below
        const idx = track.devices.findIndex((d, i) => !claimed.has(i) && match(d.name));
        if (idx >= 0) {
          roles.set(role as string, idx);
          claimed.add(idx);
        }
      }
      const looperIdx = roles.get('looper');
      const eqIdx = roles.get('eq');
      if (looperIdx !== undefined && eqIdx !== undefined) {
        for (let i = looperIdx + 1; i < eqIdx; i++) {
          if (!claimed.has(i)) {
            roles.set('inline_fx', i);
            break;
          }
        }
      }
      // Any AI-added device keeps its resolved NAME as its role key (Contract 1
      // DeviceRole open-string case).
      track.devices.forEach((d, i) => {
        if (!claimed.has(i) && !roles.has(d.name)) roles.set(d.name, i);
      });
      this.deviceIndex.set(tag, roles);

      // param name -> index per device
      const perDevice = new Map<number, Map<string, number>>();
      track.devices.forEach((d, i) => {
        const params = new Map<string, number>();
        d.params.forEach((p, j) => params.set(p, j));
        perDevice.set(i, params);
      });
      this.paramIndex.set(tag, perDevice);
    });
  }

  /** All chain IDs, in current Live track order (for snapshot building). */
  chainIds(): ChainID[] {
    return [...this.chainToTrack.keys()].map((t) => ChainID(t));
  }

  resolveChain(chain: ChainID): LiveTrackIndex | undefined {
    const t = this.chainToTrack.get(chain as string);
    return t === undefined ? undefined : LiveTrackIndex(t);
  }

  resolveCell(ref: CellRef): ResolvedCell | undefined {
    const track = this.resolveChain(ref.chain);
    if (track === undefined) return undefined;
    return { track, clipSlot: LiveClipSlotIndex(ref.slot as number) };
  }

  resolveDevice(chain: ChainID, role: DeviceRole): ResolvedDevice | undefined {
    const track = this.resolveChain(chain);
    if (track === undefined) return undefined;
    const idx = this.deviceIndex.get(chain as string)?.get(role as string);
    return idx === undefined ? undefined : { track, device: LiveDeviceIndex(idx) };
  }

  resolveParam(ref: ParamRef): ResolvedParameter | undefined {
    const dev = this.resolveDevice(ref.chain, ref.device);
    if (dev === undefined) return undefined;
    const p = this.paramIndex
      .get(ref.chain as string)
      ?.get(dev.device as number)
      ?.get(ref.param);
    return p === undefined ? undefined : { ...dev, parameter: LiveParameterIndex(p) };
  }

  resolveScene(scene: SceneID): LiveSceneIndex | undefined {
    const m = /^scene_(\d+)$/.exec(scene as string);
    if (!m) return undefined;
    const n = Number(m[1]);
    return n < this.sceneCount ? LiveSceneIndex(n) : undefined;
  }

  sceneId(index: number): SceneID {
    return SceneID(`scene_${index}`);
  }

  chainForTrack(track: LiveTrackIndex): ChainID | undefined {
    const tag = this.trackToChain.get(track as number);
    return tag === undefined ? undefined : ChainID(tag);
  }

  cellForTrackSlot(track: LiveTrackIndex, clipSlot: LiveClipSlotIndex): CellRef | undefined {
    const chain = this.chainForTrack(track);
    if (chain === undefined) return undefined;
    return { chain, slot: Slot(clipSlot as number) };
  }
}
