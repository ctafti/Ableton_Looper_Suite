# Rig-Gated Test Harnesses (Deliverable E)

Five runnable probes that verify the risky seams **on the real rig**. Written
now, run when you have the Mac + Ableton Live 12.4+ with the engine surface
selected. They are **safe to run today**: with no rig they time out and print
exactly what to do — they never hang or crash.

| # | Script | Verifies | Contract / arch |
| --- | --- | --- | --- |
| 01 | `01-osc-latency.ts` | OSC round-trip latency (feeds §8 visual-clock offset) | §6.2 |
| 02 | `02-load-item-verify.ts` | browser `load_item` load-and-verify (**seam #2**) | §6.7/§11, Contract 4 |
| 03 | `03-insert-step-automation.ts` | automation WRITE + read-back (**seam #1 — Live-12 signature check**) | §10, Contract 4 |
| 04 | `04-looper-state-roundtrip.ts` | custom looper set + echo (**seam #3**) | §6.3/§15, Contract 2/4 |
| 05 | `05-confirmed-echo-pinger.ts` | the §12 confirm-by-expectation primitive | §12, Contract 8 |

Shared: `src/osc-helper.ts` — a tiny zero-dependency OSC-over-UDP client
(send 11000 / listen 11001), with a `waitFor(predicate, timeout)` that is the
confirmation primitive.

## Run (zero install, Node 22+)

```bash
cd harnesses
node --experimental-strip-types src/01-osc-latency.ts
# or: npm run latency | load-item | automation | looper | pinger
npm run typecheck   # needs `npm install typescript` (or use the repo's tsc)
```

Point them at a remote Mac with `OSC_HOST=<mac-ip>`. Most take env overrides
(`TRACK`, `SLOT`, `CLIP`, `DEVICE`, `PARAM`, `ITEM_URI`, timeouts) — see the
header comment in each file.

## When you have the rig — recommended order

1. **01 latency** first — confirms the engine is reachable and echoing, and
   gives you the baseline round-trip number everything else assumes.
2. **05 pinger** — proves the confirm-by-expectation loop end to end on a stock
   clip fire. If this is green, the whole command/confirm model is sound.
3. **04 looper** — proves our custom M4L looper echoes state (seam #3).
4. **02 load-item** — proves "add an effect" load-and-verify (seam #2). Needs a
   real `ITEM_URI` from your boot-time browser index.
5. **03 automation** — the big one. Confirms the `insert_step` write signature
   holds on your Live 12 / Python-3.11 runtime (seam #1). The method is already
   confirmed present in the Python Live API; if the Live-12 signature differs,
   that's the finding → plan the clip-based movement fallback.

## Address note (updated 2026-07-02)

Stock AbletonOSC addresses (01, 05, and the gets in 02) are frozen and real.
The `[EXT]` addresses are now **imported directly from Contract 2**
(`contracts/types/osc.ts`) — no local copies, so harness↔contract drift is
impossible — and the shipped **engine extension** (`engine/`) implements
exactly those addresses. Install it with `engine/install.sh` before running
02/03/04. Harness 02's `ITEM_URI` comes from the engine's own index:
send `/live/browser/query <name> <max>` (e.g. via 05's console patterns) and
use a returned uri.
