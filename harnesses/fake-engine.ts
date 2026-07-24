// Full fake engine (Phase-5a pre-flight workhorse — kept in-repo per PHASE5B handoff) on UDP 11000: answers everything the rig
// server asks at boot, supports name get/set/listen, and streams SPC1.
// Lets the REAL hub/src/rig/server.ts boot headless for pre-flight.
// NOT part of the repo ferry.
import dgram from 'node:dgram';
import { encodeOsc, decodeOsc, type OscValue } from './src/osc-helper.ts';

const TAG = /\[\[([a-zA-Z0-9._-]+)\]\]|\[(T\d+)\]/;
const EQ_NAMES: string[] = ['Device On', 'Output', 'Scale', 'Adaptive Q'];
for (let b = 1; b <= 8; b++)
  for (const part of ['Filter On A', 'Filter Type A', 'Frequency A', 'Gain A', 'Q A'])
    EQ_NAMES.push(`${b} ${part.replace(' A', '')} A`);
const DEVS = [
  { name: 'NAM_A2_Amp', params: ['Model', 'Rescan', 'Input Trim', 'Output Trim', 'Quality', 'Load OK', 'DI'] },
  { name: 'NAM_A2_Looper', params: ['State', 'Speed'] },
  { name: 'EQ Eight', params: EQ_NAMES },
  { name: 'NAM_A2_Spectral', params: [] as string[] },
];
interface T { name: string; nameListen: boolean; clips: (string | null)[]; devs?: string[] }
const mk = (name: string, clips: (string | null)[] = [null, null, null, null, null, null]): T =>
  ({ name, nameListen: false, clips });
const tracks: T[] = process.env.POISON === '1'
  ? [mk('Clean [T1]', ['riff', null, null, null, null, null]), mk('Track 4 [T2]'), mk('Crunch [T2]'), mk('Shimmer [T3]')]
  : [mk('Clean [T1]', ['riff', null, null, null, null, null]), mk('Crunch [T2]'), mk('Shimmer [T3]')];

const sock = dgram.createSocket('udp4');
let peer = { port: 11001, addr: '127.0.0.1' };
const reply = (address: string, args: OscValue[]) => sock.send(encodeOsc(address, args), peer.port, peer.addr);

function paramsOf(ti: number, d: number): string[] {
  const tr = tracks[ti] as any;
  const nm = tr?.devs ? tr.devs[d] : DEVS[d]?.name;
  const cat = DEVS.find((x) => x.name === nm);
  return cat ? cat.params : ['Device On', 'Amount'];
}
sock.on('message', (buf, rinfo) => {
  try { handle(buf, rinfo); } catch (e) { console.log('MOCK HANDLER ERROR (survived):', (e as Error).message); }
});
function handle(buf: Buffer, rinfo: { address: string }) {
  peer = { port: 11001, addr: rinfo.address };
  let m; try { m = decodeOsc(buf); } catch (e) { console.log('DECODE FAIL', (e as Error).message, buf.length, 'bytes'); return; }
  if (process.env.TRACE === '1') console.log('RX', m.address, JSON.stringify(m.args));
  const a = m.args;
  const t = () => Number(a[0]);
  // bounds guard: the server's RETURNS probe asks for track 3 on purpose
  if (/^\/live\/(track|clip|clip_slot|device|looper)\//.test(m.address) && (t() < 0 || t() >= tracks.length))
    return reply('/live/error', [`mock: track ${t()} out of range`]);
  switch (m.address) {
    case '/live/engine/ping': return reply('/live/engine/hello', ['0.5.0-mock', 1]);
    case '/live/browser/rescan': { (globalThis as any).__idx = true; console.log('BROWSER RESCAN'); return reply('/live/browser/rescan', [15739]); }
    case '/live/browser/query': // same-address reply convention (the likely real shape)
      if (!(globalThis as any).__idx) return reply('/live/browser/query', [String(a[0])]);
      return reply('/live/browser/query', [String(a[0]), String(a[0]), `query:AudioFx#${String(a[0])}`]);
    case '/live/browser/load_item': {
      const tr = tracks[t()] as any;
      if (!tr.devs) tr.devs = DEVS.map((d) => d.name);
      tr.devs.push(decodeURIComponent(String(a[1]).split('#')[1] ?? 'FX').split(':')[0]);
      console.log('LOAD_ITEM', t(), a[1]);
      return;
    }
    case '/live/track/delete_device': {
      const tr = tracks[t()] as any;
      if (!tr.devs) tr.devs = DEVS.map((d) => d.name);
      tr.devs.splice(Number(a[1]), 1);
      console.log('DELETE_DEVICE', t(), a[1]);
      return;
    }
    case '/live/song/stop_all_clips': { console.log('STOP_ALL_CLIPS received'); return; }
    case '/live/song/duplicate_track': {
      const i = t();
      tracks.splice(i + 1, 0, { name: tracks[i].name, nameListen: false, clips: [...tracks[i].clips] });
      console.log('DUPLICATE_TRACK', i);
      return;
    }
    case '/live/song/delete_track': { console.log('DELETE_TRACK', t()); tracks.splice(t(), 1); return; }
    case '/live/clip_slot/delete_clip': { tracks[t()].clips[Number(a[1])] = null; return; }
    case '/live/device/set/parameter/value': {
      // amp Model set etc: remember + answer future gets with it; Load OK (idx 5) reads 1
      (tracks[t()] as any).pv = (tracks[t()] as any).pv || {};
      (tracks[t()] as any).pv[`${a[1]}:${a[2]}`] = Number(a[3]);
      return;
    }
    case '/live/song/start_playing': case '/live/song/stop_playing': return;
    case '/live/song/get/cue_points': return reply(m.address, ['NAM_A2_TEMPLATE v2', 0]);
    case '/live/song/get/num_tracks': return reply(m.address, [tracks.length]);
    case '/live/song/get/num_scenes': return reply(m.address, [8]);
    case '/live/song/get/track_names': return reply(m.address, tracks.map((x) => x.name));
    case '/live/song/get/tempo': return reply(m.address, [120]);
    case '/live/song/get/is_playing': return reply(m.address, [0]);
    case '/live/song/get/metronome': return reply(m.address, [0]);
    case '/live/song/get/clip_trigger_quantization': return reply(m.address, [4]);
    case '/live/song/get/beat': return reply(m.address, [0]);
    case '/live/track/get/devices/name': {
      const tr = tracks[t()] as any;
      if (!tr.devs) tr.devs = DEVS.map((d) => d.name);
      return reply(m.address, [t(), ...tr.devs]);
    }
    case '/live/device/get/parameters/name': return reply(m.address, [t(), Number(a[1]), ...paramsOf(t(), Number(a[1]))]);
    case '/live/device/get/parameters/value': return reply(m.address, [t(), Number(a[1]), ...paramsOf(t(), Number(a[1])).map(() => 0)]);
    case '/live/device/get/parameters/min': return reply(m.address, [t(), Number(a[1]), ...paramsOf(t(), Number(a[1])).map(() => 0)]);
    case '/live/device/get/parameters/max': return reply(m.address, [t(), Number(a[1]), ...paramsOf(t(), Number(a[1])).map(() => 1)]);
    case '/live/device/get/parameter/value': {
      const d = Number(a[1]), pi = Number(a[2]);
      const pv = (tracks[t()] as any).pv?.[`${d}:${pi}`];
      // amp device 0: Load OK is param index 5 -> reads 1 once a Model was set
      const loadOk = d === 0 && pi === 5 && (tracks[t()] as any).pv?.[`0:0`] !== undefined ? 1 : 0;
      const devOnDefault = pi === 0 && d >= DEVS.length ? 1 : loadOk; // stock fx boot ON
      return reply(m.address, [t(), d, pi, pv ?? devOnDefault]);
    }
    case '/live/track/get/volume': return reply(m.address, [t(), 0.85]);
    case '/live/track/get/panning': return reply(m.address, [t(), 0]);
    case '/live/track/get/mute': return reply(m.address, [t(), 0]);
    case '/live/track/get/arm': return reply(m.address, [t(), 0]);
    case '/live/track/get/color': return reply(m.address, [t(), 0xc9a227]);
    case '/live/track/get/current_monitoring_state': return reply(m.address, [t(), 1]);
    case '/live/track/get/input_routing_channel': return reply(m.address, [t(), (tracks[t()] as any).routing ?? '1']);
    case '/live/track/set/input_routing_channel': { (tracks[t()] as any).routing = String(a[1]); return; }
    case '/live/track/get/available_input_routing_channels': return reply(m.address, [t(), '1', '2', '3/4', 'Resampling']);
    case '/live/track/get/send': return reply(m.address, [t(), Number(a[1]), 0]);
    case '/live/track/get/playing_slot_index': return reply(m.address, [t(), -2]);
    case '/live/track/get/fired_slot_index': return reply(m.address, [t(), -1]);
    case '/live/looper/get/state': return reply('/live/looper/state', [t(), 0]);
    case '/live/clip_slot/get/has_clip': return reply(m.address, [t(), Number(a[1]), tracks[t()].clips[Number(a[1])] ? 1 : 0]);
    case '/live/clip/get/name': return reply(m.address, [t(), Number(a[1]), tracks[t()].clips[Number(a[1])] ?? '']);
    case '/live/clip/get/length': return reply(m.address, [t(), Number(a[1]), 4]);
    case '/live/track/get/name': { console.log('GET_NAME', t(), '->', tracks[t()].name); return reply(m.address, [t(), tracks[t()].name]); }
    case '/live/track/set/name': {
      tracks[t()].name = String(a[1]);
      if (tracks[t()].nameListen) reply('/live/track/get/name', [t(), tracks[t()].name]);
      return;
    }
    case '/live/track/start_listen/name': { tracks[t()].nameListen = true; return reply('/live/track/get/name', [t(), tracks[t()].name]); }
    case '/live/track/stop_listen/name': { tracks[t()].nameListen = false; return; }
    default:
      if (m.address.includes('start_listen') || m.address.includes('stop_listen')) return; // silently accept
      return reply('/live/error', [`mock: unknown address ${m.address}`]);
  }
}
sock.bind(11000, () => console.log('fake engine on 11000'));
sock.on('error', (e) => console.log('sock err (ignored):', e.message));

// spectral: tracks with a marker stream SPC1 (re-reads the name each frame)
const spec = dgram.createSocket('udp4');
spec.on('error', (e) => console.log('spec err (ignored):', e.message));
let seq = 0;
setInterval(() => {
  for (const x of tracks) {
    const mt = x.name.match(TAG); if (!mt) continue;
    const tag = Buffer.from(mt[1] ?? mt[2], 'utf8');
    const b = Buffer.alloc(22 + tag.length + 512);
    b.writeUInt32LE(0x53504331, 0); b.writeUInt8(1, 4); b.writeUInt16LE(256, 6);
    b.writeUInt32LE(seq++, 8); b.writeDoubleLE(Date.now(), 12);
    b.writeUInt16LE(tag.length, 20); tag.copy(b, 22);
    spec.send(b, 11003, '127.0.0.1');
  }
}, 33);
