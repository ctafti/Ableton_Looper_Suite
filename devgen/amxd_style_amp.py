#!/usr/bin/env python3
"""
amxd_style_amp.py (v3) — Ableton-clean presentation pass for NAM_A2_Amp.amxd,
modeled on Live's own Amp Modeler layout: tone-name bar across the top, a single
aligned knob row, a Reload button, a Load-OK LED. Flat, minimal, in-bounds.

WHAT IT CHANGES (cosmetic + labels only; contract Long Names untouched):
  - Short Names: "Input Trim"->"Gain", "Output Trim"->"Volume" (the dial label in
    Live shows the SHORT name; the hub matches the frozen LONG name, unchanged).
  - Rescan control: live.toggle -> live.text BUTTON labeled "Reload" (same
    parameter, same "Rescan" Long Name — only the widget style changes).
  - Tone-name display (`amp_tone_name` from the wirer) styled as the top bar.
  - Quality hidden (param KEPT for contract). parameter_info descriptions set.
  - Panels on the BACKGROUND layer so controls always render on top.
  - All rects verified inside the device bounds (no more clipped captions).

Run LAST: js2max -> setnames -> settype -> wire_amp -> style_amp
    python3 amxd_style_amp.py NAM_A2_Amp.amxd [OUT.amxd]
Idempotent (style boxes tagged amp_style_* are replaced on re-run).
"""
import json
import struct
import sys

from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32

INFO = {
    "Model":       "Tone selector. Index into models.json; changing it loads that NAM capture and updates Load OK.",
    "Rescan":      "Reload models.json from disk (picks up newly added tones). Does not reload the current tone.",
    "Input Trim":  "Gain: input level trim (dB) into the amp model.",
    "Output Trim": "Volume: output level trim (dB) after the amp model.",
    "Load OK":     "Load receipt (device-set): 1 = the selected model loaded, 0 = load failed. The hub reads this.",
    "Quality":     "Inert on this build: neural~ exposes no A2 quality control. Kept for contract compatibility.",
}
SHORTNAMES = {"Input Trim": "Gain", "Output Trim": "Volume"}

DEVICE_W, DEVICE_H = 460.0, 168.0

FACE  = [0.13, 0.13, 0.13, 1.0]     # flat Live-dark face
BAR   = [0.185, 0.185, 0.185, 1.0]  # top selector bar
TEXT  = [0.90, 0.90, 0.90, 1.0]
MUTED = [0.52, 0.52, 0.52, 1.0]

# one row, NATIVE live.dial width (44 — the knob graphic does not scale to a
# wider rect, which is what threw v3 off-center), centers at exactly 25/50/75%
# of the 460px device: 115, 230, 345 -> x = center - 22.
DIAL_TEXT = [0.88, 0.88, 0.88, 1.0]
# v8 layout (owner direction): TWO dropdowns stacked LEFT (Pack over Tone) drive
# selection; Gain + Volume knobs RIGHT; Model param HIDDEN (hub contract stands,
# it just has no dial — Live crashed when the 0..127 dial was swept: load storm
# into neural~; menus give one clean load per click + the brain debounces).
DIALS = {
    "Input Trim":  [268.0, 50.0, 56.0, 72.0],   # "Gain"   center 296
    "Output Trim": [364.0, 50.0, 56.0, 72.0],   # "Volume" center 392
}
HIDE_PARAMS = ("Quality", "Model")
GEAR_RECT   = [16.0, 44.0, 224.0, 18.0]     # Gear dropdown (DI at slot 0)
MENU_RECT   = [16.0, 68.0, 224.0, 18.0]     # Pack dropdown
TONE_RECT   = [16.0, 92.0, 224.0, 18.0]     # Tone dropdown
MENU_BG     = [0.85, 0.85, 0.85, 1.0]   # match the live.text (Reload) light look
MENU_TX     = [0.10, 0.10, 0.10, 1.0]
LOADOK_RECT = [428.0, 142.0, 16.0, 16.0]
RELOAD_RECT = [16.0, 138.0, 80.0, 18.0]
BROWSE_RECT = [108.0, 138.0, 80.0, 18.0]
NAME_RECT   = [16.0, 17.0, 428.0, 17.0]
BAR_RECT    = [12.0, 12.0, 436.0, 26.0]
CREDIT_RECT = [244.0, 142.0, 60.0, 14.0]


def style(patcher_text):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]

    params, tone_name_box = {}, None
    for b in boxes:
        bx = b["box"]
        vo = bx.get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname"):
            params[vo["parameter_longname"]] = bx
        if bx.get("varname") == "amp_tone_name":
            tone_name_box = bx

    # descriptions + display short names (LONG names untouched)
    for ln, bx in params.items():
        vo = bx.setdefault("saved_attribute_attributes", {}).setdefault("valueof", {})
        if ln in INFO:
            vo["parameter_info"] = INFO[ln]
        if ln in SHORTNAMES:
            vo["parameter_shortname"] = SHORTNAMES[ln]

    # Rescan: convert to a live.text BUTTON labeled Reload (same param)
    if "Rescan" in params:
        rb = params["Rescan"]
        rb["maxclass"] = "live.text"
        rb["mode"] = 1                       # 0 = toggle, 1 = button
        rb["text"] = "Reload"
        rb["texton"] = "Reload"
        rb["numinlets"] = 1
        rb["numoutlets"] = 2
        rb["outlettype"] = ["", ""]

    # clean slate: everything out of presentation; drop old style boxes
    for b in boxes:
        b["box"]["presentation"] = 0
    boxes[:] = [b for b in boxes
                if not str(b["box"].get("varname", "")).startswith("amp_style_")]

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
    add({"maxclass": "panel", "varname": "amp_style_face", "background": 1,
         "presentation": 1, "presentation_rect": [0.0, 0.0, DEVICE_W, DEVICE_H],
         "patching_rect": [900.0, 40.0, DEVICE_W, DEVICE_H],
         "mode": 0, "bgcolor": FACE, "rounded": 4, "border": 0,
         "bordercolor": [0, 0, 0, 0]})
    add({"maxclass": "panel", "varname": "amp_style_bar", "background": 1,
         "presentation": 1, "presentation_rect": BAR_RECT,
         "patching_rect": [900.0, 220.0, BAR_RECT[2], BAR_RECT[3]],
         "mode": 0, "bgcolor": BAR, "rounded": 3, "border": 0,
         "bordercolor": [0, 0, 0, 0]})

    # tone-name bar text (styled in place; fed live by the v8)
    if tone_name_box is not None:
        tone_name_box["presentation"] = 1
        tone_name_box["presentation_rect"] = NAME_RECT
        tone_name_box["textcolor"] = TEXT
        tone_name_box["fontsize"] = 11.0
        tone_name_box["fontface"] = 0
        tone_name_box["textjustification"] = 1

    # controls: one aligned row + LED + button
    for ln, rect in DIALS.items():
        if ln in params:
            params[ln]["presentation"] = 1
            params[ln]["presentation_rect"] = rect
            params[ln]["textcolor"] = DIAL_TEXT
    for ln in HIDE_PARAMS:      # Model + Quality: params live on, no UI
        if ln in params:
            params[ln]["presentation"] = 0
    for b in boxes:             # the wirer's two umenus (UI-only)
        vn = b["box"].get("varname")
        if vn in ("amp_gear_menu", "amp_pack_menu", "amp_tone_menu"):
            mb = b["box"]
            mb["presentation"] = 1
            mb["presentation_rect"] = {"amp_gear_menu": GEAR_RECT,
                                       "amp_pack_menu": MENU_RECT,
                                       "amp_tone_menu": TONE_RECT}[vn]
            mb["bgfillcolor_type"] = "color"
            mb["bgfillcolor_color"] = MENU_BG
            mb["textcolor"] = MENU_TX          # umenu's text attr
            mb["color"] = MENU_TX              # belt-and-suspenders across versions
            mb["elementcolor"] = [0.55, 0.55, 0.55, 1.0]
            mb["arrowcolor"] = [0.15, 0.15, 0.15, 1.0]
            mb["fontsize"] = 11.0
    if "Load OK" in params:
        params["Load OK"]["presentation"] = 1
        params["Load OK"]["presentation_rect"] = LOADOK_RECT
    if "Rescan" in params:
        params["Rescan"]["presentation"] = 1
        params["Rescan"]["presentation_rect"] = RELOAD_RECT
    for b in boxes:  # the wirer's Browse button (live.text, UI-only) — NO custom
        if b["box"].get("varname") == "amp_browse_btn":   # colors: native rendering
            bb = b["box"]                                  # makes it IDENTICAL to
            bb["presentation"] = 1                         # Reload (same class,
            bb["presentation_rect"] = BROWSE_RECT          # same size, same radius)
    # Quality stays presentation=0 (hidden), parameter intact.

    add({"maxclass": "comment", "varname": "amp_style_credit",
         "text": "NAM A2",
         "presentation": 1, "presentation_rect": CREDIT_RECT,
         "patching_rect": [900.0, 260.0, CREDIT_RECT[2], CREDIT_RECT[3]],
         "textcolor": MUTED, "fontsize": 8.0})

    # bounds check: nothing may hang off the device (the clipped-"R" bug)
    for b in boxes:
        bx = b["box"]
        if bx.get("presentation") == 1:
            r = bx.get("presentation_rect")
            if r and (r[0] + r[2] > DEVICE_W or r[1] + r[3] > DEVICE_H):
                raise SystemExit("layout bug: %s exceeds device bounds: %r"
                                 % (bx.get("varname") or bx.get("maxclass"), r))

    # z-order safety ("controls behind the background" report): panels first,
    # passive text next, interactive elements LAST (later boxes render on top).
    def zrank(b):
        bx = b["box"]
        if bx.get("maxclass") == "panel": return 0
        if bx.get("maxclass") == "comment": return 1
        if bx.get("maxclass") in ("umenu", "textbutton", "live.text"): return 3
        return 2
    boxes.sort(key=zrank)   # stable: preserves relative order within ranks

    pat["openinpresentation"] = 1
    # THE v4 OFF-CENTER ROOT CAUSE: js2max hardcodes patcher "devicewidth": 400,
    # so the 460px layout rendered inside a 400px viewport (everything shifted
    # right; the LED fell off the edge). Pin the viewport to the layout.
    pat["devicewidth"] = DEVICE_W
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
    print("styled v4: centered knob row (25/50/75%%), full-width tone bar, "
          "Reload button, Load OK LED bottom-right -> %s" % dst)


if __name__ == "__main__":
    main()
