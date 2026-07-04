# FIRST MAC SESSION — v2 (2026-07-02)

> Supersedes the earlier FIRST-MAC-SESSION.md. Rewritten because the ground
> shifted under it in a good way: the engine extension now ships with a
> one-command installer, the hub's core modules + a fake-Live simulator + the
> tablet shell are prebuilt and tested, and the audio sidecar has already
> passed its full seam test on Linux. Your first session is now mostly
> **install, verify, and measure** — very little "write code and hope."

**You need:** the Mac (with Ableton Live 12.4+ Suite installed and opened at
least once), the tablet, the MOTU M4, a guitar, and `nam-a2-foundation.zip`.
Have your AI coding assistant open throughout — every step below is
copy-pasteable, and when something fails, paste the exact error to the AI.

**Golden rule for the whole session:** when a step's output disagrees with
what this guide predicts, that's not a problem — that's DATA. Record it in
`reports/API-REALITY.md` and keep going.

---

## Part 1 — Mac command-line setup (~20 min, one time)

Open **Terminal** (⌘-space, type "terminal").

```bash
# 1. Apple's developer tools (compiler, git). A dialog pops up — click Install.
xcode-select --install

# 2. Homebrew (the Mac package manager). It prints follow-up commands at the
#    end — RUN THOSE TOO (they add brew to your PATH).
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 3. Node 22+ and cmake (cmake is for the sidecar later)
brew install node cmake
node --version    # expect v22 or newer
```

## Part 2 — Unpack the foundation and prove it works HERE (~10 min)

```bash
mkdir -p ~/nam-a2 && cd ~/nam-a2
unzip ~/Downloads/nam-a2-foundation.zip
cd nam-a2-foundation

# install dependencies for every package that has them
npm install                      # root (contracts typecheck)
(cd harnesses && npm install)
(cd spikes/tone3000 && npm install)
(cd hub && npm install)

# the whole off-rig proof suite should pass on the Mac exactly as it did off it:
npm run typecheck:contracts     # contracts: clean
(cd hub && npm test)             # expect: 35 pass, 0 fail
python3 engine/test_offline.py   # expect: ALL CHECKS PASS (19 checks)
```

If all three pass, freeze this moment:

```bash
git init && git add -A && git commit -m "foundation baseline: all off-rig tests green on the Mac"
```

From now on, commit after every working step. `git commit -am "message"` is
your save button; `git log --oneline` is your trail of working states.

## Part 3 — Touch the tool on day one: run the simulator (~5 min)

Before Live is involved at all, feel the instrument:

```bash
cd hub && npm run sim
```

Open `http://localhost:8420` on the Mac, then find the Mac's IP (System
Settings → Wi-Fi → Details) and open `http://<that-ip>:8420` **on the
tablet**. Fire clips, watch the queued countdown snap to the bar, tap a row
header to move the LIVE glow, pull faders. Then restart it as
`FAIL_RATE=0.3 npm run sim` and watch commands fail and revert calmly —
that's arch §12 working. Everything you see is the real Phase-2 tablet shell
speaking the real frozen protocol; the only fake thing is Live.

## Part 4 — Install the engine extension into Live (~10 min)

```bash
cd ~/nam-a2/nam-a2-foundation
bash engine/install.sh
```

The script clones AbletonOSC into Live's Remote Scripts folder if missing,
copies `extension.py` in, patches it into the handler list, and syntax-checks
everything. Then, in Live:

1. Settings → Link/Tempo/MIDI → **Control Surface: AbletonOSC**.
2. Settings → Record/Warp/Launch → **Exclusive Arm: OFF** (arch §17 needs
   hub-controlled multi-arm).
3. Watch Live's status bar for "AbletonOSC: Listening for OSC on port 11000".

## Part 5 — The harness gauntlet (~45 min, the heart of the session)

Run from `harnesses/`, in this order, **with Live open**. After each one,
paste its output into `reports/API-REALITY.md` under a "RIG RESULTS" heading
— confirmations and surprises alike.

```bash
cd harnesses

# 1. Baseline: does OSC round-trip at all, and how fast?
node --experimental-strip-types src/01-latency.ts

# 2. Is OUR extension alive inside Live?
node --experimental-strip-types src/05-extension-pinger.ts
#    expect /live/ext/hello to answer with the extension version

# 3. Looper param control (drop a stock Looper on track 1, device slot 2 first;
#    DEVICE env overrides if yours sits elsewhere)
node --experimental-strip-types src/04-looper-state.ts

# 4. Browser load: first ask the boot index for a real URI, then load it
#    (the harness prints how to get ITEM_URI via /live/browser/query)
node --experimental-strip-types src/02-load-item-verify.ts
#    then: ITEM_URI="<uri from the query>" node --experimental-strip-types src/02-load-item-verify.ts

# 5. The big one: clip-envelope automation writes + readback
node --experimental-strip-types src/03-automation-envelope.ts
```

Harness 03 passing = §10 movement design is REAL. Any [EXT] failure is an
`engine/extension.py` bug — paste the error + `Log.txt` (Live's log, findable
via Live's Preferences folder) to your AI.

## Part 6 — Bench experiments from arch §6 (~1 hr, guitar in hand)

You now have everything needed for the §6 list. Priority order for session 1:

1. **§6.1 amp-host bring-up (rev 2026-07-03)** — clone + build the `neural~`
   Max external (repo ships a Mac build script), wrap it in a minimal
   `NAM_A2_Amp.amxd` with the Contract-7 param names, load a TONE3000 A2 model
   via the `Model` param, and run the model-swap click test mid-sustain.
   Gateway (the official plugin) is your stopgap + A/B reference meanwhile —
   nothing blocks on the M4L build.
2. **§6.9 THE FEEL TEST (new)** — build 2 chains in a throwaway set, record a
   clip on chain A, play it back while noodling live on chain B for ten
   minutes. Then try to noodle on chain A *while its own clip plays* — you
   can't (monitoring vs playback is mutually exclusive per track, arch §17).
   The question that decides the summing-pair contingency: **did that limit
   annoy you in real playing, or did the looper cover it?** Write the answer
   in `reports/PROVISIONAL-SEAMS.md`.
3. **§6.5 Link Audio on the rig** — Live: enable Link + Link Audio, publish
   Main. Build & run the sidecar (already proven on Linux, see
   `sidecar-experiment/FINDINGS.md`):
   ```bash
   cd sidecar && cmake -B build -DLINK_DIR=../sidecar-experiment/link && cmake --build build
   node --experimental-strip-types ../sidecar-experiment/verify-apc1.ts 47615 &
   ./build/nam_a2_sidecar        # NAM_CHANNEL=<name> if Live's channel isn't "main"-ish
   ```
   The one unknown left is what Live names its published channel — the
   sidecar prints every channel it sees, so the answer appears on screen.
4. **§6.2 quantization feel** + verify `QUANT_BEATS` (one OSC read:
   `/live/song/get/clip_trigger_quantization` at a few settings — see the
   flagged table in `hub/src/lifecycle/lifecycle.ts`).

## Part 7 — TONE3000 while you're at it (~10 min)

```bash
cd spikes/tone3000 && npm start   # PKCE login in the browser, fetches one A2 model
```

Confirms your account + the API from the Mac, and leaves a real `.nam` file
for the first template.

## Part 8 — End-of-session ritual

```bash
git add -A && git commit -m "first rig session: harness results + bench notes"
```

Also copy the whole `~/nam-a2` folder somewhere off the Mac (external drive
or cloud). The reports you filled in today are the most valuable artifact —
they're the difference between contracts and guesses.

### What next session looks like

With today's results recorded, Phase 1 (template + boot scan) starts with the
resolver already written and tested (`hub/src/resolver/`) — the session is:
build the template .als per Contract 7, point a thin boot-scan script at it,
and watch the same tablet from Part 3 light up with REAL Live behind it.
