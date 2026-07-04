# hub/ — Contract-Frozen Core Modules + the Fake-Live Simulator

Everything in here consumes ONLY the frozen contracts (`../contracts/types/`),
which is why it could be built and fully tested off-rig. When the real hub is
assembled on the Mac (BUILD-PLAN Phases 2–4), these modules are imported as-is
— the rig work is *wiring* (OSC sockets, WS server, boot scan), not logic.

## Run it

```bash
npm install          # once (ws + dev types)
npm test             # 35 tests: codecs, resolver, lifecycle, mirror, math,
                     # golden byte-stability, full sim integration over real WS
npm run typecheck    # strict tsc, no emit
npm run sim          # fake Live + tablet at http://localhost:8420
                     # env: FAIL_RATE=0.2 TEMPO=92 QUANT=4 PORT=8420
```

Open the sim URL on the actual tablet (same LAN: `http://<machine-ip>:8420`)
and you are using the real Phase-2 tablet shell against the real protocol.

## Map

| Module | What it is | Frozen seam it implements |
| --- | --- | --- |
| `src/codec/spectral-codec.ts` | SPC1 encode+decode | Contract 6 binary datagram |
| `src/codec/audio-codec.ts` | APC1 encode+decode, TCP `StreamFramer`, `TenMsReslicer` | Contract 5 (incl. the hub's 10 ms reslicing duty) |
| `src/resolver/resolver.ts` | Stable IDs ↔ live indices, role mapping, rebuild-on-reorder | Contract 1 (+ Contract 7 role order) |
| `src/lifecycle/lifecycle.ts` | intent→sent→queued→confirmed/failed machine, supersession, retry-vs-reconcile, quant-window math | Contracts 3 + 8, arch §12 |
| `src/mirror/mirror.ts` | `MirrorStore` (hub) + `MirrorClient` (tablet) + path-grammar interpreter | Contract 3 delta grammar |
| `src/math/movement.ts` | gate/ramp/sine patterns → insertSteps triples | arch §10 |
| `src/math/bands.ts` | 256→48 log-band collapse, peak-hold, additive sum | arch §3 (reference impl mirrored in `../tablet/app.js`) |
| `src/sim/fake-live.ts` | contract-conformant fake Live: quantized launches, arm-follows-record, looper guard, duplicate policy, synthetic spectra, failure injection | Contract 3 (behind it: 2, 7, 8 semantics) |
| `src/sim/server.ts` | WS + static server hosting `../tablet/` | — |
| `golden/*.bin` | byte-exact codec fixtures — the M4L tap (SPC1) and C++ sidecar (APC1) test against these; `../sidecar/nam_a2_sidecar --selftest` prints the APC1 one | Contracts 5, 6 |

## Two hand-mirrored copies (keep in sync)

`tablet/app.js` re-implements two pieces in plain JS so the tablet needs no
build step: the mirror-delta applier (from `mirror.ts`) and the band math
(from `bands.ts`). The TS versions are the TESTED reference; if either
changes, port the change and note it in both files' headers.

## Provisional data (not architecture)

`QUANT_BEATS` in `lifecycle.ts` assumes Live's documented
clip_trigger_quantization enum ordering — one line to verify at the bench
(`/live/song/get/clip_trigger_quantization`), flagged in the source.
