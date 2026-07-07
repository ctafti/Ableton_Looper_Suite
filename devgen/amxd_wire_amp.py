#!/usr/bin/env python3
"""
amxd_wire_amp.py — inject the neural~ audio graph into a generated NAM_A2_Amp.amxd,
so the amp is built with no manual Max wiring (same technique as
amxd_wire_udpsend.py: add newobj boxes + patchlines, repackage the mx@c container).

Run AFTER amxd_setnames.py + amxd_settype.py, on the device that already has the
six params + v8 + plugin~/plugout~ scaffold:

    python3 amxd_wire_amp.py NAM_A2_Amp.amxd [OUT.amxd] [--info-outlet 1]

WHAT IT DOES (build spec §4):
  - deletes the js2max passthrough  plugin~ -> plugout~  (L and R)
  - adds:  neural~, three *~ (inTrim/outTrim/xfade), two dbtoa, line~, loadmess 1.
  - wires the mono amp chain:
        plugin~ 0 -> *~(inTrim) 0 -> neural~ 0 -> *~(outTrim) 0 -> *~(xfade) 0
                     -> plugout~ 0 AND plugout~ 1
  - trims:  live.dial "Input Trim"  -> dbtoa -> *~(inTrim) right
            live.dial "Output Trim" -> dbtoa -> *~(outTrim) right
  - crossfade + control:
        line~ -> *~(xfade) right ;  loadmess 1. -> line~ (prime to unity)
        v8 outlet 0 -> neural~ 0        (load/prewarm/clear/quality)
        v8 outlet 1 -> line~ 0          (crossfade ramps)
        neural~ <info-outlet> -> v8 inlet 0   (loaded/error/... receipts)

  Idempotent: if a neural~ box already exists it does nothing.

  --info-outlet N : which neural~ outlet carries info (loaded/error/latency/...).
    DEFAULT 1 (outlet 0 = signal, outlet 1 = info/dump — the common layout). If the
    load test never shows `[amp] loaded`, neural~'s info outlet is a different index
    — re-run with the right --info-outlet (VERIFY the object's outlets on the rig).
"""
import json
import struct
import sys

from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32


def next_id(boxes):
    n = 0
    for b in boxes:
        bid = b["box"].get("id", "")
        if bid.startswith("obj-"):
            try:
                n = max(n, int(bid[4:]))
            except ValueError:
                pass
    return n


def find_by_text(boxes, text):
    return next((b["box"]["id"] for b in boxes if b["box"].get("text") == text), None)


def find_param(boxes, longname):
    for b in boxes:
        vo = b["box"].get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname") == longname:
            return b["box"]["id"]
    return None


def wire(patcher_text, info_outlet):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]
    lines = pat.setdefault("lines", [])

    if find_by_text(boxes, "neural~") is not None:
        return p, 0, "neural~ already present — no change"

    plugin = find_by_text(boxes, "plugin~")
    plugout = find_by_text(boxes, "plugout~")
    v8 = find_by_text(boxes, "v8")
    in_trim = find_param(boxes, "Input Trim")
    out_trim = find_param(boxes, "Output Trim")
    missing = [n for n, v in [("plugin~", plugin), ("plugout~", plugout), ("v8", v8),
                              ("Input Trim", in_trim), ("Output Trim", out_trim)] if v is None]
    if missing:
        raise SystemExit("cannot wire — missing objects: %r "
                         "(run amxd_setnames.py + amxd_settype.py first?)" % missing)

    counter = [next_id(boxes)]

    def add(text, ins, outs, x, y, w=90):
        counter[0] += 1
        nid = "obj-%d" % counter[0]
        boxes.append({"box": {
            "id": nid, "maxclass": "newobj", "text": text,
            "numinlets": ins, "numoutlets": outs,
            "outlettype": ["signal" if "~" in text else ""] * outs,
            "patching_rect": [float(x), float(y), float(w), 22.0],
        }})
        return nid

    def cut(src_id, dst_id):
        before = len(lines)
        lines[:] = [l for l in lines
                    if not (l["patchline"]["source"][0] == src_id
                            and l["patchline"]["destination"][0] == dst_id)]
        return before - len(lines)

    def link(src, so, dst, di):
        for l in lines:
            pl = l["patchline"]
            if pl["source"] == [src, so] and pl["destination"] == [dst, di]:
                return
        lines.append({"patchline": {"source": [src, so], "destination": [dst, di]}})

    # remove the js2max passthrough
    removed = cut(plugin, plugout)

    # objects
    neural = add("neural~", 1, max(2, info_outlet + 1), 40, 200, 120)
    in_g = add("*~", 2, 1, 40, 150)
    out_g = add("*~", 2, 1, 40, 260)
    xfade = add("*~", 2, 1, 40, 320)
    in_db = add("dbtoa", 1, 1, 220, 120)
    out_db = add("dbtoa", 1, 1, 220, 230)
    ln = add("line~", 2, 2, 220, 320)
    lm = add("loadmess 1.", 1, 1, 360, 300, 80)

    # audio chain
    link(plugin, 0, in_g, 0)
    link(in_g, 0, neural, 0)
    link(neural, 0, out_g, 0)
    link(out_g, 0, xfade, 0)
    link(xfade, 0, plugout, 0)
    link(xfade, 0, plugout, 1)
    # trims
    link(in_trim, 0, in_db, 0)
    link(in_db, 0, in_g, 1)
    link(out_trim, 0, out_db, 0)
    link(out_db, 0, out_g, 1)
    # control
    link(ln, 0, xfade, 1)
    link(lm, 0, ln, 0)
    link(v8, 0, neural, 0)
    link(v8, 1, ln, 0)
    link(neural, info_outlet, v8, 0)

    # tone-name display: v8 out 3 -> [prepend set] -> a named comment the styler
    # will place on the faceplate. Created here so the cord exists pre-styling.
    prep = add("prepend set", 1, 1, 360, 200, 90)
    counter[0] += 1
    disp_id = "obj-%d" % counter[0]
    boxes.append({"box": {
        "id": disp_id, "maxclass": "comment", "varname": "amp_tone_name",
        "text": "— no tone loaded —",
        "numinlets": 1, "numoutlets": 0,
        "patching_rect": [360.0, 230.0, 220.0, 22.0],
    }})
    link(v8, 3, prep, 0)
    link(prep, 0, disp_id, 0)

    # Browse button (plain textbutton — NOT a live.* param; the frozen six stay
    # frozen) -> a message that opens the TONE3000 bridge in the default browser.
    # The DEVICE does no networking; it just launches a URL (REV 2026-07-05c).
    counter[0] += 1
    btn_id = "obj-%d" % counter[0]
    boxes.append({"box": {
        "id": btn_id, "maxclass": "live.text", "varname": "amp_browse_btn",
        "mode": 1, "text": "Browse", "texton": "Browse",
        "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
        "patching_rect": [500.0, 230.0, 80.0, 18.0],
        "saved_attribute_attributes": {"valueof": {"parameter_enable": 0}},
    }})
    counter[0] += 1
    msg_id = "obj-%d" % counter[0]
    boxes.append({"box": {
        "id": msg_id, "maxclass": "message",
        "text": "; max launchbrowser http://localhost:7333",
        "numinlets": 2, "numoutlets": 1, "outlettype": [""],
        "patching_rect": [500.0, 260.0, 260.0, 22.0],
    }})
    link(btn_id, 0, msg_id, 0)

    # THREE dropdowns (umenus — UI-only, NOT live.* params), mirroring TONE3000's
    # taxonomy: GEAR (v8 out 4; slot 0 = DI) -> PACK (out 8) -> TONE (out 5).
    def add_menu(varname, out_idx, prepend_word, y):
        counter[0] += 1
        mid = "obj-%d" % counter[0]
        boxes.append({"box": {
            "id": mid, "maxclass": "umenu", "varname": varname,
            "numinlets": 1, "numoutlets": 3, "outlettype": ["int", "", ""],
            "parameter_enable": 0,
            "patching_rect": [640.0, float(y), 200.0, 22.0],
        }})
        pr = add("prepend " + prepend_word, 1, 1, 640, y + 30, 96)
        link(v8, out_idx, mid, 0)
        link(mid, 0, pr, 0)
        link(pr, 0, v8, 0)
        return mid
    add_menu("amp_gear_menu", 4, "gear", 190)
    add_menu("amp_pack_menu", 8, "pack", 260)
    add_menu("amp_tone_menu", 5, "tone", 330)

    # DI dry path: guitar -> Volume gain -> gate -> out. The Volume stage is fed
    # by the SAME dbtoa as the wet Output Trim, so "Volume" works identically in
    # DI (0 dB = unity = clean bypass). Gate line~ on v8 outlet 6; Gain dial is
    # greyed (active 0) via v8 outlet 7 while DI is engaged.
    dry_vol = add("*~", 2, 1, 400, 120)
    dry_g = add("*~", 2, 1, 400, 160)
    dry_ln = add("line~", 2, 2, 520, 130)
    dry_lm = add("loadmess 0.", 1, 1, 520, 90, 80)
    link(plugin, 0, dry_vol, 0)
    link(out_db, 0, dry_vol, 1)      # shared Volume dbtoa -> dry gain stage
    link(dry_vol, 0, dry_g, 0)
    link(dry_ln, 0, dry_g, 1)
    link(dry_lm, 0, dry_ln, 0)
    link(dry_g, 0, plugout, 0)
    link(dry_g, 0, plugout, 1)
    link(v8, 6, dry_ln, 0)
    link(v8, 7, in_trim, 0)          # 'active 0/1' messages grey/un-grey Gain

    return p, 22, "added 22 objects, removed %d passthrough cord(s), wired 36 cords" % removed


def main():
    argv = [a for a in sys.argv[1:]]
    info_outlet = 1
    if "--info-outlet" in argv:
        i = argv.index("--info-outlet"); info_outlet = int(argv[i + 1]); del argv[i:i + 2]
    positional = [a for a in argv if not a.startswith("--")]
    if not positional:
        raise SystemExit(__doc__)
    src = positional[0]
    dst = positional[1] if len(positional) > 1 else src

    d, chunks = load(src)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    json_off, reserved, dlst, json_bytes, term = split_mxc(payload)

    patcher, added, msg = wire(json_bytes.decode("utf-8"), info_outlet)
    print(msg + (" (info outlet = %d)" % info_outlet if added else ""))

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + term
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", json_off + len(new_blob))
    new_payload = header + new_blob + set_dlst_sz32(dlst, len(new_blob))
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:po] + new_ptch)
    print("-> %s" % dst)


if __name__ == "__main__":
    main()
