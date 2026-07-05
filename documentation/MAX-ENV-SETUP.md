# §6.1 Max environment setup (do this BEFORE the plugin build)

Goal: get the toolchain + the `neural~` external building on your Mac, and the
model file staged where the `.amxd` will look for it. Once this is green, hand
`AMP-HOST-HANDOFF.md` (+ the files it lists) to the building AI.

**Ground truth, verified 2026-07-04 via the real repos/docs — not assumed:**
- `neural~` = `github.com/apresta/neural_tilde` (C++, MIT). Loads NAM + AIDA-X
  captures. Built on the **NeuralAudio** library + **AudioDSPTools** (resampling
  when host rate ≠ capture rate). Message API (from your API-REALITY audit):
  `load <path>`, `prewarm`, `clear`; info outlet: `loaded <path>`, `error <msg>`,
  `latency`, `loudness`.
- Max externals build via the **Max SDK** (`github.com/Cycling74/max-sdk`), which
  auto-fetches `max-sdk-base` at CMake configure time. CMake **generates an Xcode
  project**; you then build with `cmake --build`. On **Apple Silicon** the built
  `.mxo` must be **ad-hoc codesigned** or Max refuses to load it
  (`codesign --force --deep -s - <name>.mxo`).

---

## 0. What you already have (from earlier session)
- Xcode + command-line tools (`xcode-select -p` → `/Applications/Xcode.app/...`) ✅
- cmake 4.3.4 ✅
- node 22 via nvm ✅
- A real A2 model at `spikes/tone3000/out/651635.model` (Marshall 1987X) ✅
- Ableton Live 12.4.2 **Suite** (so Max for Live is bundled) ✅

## 1. Stage the model into a models folder (Contract-7 structure)

The `.amxd` reads a **models folder** containing `models.json` (the manifest) +
the model files. `models.json` maps the integer `Model` param → a file path
**relative to the manifest's folder** (see `contracts/types/template.ts`
`AMP_PARAMS` / `ToneManifest`).

```bash
cd ~/Aibleton/Aibleton
mkdir -p models
cp spikes/tone3000/out/651635.model models/651635.model
```

Create `models/models.json`:

```json
{
  "version": 1,
  "entries": [
    { "index": 0, "file": "651635.model", "name": "Marshall 1987X SE Crunch Mod", "toneId": 651635 }
  ]
}
```

> ⚠ **Extension caveat:** the file is `.model`, but `neural~` may expect `.nam`.
> If `neural~` refuses to load it, `cp models/651635.model models/651635.nam`
> and point the manifest `file` at the `.nam`. The bytes are a NAM capture
> regardless of extension — this is a rename, not a conversion. FLAG which
> extension actually worked in `reports/API-REALITY.md`.

## 2. Clone the Max SDK + neural_tilde

Both are outside the repo tree (build tooling, not app code). Put them in the
OUTER `~/Aibleton/` folder next to the analyzer, so they're never committed:

```bash
cd ~/Aibleton

# Max SDK (auto-fetches max-sdk-base at configure time)
git clone --recursive https://github.com/Cycling74/max-sdk.git

# the neural~ external (has its own submodule deps: NeuralAudio, AudioDSPTools)
git clone --recursive https://github.com/apresta/neural_tilde.git
```

**If either has submodules that didn't populate** (you'll find out at build
time with "file not found" on NeuralAudio/AudioDSPTools headers):
```bash
cd ~/Aibleton/neural_tilde && git submodule update --init --recursive
```

## 3. Build neural_tilde (the building AI will drive this, but here's the shape)

`neural_tilde` ships its own CMake. The canonical Max-SDK flow is:

```bash
cd ~/Aibleton/neural_tilde
cmake -B build -G Xcode                      # generate the Xcode project
cmake --build build --config Release          # compile
# Apple Silicon: ad-hoc codesign so Max will load it
codesign --force --deep -s - build/**/neural~.mxo 2>/dev/null || true
```

> The exact flags / whether it needs `-DMAX_SDK_PATH=...` come from
> **neural_tilde's own README** — the building AI should read that repo's README
> FIRST and follow ITS instructions where they differ from the generic flow
> above. This is the single biggest unknown; don't assume the generic flow.

**Where the `.mxo` must end up:** Max loads externals from
`~/Documents/Max 8/Library/` (or `Max 9`), or you point Max's search path at the
build output. Confirm your Max version's Library path and copy `neural~.mxo`
there (the building AI covers this).

## 4. Confirm neural~ loads in Max (smoke test, before the .amxd)

Open Max (standalone, from Live Suite: it's in the Max application, or via a M4L
device's edit button). Make a new patcher, create an object box, type `neural~`.
- If it instantiates (object box gets inlets/outlets, no "no such object") →
  the external built + loaded. ✅
- If "no such object" → search path issue (step 3) or codesign
  (Apple Silicon — check Console.app for a "cannot be loaded due to system
  security policy" line).

Once `neural~` instantiates in a bare patcher and can `load` your model file
(send it `load <abs-path-to-model>` and watch the info outlet say
`loaded ...`), you have proven the hard part. THEN the building AI wraps it in
`NAM_A2_Amp.amxd` per the handoff brief.

---

## Hand-off trigger

You're ready to hand off when:
1. `models/models.json` + the model file are in place.
2. `neural~` instantiates in a bare Max patcher.
3. `neural~` successfully `load`s your model (info outlet: `loaded`).

If you get stuck before (2)/(3), that's fine — the building AI can also drive
the neural_tilde build; give it this file's status so it knows where you stopped.
