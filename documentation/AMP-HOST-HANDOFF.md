# HANDOFF BRIEF — build `NAM_A2_Amp.amxd` (the NAM A2 amp host)

**You are building a Max for Live device from scratch.** This brief is
self-contained. Read it fully before writing anything. The person handing this
to you has a working Mac rig (Ableton Live 12.4.2 Suite, Max for Live bundled),
a compiled/loadable `neural~` external, and a real A2 model file staged. Your
job is the `.amxd` wrapper that turns `neural~` into a contract-compliant,
AI-controllable amp.

---

## 0. Golden rule (inherited from this project)

When something you build disagrees with what this brief predicts, that is
**DATA, not failure.** Record it in `reports/API-REALITY.md` under a "RIG
RESULTS" heading and keep going. This project freezes contracts against reality;
every mismatch found is the point, not a setback. Do NOT silently "fix" a
mismatch by reshaping the contract — surface it.

## 1. What this device is, in one paragraph

`NAM_A2_Amp.amxd` is a Max for Live **audio-effect** device that hosts one
`neural~` object (which runs a NAM A2 amp capture). It sits on a guitar track as
the amp. The hub/AI controls it **only** through a small, frozen set of named
parameters (below) reachable via Ableton's stock OSC param path — the hub never
talks to `neural~` directly. The device's job: expose those params, translate
`Model` changes into `neural~` `load <path>` messages, and report back whether
the load actually succeeded (observed truth, never assumed).

## 2. THE PARAMETER CONTRACT (frozen — use these display names VERBATIM)

From `contracts/types/template.ts` (`AMP_PARAMS`). The Max device's parameter
**Long Name / display names must match these exactly** — the hub sets/gets by
these strings over stock Live OSC. Do not rename, abbreviate, or re-case.

| Param display name | Type | Range/units | Meaning |
|---|---|---|---|
| `Model` | int (quantized) | 0..N-1 | Index into the tone manifest. THE tone knob. On change → load that model. |
| `Rescan` | int (quantized) | 0/1 toggle | On ANY change, re-read `models.json`. |
| `Input Trim` | float | dB (e.g. -24..+24) | Input gain trim before `neural~`. |
| `Output Trim` | float | dB (e.g. -24..+24) | Output gain trim after `neural~`. |
| `Quality` | float | 0..1 | NeuralAudio A2 quality scaling (1 = A2-Full). Per-chain CPU knob. |
| `Load OK` | int (quantized) | 0/1 | **Device SETS this** after a load attempt: 1 = `neural~` reported `loaded`, 0 = `error`. Hub READS it as the receipt. |

`Load OK` is the receipt mechanism — see §4. It is the difference between the AI
knowing a tone loaded vs. assuming it. Non-negotiable.

## 3. THE MODELS FOLDER + MANIFEST (Contract 7)

- A **models folder** contains `models.json` + the model files.
- `models.json` shape (`ToneManifest` in `template.ts`):
  ```json
  { "version": 1,
    "entries": [ { "index": 0, "file": "651635.model", "name": "...", "toneId": 651635 } ] }
  ```
- **Append-only**: an entry's `index` NEVER changes once assigned. Deletions
  tombstone (`"file": null`), they don't reindex. A saved `Model` value must
  never silently point at a different amp.
- The device maps `Model` int → manifest `index` → `file` (path **relative to
  the manifest folder**) → absolute path → `neural~ load <abspath>`.
- The hub owns ToneID→index; the **device only maps index→file**. Don't put
  ToneID logic in the device.
- On `Rescan` change: re-read `models.json` from disk (picks up hub-added
  entries) without reloading the current model.

**Where the folder lives:** staged at `~/Aibleton/Aibleton/models/` for this
build. The device needs a way to know that path — simplest is a device attribute
/ a `patcherargs` / a saved path; decide and document it. (A Live-friendly option
is to resolve it relative to the Live set or an absolute configured path. Note
what you chose in the brief-back.)

## 4. THE LOAD RECEIPT PATH (the important flow — arch §10/§15, template.ts:311)

This exact sequence is frozen:

```
hub sets `Model` param (int)
   → device reads manifest[index].file, builds abs path
   → device sends `load <abspath>` to neural~
   → neural~ answers on its info outlet: `loaded <path>`  OR  `error <msg>`
   → device mirrors that into the `Load OK` param: 1 for loaded, 0 for error
   → hub reads `Load OK` back = the receipt
```

Loaded truth is **OBSERVED via neural~'s info outlet, never assumed** from the
fact that you sent `load`. Wire the info outlet → parse `loaded`/`error` →
set `Load OK`. If `neural~`'s actual outlet vocabulary differs from
`loaded`/`error` (verify against the running object!), record the real strings in
`API-REALITY.md` and adapt — the *param* stays frozen, only your parser changes.

## 5. THE MODEL-SWAP CLICK MITIGATION (arch §6.1, the swap-click hazard)

Naive model switching bursts white noise (documented hazard: NeuralAudio can
switch to an uninitialized sub-model mid-stream). Mitigation you must implement:
- On a `Model` change, **`prewarm`** the new model before it goes live
  (neural~ supports a `prewarm` message — verify), AND
- Apply a **short output crossfade** you own in the patch (e.g. a fast line~
  ramp on the output gain: duck → swap → un-duck over ~5–20 ms). The crossfade
  is YOURS, not neural~'s.
- The **model-swap click test**: load model A, play a sustained note, swap to
  model B mid-sustain, listen for a click/noise burst. Pass = no audible burst.
  This is the acceptance test for the device. Record the result.

## 6. AUDIO PATH INSIDE THE DEVICE

```
[audio in] → [Input Trim gain] → [neural~ (Quality attr)] → [Output Trim gain] → [output crossfade] → [audio out]
```
- `neural~` runs the capture. Feed `Quality` to whatever attribute/message
  NeuralAudio exposes for A2 quality scaling (verify the exact attr name against
  the object; the concept is 0..1).
- Run Live at **48 kHz** (the rig standard — see the sample-rate finding in
  API-REALITY). At 48k, neural~'s resampler (AudioDSPTools) shouldn't engage for
  48k captures, minimizing latency. If the capture is a different rate, neural~
  resamples and reports `latency` on its info outlet — surface that if useful.

## 7. BUILD ORDER (suggested)

> **Authoring method — your choice, and it doesn't block you.** You can
> hand-author this `.amxd` in the Max editor (the default, fully viable — the
> foundation is proven: `neural~` loads a real model), OR generate it via the
> device-generation pipeline (`reports/handoff/AI-DEVICE-GENERATION.md`,
> `js2max`/`py2max`). **Only use the pipeline if it has passed its own step-0
> verification** (a generated device that loads + exposes a param + passes
> signal in this Live 12.4.2). If the pipeline isn't proven yet, hand-author —
> do NOT block the amp on an unverified generator. Either way the RESULT is the
> same contract-compliant device; this brief defines that result.

1. **Bare patcher smoke test**: `neural~` instantiates, `load <abspath>` of the
   staged model → info outlet says `loaded`. (If not done already — this proves
   the external before you wrap it.)
2. **M4L skeleton**: new Audio Effect (`.amxd`), add the 6 params with EXACT
   names (§2), no logic. Confirm each appears in Live and is OSC-reachable
   (the hub reads/writes by name).
3. **Audio path** (§6): trims + neural~ + output gain, audio passes through.
4. **Manifest + load** (§3/§4): `Model` change → manifest lookup → `load` →
   parse info outlet → set `Load OK`. Test with the 1-entry manifest.
5. **Swap mitigation** (§5): prewarm + crossfade; run the swap-click test.
6. **Rescan**: `Rescan` toggle re-reads `models.json`.
7. **Brief-back**: write what you built, every place reality differed from this
   brief, and the swap-click result, into `API-REALITY.md`.

## 8. HARD CONSTRAINTS (do not violate)

- Param display names EXACTLY as §2. The hub matches by string.
- `Load OK` reflects OBSERVED load result only.
- Manifest indices are append-only; device maps index→file only.
- Don't make the device reach the network or TONE3000 — it loads local files.
- Don't add params outside the frozen set without flagging them
  `__provisional` and recording them (they won't be in the contract).
- 48 kHz assumed.

## 9. WHAT TO VERIFY AGAINST REALITY (don't trust this brief blindly)

> **UPDATE 2026-07-04 — several of these are now RIG-VERIFIED** (neural~ built +
> loaded a real A2 model in Max 9 on the target Mac). Confirmed:
> - message `load <path>` works; **the file must be `.nam`** (the TONE3000 fetch
>   saves `.model` — you MUST copy/rename to `.nam`, e.g.
>   `cp 651635.model 651635.nam`; `.model` is not recognized).
> - info-outlet vocabulary CONFIRMED: `loaded <path>`, `latency <ms>`,
>   `loudness <dB>`, plus `queued <path>`, `cleared`, `error <message>`, and
>   `bang`→status. So the `Load OK` parser keys on `loaded` (→1) vs `error` (→0);
>   treat `queued` as "not yet loaded, wait for `loaded`".
> - at 48 kHz host rate with a 48k model, `latency` reports 0 (resampler idle).
> - `prewarm` is **NAM-only** (per neural~ README) — guard it for NAM models.
> - the `.mxo` installs to `~/Documents/Max 9/Packages/neural/externals/` and
>   needs ad-hoc codesign on Apple Silicon (both done this session).
>
> STILL to verify by the building AI:
> - the `Quality` attribute/message name on neural~ for A2 0..1 scaling.
> - whether neural~ exposes A2 quality as an attribute vs a message.

These are the things this brief states but that YOU must confirm against the
actual `neural~` object + NeuralAudio, recording any difference:
- ~~`neural~` message names~~ VERIFIED: `load` / `clear` / `prewarm` (NAM-only) / `bang`.
- ~~info-outlet vocabulary~~ VERIFIED (see update box above).
- the `Quality` attribute/message name on neural~ for A2 scaling (verify)
- ~~whether neural~ accepts `.model` or needs `.nam`~~ VERIFIED: needs `.nam`.
- Max version Library path for the `.mxo` — VERIFIED Max **9**.
- ~~Apple-Silicon codesign requirement~~ VERIFIED: yes, done.

## 10. FILES YOU'RE BEING GIVEN (and why)

- `AMP-HOST-HANDOFF.md` — this brief.
- `CODEBASE_ANALYSIS.xml` — full repo overview; grep it for `AMP_PARAMS`,
  `ToneManifest`, `template.ts`, arch §6.1/§10/§15 context.
- `template.ts` (contracts/types) — the AUTHORITATIVE param + manifest source.
  If this brief and `template.ts` ever disagree, **`template.ts` wins.**
- (Optional) `API-REALITY.md` + `PROVISIONAL-SEAMS.md` — the running findings
  log; read the 2026-07-03 "Amp host audit" section (neural~ / NeuralAudio /
  swap-click hazard research) and the 2026-07-04 sample-rate finding.

## 11. DEFINITION OF DONE

`NAM_A2_Amp.amxd` on a track: the 6 params exist with exact names and are
OSC-reachable; setting `Model` loads the mapped capture and `Load OK` reflects
the real result; audio passes through with `Input/Output Trim` + `Quality`
working; a mid-sustain model swap produces no audible click; `Rescan` re-reads
the manifest. Brief-back written into `API-REALITY.md`, including every
reality-vs-brief difference and the swap-click test result.
