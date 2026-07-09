#!/usr/bin/env python3
"""
amxd_style_looper.py — presentation pass for NAM_A2_Looper.amxd v2, in the amp
faceplate language (amxd_style_amp.py): dark face, status bar across the top,
one row of big native live.text transport buttons, Clear bottom-left.

WHAT IT CHANGES (cosmetic only; contract Long Names + echo path untouched):
  - Status bar: the wirer's `looper_status` comment centered in the top bar
    (fed live by v8 outlet 3 — OBSERVED state only, per R3's truthful rule).
  - Transport row: Rec / Play / Dub / Stop as 98x48 touch-size buttons. All the
    SAME object class (live.text — the amp learned identical rendering requires
    identical class) with NATIVE colors, so the lit toggle state is Live's own
    highlight.
  - v2.1 position bar: thin display-only slider under the transport row
    (ignoreclick — the playhead is observed truth, not a scrub control).
  - Clear bottom-left (Reload-sized), Undo beside it (the amp's Browse slot),
    "NAM A2" credit bottom-right.
  - `State` and `State Out` dials HIDDEN (presentation 0) — params fully intact
    and OSC-addressable; humans get buttons, the hub keeps its contract.
  - Panels on the BACKGROUND layer; in-bounds check; z-order sort;
    devicewidth/deviceheight pinned (js2max hardcodes 400).

Run LAST: js2max -> setnames --int -> wire_udpsend -> wire_looper -> style_looper
    python3 amxd_style_looper.py NAM_A2_Looper.amxd [OUT.amxd]
Idempotent (style boxes tagged looper_style_* are replaced on re-run).
"""
import json
import struct
import sys

from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32

INFO = {
    "State":     "Looper state command (hub-set): 0=Stop 1=Play 2=Record 3=Overdub. "
                 "Absolute + idempotent. The buttons drive this same state machine.",
    "State Out": "Observed-state receipt (device-set): what the looper is ACTUALLY "
                 "doing. The hub reads this; never set it.",
}

DEVICE_W, DEVICE_H = 460.0, 168.0

FACE = [0.13, 0.13, 0.13, 1.0]
BAR = [0.185, 0.185, 0.185, 1.0]
TEXT = [0.90, 0.90, 0.90, 1.0]
MUTED = [0.52, 0.52, 0.52, 1.0]

BAR_RECT = [12.0, 12.0, 436.0, 26.0]
STATUS_RECT = [16.0, 17.0, 428.0, 17.0]
BTN_Y, BTN_W, BTN_H, BTN_GAP = 58.0, 98.0, 48.0, 12.0
BTN_ORDER = ["looper_btn_rec", "looper_btn_play", "looper_btn_dub", "looper_btn_stop"]
POS_RECT = [16.0, 114.0, 428.0, 10.0]     # playhead bar under the transport row
CLEAR_RECT = [16.0, 138.0, 80.0, 18.0]
UNDO_RECT = [108.0, 138.0, 80.0, 18.0]    # the amp's Browse slot
REDO_RECT = [200.0, 138.0, 80.0, 18.0]
IND_RECT = [292.0, 140.0, 86.0, 14.0]     # take indicator ("take: current/undone")
CREDIT_RECT = [384.0, 142.0, 60.0, 14.0]
HIDE_PARAMS = ("State", "State Out")

POS_BG = [0.10, 0.10, 0.10, 1.0]          # bar trough, slightly darker than face
POS_KNOB = [0.85, 0.85, 0.85, 1.0]        # playhead, matches native button light


def style(patcher_text):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]

    params, by_varname = {}, {}
    for b in boxes:
        bx = b["box"]
        vo = bx.get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname"):
            params[vo["parameter_longname"]] = bx
        if bx.get("varname"):
            by_varname[bx["varname"]] = bx

    need = BTN_ORDER + ["looper_btn_clear", "looper_btn_undo", "looper_btn_redo",
                        "looper_status", "looper_undo_ind", "looper_pos_bar"]
    missing = [v for v in need if v not in by_varname]
    if missing:
        raise SystemExit("style: missing wirer boxes %r — run amxd_wire_looper.py first"
                         % missing)

    # parameter_info on the (hidden) contract params
    for ln, bx in params.items():
        if ln in INFO:
            bx.setdefault("saved_attribute_attributes", {}) \
              .setdefault("valueof", {})["parameter_info"] = INFO[ln]

    # clean slate: everything out of presentation; drop old style boxes
    for b in boxes:
        b["box"]["presentation"] = 0
    boxes[:] = [b for b in boxes
                if not str(b["box"].get("varname", "")).startswith("looper_style_")]

    ctr = [0]
    for b in boxes:
        bid = b["box"].get("id", "")
        if bid.startswith("obj-"):
            try:
                ctr[0] = max(ctr[0], int(bid[4:]))
            except ValueError:
                pass

    def add(box):
        ctr[0] += 1
        box["id"] = "obj-%d" % ctr[0]
        boxes.append({"box": box})

    # panels on the BACKGROUND layer (always behind controls)
    add({"maxclass": "panel", "varname": "looper_style_face", "background": 1,
         "presentation": 1, "presentation_rect": [0.0, 0.0, DEVICE_W, DEVICE_H],
         "patching_rect": [1400.0, 40.0, DEVICE_W, DEVICE_H],
         "mode": 0, "bgcolor": FACE, "rounded": 4, "border": 0,
         "bordercolor": [0, 0, 0, 0]})
    add({"maxclass": "panel", "varname": "looper_style_bar", "background": 1,
         "presentation": 1, "presentation_rect": BAR_RECT,
         "patching_rect": [1400.0, 220.0, BAR_RECT[2], BAR_RECT[3]],
         "mode": 0, "bgcolor": BAR, "rounded": 3, "border": 0,
         "bordercolor": [0, 0, 0, 0]})

    # status readout in the top bar
    st = by_varname["looper_status"]
    st["presentation"] = 1
    st["presentation_rect"] = STATUS_RECT
    st["textcolor"] = TEXT
    st["fontsize"] = 11.0
    st["fontface"] = 0
    st["textjustification"] = 1

    # transport row (native live.text rendering; identical class = identical look)
    x = 16.0
    for vn in BTN_ORDER:
        bx = by_varname[vn]
        bx["presentation"] = 1
        bx["presentation_rect"] = [x, BTN_Y, BTN_W, BTN_H]
        bx["fontsize"] = 12.0
        x += BTN_W + BTN_GAP

    cb = by_varname["looper_btn_clear"]
    cb["presentation"] = 1
    cb["presentation_rect"] = CLEAR_RECT

    ub = by_varname["looper_btn_undo"]
    ub["presentation"] = 1
    ub["presentation_rect"] = UNDO_RECT

    rb2 = by_varname["looper_btn_redo"]
    rb2["presentation"] = 1
    rb2["presentation_rect"] = REDO_RECT

    ind = by_varname["looper_undo_ind"]
    ind["presentation"] = 1
    ind["presentation_rect"] = IND_RECT
    ind["textcolor"] = MUTED
    ind["fontsize"] = 9.0

    # position bar: thin horizontal slider (wider-than-tall = horizontal),
    # trough dark, playhead light; fed set-without-output by the v8's pos stream
    pb = by_varname["looper_pos_bar"]
    pb["presentation"] = 1
    pb["presentation_rect"] = POS_RECT
    pb["bgcolor"] = POS_BG
    pb["knobcolor"] = POS_KNOB
    pb["knobshape"] = 1              # bar-style playhead (falls back fine if ignored)
    pb["ignoreclick"] = 1            # display-only: a click must not scrub/emit

    for ln in HIDE_PARAMS:      # params live on, no dial UI (buttons instead)
        if ln in params:
            params[ln]["presentation"] = 0

    add({"maxclass": "comment", "varname": "looper_style_credit",
         "text": "NAM A2",
         "presentation": 1, "presentation_rect": CREDIT_RECT,
         "patching_rect": [1400.0, 260.0, CREDIT_RECT[2], CREDIT_RECT[3]],
         "textcolor": MUTED, "fontsize": 8.0})

    # bounds check: nothing may hang off the device (the clipped-"R" bug)
    for b in boxes:
        bx = b["box"]
        if bx.get("presentation") == 1:
            r = bx.get("presentation_rect")
            if r and (r[0] + r[2] > DEVICE_W or r[1] + r[3] > DEVICE_H):
                raise SystemExit("layout bug: %s exceeds device bounds: %r"
                                 % (bx.get("varname") or bx.get("maxclass"), r))

    # z-order safety: panels first, passive text next, interactive elements LAST
    def zrank(b):
        bx = b["box"]
        if bx.get("maxclass") == "panel": return 0
        if bx.get("maxclass") == "comment": return 1
        if bx.get("maxclass") in ("umenu", "textbutton", "live.text", "slider"): return 3
        return 2
    boxes.sort(key=zrank)   # stable: preserves relative order within ranks

    pat["openinpresentation"] = 1
    pat["devicewidth"] = DEVICE_W      # js2max hardcodes 400 (API-REALITY finding 3)
    pat["deviceheight"] = DEVICE_H
    return p


def main():
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not positional:
        raise SystemExit(__doc__)
    src = positional[0]
    dst = positional[1] if len(positional) > 1 else src

    d, chunks = load(src)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    json_off, reserved, dlst, json_bytes, term = split_mxc(payload)

    patcher = style(json_bytes.decode("utf-8"))

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + term
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", json_off + len(new_blob))
    new_payload = header + new_blob + set_dlst_sz32(dlst, len(new_blob))
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:po] + new_ptch)
    print("styled: status bar + Rec/Play/Dub/Stop row + position bar + Clear/Undo/Redo + take indicator, "
          "dials hidden, %dx%d -> %s" % (DEVICE_W, DEVICE_H, dst))


if __name__ == "__main__":
    main()
