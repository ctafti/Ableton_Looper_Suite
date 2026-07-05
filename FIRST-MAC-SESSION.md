# FIRST MAC SESSION — v4 (2026-07-04, evening)

> Supersedes v3 (earlier today). The build itself still hasn't advanced past
> "about to run the simulator" — but the **repo + tooling infrastructure around
> it is now solid**: the project is published to GitHub, the codebase analyzer
> has completed a real run, and a first-run crash bug in the analyzer is fixed.
> This revision records that, and corrects the GitHub naming (which turned out
> different from what we assumed).

**Golden rule (unchanged):** when a step's output disagrees with what this
guide predicts, that's not a problem — that's DATA. Record it in
`reports/API-REALITY.md` and keep going.

---

## Progress at a glance

| Part | What | Status |
|---|---|---|
| 1 | Mac command-line setup | ✅ **DONE** |
| 2 | Unpack foundation + prove it works | ✅ **DONE** (baseline committed) |
| — | *Side work:* hub duplicate-generation cleanup | ✅ **DONE** (35→20 tests, committed) |
| — | *Side work:* codebase-analyzer setup + first real run | ✅ **DONE** |
| — | *Side work:* publish repo to GitHub | ✅ **DONE** (verify push landed) |
| 3 | Run the simulator | ✅ **DONE** |
| 4 | Install engine extension into Live | ✅ **DONE** |
| 5 | The harness gauntlet | ✅ **DONE** (5 spikes; 2 seams closed) |
| 6 | Bench experiments (guitar in hand) | ◐ **IN PROGRESS** (6.2 ✅ 6.5 ✅; 6.1 next; 6.9 pinned) |
| 7 | TONE3000 | ✅ **DONE** (real A2 model fetched) |
| 8 | End-of-session ritual | ☐ not started |

**Nothing in Live has been touched yet.** All recent activity was repo hygiene
and tooling; the actual rig build resumes at Part 3.

**Loose ends to close before Part 3:**
1. **Verify the GitHub push actually landed:** `git log --oneline origin/main`
   (or open the repo in a browser). If `origin/main` shows your commits, you're
   pushed.
2. **Fix the analyzer's GitHub username:** set `GITHUB_USERNAME=ctafti` in
   `~/Aibleton/.env` (your GitHub handle is `ctafti`, *not* your Mac username
   `cyrustafti`). Otherwise the analyzer's auto-push / API calls will fail.
3. **Swap in the `save_state`-fixed analyzer** (see §A below) so future fresh
   repos don't hit the first-run crash.

---

## Project layout & environment (as actually set up)

- **Project root (the repo):** `~/Aibleton/Aibleton` *(nested — inner `Aibleton`
  is the git repo; outer is a container).* Everywhere older notes said
  `~/nam-a2/nam-a2-foundation`, read `~/Aibleton/Aibleton`.
- **Outer folder `~/Aibleton/`** holds the build docs, the original zip, and the
  codebase analyzer + its `.env` (kept out of the repo on purpose).
- **Two different "usernames" — don't mix them up:**
  - **Mac / filesystem username:** `cyrustafti` → all local paths are
    `/Users/cyrustafti/...` (e.g. `ANALYZER_ROOT=/Users/cyrustafti/Aibleton/Aibleton`).
  - **GitHub username:** `ctafti` → the remote URL and `GITHUB_USERNAME` use this.
- **GitHub repo:** `Ableton_Looper_Suite` (**underscores**, not hyphens) at
  **https://github.com/ctafti/Ableton_Looper_Suite** — private.
- **Node:** nvm, pinned via `.nvmrc` = `22` (v22.23.1). Global default is still
  node 20 and Homebrew's node 26 is shadowed — ignore both; run `nvm use` in a
  fresh shell so `node --version` shows v22.x before any harness.
- **Python venv:** `.venv` is active (`(.venv)` prompt). Harmless to the Node
  work; `python3 engine/test_offline.py` runs fine inside it.

Sanity check on opening a new terminal for this project:

```bash
cd ~/Aibleton/Aibleton
nvm use              # -> Now using node v22.x (from .nvmrc)
pwd                  # must end in /Aibleton/Aibleton
ls                   # must show package.json, hub, harnesses, contracts, engine ...
```

If `ls` shows `BUILD-PLAN.md` and the zip, you've drifted **up** to the outer
folder — `cd Aibleton` once more.

---

## Part 1 — Mac command-line setup ✅ DONE

Homebrew, cmake (4.3.4), and node installed. Homebrew's node was shadowed by
nvm, so node 22 was installed through nvm (`nvm install 22` → v22.23.1) and
pinned with `.nvmrc`. Nothing to redo.

---

## Part 2 — Unpack the foundation and prove it works ✅ DONE

The foundation was **already unpacked** at `~/Aibleton/Aibleton` (no `unzip`).
What passed:

```bash
cd ~/Aibleton/Aibleton
nvm use
npm install
(cd harnesses && npm install)
(cd spikes/tone3000 && npm install)
(cd hub && npm install)
npm run typecheck:contracts      # ✅ clean
(cd hub && npm test)             # ✅ 20 pass / 0 fail  (see baseline note)
python3 engine/test_offline.py   # ✅ ALL CHECKS PASS
```

**Corrected test baseline:** older notes predicted "35 pass." That counted a
duplicated set of hub modules. After the cleanup below, the real de-duplicated
suite is **20 pass, 0 fail** — 20 is your baseline; fewer is a regression.

Committed as `foundation baseline: all off-rig tests green on the Mac`.

---

## Side work done (not in the original guide, but part of your repo/tooling now)

### A. Codebase-analyzer workflow ✅ (first real run complete)

Lives in the **outer** folder at `~/Aibleton/codebase_analyzer.py` (outside the
repo, so it + secrets are never committed). Its `.env` sits at `~/Aibleton/.env`
with the API keys, `ANALYZER_ROOT=/Users/cyrustafti/Aibleton/Aibleton`, and
`GITHUB_USERNAME=ctafti` (fix this if it still says cyrustafti).

Run it:

```bash
python3 ~/Aibleton/codebase_analyzer.py --dry-run --no-commit   # target + file list + cost
python3 ~/Aibleton/codebase_analyzer.py --no-commit             # real analysis, no git
python3 ~/Aibleton/codebase_analyzer.py                         # commit per-file + PUSH
```

Status: a real `--no-commit` run completed and wrote
`documentation/CODEBASE_ANALYSIS.xml` (~62k chars, committed to the repo by hand).

Things already handled / to know:
- **`.gitignore` excludes the vendored Ableton Link + Asio tree** via
  `sidecar-experiment/link/*` (a plain trailing-slash dir path does **not**
  match this tool's gitignore parser — use the `/*` glob form). Dropped the
  analyzer from 1411 files (~$1.19) to ~53 (~$0.05).
- **`save_state` first-run crash — FIXED.** On a fresh repo the `data/` dir
  didn't exist and `save_state` crashed with `FileNotFoundError` at the very end
  (after writing the XML, before committing). The fixed build creates the dir
  first (`state_path.parent.mkdir(parents=True, exist_ok=True)`). Swap in the
  updated file so new repos don't need a manual `mkdir -p data`.
- **AUTO-PUSH IS ON.** This build has `ENABLE_GIT_PUSH = True`; now that a GitHub
  remote exists, any run *without* `--no-commit` will commit per-file **and push
  to `Ableton_Looper_Suite`**. For the first few real runs, prefer `--no-commit`
  (or `--no-push`) and eyeball `git status` before letting it push unattended.
  To disable permanently: set `ENABLE_GIT_PUSH = False` near the top of the file.

### B. Hub duplicate-generation cleanup ✅ (committed)

`hub/src` shipped **two generations** of four modules — an older flat layout
(`src/resolver.ts`, `src/lifecycle.ts`, `src/mirror.ts`, `src/codecs/`) and the
current nested one (`src/resolver/resolver.ts`, `src/lifecycle/lifecycle.ts`,
`src/mirror/mirror.ts`, `src/codec/`). Nested is canonical: the simulator
imports it, it's newer, and it's what Part 6.4 points at for `QUANT_BEATS`. Only
`test/hub.test.ts` referenced the flat set. Removed it + the flat files; `npm
test` → 20/0, `tsc --noEmit` clean. Committed.

### C. GitHub publish ✅ (verify the push)

- Repo: **https://github.com/ctafti/Ableton_Looper_Suite** (private, underscores).
- Vendored Link tree **untracked**: `git rm -r --cached sidecar-experiment/link`
  done; `git ls-files sidecar-experiment/link` → 0.
- No secrets tracked (only `spikes/tone3000/.env.example`, a template — safe).
- Remote wired: `git remote add origin https://github.com/ctafti/Ableton_Looper_Suite.git`.
- **Auth:** push over HTTPS uses your **personal access token** (the `ghp_...`
  from `.env`) as the *password*, not your GitHub password. It needs `repo`
  scope. To avoid re-typing: `git config --global credential.helper osxkeychain`.
- **Verify it landed:** `git log --oneline origin/main`.

Commit history so far: `foundation baseline` → `hub dedup` → `stop tracking
vendored Ableton Link tree` → `add codebase analysis doc + finalize gitignore`.

---

## Part 3 — Touch the tool on day one: run the simulator (~5 min) ▶ NEXT

Before Live is involved at all, feel the instrument. (The dedup didn't touch
this — the sim runs on the nested modules, still green.)

```bash
cd ~/Aibleton/Aibleton/hub
nvm use
npm run sim
```

Open `http://localhost:8420` on the Mac, then find the Mac's IP (System
Settings → Wi-Fi → Details) and open `http://<that-ip>:8420` **on the tablet**.
Fire clips, watch the queued countdown snap to the bar, tap a row header to move
the LIVE glow, pull faders. Then restart as `FAIL_RATE=0.3 npm run sim` and
watch commands fail and revert calmly — that's arch §12 working. Everything is
the real Phase-2 tablet shell speaking the real frozen protocol; only Live is
fake.

---

## Part 4 — Install the engine extension into Live (~10 min) ☐

```bash
cd ~/Aibleton/Aibleton
bash engine/install.sh
```

Clones AbletonOSC into Live's Remote Scripts folder if missing, copies
`extension.py` in, patches the handler list, syntax-checks. Then in Live:

1. Settings → Link/Tempo/MIDI → **Control Surface: AbletonOSC**.
2. Settings → Record/Warp/Launch → **Exclusive Arm: OFF** (arch §17).
3. Watch the status bar for "AbletonOSC: Listening for OSC on port 11000".

> Heads-up: this makes **global** changes to your Live install (a Remote Script
> + a preference). Reversible, but not sandboxed — fine if this is your everyday
> Live, just know it persists across all your sets.

---

## Part 5 — The harness gauntlet (~45 min, the heart of the session) ☐

Run from `harnesses/`, **with Live open**. After each, paste output into
`reports/API-REALITY.md` under a "RIG RESULTS" heading.

> Filenames below are the **actual** files in `harnesses/src/` (older notes had
> stale names).

```bash
cd ~/Aibleton/Aibleton/harnesses
nvm use

# 1. Baseline: does OSC round-trip at all, and how fast?
node --experimental-strip-types src/01-osc-latency.ts

# 2. Is OUR extension alive inside Live?
node --experimental-strip-types src/05-confirmed-echo-pinger.ts
#    expect /live/ext/hello to answer with the extension version

# 3. Looper param control (stock Looper on track 1, device slot 2; DEVICE env overrides)
node --experimental-strip-types src/04-looper-state-roundtrip.ts

# 4. Browser load: ask the boot index for a real URI, then load it
node --experimental-strip-types src/02-load-item-verify.ts
#    then: ITEM_URI="<uri>" node --experimental-strip-types src/02-load-item-verify.ts

# 5. The big one: clip-envelope automation writes + readback
node --experimental-strip-types src/03-insert-step-automation.ts
```

(Shared OSC plumbing: `harnesses/src/osc-helper.ts`.)

Harness 03 passing = §10 movement design is REAL. Any `[EXT]` failure is an
`engine/extension.py` bug — paste the error + Live's `Log.txt` to your AI.

---

## Part 6 — Bench experiments from arch §6 (~1 hr, guitar in hand) ◐ IN PROGRESS

> **Not a sequence — four independent experiments.** Done so far this session:
> **§6.2 ✅** and **§6.5 ✅**. **§6.1 is next** (the big from-scratch build).
> **§6.9 is intentionally PINNED behind §6.1** (see below). Order taken:
> 6.2 → 6.5 → (7) → 6.1 → 6.9.

1. **§6.1 amp-host bring-up** ☐ **NEXT — being handed to a build AI.** Clone +
   build the `neural~` Max external (`github.com/apresta/neural_tilde`, MIT —
   built on NeuralAudio + AudioDSPTools), wrap it in a minimal `NAM_A2_Amp.amxd`
   with the Contract-7 param names (`Model`/`Rescan`/`Input Trim`/`Output Trim`/
   `Quality`/`Load OK`), load the fetched A2 model via `Model`, run the model-swap
   click test mid-sustain (prewarm + output crossfade). **Two docs drive this:**
   - `reports/handoff/MAX-ENV-SETUP.md` — YOU run first: toolchain + clone the
     Max SDK & neural_tilde, stage the model into `models/models.json`, smoke-test
     that `neural~` loads.
   - `reports/handoff/AMP-HOST-HANDOFF.md` — hand to the build AI (with
     `CODEBASE_ANALYSIS.xml` + `contracts/types/template.ts`) to build the `.amxd`.
   > Verified 2026-07-04: Max externals build via the Max SDK (auto-fetches
   > max-sdk-base; CMake generates an Xcode project); Apple-Silicon `.mxo` needs
   > ad-hoc codesign (`codesign --force --deep -s - neural~.mxo`).

2. **§6.9 THE FEEL TEST** ☐ **PINNED until §6.1 lands.** 2 chains in a throwaway
   set, record a clip on chain A, play it back while noodling live on chain B for
   ten minutes. Then try to noodle on chain A *while its own clip plays* — you
   can't (monitoring vs playback is mutually exclusive per track, arch §17).
   Decide the summing-pair contingency: **did that limit annoy you, or did the
   looper cover it?** Answer in `reports/PROVISIONAL-SEAMS.md`. **Deferred on
   purpose:** the judgment is only meaningful with real amp tone in hand, not a
   dry DI — so it waits for §6.1.

3. **§6.5 Link Audio on the rig** ✅ **DONE — proven end-to-end.** Sidecar built
   clean on Mac (AppleClang 21) and streamed real guitar audio Live → Link Audio
   → C++ → APC1 → Node decoder: 7,152 packets, `headerBad=0`, `seqSkips=0`, 48 kHz.
   **Corrected commands (the originals here were wrong — see API-REALITY):**
   ```bash
   cd ~/Aibleton/Aibleton/sidecar
   cmake -B build -DLINK_DIR=../sidecar-experiment/link && cmake --build build
   ./build/nam_a2_sidecar --selftest      # golden APC1 header matches
   # then, with Live's Link + Link Audio ON and Main published:
   #   terminal 2:
   node --experimental-strip-types ../sidecar-experiment/verify-apc1.ts
   #   terminal 1 (channel is 'Main'; port MUST be 9701 to match the verifier):
   NAM_CHANNEL=Main NAM_HUB_PORT=9701 ./build/nam_a2_sidecar
   # then PLAY audio on Main. NB: run Live at 48 kHz or every packet fails.
   ```
   Findings recorded: channel=`Main`, port=9701, `main.cpp`→`verify-apc1.ts` is
   the header-check test (NOT the ramp probe), Link Audio enable is a clean
   Settings toggle, rig must be 48 kHz.

4. **§6.2 quantization feel** + verify `QUANT_BEATS` ✅ **DONE.** Read
   `/live/song/get/clip_trigger_quantization` at three dropdown settings —
   None→0, "1 Bar"→4, "1/4"→7 — all matched the assumed table. `QUANT_BEATS` in
   `hub/src/lifecycle/lifecycle.ts` de-flagged from ASSUMED to verified. (Probe:
   `harnesses/src/quant-verify.ts`.)

---

## Part 7 — TONE3000 ✅ DONE (real A2 model fetched)

The PKCE flow works from the Mac. **Two gotchas the original steps missed:**
- The spike has **no `.env` loader** — run it with Node's `--env-file`:
  ```bash
  cd ~/Aibleton/Aibleton/spikes/tone3000
  nvm use
  node --env-file=.env --import tsx src/fetch-a2-model.ts
  ```
  (`.env` needs `T3K_CLIENT_ID=t3k_pub_…` **and** `T3K_TONE_ID=<an A2 tone id>` —
  the stub fires if EITHER is missing. Use the PUBLISHABLE key, never the secret.)
- Approve the login in the **Mac's own browser**, not a phone (the callback is
  the Mac's LAN IP:47700 — a phone on a different segment times out).

Result: fetched tone 74416 → model 651635 ("Marshall 1987X SE Crunch Mod"),
saved to `spikes/tone3000/out/651635.model` (note: `.model`, not `.nam`). This is
the model §6.1 loads. `load_tone` (Contract 4) is grounded.

---

## Part 8 — End-of-session ritual ☐

```bash
cd ~/Aibleton/Aibleton
git add -A && git commit -m "first rig session: harness results + bench notes"
git push        # or let the analyzer's auto-push handle it
```

Also copy the whole `~/Aibleton` folder somewhere off the Mac. The reports you
filled in are the most valuable artifact — the difference between contracts and
guesses.

### What next session looks like

Phase 1 (template + boot scan) starts with the resolver already written and
tested (`hub/src/resolver/`): build the template `.als` per Contract 7, point a
thin boot-scan script at it, and watch the same tablet from Part 3 light up with
REAL Live behind it.
