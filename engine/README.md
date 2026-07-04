# Engine Extension (Deliverable F — added 2026-07-02)

The Python side of Contract 2's `[EXT]` addresses, written **off-rig** against
the real AbletonOSC source. Before this existed, harnesses 02/03/04 probed
addresses that no code implemented — so the first Mac session would have been
"write a Remote Script extension," not "install and test." Now it's the latter.

```
extension.py       ← the handler: every [EXT] address in Contract 2
install.sh         ← idempotent installer (clone/patch/register/compile-check)
test_offline.py    ← mock-Live test of every handler — runs with NO rig
```

## What it implements (all Contract 2 `[EXT]` addresses)

| Address | What | Reply (same address, port 11001) |
| --- | --- | --- |
| `/live/engine/ping` (+ unsolicited `/live/engine/hello` on init) | liveness, arch §13 | `(version, protocol)` |
| `/live/clip/insert_steps` | **batched** automation write, ONE atomic undo (§10) | `(track, clip, ok, reason)` |
| `/live/clip/insert_step` | single-step write | `(track, clip, ok, reason)` |
| `/live/clip/get/envelope` | readback via `value_at_time` — the receipt | `(t, c, d, p, time0, value0, …)` |
| `/live/clip/clear_envelope` | official LOM clear | `(track, clip, ok, reason)` |
| `/live/clip/add_warp_marker` `/move_` `/remove_` | warp markers (LOM) | `(track, clip, ok, reason)` |
| `/live/browser/rescan` | (re)build the name→uri index (§11 stage 1) | `(loadableItemCount)` |
| `/live/browser/query` | look up items — how you get a real `ITEM_URI` | `(query, name0, uri0, …)` |
| `/live/browser/load_item` | **load-and-verify**: select track → load → diff device list (§11 stages 2–3) | `(track, ok, addedIndex, addedName-or-reason)` |
| `/live/looper/set_state` / `/live/looper/get/state` | our M4L looper's `State` param, matched **by name** | `(track, device, observedState)` — `-1` = no State param |
| `/live/song/set/is_ableton_link_enabled` | LOM Link toggle (§14) | `(observed 0/1)` |

Every handler replies with **observed** state or an honest failure reason —
never success-by-assumption (arch §11 stage 3).

## Install (on the Mac, ~1 minute)

```bash
cd engine
./install.sh
```

It finds AbletonOSC in `~/Music/Ableton/User Library/Remote Scripts`
(clones it if missing), copies `extension.py` in, registers the handler in
`__init__.py` + `manager.py` (idempotent — re-running is safe, including after
a `git pull` of AbletonOSC), and byte-compiles so syntax errors surface in the
terminal instead of inside Live. Custom User Library path?
`REMOTE_SCRIPTS="/your/path/Remote Scripts" ./install.sh`.

Then **quit + reopen Live** and confirm AbletonOSC is the selected Control
Surface. The engine announces `/live/engine/hello` on every init.

## Verify

```bash
python3 engine/test_offline.py      # no rig needed — 19 logic checks
cd harnesses && npm run pinger      # rig: stock echo loop
npm run automation                  # rig: seam #1 (Live-12 insert_step signature)
npm run load-item                   # rig: seam #2 (get a URI via /live/browser/query first)
npm run looper                      # rig: seam #3 (needs the M4L looper on the track)
```

## What this does NOT change

The **PROVISIONAL** tags stay until the rig harnesses run: this code proves our
logic is sound (test_offline.py), but only real Live proves `insert_step`'s
Live-12 signature, `load_item`'s reliability, and the looper echo. One
deliberately-flagged softness: `add_warp_marker`'s Python calling convention
varies across Live versions; the handler tries both known conventions and
reports honestly — the rig run pins which one Live 12 uses.
