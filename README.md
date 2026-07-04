# NAM A2 Rig — Off-Machine Foundation

This is the machine-independent slice of Phases 0–1: the **frozen contracts**
every component builds against, the **evidence** they're grounded in real APIs,
the **unfrozen seams** with the exact experiment that closes each, one runnable
**TONE3000 spike**, and five **rig-gated test harnesses**. No Mac / Ableton /
audio interface / tablet was needed to produce any of it.

Everything here was frozen against **real, current external APIs** (verified
2026-07-01) — never guessed. Where a field couldn't be verified off-rig it is
marked `ASSUMED` and listed as a provisional seam with the spike that resolves it.

## Map

```
contracts/
  CONTRACTS.md            ← plain-language spec of all 8 contracts + CHANGELOG (start here)
  types/*.ts              ← the contracts AS TypeScript (source of truth, Node side)
  schemas/*.json          ← cross-language WIRE formats (Python engine, sidecar, tablet)
reports/
  API-REALITY.md          ← per-contract source audit + every ASSUMED field (Deliverable B)
  PROVISIONAL-SEAMS.md     ← each unfrozen item + the spike that closes it (Deliverable C)
spikes/tone3000/          ← OAuth PKCE + fetch-one-A2-model, runnable off-rig (Deliverable D)
harnesses/                ← 5 OSC probes; addresses IMPORTED from Contract 2 (Deliverable E)
engine/                   ← Python engine extension implementing every Contract-2
                            [EXT] address + one-script installer + offline mock
                            test (19 checks) (Deliverable F)
hub/                      ← Deliverable G: the hub's CORE MODULES, built on the
                            frozen contracts and fully tested off-rig (35 tests):
                            SPC1/APC1 codecs + golden byte fixtures, stable-ID
                            resolver, command lifecycle, mirror/delta engine,
                            movement + spectral-display math — AND the fake-Live
                            SIMULATOR (`npm run sim`). See hub/README.md.
tablet/                   ← Deliverable H: the Phase-2 tablet walking skeleton
                            (plain JS, no build step) served by the simulator.
                            Fire clips, queued countdowns, failed→revert, go_live,
                            live spectra — the real UI shell on the real protocol.
sidecar/                  ← Deliverable I: the Phase-8 audio-bridge sidecar (C++,
                            ~260 lines, build-once). PROVEN off-rig end to end —
                            see sidecar-experiment/FINDINGS.md.
sidecar-experiment/       ← The Link Audio de-risk: Ableton's repo (LinkAudio.hpp
                            confirmed real; LinkAudioHut builds clean on Linux),
                            a sample-exact transfer probe, the Node APC1 seam
                            verifier, and FINDINGS.md with the PASS results.
FIRST-MAC-SESSION.md      ← START HERE at the computer: the step-by-step on-ramp
                            (v2, current with everything above).
```

**Updated 2026-07-03 — amp host decision.** The amp slot is now OUR M4L device
(`NAM_A2_Amp.amxd` wrapping the MIT `neural~` external) instead of the Gateway
VST in a rack: verified that Gateway's model loading is GUI-only, which capped
the AI's tone vocabulary at hand-baked rack chains and dead-ended the TONE3000
API flow at a file dialog. Tone switching now rides the frozen `set_param` path
via a `Model` index parameter + hub-written append-only manifest, with an
OBSERVED load receipt. Contract 7 carries the pinned surfaces; evidence in
reports/API-REALITY.md; bring-up is §6.1.

**Updated 2026-07-02 (second pass — the prebuild).** Deliverables G/H/I landed:
hub core modules + simulator (35/35 tests), the tablet walking skeleton, and
the audio sidecar with its full seam PROVEN on Linux (real Link Audio channel
discovery + sample-exact transfer + frozen APC1 bytes decoding cleanly in Node
— `sidecar-experiment/FINDINGS.md`). Phase 2 tablet work and Phase 8's scary
part are now substantially de-risked before the rig exists.

**Updated 2026-07-02 (first pass)** after a full review: `eq` role landed (arch §16 sync),
harness↔contract address drift eliminated (harnesses import Contract 2),
`duplicate_clip_to` empty-target caveat, stock monitoring/input-routing
commands + the arm-follows-record policy (arch §17), `set_volume`/`set_pan`/
`go_live`, pinned MirrorDelta grammar, and the new `engine/` deliverable.
Full detail: the CHANGELOG in `contracts/CONTRACTS.md`.

## The 8 contracts

| # | File | What | Tag |
| --- | --- | --- | --- |
| 1 | `types/ids.ts` | Stable-ID scheme (no raw indices above the resolver) | **FREEZE-NOW** |
| 2 | `types/osc.ts` | OSC vocab (down) + listener/echo events (up) | **FREEZE-NOW** (3 EXT items PROVISIONAL) |
| 3 | `types/ws.ts` | Hub ↔ tablet WebSocket protocol | **FREEZE-NOW** |
| 4 | `types/ai-tools.ts` | AI assistant tool schema | **verbs FREEZE-NOW** (3 receipts PROVISIONAL) |
| 5 | `types/audio-sidecar.ts` | Sidecar → hub PCM audio | **FREEZE-NOW** |
| 6 | `types/spectral.ts` | M4L spectral telemetry | **FREEZE-NOW** |
| 7 | `types/template.ts` | Live template structure | **FREEZE-NOW** |
| 8 | `types/command-rule.ts` | Absolute / idempotent command rule | **FREEZE-NOW** |

## Type-check everything

```bash
npm install                       # typescript + @types/node
npm run typecheck:contracts       # → 0 errors
npm run typecheck:spike
npm run typecheck:harnesses
```

---

# SUMMARY

## ✅ FROZEN NOW — build against these; they won't move

- **Contract 1 — Stable IDs.** Branded `ChainID` / `Slot` / `CellRef` / `SceneID`
  / `ParamRef` / `DeviceRole`; raw Live indices exist only inside the resolver
  and are a *compile error* anywhere above it.
- **Contract 2 — OSC (stock parts).** Ports 11000/11001, transport, clip/scene
  fire, **`duplicate_clip_to` (already exists — no extension needed)**, track
  mixer, device params, snapshot, `track_names` + `cue_points` reads, warp-marker
  + `clear_envelope` + Link-toggle (LOM-backed). Grounded in the AbletonOSC README
  and the official LOM.
- **Contract 3 — Hub↔tablet WS.** v1, three channels (state/telemetry/control),
  rev-counter + resync, WebRTC signalling relay, `TabletCommand` set with baked-in
  semantics, confirmed-echo phases.
- **Contract 4 — AI tools (verbs).** The fixed tool vocabulary; spatial-only args;
  absolute values; confirmed receipts. `load_tone` grounded by the spike below.
- **Contract 5 — Sidecar PCM.** 40-byte LE header mirroring Link Audio's Info
  block + interleaved int16; hub reslices to 10 ms for `@roamhq/wrtc`. Grounded in
  `LinkAudio.hpp` and the wrtc nonstandard-API docs.
- **Contract 6 — Spectral telemetry.** 256 bins, ~0–16 kHz, ~30 fps; frozen
  binary datagram (`SPC1`).
- **Contract 7 — Template.** Cue-point **sentinel** (`NAM_A2_TEMPLATE v1`),
  `[[tag]]` chain naming, device order amp→looper→inline_fx→spectral, Return A=
  reverb / B=delay, sends parallel & post-record-tap. Detection uses only stock
  AbletonOSC reads.
- **Contract 8 — Absolute/idempotent rule.** Every command sets a target;
  idempotent→retry, stateful→reconcile.

## 🟡 PROVISIONAL — shape usable now, one behaviour pending a named spike

| Seam | What's unproven | Closes via |
| --- | --- | --- |
| **#1 automation write** (`insert_step` / `write_movement`) | Write path **confirmed present in the Python Remote-Script Live API** our engine uses (Live 9–11; used by ClyphX) — absent only from the M4L apiref I first checked. Open item: confirm the **Live-12 / Python-3.11 signature**. | **Harness 03** |
| **#2 browser `load_item`** (`add_device`) | `load_item` exists, but load reliability + post-load readback receipt + version-varying URIs unproven. | **Harness 02** |
| **#3 looper echo** (`looper_state`) | Our custom M4L looper must echo its state back for a truthful receipt/mirror. | **Harness 04** |
| **#4 enable Link *Audio* on 12.4 via LOM** | Plain Link toggle is LOM-settable (frozen); the 12.4 Link-**Audio** enable may need a wizard step. | rig bench + Harness 01 |

Full detail + "what each spike must observe" in `reports/PROVISIONAL-SEAMS.md`.

## ▶️ RUNNABLE RIGHT NOW (no rig, no credentials)

- **TONE3000 spike** — `spikes/tone3000/`. `node --experimental-strip-types
  src/pkce.ts` self-tests the PKCE math green; the headless-flow and fetch-a2
  entry points STUB-print their plan without creds. With a publishable key +
  tone id, `fetch-a2-model.ts` fetches a real **A2** model end-to-end
  (`architecture=2`). App-registration steps + "run for real" in its README.
- **OSC codec + harness scaffolding** — all five harnesses run today, time out
  cleanly with no rig, and print exactly what to do. The OSC encode/decode
  round-trips (self-tested).
- **Type-checks** — all three TS projects compile with 0 errors under `strict`.

## 🔌 RIG-GATED (write-done, run when hardware exists)

- **Install the engine first:** `cd engine && ./install.sh` (one script; clones
  AbletonOSC if needed, registers the extension, compile-checks). Then quit +
  reopen Live. `python3 engine/test_offline.py` proves the extension's logic
  today, with no rig at all.
- **Harnesses 01–05** against the live engine (Mac + Ableton 12.4+ + AbletonOSC
  surface). Recommended order and env knobs in `harnesses/README.md`. Run **03**
  early — it confirms the Live-12 signature of the automation-write path (the last
  open question on an otherwise-confirmed capability).
- **Deferred (no Mac this session, by design):** the native Link Audio **sidecar**
  C++ build (adapt `LinkAudioHut` / `Void-LinkAudio`) and the **M4L** patches
  (custom looper + spectral tap). Contracts 5/6/7 are frozen so that work has a
  fixed target when the Mac is available.

## ⚑ Findings flagged (not silently absorbed)

1. **`duplicate_clip_to` already exists** in AbletonOSC — arch §2's "needs a minor
   extension" is out of date (positive: the hero move is stock).
2. **Correction to my first pass:** `insert_step` / `value_at_time` /
   `automation_envelope` **are** in the **Python Remote-Script Live API** our
   engine uses (confirmed Live 9–11; used by ClyphX) — **confirming** arch §10, not
   contradicting it. I originally checked the **M4L apiref**, the wrong surface,
   where they're absent. Stays PROVISIONAL only to confirm the **Live-12 /
   Python-3.11 signature**; Harness 03 does that on-rig.
3. **Enabling Link *Audio* (not plain Link) on 12.4 via LOM** is an unverified
   bench item; kept as a possible wizard step so nothing frozen depends on it.

See `reports/API-REALITY.md` for the full source-by-source audit.
