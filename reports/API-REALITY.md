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

---

## RIG RESULTS 2026-07-04 — first on-rig session (Live 12.4.2, M-series Mac)

*First time the contracts met a real Ableton rig. Everything below is measured
or read from `Log.txt`, not inferred. Golden rule: where the rig disagreed with
the guide, the disagreement is recorded as data.*

### What the rig confirmed

- **OSC round-trip (spike 01):** 30/30 replies, min 74.5 / **median 78.9** /
  mean 80.0 / p95 88.4 / max 92.8 ms, on `/live/song/get/tempo` over
  127.0.0.1:11000→11001. Transport + reply model work. **Caveat:** median ~79 ms
  is ABOVE the ~30–50 ms "feels instant" rule of thumb for confirmed UI — flag
  for UI-feel tuning (this is loopback on the Mac; a LAN tablet will be higher).
  Also note spike 01 exercises a STOCK AbletonOSC address, so it proves stock
  AbletonOSC is alive, not the custom engine (see next).

- **Custom engine extension IS loaded (proven via `Log.txt`, not via a hello
  ping):** `extension.py`'s own handlers ran and logged with the `engine:`
  prefix — e.g. `INFO:abletonosc: engine: browser index built (15739 loadable
  items)` and the `engine … failed:` warnings. That log signature only exists in
  our extension, so the custom layer is confirmed running, not just stock
  AbletonOSC. **Correction to the install note:** `/live/engine/hello` is an
  *unsolicited announce at init only* — it is NOT a registered request handler,
  so pinging it returns stock AbletonOSC's `Unknown OSC address: /live/engine/
  hello`. Do not use a `/live/engine/hello` request as a liveness probe; use the
  `engine:`-prefixed log lines (or catch the unsolicited announce right after a
  Live restart) instead.

- **Confirmed-echo primitive / Contract 8 (spike 05):** CONFIRMED in 76.7 ms
  (arm `playing_slot_index` → fire `clip_slot` → matching echo). **Precondition:**
  only confirms when a REAL clip exists in the fired slot; an empty slot produces
  no echo and a false 1500 ms timeout. Read an empty-slot timeout as "nothing to
  confirm," not "engine dead."

- **Automation write/read (spike 03) — Seam 1 CLOSED:** `insert_steps` +
  `clear_envelope` + `get/envelope` behave on this Live 12.4.2 / Python-3.11
  runtime. Wrote a 4-point ramp, read back
  `0,0,0,1,0.5,0,1.5,0,2.5,1,3.5,1` (4 points as time/value pairs, ramp correct),
  and **one Cmd-Z reverted the whole write** (atomic-undo wrapping works). The
  Live-12 signature question from item #2 is resolved: signature holds. **No
  fallback to clip-based movement needed.** → Contract 2 `insertStep` /
  Contract 4 `write_movement` move to FREEZE.
  - **Failure mode recorded:** the same call FAILED with `Index out of range`
    (all three of clear/insert/get) on a cold run (`Log.txt` 16:14), returning 0
    points. Cause is an unresolved target (empty clip slot / no device at the
    addressed index / non-continuous param), not a flaky primitive — the engine
    honestly reports the bad target. Exact device state at 16:14 could not be
    reconstructed, so we record the failure MODE, not a precise root cause.
    **Rule for callers:** resolve a real continuous param before writing; treat
    `Index out of range` as "bad target."

- **Browser index + load (spike 02) — Seam 2 CLOSED:** `/live/browser/rescan`
  built a **15,739-item** index (logged); `/live/browser/query "Reverb"`
  returned a flat `[name, uri, name, uri, …]` reply (bare device =
  `query:AudioFx#Reverb`, `.adg` entries = Audio-Effect-Rack presets);
  `load_item query:AudioFx#Reverb` onto track 0 gave device count **1 → 2
  (delta === 1)**. Failure detectable (literal `<uri>` placeholder → delta 0).
  → Contract 2 `browserLoadItem` + `browserRescan` move to FREEZE. This also
  proves the Phase-1 boot-index mechanism end to end.

### Guide-vs-reality discrepancies (FIRST-MAC-SESSION.md Part 5)

- **spike 05 does NOT use `/live/ext/hello`.** The guide's Part-5 comment says
  harness 05 should "expect `/live/ext/hello` to answer with the extension
  version." The actual `05-confirmed-echo-pinger.ts` does a clip-fire
  confirmed-echo instead, and no `/live/ext/hello` (nor `/live/engine/hello`)
  request handler exists. Correct the guide comment.
- **Looper handlers throw, not no-op (spike 04):** with no M4L looper present,
  `find_state_param` / `looper_set_state` / `looper_get_state` (extension.py
  :343/:352/:362) RAISE rather than returning an honest `(ok=0, reason)`.
  Harness conclusion ("add a state outlet") is right; the crash-vs-tuple bug is
  logged in PROVISIONAL-SEAMS Seam 3 for fix when the device is built.

- **QUANT_BEATS verified (§6.2):** `/live/song/get/clip_trigger_quantization`
  read back three fixed points that all matched the assumed table — None→0,
  "1 Bar"→4, "1/4"→7. Live's enum is monotonic so those pin the full ordering
  (0=None … 13=1/32). The "⚠ ASSUMED" flag in `hub/src/lifecycle/lifecycle.ts`
  is removed; QUANT_BEATS is now confirmed data.

- **Link Audio → sidecar → hub PROVEN end-to-end (§6.5):** `sidecar/main.cpp`
  compiled clean on Mac (AppleClang 21, zero warnings — first cross-platform
  build from the Linux original), and streamed real guitar audio
  **Live → Link Audio → C++ → APC1 bytes → Node decoder**: **7,152 packets,
  `headerBad=0`, `seqSkips=0`**, 48 kHz stereo, via
  `NAM_CHANNEL=Main NAM_HUB_PORT=9701 ./build/nam_a2_sidecar` +
  `verify-apc1.ts`. `--selftest` golden APC1 header matched the hub's expected
  bytes exactly. Contract 5 receive path confirmed on the rig. **Link Audio
  enable is a clean Settings toggle** (Settings → Link → Audio: On), not a
  hidden wizard step (resolves arch §14 / Seam 4 enable question favorably);
  Settings Latency field = 100 ms.

- **⚠ SAMPLE-RATE FINDING (rig must be 48 kHz):** Live defaulted to **44.1 kHz**
  and every APC1 packet failed the verifier's `sampleRate === 48000` check
  (`headerBad=7393`), despite audio flowing perfectly (`seqSkips=0`). The sidecar
  forwarded the true rate honestly; the verifier rejected honestly. Setting Live
  → Audio → Sample Rate → **48000** produced an immediate clean PASS. The whole
  rig assumes 48 kHz (Contract 5 header check, `--selftest` golden header, and
  the §6.1 `neural~` resampler note all bake in 48k). **→ Boot/wizard should
  assert `sampleRate === 48000` and warn otherwise.**

- **§6.5 guide corrections:** channel is `Main` (capital M); sidecar needs
  `NAM_HUB_PORT=9701` to reach the verifier (defaults 47615 vs 9701 don't meet);
  the header-checking test is `main.cpp → verify-apc1.ts`, NOT the separate
  synthetic-ramp self-test `probe/nam_a2_probe.cpp` (`send`/`recv` pair).

- **§6.1 amp-host FOUNDATION built + proven (env ready; `.amxd` handed off):**
  `neural~` external (`apresta/neural_tilde`, MIT) compiled clean on the Mac
  (NeuralAudio + NAM Core + A2 fast-path WaveNet; AppleClang 21), installed to
  `~/Documents/Max 9/Packages/neural/externals/neural~.mxo`, ad-hoc codesigned
  (required on Apple Silicon), and **instantiated + loaded a real A2 model in
  Max 9**. Console receipt on load of `models/651635.nam`:
  `loaded <path>` / `latency 0` / `loudness -2.83`. **Verified facts for the
  amp-host build:** neural~ needs `.nam` (not the `.model` the fetch saves —
  rename); info-outlet vocab is `loaded`/`latency`/`loudness`/`queued`/`cleared`/
  `error`/`bang`; `prewarm` is NAM-only; 48 kHz → 0 resampling latency. Building
  the `NAM_A2_Amp.amxd` wrapper is handed to a build AI via
  `reports/handoff/AMP-HOST-HANDOFF.md`. **Note the neural_tilde build gotcha:**
  running raw cmake (not `build.sh`) builds the Mac `.mxo` fine but the Windows
  cross-target errors on missing llvm-mingw — that error is cosmetic; the Mac
  external builds and installs before it, and you don't want the Windows target.

### Still open after this session

- **NEW WORKSTREAM — AI device generation (Deliverable E,
  `reports/handoff/AI-DEVICE-GENERATION.md`):** pipeline for the AI to author
  `.amxd` devices from intent ("stop, ask, build a patch, load, resume") AND to
  build the core devices (looper, amp). Tooling identified + real (`js2max`
  JS→.amxd, `py2max` Python→.maxpat, Ableton `maxdevtools` for text-diffing
  devices) but **NOT yet verified on this rig** — step 0 (prove a generated
  device loads + exposes a param + passes signal in Live 12.4.2) is the gate
  before it's used to build anything. Doesn't fight the architecture *because*
  the workflow stops first (no live param-surface mutation, no hot audio-graph
  edits) and loads via the proven browser path. First real target: re-author the
  looper (Seam 3) via the pipeline.

- **Seam 3** (looper state echo) — device not built. **Seam 4** (Link Audio) —
  ◐ enable mechanism + audio path now proven; only the end-to-end latency NUMBER
  remains (Settings shows 100 ms; direct capture→decode measurement still wanted).
  Part 6 remaining: **§6.1 amp host** (the `neural~` external + `.amxd` build)
  is next. **§6.9 feel test is intentionally PINNED until §6.1 lands** — the
  test is a subjective judgment about whether the monitoring-vs-playback limit
  annoys you in practice, which is only meaningful with real amp tone in hand,
  not a dry DI. **§6.2 quant** and **§6.5 Link Audio** ✅ done this session.

- **§7 TONE3000 fetch PROVEN (bonus, done this session):** full PKCE flow works
  from the Mac — `t3k_pub_…` publishable key accepted, browser login, token
  exchange, and download of a real A2 model (tone 74416 → model 651635,
  "Marshall 1987X SE Crunch Mod", 295,168 bytes → `spikes/tone3000/out/651635.model`).
  `load_tone` (Contract 4) is grounded. **Spike usability findings:** (a) the
  script has NO `.env` loader — must run with Node's `--env-file=.env`
  (`node --env-file=.env --import tsx src/fetch-a2-model.ts`), else it silently
  stubs; (b) the STUB fires on `!token || !toneIdEnv` but doesn't say WHICH is
  missing — `T3K_TONE_ID` is effectively REQUIRED for a deterministic fetch;
  (c) the LAN callback must be reachable from the approving device — approve in
  the **Mac's own browser** (phone-on-different-LAN times out); (d) file saves
  as `.model`, not `.nam` — watch whether `neural~` cares about the extension.
