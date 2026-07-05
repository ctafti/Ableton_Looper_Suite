# AI DEVICE GENERATION — design + bring-up (Deliverable E)

*Status: NEW workstream, 2026-07-04. The tooling named here is REAL but
**NOT YET VERIFIED on this rig** — treat "step 0" (verify the generator) as a
gate, exactly like `--selftest` gated the sidecar. Nothing downstream is trusted
until a generated device is proven to load + expose its params + pass signal.*

---

## 0. The feature, in the user's words

> "When we're digging around on the looper, we can stop everything, hit the mic
> button, tell the AI to make a patch that does XYZ, it builds that patch from
> scratch and loads it, and we go on with our day."

**Two uses, one pipeline:**
1. **Live authoring** — the "stop, ask, build, load, resume" loop above.
2. **Build-time authoring** — the AI writes the core devices (looper, amp host,
   future ones) as `.amxd` files instead of a human hand-patching them.

## 1. Why this DOESN'T fight the architecture (the key realization)

Earlier worry was real-time device conjuring *mid-performance*. That's not this.
Because the workflow **stops first**, every hard constraint dissolves:

- **Live's parameter-surface limit doesn't bite.** Live only rejects params
  *added to an already-loaded device*. We load a **fresh** device whose params
  exist at instantiation (the AI wrote them into the file first). No conflict.
  *(Confirmed constraint, C74 forum: "Live only recognizes parameters that exist
  when the device is first instantiated" — so we never mutate a live param
  surface; we author complete devices and load them.)*
- **Audio-safety doesn't bite.** Nothing streams while we build; we load into a
  quiet state and resume. (The swap-click hazard was about hot-swapping under
  sustain — irrelevant when stopped.)
- **Receipts/observed-truth still hold.** A generated device enters through the
  SAME proven browser path (seam #2: `rescan` → `query` → `load_item`, verified
  2026-07-04, delta===1) and its param surface is read back to confirm. New
  device, same observed-truth door.

So this is on-brand: AI authoring **inside** contracts, at a slower cadence than
param tweaks — not a new epistemics.

## 2. The pipeline

```
spoken/typed intent ("make a patch that does XYZ")
   → AI authors device source
   → COMPILE to .amxd
   → VERIFY (headless load-test: instantiates? right params? passes signal?)
   → place in Live's User Library, rescan, load_item   (proven path)
   → read param surface back = receipt
   → resume
```

The **VERIFY** step is the whole ballgame — it's what makes a generated device
trustworthy. A wrong patch usually *loads but misbehaves* rather than erroring,
so a load-and-check gate is mandatory before any generated device is "blessed."

## 3. Candidate tooling (REAL; verify before trusting)

| Tool | Input → Output | Install | Notes |
|---|---|---|---|
| **`js2max`** (ktamas77) | `.js` → `.amxd` | `npx js2max compile x.js` | Wraps a Max 9 **`v8`** object into M4L scaffolding (`plugin~`/`plugout~`, `live.thisdevice`); `@ui` decorators auto-gen UI. `.amxd` format reverse-engineered from Ableton `maxdevtools`. **Best fit** — AI writes JS (its strength); tool builds the fragile patch structure. |
| **`py2max`** (shakfu) | Python → `.maxpat` | `pip install py2max` | Pure Python, no deps, 418+ tests, round-trips `.maxpat`. Emits `.maxpat` (not `.amxd`) — needs a wrap step for M4L. Great for precise object/UI layout + SVG preview. |
| **`maxpylang`** (Barnard-PL-Labs) | Python → `.maxpat` | `pip install maxpylang` | NIME 2023 alt to py2max. Backup option. |
| **`Ableton/maxdevtools`** | `.amxd`/`.maxpat`/`.als` → text diff | git clone | Ableton's OWN tooling. Gives **text git-diffs of devices** (`amxd_textconv.py`) — lets AI-generated devices live in git as reviewable diffs, not blobs. **Adopt regardless of generator choice.** Note: `.amxd` textconv needs FROZEN devices. |

**Design bet:** `js2max` as primary (AI→JS→.amxd), `py2max` as the fallback /
for cases needing precise DSP-object layout, `maxdevtools` for versioning. All
THREE unverified on this rig until step 0 below.

## 4. Bring-up — STEP 0 (do this before using it to build anything)

> **Sandbox pre-check done 2026-07-04 (Claude, off-rig):** `py2max` 0.3.1
> installs (`pip install py2max`) and generates **well-formed `.maxpat` JSON** —
> correct `patcher`/`boxes`/`patchlines`, a `plugin~ → *~ → plugout~` stereo
> skeleton rendered cleanly. So the *generation* half works. **Two findings that
> move the risk to the Mac:**
> 1. py2max stamps `appversion.major = 8` + `architecture = x64`. Your rig is
>    **Max 9 / arm64**. Max usually opens older patches fine, but VERIFY it loads
>    in *your* Live 12.4.2 — don't assume.
> 2. py2max emits **`.maxpat`, not `.amxd`** (no M4L wrap). Live loads `.amxd`.
>    So py2max alone can't produce a Live device — it needs a `.maxpat`→`.amxd`
>    wrap, OR use **`js2max`** which emits `.amxd` directly. **This packaging
>    half — →.amxd, correct version, actually loads in Live — is the UNVERIFIED,
>    real-risk part.** That's the Mac-side gate below.
> Also: py2max does NOT validate object names (it wrote a `*~` box with only a
> "not in MaxRef DB" debug note) — so the AI can emit typos/nonexistent objects
> and the tool won't catch it. The load-in-Live gate is load-bearing, not
> ceremony.

The generator is a dependency; prove it like we proved the sidecar. On the Mac:

```bash
# --- js2max path ---
cd ~/Aibleton                      # outer folder (tooling, not committed)
# minimal test device: a JS gain effect
mkdir -p devgen && cd devgen
cat > gain.js << 'EOF'
// @device audio-effect
// @ui slider "Gain" 0 1 0.5
inlets = 1; outlets = 1;
function msg_float(g){ outlet(0, g); }   // placeholder logic
EOF
npx js2max compile gain.js -o gain.amxd     # or default .amxd target
```
Then VERIFY (the gate):
1. Drop `gain.amxd` on a track in Live — does it load without error?
2. Does the "Gain" param appear AND is it OSC-reachable
   (`/live/device/get/parameters/name` via the engine)?
3. Does audio pass?

```bash
# --- py2max path (parallel sanity check) ---
pip install --break-system-packages py2max
python3 - << 'EOF'
from py2max import Patcher
p = Patcher('smoke.maxpat')
a = p.add_textbox('plugin~'); b = p.add_textbox('plugout~')
p.add_line(a, b)
p.save()
print('wrote smoke.maxpat')
EOF
# open smoke.maxpat in Max — does it look right?
```

**Only when a generated device LOADS + EXPOSES A PARAM + PASSES SIGNAL is the
pipeline "green."** Record the result (which tool, which Max/Live versions, any
`.amxd`-format gotcha) in `reports/API-REALITY.md`. Until then, the looper and
amp host build via their EXISTING plans — do NOT put an unproven generator on
their critical path.

## 5. Sequencing (honest bootstrap order)

1. **Prove the generator** (step 0). Gate.
2. **Re-author the looper via the pipeline.** The looper (Seam 3) is NOT built
   yet and is a good first real target — a self-contained M4L device with a
   small param surface (`State` + a state-report outlet, per Seam 3). If the
   pipeline can produce a working looper that closes Seam 3, it's proven on
   something real and useful.
3. **Amp host:** the `NAM_A2_Amp.amxd` handoff (`AMP-HOST-HANDOFF.md`) can EITHER
   proceed as-is (hand-authored by the build AI) OR be produced via the pipeline
   once green. **Recommendation:** don't block the amp on the generator — its
   foundation is already proven (`neural~` loads). If the pipeline is green in
   time, use it for the amp; if not, the handoff stands. Two independent paths,
   deliberately.
4. **Wire the live loop** (tablet mic → intent → generate → verify → load) only
   after the offline pipeline is trustworthy.

## 6. Contract fit

- Generated devices MUST still honor the relevant contract param names when they
  play a known role (e.g. a generated amp uses `AMP_PARAMS` verbatim). Freeform
  "make a patch that does XYZ" devices that AREN'T a contracted role get a
  generated ad-hoc param surface, and the hub addresses them by reading their
  actual params back (the receipt) rather than assuming.
- The VERIFY step's param read-back reuses the SAME mechanism as the amp host's
  `Load OK` receipt idea: observe the real surface, never assume it.
- Versioning: commit generated `.amxd` (frozen) with `maxdevtools` textconv so
  diffs are reviewable — same discipline as every other artifact.

## 7. Open risks (name them, don't hide them)

- **Generation reliability.** AI-authored patches load-but-misbehave more than
  they hard-error. Mitigation: the VERIFY gate + prefer `js2max` (AI writes JS,
  tool builds structure) over raw JSON emission.
- **Live-12 `.amxd` compatibility.** `js2max`'s format is reverse-engineered;
  confirm its output loads in *your* Live 12.4.2 specifically (step 0).
- **Latency of the loop.** generate + Live reindex = seconds. Fine for
  "stop, ask, build, resume"; NOT for real-time. Set expectations accordingly.
- **UI quality.** auto-layout UIs are functional, not beautiful. Acceptable for
  v1 utility devices; revisit for anything player-facing.
