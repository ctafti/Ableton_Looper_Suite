# NAM A2 Rig — Frozen Contracts

*The plain-language spec for every seam between components. The matching
TypeScript lives in `contracts/types/` (source of truth for the Node side); the
cross-language wire formats are mirrored in `contracts/schemas/`.*

**How to read the tags**

- **FREEZE-NOW** — grounded in a real, current API we verified. Build against it;
  it should not move. (If it ever must move, that's a versioned change, not a
  surprise.)
- **PROVISIONAL** — our best current design, but one field/behaviour depends on a
  capability we could not verify off-rig. It is marked inline and listed in
  `reports/PROVISIONAL-SEAMS.md` with the exact spike that resolves it.

Every source we leaned on is audited in `reports/API-REALITY.md`.

**CHANGELOG (every change to a frozen contract lands here — added 2026-07-02
after an architecture revision failed to propagate; see rev process note in
the arch doc):**

- **2026-07-03 — amp host decision (arch rev 2026-07-03).**
  1. Contract 7: amp fixture is now our own M4L device **`NAM_A2_Amp.amxd`**
     (wrapping the MIT `neural~` external / NeuralAudio engine — A1+A2) instead
     of the Gateway VST in a rack. Gateway's model load was verified GUI-only.
  2. Contract 7: new pinned surfaces — **`AMP_PARAMS`** (Model / Rescan /
     Input Trim / Output Trim / Quality, display names verbatim),
     **`AMP_LOAD_RECEIPT_PARAM`** ('Load OK', observed not assumed), and the
     **tone manifest seam** (`ToneManifest`, `TONE_MANIFEST_FILENAME` =
     'models.json'): hub-written, **append-only** ordering with tombstones so a
     saved Model index can never silently point at a different amp.
     ToneID→index mapping lives in the hub.
  3. **No wire changes**: tone switching rides the existing stock set/get-param
     path. Contracts 1–6 and 8 untouched. Evidence in reports/API-REALITY.md.

- **2026-07-02 — sync + review fixes.**
  1. Contract 7 / Contract 1: added the **`eq` DeviceRole** and the
     amp→looper→inline_fx→**eq**→spectral order (arch rev 2026-07-01b §16 had
     locked this; it never landed here). EQ Eight is a required fixture.
  2. Contract 2: **`duplicate_clip_to` targets an EMPTY slot** (verified in the
     AbletonOSC README) — hub policy: delete-then-duplicate as one logical
     stateful command.
  3. Contract 2: added **stock** monitoring + input-routing commands
     (`current_monitoring_state`, `input_routing_type/channel` — verified
     stock in AbletonOSC source) powering the new **arm-follows-record**
     policy (Contract 7 `ARM_POLICY`, arch §17). No engine extension needed.
  4. Contract 2: added batched **`insert_steps`** (one message = one atomic
     undo), **`get/envelope`** readback, **`browser/query`**,
     **`looper/get/state`**, **`engine/ping`**.
  5. Contract 3: added **`set_volume` / `set_pan`** (mirror exposed them,
     nothing could set them), **`go_live`**; pinned the **MirrorDelta path
     grammar** (stable-ID-keyed, never positional); `TABLET_COMMAND_SEMANTICS`
     declared authoritative over the client-sent field. Contract 4 mirrors the
     three new verbs.
  6. `LooperState`/`WarpMode` converted from TS `enum` to erasable const
     objects so harnesses import the contract directly (drift now impossible);
     harness 03/04 arg shapes corrected to match the contract.
  7. New deliverable **F: `engine/`** — the Python extension implementing every
     `[EXT]` address, with installer + offline mock test.

---

## Contract 1 — Stable-ID scheme · FREEZE-NOW

**The one rule:** nothing above the resolver ever speaks raw Live indices. The
tablet and the AI say **where** in our own words — a **CellRef** (`chain` +
`slot`), a **ChainID**, a **SceneID**, or a **DeviceRole** ("the amp", "the
looper"). The **resolver** is the single place that turns those into Live track /
clip-slot / device / parameter indices, and back.

Why: Live indices shift when you add/remove tracks or devices, and parameter
order changes across device versions. If those leaked into messages, every
edit to the Set would silently break saved commands. Branding the id types in
TypeScript makes "put a raw index in a websocket message" a **compile error**,
not a runtime bug you'd have to debug by reading code.

Key types: `ChainID`, `Slot`, `CellRef {chain, slot}`, `SceneID`, `ToneID`,
`ParamRef {chain, device, param}`, `DeviceRole` (`amp | looper | inline_fx |
spectral | …`). Raw indices exist only as separately-branded types
(`LiveTrackIndex`, …) usable **only** inside the resolver and OSC layer.

---

## Contract 2 — OSC vocabulary (down) + listener/echo events (up) · mostly FREEZE-NOW

The wire between the hub and the **engine** (an extended AbletonOSC MIDI Remote
Script). Grounded in AbletonOSC's real address space (verified against its
README): engine **listens on UDP 11000**, **replies on UDP 11001**; property
listeners are change-only and armed with `/live/<obj>/start_listen/<prop>`.

**Down (commands).** Each command is tagged by origin:

- **`[OSC]` — exists verbatim in AbletonOSC today → FREEZE-NOW:** transport
  (play/stop/tempo/metronome/quantization), clip-slot fire/create/delete, clip
  fire/stop/state, **`/live/clip_slot/duplicate_clip_to`** (the hero drag — it
  **already exists**; see API-REALITY), scene fire, track mixer (vol/pan/send/
  mute/arm), device get/set parameter, view/selected-track, bulk snapshot.
- **`[EXT]` — we add to the engine; LOM-backed → tag varies:** warp-marker
  add/move/remove (**FREEZE**, official LOM), `clearEnvelope` (**FREEZE**),
  `insertStep` automation write (**PROVISIONAL** — write path confirmed in the
  Python Live API; pending Live-12 signature check, item #2),
  browser `load_item` (**PROVISIONAL** — reliability), `looperSetState`
  (**PROVISIONAL** — our M4L device), `setLinkEnabled` (**FREEZE**, LOM-settable),
  `requestSnapshot`.

**Up (events).** A discriminated union `OscUpEvent`: `engine_hello` (sent on
init so the hub learns instantly), property echoes (clip playing/recording,
fired-slot, param value), plus **PROVISIONAL** `device_load_result`,
`looper_state`, `automation_readback`.

Enums frozen here: `LooperState {Stop=0, Play=1, Record=2, Overdub=3}`,
`WarpMode` (from the LOM enum), snapshot property set.

---

## Contract 3 — Hub ↔ tablet WebSocket protocol · FREEZE-NOW

`WS_PROTOCOL_VERSION = 1`. Three channels on one socket:

- **state** — `snapshot` (full mirror), `delta` (patch), `command_status`; every
  message carries a monotonic `rev` so the tablet can detect a missed delta and
  ask for a resync. The mirror is the tablet's whole truth: it **renders states
  it's told**, it never guesses.
- **telemetry** — spectral frames + beat/clock (see Contract 6).
- **control** — `hello`, `resync_request`, `command`, and **WebRTC signalling
  relay** (`rtc_offer` / `rtc_answer` / `ice`) so the roaming audio stream can be
  negotiated over the same socket (arch §8).

A tablet command (`TabletCommand`) is one of a fixed set (fire/stop clip, launch
scene, duplicate-clip-to, set param/send/mute, looper_state, set tempo/
metronome). Each carries its **Contract-8 semantics** so hub and tablet agree on
retry behaviour without a side table. A command moves through phases
`intent → sent → queued → confirmed | failed`; **confirmed means the engine
echoed the resulting state**, not that a packet left.

---

## Contract 4 — AI assistant tool schema · verbs FREEZE-NOW (some receipts PROVISIONAL)

The voice AI can only call a **frozen, small set of tools** (`AI_TOOLS`). It
never touches Live directly and never speaks indices — arguments are CellRef /
ChainID / DeviceRole / SceneID, values are **absolute targets**.

Frozen verbs: `fire_clip`, `stop_clip`, `launch_scene`, `duplicate_clip_to`,
`set_param`, `set_send`, `set_mute`, `set_tempo`, `set_metronome`,
`looper_state`, `write_movement`, `add_device`, `load_tone`.

**Receipts describe observed state** and can come back `confirmed:false` on
timeout. Three receipts are **PROVISIONAL** and carry a `__provisional` marker:
`looper_receipt` (our M4L looper's echo is unproven — spike 04),
`movement_receipt` (write path confirmed in the Python Live API; pending only the
Live-12 signature check — spike 03), `device_add_receipt` (browser `load_item`
readback unproven — spike 02). `load_tone` the **tool** is frozen and grounded by the TONE3000 spike
(deliverable D); applying the fetched model to the amp is a rig step.

---

## Contract 5 — Audio sidecar → hub (PCM) · FREEZE-NOW

The first hop of roaming audio: a native **sidecar** joins Live's **Ableton Link
Audio** session, receives the **Main** channel, and streams raw PCM to the hub
over loopback TCP. The hub then packetises to WebRTC/Opus for the tablet.

Grounded in two real APIs: **Link Audio** delivers *interleaved 16-bit signed*
samples with an Info block (`numChannels, numFrames, sampleRate, count,
sessionBeatTime, tempo, sessionId`) — we mirror it in a **frozen 40-byte binary
header** so the sidecar forwards it losslessly. **@roamhq/wrtc** wants 10 ms
16-bit frames (480 samples/channel at 48 kHz), so the **hub reslices** the stream
to 10 ms before `onData`; the sidecar sends natural Link buffer sizes. This seam
is exactly where the **real-Link-Audio vs. virtual-device fallback** swap hides.

---

## Contract 6 — M4L spectral telemetry · FREEZE-NOW

Each chain's M4L FFT tap emits **256 linear magnitudes, ~0–16 kHz, ~30 fps**,
keyed by the chain's tag. Logical frame: `{chainTag, seq, tMs, magnitudes[256]}`
with magnitudes normalised 0..1. On the hot M4L→hub UDP hop they travel as a
**frozen little-endian binary datagram** (magic `SPC1`, 22-byte fixed header +
UTF-8 chainTag + 256×uint16); `seq` lets the tablet drop stale frames, `tMs`
lets it render jitter-aware. FFT size 4096 (~12 Hz bins at 48 k) upstream.

---

## Contract 7 — Live template structure · FREEZE-NOW

The known Set layout everything else assumes.

- **Boot sentinel:** a cue point named `NAM_A2_TEMPLATE v1`. Cue points are
  listable from **stock** AbletonOSC (`/live/song/get/cue_points`), so "is our
  template open, and is it the right version?" needs no engine extension.
- **Chain tag:** each chain track's **name** carries `[[tag]]` (e.g.
  `Clean [[chain.clean]]`), read once at load (`/live/song/get/track_names`) to
  mint the stable ChainID and to key spectral telemetry. Display text outside the
  brackets stays freely editable.
- **Per-chain device order (front→back):** `amp` (NAM rack + Gateway + chain
  selector) → `looper` (custom M4L; **records here, dry**) → `inline_fx` (the
  per-row escape hatch, **after** the looper so its tail doesn't print into the
  loop; may be empty) → `eq` (stock **EQ Eight fixture** on every chain, §16b)
  → `spectral` (FFT tap **last**, so the viz shows the **post-EQ** full chain —
  cut a peak and watch the curve flatten in the same view).
- **Physical inputs + arm-follows-record (added 2026-07-02, arch §17):** each
  chain has a baked default input (MOTU **M4**: guitar=in 1, mic=in 2,
  synth=ins 3/4). The hub keeps **at most one live chain per input** — tapping
  record or `go_live` on a chain arms+monitors it and disarms the previous
  live chain on the same input, all via **stock** AbletonOSC (arm /
  current_monitoring_state / input_routing). Tone follows attention; no
  assignment UI. Looper guard: entering looper Record/Overdub stops that
  chain's clip playback first, so clip audio never imprints into an overdub.
- **Structure hedge:** the contract describes chains by device ROLES + routing
  guarantees, not "one chain == one track". If the same-chain live-over-clip
  bench test (arch §6.9) demands it, a chain becomes a clip-track + FX-track
  summing pair in a later TEMPLATE version — a resolver/template change, not a
  contract break.
- **Returns:** Return A = **reverb**, Return B = **delay**. Send A/B are
  **parallel and downstream of the looper's record tap**, surfaced as params, so
  overdubs stay dry at any send level. Per-clip reverb/delay movement is done by
  automating the **send level**, never the return device (different track →
  unreachable by a clip envelope; arch §10 routing constraint).

---

## Contract 8 — Absolute / idempotent command rule · FREEZE-NOW

**Every command sets a target state; none nudges.** "Set gain to 0.4", never
"turn it up". Two mutation classes drive retry behaviour:

- **idempotent** (absolute set / fire a specific slot) → safe to blind-retry
  (max attempts 3). A dropped UDP packet just gets re-sent.
- **stateful** (creates/duplicates a clip, inserts a device, writes an envelope)
  → **reconcile then decide**: never blind-retry, read state back and act on the
  truth.

Because commands are absolute, the confirmed-echo model (Contract 12 /
`command_status`) is enough — no transactional ACK protocol needed. `assertAbsolute`
guards this at the type level; `TABLET_COMMAND_SEMANTICS` and each `AI_TOOLS`
entry carry the class so every layer agrees.

---

*Findings against the source docs (e.g. `duplicate_clip_to` already exists; and a
**correction to my own first pass** — `insert_step`/`value_at_time` **are** in the
Python Remote-Script Live API our engine uses, confirming arch §10; they're absent
only from the M4L apiref I initially checked, leaving just a Live-12 signature
check) are documented in `reports/API-REALITY.md` rather than silently absorbed.*
