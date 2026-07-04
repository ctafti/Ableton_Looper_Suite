# SIDECAR EXPERIMENT — FINDINGS (2026-07-02, Linux container)

**Verdict: the project's designated scariest part (BUILD-PLAN Phase 8, arch §13)
is substantially de-risked.** Everything below ran and passed in this
container, off-rig, using the frozen Contract 5 seam.

## What was proven

1. **`LinkAudio.hpp` is real and in Ableton/link master.** Cloned from
   github.com/Ableton/link (`sidecar-experiment/link/`, GPL-2.0-or-later —
   fine, this project is open source). The API: `ableton::LinkAudio` extends
   `BasicLink`; `LinkAudioSink` publishes a channel (write into a
   `BufferHandle`, `commit()` with the session state); `channels()` enumerates
   `{peerName, name, id}`; `LinkAudioSource(link, id, callback)` receives
   buffers on a Link-managed thread.

2. **`LinkAudioHut` builds clean on Linux, first try.**
   `cmake -DLINK_BUILD_JACK=OFF` + `make LinkAudioHut`. Binary at
   `link/build/bin/LinkAudioHut`. No toolchain fights.

3. **Same-machine peer + channel discovery works** (UDP multicast on loopback
   functioned even inside this container): the receiver found peer
   `nam-a2-send`, channel `nam-a2-probe`, within ~1 s.

4. **Sample-exact audio transfer.** The custom probe
   (`probe/nam_a2_probe.cpp`) publishes a deterministic int16 ramp;
   the receiver verifies every sample with a boundary-aware modular check.
   Final run: **547 buffers, 136,750 samples, zero corruption.**

5. **The full Contract-5 seam end-to-end:** receiver forwarded every Link
   buffer as APC1 bytes over TCP to `verify-apc1.ts`, which decoded them with
   the hub's own `StreamFramer` + decoder: **367 packets, 91,750 samples,
   0 header errors — PASS.** The C++ encoder in the probe is the reference
   implementation for the real sidecar's output stage.

6. **The ACTUAL Phase-8 sidecar (`sidecar/nam_a2_sidecar`) passed the full
   chain over real Link Audio.** Probe `send` played fake-Live publishing a
   channel; the shipping sidecar binary (real mode, `NAM_CHANNEL=probe`)
   discovered it via `setChannelsChangedCallback`, subscribed, and forwarded
   **2,400 packets / 600,000 samples** to the Node verifier: 0 header errors,
   0 sequence skips. Its `--selftest` prints APC1 header bytes identical to
   `hub/golden/audio-packet.apc1.bin`, so the C++ and Node encoders are pinned
   to each other. On the rig, the only change is pointing `NAM_CHANNEL` at
   whatever Live names its published Main output.

## What was learned (feeds Phase 8 directly)

- **Link reslices freely.** We committed 480-frame buffers; the receiver got
  ~124-frame buffers. Contract 5's "the hub reslices into 10 ms frames; never
  assume sender chunk sizes" design decision is thereby VALIDATED, not just
  prudent.
- **`LinkAudioSource::BufferHandle::Info` maps 1:1 onto the APC1 header**
  (numChannels, numFrames, sampleRate, count→sequence, sessionBeatTime,
  tempo). No impedance mismatch; the sidecar's receive callback is ~30 lines.
- **The receive ring drops whole buffers if the consumer lags** (we saw
  hundreds under container scheduling; a real machine with normal audio
  scheduling should see few). Drops are perfectly visible via `info.count`
  discontinuities → surfaced through APC1's `sequence` field → the hub's
  reslicer + WebRTC path already treat a sequence skip as a discontinuity.
  The design absorbs this failure mode end to end.
- Enabling requires BOTH `link.enable(true)` and `link.enableLinkAudio(true)`.
- `BufferHandle` is non-copyable and strictly one-at-a-time; construct it in
  a scope, check `if (handle)`, write, `commit()`, let it destruct.

## What still needs the rig (honest list)

- Live 12.4 actually publishing its master-tap Link Audio channel(s), channel
  naming, and whether the tap is pre/post master fader (§13 open question).
- Cross-machine discovery over the studio Wi-Fi (multicast on real network
  gear; some routers filter mDNS/multicast — §6 item 5).
- Real latency numbers guitar→tablet (the §6 measurement).
- macOS build of the same probe (expected trivial — Link is the same
  header-only library there; CoreAudio backends exist in the examples).

## Repro

```bash
cd sidecar-experiment
# probe was built with: cd probe && mkdir build && cd build && cmake .. && make
node --experimental-strip-types verify-apc1.ts 9701 &   # Node end of the seam
./probe/build/nam_a2_probe send &                        # fake "Live master tap"
./probe/build/nam_a2_probe recv 127.0.0.1 9701           # the sidecar path
# expect: "[recv] PASS ..." and "[verify] PASS ..."
```
