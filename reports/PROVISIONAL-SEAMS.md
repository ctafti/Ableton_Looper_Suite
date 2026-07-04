# Provisional Seams (Deliverable C)

*Every contract item that is NOT frozen, why it's uncertain, which spike resolves
it, and exactly what that spike must observe to close it. When a seam closes,
move its item to FREEZE-NOW in the contract and delete it here.*

Each seam is designed so the **shape** is already usable — code can compile and
run against it today — and only a specific behaviour is pending. The frozen parts
around each seam do not move when it resolves.

---

## Seam 1 — Automation WRITE (`insert_step` / `write_movement`) — ✅ CLOSED (rig 2026-07-04)

> **CLOSED on the Live 12.4.2 rig (spike 03).** All four required observations
> met: envelope obtained for a continuous param, multi-point ramp written
> (clear-before-write), read back matching (`0,0,0,1,0.5,0,1.5,0,2.5,1,3.5,1` =
> 4 points, ramp correct), and **one Cmd-Z reverted the whole write** (atomic
> undo confirmed). The Live-12 / Python-3.11 signature holds — no fallback to
> clip-based movement needed. **→ Move `DOWN.insertStep` to FREEZE-NOW in
> Contract 2 and drop `__provisional` from `MovementReceipt`.**
>
> **Precondition finding (record, don't hide):** the engine handlers throw
> `Index out of range` — and the readback returns 0 points — when the target
> `track/clip/device/param` doesn't resolve (empty clip slot, no device at the
> given index, or a non-continuous param). This is the "honest failure tuple"
> design working, not a flake: a first cold run failed this way
> (`Log.txt` 16:14: `clear_envelope` / `insert_steps` / `get/envelope` all
> `Index out of range`), then passed once a valid device/param existed on
> track 0. The exact device state at the failing moment could not be
> reconstructed, so we record the *failure mode* (write requires an existing
> continuous param at the addressed index) rather than a precise root cause.
> **Actionable:** callers must resolve a real continuous param before writing;
> treat `Index out of range` as "bad target," not "automation broken."

- **Where:** Contract 2 `DOWN.insertStep` (`[EXT]`); Contract 4 `write_movement`
  + `MovementReceipt.__provisional`; the `automation_readback` up-event.
- **What's uncertain (narrowed):** the write primitives `insert_step` /
  `value_at_time` **exist in the Python Remote-Script Live API our engine uses** —
  confirmed present across Live 9–11 in the API dumps and used by ClyphX (see
  API-REALITY item #2; the earlier "not in the LOM / needs `.pyc` hacks" concern
  was an M4L-surface mistake and does **not** apply here). The **only** open item
  is confirming the **signature still holds on Live 12's Python-3.11 runtime**
  (Live 12 changed the Remote-Script Python from 3.7 → 3.11; the API surface is
  preserved in bytecode but I have no direct Live-12 dump of this class). So this
  is a **signature check**, not an existence question.
- **Resolved by:** **spike 03** (`harnesses/src/03-insert-step-automation.ts`,
  arch §10) — which now has a real counterparty: the shipped **engine
  extension** (`engine/extension.py`) implements `insert_steps` / `get/envelope`
  and passed the offline mock test, so the rig run is a pure Live-12 behaviour
  check, not a write-code-first task.
- **Spike must observe:**
  1. From the Remote Script on **Live 12.x**, obtain the clip's automation
     envelope for a **continuous** device parameter on the clip's OWN track
     (via `Clip.automation_envelope` / `create_automation_envelope`).
  2. Call `insert_step` to write a known multi-point shape (clear-before-write;
     wrap as one atomic undo) — i.e. confirm the **Live-12 signature** matches the
     documented `(AutomationEnvelope, float, float, float) → None`.
  3. **Read the envelope back** (`value_at_time`) and confirm the points match
     within tolerance (this readback is the `MovementReceipt`).
  4. Confirm one Cmd-Z reverts the whole write.
- **If the Live-12 signature differs / fails:** fall back to **clip-based
  movement** (pre-baked automation clips / parameter-lane clips) and re-shape
  `write_movement` accordingly. The tool VERB stays; only the receipt/mechanism
  changes. (This fallback is now a low-probability contingency, not the expected
  outcome.)

---

## Seam 2 — Browser `load_item` reliability + readback (`add_device`) — ✅ CLOSED (rig 2026-07-04)

> **CLOSED on the Live 12.4.2 rig (spike 02).** Full flow verified end to end:
> `/live/browser/rescan` built an index of **15,739 loadable items**
> (`Log.txt`: "engine: browser index built (15739 loadable items)");
> `/live/browser/query` for "Reverb" returned a **flat `[name, uri, name,
> uri, …]` reply** with URIs in `query:AudioFx#…` form; loading
> `query:AudioFx#Reverb` onto track 0 moved the device count **1 → 2
> (delta === 1)** = exactly one new device. Failure is detectable too (an
> earlier load of the literal placeholder `<uri>` correctly reported delta 0).
> **→ Move `DOWN.browserLoadItem` + `browserRescan` to FREEZE-NOW in Contract 2
> and drop `__provisional` from `DeviceAddReceipt`.**
>
> **Rig notes for the boot index (Phase 1):** (a) URIs are version-specific — the
> rescan→query→URI path is the sanctioned way to get one; never hard-code.
> (b) The query reply is flat name/URI pairs; the bare device is
> `query:AudioFx#Reverb`, while `.adg` entries are Audio-Effect-Rack presets
> (may expand to != 1 device — prefer bare devices for single-device loads).
> (c) `rescan` reply carries the item count as its single arg (15739).
> (d) This is the same mechanism Part 8's "next session / boot scan" depends on
> — now proven.

- **Where:** Contract 2 `DOWN.browserLoadItem` (`[EXT]`) + `browserRescan`;
  Contract 4 `add_device` + `DeviceAddReceipt.__provisional`; the
  `device_load_result` up-event.
- **What's uncertain:** `Browser.load_item` **is** confirmed in the
  control-surface API, but (a) browser **URIs vary by Live version** (so we index
  at boot, never hard-code), and (b) load reliability + the **post-load device
  readback** that forms the receipt are unproven. Arch §11 marks this
  "Verify load reliability."
- **Resolved by:** **spike 02** (`harnesses/src/02-load-item-verify.ts`,
  arch §6.7/§11).
- **Spike must observe:**
  1. Index `Application.browser` at boot → name→item map (with `uri`).
  2. Snapshot the target track's device list **before**.
  3. `browser.load_item(item)` onto the selected track.
  4. Re-read the device list and **diff**; success = exactly one new device whose
     class/name matches the resolved item (this diff is the receipt).
  5. Confirm a **failed/mismatched** load is detectable (so the AI knows it
     failed instead of lying), and confirm the boot-indexed URIs still resolve.
- **If it fails/flaky:** restrict `add_device` to a verified subset (stock
  devices), keep the load-and-verify receipt, and surface unreliable items as
  "not confirmable."

---

## Seam 3 — Custom looper state echo (`looper_state`)

- **Where:** Contract 2 `DOWN.looperSetState` (`[EXT]`) + the `looper_state`
  up-event; Contract 4 `looper_state` + `LooperReceipt.__provisional`;
  Contract 3 `LooperMirror.state`.
- **What's uncertain:** the looper is **our own custom M4L device** (arch §15,
  built because native Looper's State is flaky to WRITE). Setting state is
  designed to be clean; the open item is that the device **echoes its current
  state back** over Contract 2 so the receipt/mirror are truthful. Until the
  device exists and is on a rig, the echo is `ASSUMED`.
- **Resolved by:** **spike 04**
  (`harnesses/src/04-looper-state-roundtrip.ts`, arch §6.3).
- **Spike must observe:**
  1. Send each absolute state (Stop/Play/Record/Overdub) to the M4L looper.
  2. The device reports its resulting state back (property listener or explicit
     reply) within window W.
  3. The reported state matches the commanded state (absolute → idempotent
     re-send is safe).
- **If it fails:** add an explicit state-report outlet to the M4L patch (we own
  it), then re-run. The enum + verb stay frozen.
- **Rig note (2026-07-04, still OPEN):** spike 04 ran against a rig with no M4L
  looper present (as expected — the device isn't built). Harness output was
  "no echoes / add a state outlet," which is the correct *conclusion*, but
  `Log.txt` shows `find_state_param` (extension.py:343) / `looper_set_state`
  (:352) / `looper_get_state` (:362) **raising exceptions** each call rather
  than returning a clean honest-failure tuple. Seam status is unchanged (needs
  the device), but when the M4L looper is built, also make `find_state_param`
  return an honest `(ok=0, reason)` when no 'State' param exists instead of
  throwing — so absence is reported, not crashed.

---

## Seam 4 — Enable **Link Audio** on Live 12.4 via LOM — ◐ PARTIALLY CLOSED (rig 2026-07-04)

> **Enable mechanism resolved (rig, Live 12.4.2); latency-as-a-LOM-property still
> open.** Link Audio enable is a **clean Settings toggle**, NOT a hidden wizard
> step: Settings → **Link** → *Link Audio* → **Audio: On**, with a **Name** field
> (the peer/session name) and a **Latency** field (observed **100 ms**). Plain
> **Link** must also be ON (its transport-bar toggle is shown via
> Settings → Link → *Show Link Toggle: Show*). So the "wizard step vs LOM
> property" question resolves toward **either works** — a human toggle is trivial,
> and if a LOM property is wanted later it's a nicety, not a blocker.
>
> **PROVEN end-to-end (spike via `sidecar/main.cpp` → `verify-apc1.ts`):** with
> Link + Link Audio on and Live's Main published, real guitar audio streamed
> **Live → C++ sidecar → APC1 bytes → Node decoder** cleanly: **7,152 packets,
> `headerBad=0`, `seqSkips=0`**, 48 kHz stereo. Contract 5's receive path is real
> on the Mac.
>
> **⚠ SAMPLE-RATE FINDING (important, affects §6.1 too):** the rig MUST run at
> **48 kHz**. Live defaulted to **44.1 kHz**, and every packet failed the
> verifier's `sampleRate === 48000` header check (`headerBad=7393`) — the sidecar
> forwarded honestly, the verifier rejected honestly; the mismatch was Live's
> audio setting. Setting Live → Settings → **Audio → Sample Rate → 48000** flipped
> it to a clean PASS. **→ The boot/wizard should assert `sampleRate === 48000` and
> warn otherwise** (also protects the amp host / `neural~` resampler per §6.1).
>
> **Still open:** the end-to-end Link-Audio→hub **latency number** (feeds §8
> visual-clock offset). The Settings **Latency** field reads 100 ms, but the true
> end-to-end (capture → decode) figure still wants a direct measurement.
>
> **Guide corrections (FIRST-MAC-SESSION §6.5):** (a) Live's published channel is
> **`Main`** (capital M) — the sidecar default pattern "main" matches it, but the
> guide's implied name was off; (b) the sidecar needs **`NAM_HUB_PORT=9701`** to
> reach `verify-apc1.ts` (verifier default 9701; sidecar default 47615 — they
> don't meet otherwise); (c) the §6.5 test pairs **`main.cpp` → `verify-apc1.ts`**
> (header-check on real audio), NOT the probe (`nam_a2_probe.cpp`, a separate
> synthetic-ramp self-test). Full run that passed:
> `NAM_CHANNEL=Main NAM_HUB_PORT=9701 ./build/nam_a2_sidecar` +
> `node --experimental-strip-types sidecar-experiment/verify-apc1.ts` + play audio.

- **Where:** Contract 2 `DOWN.setLinkEnabled` (`[EXT]`, FREEZE for the **Link**
  toggle) — the **Link Audio** enable specifically is the pending bit.
- **What's uncertain:** `Song.is_ableton_link_enabled` (plain Link) is
  LOM-settable and frozen. Enabling **Link Audio** (the audio-streaming feature,
  new in 12.4, arch §14) may not have a clean LOM property; arch §14 lists the
  "12.4 Link-Audio-enable property" + end-to-end latency as the only remaining
  bench items. Also: the LOM Link toggle only works if Live's Link transport-bar
  control is visible.
- **Resolved by:** rig bench check during the audio-bridge bring-up (deferred —
  no Mac this session), plus **spike 01**'s latency measurement once audio flows.
- **Spike/bench must observe:**
  1. Whether Link Audio can be enabled programmatically, or must be a **wizard
     step** ("enable Link + Link Audio in Live", detected by the hub receiving
     Main) per arch §12/§264.
  2. End-to-end Link-Audio→hub latency (feeds the §8 visual-clock offset).
- **If no LOM property exists:** keep it as a detected wizard step (the wizard
  "never proceeds on faith"); nothing in the frozen contracts depends on
  programmatic enable.

---

## Not a seam, but decide-by-feel at first bench (added 2026-07-02)

- **Same-chain live-over-clip (arch §6 item 9 / §17).** On one Ableton track,
  monitoring live input and hearing a clip play back are mutually exclusive. v1
  accepts this (going live on a chain ducks its playing clip; the ↻ looper
  covers same-tone layering). **Bench test:** play a clip on a chain, go live
  on that chain, judge whether the duck-out bothers you in practice. If it
  does → the chain becomes a clip-track + FX-track **summing pair** in a
  template revision (Contract 7's structure hedge exists precisely so this is
  a template version bump, not a contract break).
- **Monitoring-mode nuance:** the exact `current_monitoring_state` per state
  (In vs Auto) for the arm-follows-record policy is a bench pick, not frozen.

## Not a seam, but verify at first boot

- **Template device identities (Contract 7).** The exact device class/name
  strings the resolver matches per role are set when you build the `.als`. Not a
  spike — a **boot scan** against the real Set confirms the role→device mapping.
- **Link-Audio vs virtual-device fallback (Contract 5).** Both sit behind the
  frozen PCM seam; which one ships is a build decision, not a contract change.


---

## ADDENDUM 2026-07-03 — new/changed provisional items

- **CLOSED (moot):** "Gateway chain-selector is OSC-addressable" (old §6.1) —
  plan replaced by the M4L amp host (arch rev 2026-07-03).
- **NEW (rig, §6.1):** `neural~` builds on the Mac and its message/outlet API
  behaves as documented.
- **NEW (rig, §6.1):** model-swap click test under sustain (`prewarm` + our
  output crossfade).
- **NEW (rig, §6.1):** A2-Full CPU per instance × 4 chains at 128 samples on
  the M4 — expected trivially fine per TONE3000's published A2 numbers, but
  measure, don't trust.

---

## ADDENDUM 2026-07-04 — FIRST RIG SESSION results (harness gauntlet)

First run of the harness gauntlet against a real rig (Live **12.4.2**, engine
extension installed, AbletonOSC surface selected). Two seams closed, one gained
a fix-later note, one untouched.

- **Seam 1 (automation write): ✅ CLOSED.** spike 03 passed structurally + atomic
  Cmd-Z confirmed. See banner above. Precondition finding recorded (`Index out
  of range` on unresolved target). → Contract 2 `insertStep` to FREEZE.
- **Seam 2 (browser load): ✅ CLOSED.** spike 02 passed (15,739-item index,
  `query:AudioFx#Reverb` → delta 1). See banner above. → Contract 2
  `browserLoadItem` + `browserRescan` to FREEZE.
- **Seam 3 (looper state): OPEN, unchanged.** M4L looper not built yet. Added a
  note: `find_state_param` throws instead of returning an honest failure tuple
  when no 'State' param exists — fix when the device is built.
- **Seam 4 (Link Audio enable): OPEN, unchanged.** Audio-bridge bring-up
  deferred; not exercised this session.
- **Confirmation primitive (arch §12): proven.** spike 05 confirmed in ~77 ms —
  but ONLY once a real clip existed in the fired slot; an empty slot yields no
  echo and a false timeout. The confirm pattern needs a real target to confirm
  against. (Not a seam; recorded for the harness authors.)

See `reports/API-REALITY.md` → "RIG RESULTS 2026-07-04" for latency numbers, the
custom-extension-alive proof, and guide-vs-reality corrections.
