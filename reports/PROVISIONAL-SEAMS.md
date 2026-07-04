# Provisional Seams (Deliverable C)

*Every contract item that is NOT frozen, why it's uncertain, which spike resolves
it, and exactly what that spike must observe to close it. When a seam closes,
move its item to FREEZE-NOW in the contract and delete it here.*

Each seam is designed so the **shape** is already usable — code can compile and
run against it today — and only a specific behaviour is pending. The frozen parts
around each seam do not move when it resolves.

---

## Seam 1 — Automation WRITE (`insert_step` / `write_movement`)

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

## Seam 2 — Browser `load_item` reliability + readback (`add_device`)

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

---

## Seam 4 — Enable **Link Audio** on Live 12.4 via LOM

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
