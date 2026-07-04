/**
 * FAKE LIVE — the simulator behind the WS seam (Contract 3). It emulates the
 * hub+Live pair from the tablet's point of view: serves snapshots, answers
 * commands with contract-conformant CommandStatus phases (including realistic
 * launch-quantization delays), streams synthetic per-chain spectra + beat
 * telemetry, and can inject failures (FAIL_RATE) so the tablet's
 * failed→revert path gets exercised.
 *
 * IT CLAIMS NOTHING ABOUT LIVE. Every behaviour here implements OUR frozen
 * contracts; the rig harnesses prove real Live separately. That's what makes
 * building the tablet against this sanctioned rather than the "UI against a
 * guessed state shape" trap — the shape isn't guessed, it's Contract 3.
 *
 * Also enforced here so the tablet meets them early:
 *  - duplicate_clip_to's empty-target policy (delete-then-duplicate, ONE
 *    logical command — Contract 2 caveat)
 *  - arm-follows-record: one live chain per physical input (Contract 7
 *    ARM_POLICY); go_live re-routes the glow
 *  - looper guard: looper Record/Overdub stops that chain's playing clip
 */
import { MirrorStore, type DeltaChange } from '../mirror/mirror.ts';
import { msToNextBoundary, QUANT_BEATS } from '../lifecycle/lifecycle.ts';
import { LooperState } from '../../../contracts/types/osc.ts';
import { ChainID, Slot, SceneID, ToneID } from '../../../contracts/types/ids.ts';
import type {
  MirrorSnapshot,
  ChainMirror,
  CellMirror,
  StateMessage,
  TelemetryMessage,
  TabletCommand,
  CommandStatus,
} from '../../../contracts/types/ws.ts';
import { SPECTRAL, type SpectralFrame } from '../../../contracts/types/spectral.ts';

export interface SimOptions {
  failRate?: number; // 0..1 chance a command's echo "gets lost"
  tempoBpm?: number;
  quantIndex?: number; // clip_trigger_quantization index (4 = 1 bar)
}

type Send = (msg: StateMessage | TelemetryMessage) => void;

const CHAIN_DEFS = [
  { tag: 'chain.clean', name: 'Clean', color: '#C9A227', input: 'guitar' },
  { tag: 'chain.crunch', name: 'Crunch', color: '#C77D4A', input: 'guitar' },
  { tag: 'chain.shimmer', name: 'Shimmer', color: '#7FA6A3', input: 'guitar' },
  { tag: 'chain.vox', name: 'Vox', color: '#9B7FA6', input: 'mic' },
];
const SLOTS = 6;

function makeCell(slot: number, hasClip: boolean, name: string | null): CellMirror {
  return { slot: Slot(slot), hasClip, name, lengthBeats: hasClip ? 8 : null, playing: false, recording: false, isLooper: false };
}

function initialSnapshot(tempoBpm: number, quantIndex: number): MirrorSnapshot {
  const chains: ChainMirror[] = CHAIN_DEFS.map((def, ci) => ({
    id: ChainID(`chain_${def.tag}`),
    name: def.name,
    color: def.color,
    toneId: ci === 0 ? ToneID(1001) : null,
    volume01: 0.85,
    panMinus1to1: 0,
    sendA01: 0.1,
    sendB01: 0,
    muted: false,
    armed: ci === 0,
    live: ci === 0, // clean starts live for guitar
    inputName: def.input,
    cells: Array.from({ length: SLOTS }, (_, s) => makeCell(s, (s + ci) % 3 === 0, (s + ci) % 3 === 0 ? `take ${s + 1}` : null)),
    looper: null,
    devices: [
      // NAM_A2_Amp surface per Contract 7 AMP_PARAMS (rev 2026-07-03):
      // Model = the tone knob (manifest index); Load OK = the observed receipt.
      { role: 'amp', name: 'NAM_A2_Amp', params: [
        { name: 'Model', value: ci, min: 0, max: 127, quantized: true },
        { name: 'Input Trim', value: 0.5, min: 0, max: 1, quantized: false },
        { name: 'Output Trim', value: 0.5, min: 0, max: 1, quantized: false },
        { name: 'Quality', value: 1, min: 0, max: 1, quantized: false },
        { name: 'Load OK', value: 1, min: 0, max: 1, quantized: true },
      ] },
      { role: 'looper', name: 'NAM_A2_Looper', params: [{ name: 'State', value: 0, min: 0, max: 3, quantized: true }, { name: 'Speed', value: 1, min: 0.25, max: 4, quantized: false }] },
      { role: 'eq', name: 'EQ Eight', params: [{ name: '3 Frequency A', value: 0.5, min: 0, max: 1, quantized: false }, { name: '3 Gain A', value: 0.5, min: 0, max: 1, quantized: false }] },
    ],
  }));
  return {
    tempoBpm,
    isPlaying: true,
    metronome: false,
    globalQuantization: quantIndex,
    linkEnabled: false,
    chains,
    scenes: Array.from({ length: SLOTS }, (_, s) => ({ id: SceneID(`scene_${s}`), name: `Scene ${s + 1}`, triggered: false })),
  };
}

export class FakeLive {
  readonly store: MirrorStore;
  private readonly failRate: number;
  private readonly send: Send;
  private positionBeats = 0;
  private lastTickMs: number;
  private seqByChain = new Map<string, number>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];

  constructor(send: Send, opts: SimOptions = {}) {
    this.send = send;
    this.failRate = opts.failRate ?? 0;
    this.store = new MirrorStore(initialSnapshot(opts.tempoBpm ?? 120, opts.quantIndex ?? 4));
    this.lastTickMs = Date.now();
  }

  start(): void {
    // beat clock + telemetry (Contract 3 telemetry channel)
    this.intervals.push(setInterval(() => this.beatTick(), 50));
    this.intervals.push(setInterval(() => this.spectraTick(), 1000 / SPECTRAL.fps));
  }
  stop(): void {
    this.intervals.forEach(clearInterval);
    this.timers.forEach(clearTimeout);
  }

  sendSnapshot(): void {
    this.send(this.store.snapshotMessage());
  }

  // ------------------------------------------------------------------------
  handleCommand(cmd: TabletCommand): void {
    const status = (phase: CommandStatus['phase'], extra: Partial<CommandStatus> = {}) =>
      this.send({ channel: 'state', type: 'command_status', rev: this.store.revision, payload: { commandId: cmd.commandId, phase, ...extra } });

    status('sent');
    const lost = Math.random() < this.failRate;

    const confirmNow = (mutate: () => void) => {
      if (lost) {
        // echo "lost": after the immediate window the hub reports failed
        this.after(400, () => status('failed', { reason: "didn't take — retry" }));
        return;
      }
      mutate(); // deltas flow as the mutation happens (truth up)
      status('confirmed');
    };

    const snap = this.store.snapshot;
    const chainOf = (id: string) => snap.chains.find((c) => (c.id as string) === id);

    switch (cmd.kind) {
      case 'fire_clip': {
        const quantMs = msToNextBoundary(this.positionBeats, QUANT_BEATS[snap.globalQuantization] ?? 4, snap.tempoBpm);
        status('queued', { queuedForMs: Math.round(quantMs) });
        this.after(quantMs, () => {
          if (lost) {
            status('failed', { reason: 'no echo within window' });
            return;
          }
          const chain = chainOf(cmd.cell.chain as string);
          if (!chain) return status('failed', { reason: 'unknown chain' });
          // one playing clip per row (true Session behaviour, §1)
          for (const cell of chain.cells) {
            if (cell.playing) this.push(this.store.setCell(chain.id as string, cell.slot as number, 'playing', false));
          }
          const target = chain.cells.find((cl) => (cl.slot as number) === (cmd.cell.slot as number));
          if (!target?.hasClip) {
            // firing an EMPTY slot on the LIVE chain records (arm-follows-record)
            this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'recording', true));
            this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'hasClip', true));
            this.after(2000, () => {
              this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'recording', false));
              this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'playing', true));
              this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'name', 'new take'));
              this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'lengthBeats', 8));
            });
            this.goLiveInternal(chain.id as string); // tone follows attention
          } else {
            this.push(this.store.setCell(chain.id as string, cmd.cell.slot as number, 'playing', true));
          }
          status('confirmed');
        });
        return;
      }
      case 'stop_clip':
        return confirmNow(() => {
          this.push(this.store.setCell(cmd.cell.chain as string, cmd.cell.slot as number, 'playing', false));
        });
      case 'launch_scene': {
        const quantMs = msToNextBoundary(this.positionBeats, QUANT_BEATS[snap.globalQuantization] ?? 4, snap.tempoBpm);
        status('queued', { queuedForMs: Math.round(quantMs) });
        this.after(quantMs, () => {
          if (lost) return status('failed', { reason: 'no echo within window' });
          const sceneSlot = Number((cmd.scene as string).split('_')[1]);
          for (const chain of this.store.snapshot.chains) {
            for (const cell of chain.cells) {
              const shouldPlay = (cell.slot as number) === sceneSlot && cell.hasClip;
              if (cell.playing !== shouldPlay) this.push(this.store.setCell(chain.id as string, cell.slot as number, 'playing', shouldPlay));
            }
          }
          status('confirmed');
        });
        return;
      }
      case 'duplicate_clip_to':
        return confirmNow(() => {
          // Contract 2 caveat enforced HERE the way the real hub will:
          // occupied target -> delete-then-duplicate as ONE logical command.
          const from = chainOf(cmd.from.chain as string)?.cells.find((cl) => (cl.slot as number) === (cmd.from.slot as number));
          if (!from?.hasClip) return;
          const toChain = cmd.to.chain as string;
          const toSlot = cmd.to.slot as number;
          this.push(this.store.apply([
            { path: `chains/${toChain}/cells/${toSlot}/hasClip`, value: true },
            { path: `chains/${toChain}/cells/${toSlot}/name`, value: from.name },
            { path: `chains/${toChain}/cells/${toSlot}/lengthBeats`, value: from.lengthBeats },
            { path: `chains/${toChain}/cells/${toSlot}/playing`, value: false },
          ] satisfies DeltaChange[]));
        });
      case 'set_param':
        return confirmNow(() => {
          this.push(this.store.setParamValue(cmd.chain as string, cmd.device as string, cmd.param, cmd.value));
        });
      case 'set_send':
        return confirmNow(() => {
          this.push(this.store.setChainField(cmd.chain as string, cmd.send === 'A' ? 'sendA01' : 'sendB01', cmd.value01));
        });
      case 'set_mute':
        return confirmNow(() => this.push(this.store.setChainField(cmd.chain as string, 'muted', cmd.muted)));
      case 'set_volume':
        return confirmNow(() => this.push(this.store.setChainField(cmd.chain as string, 'volume01', cmd.value01)));
      case 'set_pan':
        return confirmNow(() => this.push(this.store.setChainField(cmd.chain as string, 'panMinus1to1', cmd.valueMinus1to1)));
      case 'go_live':
        return confirmNow(() => this.goLiveInternal(cmd.chain as string));
      case 'set_tempo':
        return confirmNow(() => this.push(this.store.setTop('tempoBpm', cmd.bpm)));
      case 'set_metronome':
        return confirmNow(() => this.push(this.store.setTop('metronome', cmd.on)));
      case 'looper_state':
        return confirmNow(() => {
          // looper guard (Contract 7): Record/Overdub stops this chain's clips
          if (cmd.state === LooperState.Record || cmd.state === LooperState.Overdub) {
            const chain = chainOf(cmd.chain as string);
            for (const cell of chain?.cells ?? []) {
              if (cell.playing) this.push(this.store.setCell(cmd.chain as string, cell.slot as number, 'playing', false));
            }
          }
          this.push(this.store.setParamValue(cmd.chain as string, 'looper', 'State', cmd.state));
        });
    }
  }

  /** ARM_POLICY: one live chain per physical input; tone follows attention. */
  private goLiveInternal(chainId: string): void {
    const target = this.store.snapshot.chains.find((c) => (c.id as string) === chainId);
    if (!target) return;
    for (const c of this.store.snapshot.chains) {
      const shouldBeLive = (c.id as string) === chainId ? true : c.inputName === target.inputName ? false : c.live;
      if (c.live !== shouldBeLive) {
        this.push(this.store.setChainField(c.id as string, 'live', shouldBeLive));
        this.push(this.store.setChainField(c.id as string, 'armed', shouldBeLive));
      }
    }
  }

  // ------------------------------------------------------------------------
  private beatTick(): void {
    const now = Date.now();
    const dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (!this.store.snapshot.isPlaying) return;
    const beatsPerSec = this.store.snapshot.tempoBpm / 60;
    const prev = this.positionBeats;
    this.positionBeats += dt * beatsPerSec;
    if (Math.floor(this.positionBeats) !== Math.floor(prev)) {
      this.send({
        channel: 'telemetry',
        type: 'beat',
        payload: { beat: Math.floor(this.positionBeats), tempoBpm: this.store.snapshot.tempoBpm, tMs: now },
      });
    }
  }

  /** Synthesize a plausible per-chain spectrum: moving peaks when audible. */
  private spectraTick(): void {
    const t = Date.now() / 1000;
    for (const chain of this.store.snapshot.chains) {
      const audible = !chain.muted && (chain.live || chain.cells.some((c) => c.playing));
      const seq = (this.seqByChain.get(chain.id as string) ?? 0) + 1;
      this.seqByChain.set(chain.id as string, seq);
      const mags = new Array<number>(SPECTRAL.binCount).fill(0);
      if (audible) {
        const base = 20 + 40 * Math.abs(Math.sin(t * 0.3 + seq * 0.001));
        for (let p = 0; p < 4; p++) {
          const center = base * (p + 1) * (1 + 0.1 * Math.sin(t * (0.5 + p * 0.2)));
          const amp = 0.8 / (p + 1);
          for (let i = Math.max(0, Math.floor(center - 6)); i < Math.min(SPECTRAL.binCount, center + 6); i++) {
            const d = (i - center) / 3;
            mags[i] = Math.min(1, mags[i] + amp * Math.exp(-d * d));
          }
        }
        for (let i = 0; i < SPECTRAL.binCount; i++) mags[i] = Math.min(1, mags[i] + 0.02 * Math.random());
      }
      const frame: SpectralFrame = { chainTag: this.tagOf(chain.id as string), seq, tMs: Date.now(), magnitudes: mags };
      this.send({ channel: 'telemetry', type: 'spectra', payload: frame });
    }
  }

  private tagOf(chainId: string): string {
    return chainId.replace(/^chain_/, '');
  }
  private push(msg: StateMessage): void {
    this.send(msg);
  }
  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, Math.max(0, ms)));
  }
}
