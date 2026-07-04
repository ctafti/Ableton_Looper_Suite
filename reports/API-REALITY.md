# API Reality Report (Deliverable B)

*What each contract is grounded in, what could NOT be verified off-rig (marked
`ASSUMED`), and which spike or doc confirms each. Research performed 2026-07-01.*

**Prime-directive note:** contracts were frozen against real, current external
APIs. Where a field could not be verified against a source, it is produced but
tagged `ASSUMED — verify against <source>` and echoed into
`reports/PROVISIONAL-SEAMS.md`.

---

## ⚑ Three items to note — read first

*(#1 and #3 are discrepancies against the source docs; **#2 is a correction to my
own earlier analysis** — it now largely **confirms** arch §10 rather than
contradicting it, once the right API surface is checked.)*

1. **`duplicate_clip_to` ALREADY EXISTS (positive).** Arch §2 assumed the
   drag-clip-to-chain hero move needs a "minor extension" to AbletonOSC. It does
   not: `/live/clip_slot/duplicate_clip_to (track, clip, target_track,
   target_clip)` is in AbletonOSC's current address space verbatim. Contract 2
   marks it `[OSC]` FREEZE-NOW; no extension required. *Source: AbletonOSC
   README.*

2. **Automation-write primitives: absent from the *M4L apiref*, but present in
   the *Python Remote-Script Live API* our engine uses (corrected).** Arch §10
   calls `Clip.automation_envelope()`, `insert_step`, and `value_at_time`
   "verified, stable." **My first pass checked the wrong API surface.** I checked
   the **Max-for-Live JS-LOM apiref** (docs.cycling74.com/apiref/lom/), where the
   `Clip` class shows the read/clear side (`automation_envelope` for reading,
   `clear_envelope` / `clear_all_envelopes` / `has_envelopes`) but **not** the
   write primitives — so I wrongly concluded they were unavailable. Our engine is
   **not** Max for Live; it is a **Python control-surface Remote Script**
   (AbletonOSC-style), which imports and calls the `Live` module directly and has
   the fuller **Python Live API** surface. In that surface, `AutomationEnvelope`
   ("Describes parameter automation per clip") with **`insert_step((Automation
   Envelope),(float),(float),(float)) → None`**, **`value_at_time((Automation
   Envelope),(float)) → float`**, and **`Clip.automation_envelope((Clip),
   (DeviceParameter)) → AutomationEnvelope`** are **real, long-standing methods** —
   verified in the "API_MakeDoc"/Hanz Petrov Python-API dumps (via
   `NSUSpray/Live_API_Doc`) across Live **9.1, 9.5, 9.7, 10.1, and into 11.0**
   (Live 10+ also adds `create_automation_envelope`), and used by Python Remote
   Scripts such as **ClyphX**. The `LomTypes.pyc` / `MxDCore.pyc` patching lore I
   originally cited is a **Max-for-Live JS-LOM whitelist** limitation (`_MxDCore`
   is literally the M4L core module); it does **not** apply to a Python Remote
   Script. So arch §10's "verified, stable" is essentially right **for our
   surface**. **Remaining unknown → still PROVISIONAL:** Live 12 moved the Remote-
   Script runtime to **Python 3.11** (from 3.7 in Live 11), which broke clean
   decompilation though the API surface is preserved in bytecode; I did not find a
   direct Live-12 dump of this class. So Contract 2's `insertStep` / Contract 4's
   `write_movement` stay PROVISIONAL only to **confirm the Live-12 signature holds
   on the 3.11 runtime** — that on-rig check is **spike 03**. (Sources:
   `NSUSpray/Live_API_Doc` version dumps; `structure-void.com/ableton-live-midi-
   remote-scripts` on the Live 11→12 Python change; Ableton forum confirming
   ClyphX use.)

3. **Link-Audio-enable via LOM on Live 12.4 is a bench item (`ASSUMED`).**
   `Song.is_ableton_link_enabled` is LOM-settable (confirmed), and arch §14 says
   Link-enable is LOM-settable — but the doc itself flags the **12.4
   Link-Audio-enable property** and end-to-end latency as the only remaining
   bench items. Contract 2's `setLinkEnabled` is FREEZE for the **Link** toggle;
   enabling **Link Audio** specifically on 12.4 is `ASSUMED — verify on rig`
   (caveat: the LOM Link toggle only works if Live's Link transport-bar control
   is visible).

---

## Addendum — 2026-07-02 review verifications

- **`duplicate_clip_to` re-verified, with a caveat:** the AbletonOSC README
  describes it as duplicating **to an EMPTY target clip slot**. The hero drag
  will hit occupied targets → hub policy is delete-then-duplicate as one
  logical stateful command (Contract 2 caveat note).
- **Monitoring + input routing are STOCK (verified in AbletonOSC `track.py`):**
  `current_monitoring_state` is a normal rw property
  (`/live/track/set/current_monitoring_state`, 0=In 1=Auto 2=Off), and input
  routing is settable **by display name** via
  `/live/track/set/input_routing_type` / `input_routing_channel`, with
  `available_input_routing_types/channels` getters. This makes the whole
  arm-follows-record policy (arch §17) FREEZE-NOW with **zero** engine
  extension.
- **Handler/reply conventions (verified in `osc_server.py` / `handler.py`):** a
  callback returning a tuple auto-replies on the SAME address to the sender's
  host on port 11001 — the convention `engine/extension.py` and the harness
  `waitFor` predicates are built on.

## Per-contract grounding

### Contract 1 — Stable-ID scheme
- **Source:** internal design; no external API. Branded-type technique is
  standard TypeScript.
- **ASSUMED:** none (this is our abstraction).
- **Confirmed by:** compiles under `strict` + `noUnusedLocals` (tsc clean).

### Contract 2 — OSC vocabulary + echoes
- **Source:** AbletonOSC README (github.com/ideoforms/AbletonOSC), fetched.
  Ports 11000/11001, listener model, and the `[OSC]` address list are verbatim.
- **`[OSC]` FREEZE-NOW (verified present):** song transport/tempo/metronome/
  quantization; `clip_slot` fire/create/delete/`duplicate_clip_to`; `clip`
  fire/stop/is_playing/is_recording/is_overdubbing/warp_mode; `scene/fire`;
  track vol/pan/send/mute/arm + listeners (`playing_slot_index`,
  `fired_slot_index`); device get/set parameter + parameter listener;
  view/selected_track; `/live/song/get/track_data` bulk snapshot;
  `/live/song/get/track_names`, `/live/song/get/cue_points`,
  `/live/song/get/num_tracks|num_scenes`.
- **`[EXT]` LOM-backed FREEZE:** warp-marker add/move/remove
  (`Clip.add_warp_marker` / `move_warp_marker` / `remove_warp_marker` — official
  LOM), `clearEnvelope` (`Clip.clear_envelope` — official LOM), `setLinkEnabled`
  (`Song.is_ableton_link_enabled` — official LOM).
- **`[EXT]` ASSUMED / PROVISIONAL:** `insertStep` (automation write —
  `AutomationEnvelope.insert_step` / `value_at_time` are **confirmed present in
  the Python Remote-Script Live API** across Live 9–11 per the API dumps; still
  PROVISIONAL only to confirm the **Live-12 / Python-3.11 signature** on-rig — see
  item #2 + spike 03); `browserLoadItem` (`Browser.load_item` **is**
  confirmed in the control-surface API, but URIs vary by Live version and
  load reliability is unproven — spike 02); `looperSetState` (our M4L device —
  spike 04); the corresponding up-events `automation_readback`,
  `device_load_result`, `looper_state`.
- **Confirmed by:** AbletonOSC README (present list); LOM apiref (EXT LOM basis);
  spikes 02/03/04 for the PROVISIONAL items.

### Contract 3 — Hub↔tablet WS protocol
- **Source:** internal protocol; no external API to verify. WebRTC signalling
  fields align with standard offer/answer/ICE relay.
- **ASSUMED:** none external. The mirror/rev/resync design is ours.
- **Confirmed by:** tsc clean; wire mirror in `schemas/ws-state.schema.json` +
  `schemas/ws-telemetry.schema.json`.

### Contract 4 — AI tool schema
- **Source:** maps 1:1 onto Contract 2/3 (so it inherits their grounding) +
  the TONE3000 spike for `load_tone`.
- **ASSUMED / PROVISIONAL receipts:** `looper_receipt` (spike 04),
  `movement_receipt` (spike 03 — confirm the Live-12 signature of the
  Python-API `insert_step` write path; see item #2),
  `device_add_receipt` (spike 02). Marked with `__provisional` in `ai-tools.ts`.
- **Confirmed by:** the same spikes; `load_tone` grounded by `spikes/tone3000`.

### Contract 5 — Audio sidecar → hub (PCM)
- **Source:** `LinkAudio.hpp` (raw.githubusercontent.com/Ableton/link/master/
  include/ableton/LinkAudio.hpp, HTTP 200, GPL-2.0-or-later) — `LinkAudioSource::
  BufferHandle` = `int16_t* samples` + `Info {numChannels, numFrames, sampleRate,
  count, sessionBeatTime, tempo, sessionId}`; "interleaved, 16-bit signed." And
  `@roamhq/wrtc` docs/nonstandard-apis.md — `RTCAudioData {Int16Array samples;
  sampleRate; bitsPerSample=16; channelCount; numberOfFrames}`, 10 ms/frame
  (48 k mono ⇒ 480).
- **ASSUMED:** the concrete **48 kHz / stereo** capture format is a target, not a
  guarantee — the header carries the ACTUAL `sampleRate`/`numChannels` each
  packet, so the hub trusts the header. Port `47615` is our choice.
- **Confirmed by:** the two source files above; end-to-end format is a rig item
  (sidecar build is deferred — no Mac this session).

### Contract 6 — Spectral telemetry
- **Source:** arch §3 (256 magnitudes, ~0–16 kHz, ~30 fps, FFT 4096, Node-for-Max
  UDP/OSC). No external API constrains the wire format; we froze our own binary
  layout.
- **ASSUMED:** none external; the binary layout is ours and self-consistent.
- **Confirmed by:** tsc clean; `schemas/spectral-frame.descriptor.json`.

### Contract 7 — Template structure
- **Source:** arch §3/§7/§11/§12/§15 for layout; AbletonOSC README for the two
  detection primitives (`/live/song/get/cue_points`, `/live/song/get/track_names`
  both present) — so the sentinel + chain-tag reads are FREEZE-NOW with **no**
  extension.
- **ASSUMED:** the exact device identity strings the resolver matches per role
  (NAM rack / Gateway / our M4L looper / M4L spectral) are set when you BUILD the
  .als; the resolver matches by role-order per this contract. Verify at first
  boot against the real Set.
- **Confirmed by:** AbletonOSC README (detection); the .als build + a boot scan
  on the rig.

### Contract 8 — Absolute/idempotent command rule
- **Source:** internal policy; consistent with OSC being fire-and-forget UDP
  (arch §12 "confirm by expectation-matching, not receipts").
- **ASSUMED:** none.
- **Confirmed by:** tsc clean; used by Contracts 2/3/4.

---

## Sources consulted (raw copies under `/home/claude/research/`)

- **AbletonOSC README** — github.com/ideoforms/AbletonOSC (address space, ports,
  listener model, `duplicate_clip_to`, `cue_points`, `track_names`, `track_data`).
- **Max-for-Live JS-LOM apiref** — docs.cycling74.com/apiref/lom/ (`Clip`
  warp-marker + `clear_envelope`/`automation_envelope` read side;
  `Song.is_ableton_link_enabled`; `Browser.load_item`). **This is the M4L
  surface, NOT the surface our engine uses** — it omits the `insert_step` /
  `value_at_time` write methods, which was the source of my original error (see
  item #2). Cross-checked against `github.com/6uclz1/ableton-cli`
  (browser categories/search/load; "URIs vary by version").
- **Python Remote-Script Live API dumps** — `NSUSpray/Live_API_Doc` (prettified
  Hanz Petrov / "API_MakeDoc" dumps): `AutomationEnvelope.insert_step` /
  `value_at_time` and `Clip.automation_envelope` / `create_automation_envelope`
  present across Live **9.1, 9.5, 9.7, 10.1, → 11.0**. **This is the surface our
  Python control-surface Remote Script actually uses.** Corroborated by
  `structure-void.com/ableton-live-midi-remote-scripts` (the Remote-Script Python
  API; notes Live 11 = Python 3.7, **Live 12 = Python 3.11**, API surface
  preserved in bytecode) and by an Ableton forum thread confirming **ClyphX**
  (a Python Remote Script) used `insert_step`/`value_at_time`. The
  `LomTypes.pyc`/`MxDCore.pyc` patching seen on the Cycling '74 forum is an
  **M4L-only** workaround (`_MxDCore` = the Max-for-Live core), not needed here.
- **Ableton Link — `LinkAudio.hpp`** — raw.githubusercontent.com/Ableton/link/
  master/include/ableton/LinkAudio.hpp (Source/Sink model, BufferHandle Info,
  interleaved int16). GPL-2.0-or-later; fine — the tool is open source.
- **@roamhq/wrtc** — v0.10.0 docs/nonstandard-apis.md (`RTCAudioSource.onData`,
  `RTCAudioData`, 10 ms/16-bit).
- **TONE3000 API** — www.tone3000.com/api (full docs) + ref impls
  github.com/tone-3000/api and github.com/tone-3000/t3k-api
  (`src/tone3000-client.ts`). Grounds deliverable D; see that spike's README.


---

## ADDENDUM 2026-07-03 — Amp host audit (web-verified)

- **Gateway (official NAM plugin):** model loading is a GUI action ("Select
  model directory…" per TONE3000's A2 guide + launch post). No automatable
  model-selection parameter or MIDI PC found in any official doc. This is what
  killed the VST-in-a-rack plan: pre-baked tones only, CPU per always-running
  baked instance, loaded model invisible to the LOM (receipts would be
  assertions), and the TONE3000 API flow dead-ends at a human file dialog.
- **`neural~` (github.com/apresta/neural_tilde, MIT):** Max external for NAM +
  AIDA-X captures on the NeuralAudio library. Message API: `load <path>`,
  `prewarm` (anti-artifact), `clear`; info outlet reports `loaded <path>`,
  `error <msg>`, `latency`, `loudness`. Handles host-rate resampling. Ships a
  Mac build script. VERIFY ON RIG (§6.1): builds clean; message/outlet names
  behave as documented.
- **NeuralAudio (github.com/mikeoliphant/NeuralAudio, MIT):** "NAM WaveNet and
  LSTM models, A1 and A2 support"; A2 runs via the NAM Core implementation
  (build with NAM Core enabled); A2 **quality scaling 0.0–1.0** with a noted
  real-time-safety caveat when scaling switches to an uninitialized sub-model.
  The library ships in real products (Darkglass Anagram, NAM LV2, neural_tilde).
- **Swap-click hazard (secondhand but consistent):** naive model switching is
  reported to burst white noise (HISE forum model-switching thread). Mitigation
  pinned in §6.1: `prewarm` + a short output crossfade we own in the patch.
- **Ops:** run Live at 48 kHz so model rate matches capture rate and
  `neural~`'s resampler (and its reported latency) never engages.
