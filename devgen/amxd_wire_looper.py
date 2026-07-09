#!/usr/bin/env python3
"""
amxd_wire_looper.py — inject the LOOP AUDIO CORE + the v2 human UI into a
generated NAM_A2_Looper.amxd (LOOPER-HANDOFF REV 2026-07-06 R3/R4), same
technique as amxd_wire_amp.py: add boxes + patchlines, repackage mx@c.

Run AFTER amxd_setnames.py --int and amxd_wire_udpsend.py, on the device that
already has the two params + v8 + plugin~/plugout~ + the echo OSC I/O:

    python3 amxd_wire_looper.py NAM_A2_Looper.amxd [OUT.amxd]

WHAT IT DOES:
  1. AUDIO CORE (v2 reality fix — the shipped v1 device had NO loop; v8 outlet 0
     was wired to nothing and audio was a plugin~->plugout~ passthrough):
       buffer~ nam_loop 60000 (60 s mono)
       write:  (monoin + read*ovd) -> poke~ value; index -> (idx*wgate + wgate-1)
               -> poke~ index  (poke~ ignores negative indices = write gate)
       read:   index -> index~ -> read; out = read * playgate(line~) summed into
               plugout~ L+R alongside the untouched dry passthrough
       index:  selector~ 2 chooses count~ (fresh record) vs phasor~*len (loop);
               snapshot~ on count~ captures the loop length at record-stop
     All driven by v8 OUTLET 0 via
       [route srcsel freq phase len wgate wminus ovd play snap cnt clear
        usave uswap pmet]
     (looper.js dspPlan/clearPlan own the vocabulary; the graph is dumb.)
  2. HUMAN UI (all UI-only — parameter_enable 0, NO new Live params):
       4x live.text TOGGLES  Rec/Play/Dub/Stop  (varname looper_btn_*)
         -> [prepend btnrec|btnplay|btndub|btnstop] -> v8 inlet 0
       3x live.text BUTTONS  Clear + Undo + Redo -> [prepend btn*] -> v8
       2x comment            looper_status (readout), looper_undo_ind (take)
       1x slider             looper_pos_bar (non-param, set-without-output)
       v8 OUTLET 3 -> [route ledrec ledplay ledstop leddub status pos uact
                       ract uind]
         led* -> [prepend set] -> its button   ("set" = no output: no feedback loop)
         status -> [prepend set] -> looper_status
         pos -> [prepend set] -> looper_pos_bar (playhead fraction 0..1)
         uact/ract -> [prepend active] -> Undo/Redo (grey when unavailable)
         uind -> [prepend set] -> looper_undo_ind ("take: current"/"take: undone")
     Highlights/status are therefore fed ONLY by the v8's transition path (R3's
     truthful rule) — a hub-driven change moves the buttons too.
  3. v2.1 UNDO CORE (BUILD-PLAN §15(b), single-level): buffer~ nam_loop_undo +
     nam_loop_tmp shadows; "usave" copies live->shadow (buffer~ `duplicate`
     message — VERIFY-ON-RIG; fallback = v8 Buffer peek/poke); "uswap" 3-way-
     swaps live<->shadow via [t b b b] (fires right-to-left: tmp<-live,
     live<-shadow, shadow<-tmp). Content-only: State is never touched.
  4. v2.1 POSITION: [metro 50] -> snapshot~ on the SHARED index signal ->
     [prepend pos] -> v8 -> "pos" fraction to the bar. The tap point IS the
     write/read index, so the bar cannot disagree with the audio.
  5. Forces the v8 box to numoutlets=4 (outlet 3 = UI) in case the compiler
     saved fewer — saved cords to a higher outlet than the box declares are
     dropped by Max at load time.

Idempotent: if a "buffer~ nam_loop" box already exists it does nothing.
FROZEN-SURFACE GUARANTEE: adds zero live.* parameters; never touches the State /
State Out boxes, the udpsend/udpreceive echo path, or the dry passthrough cords.
"""
import json
import struct
import sys

from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32

ROUTE_DSP = ("route srcsel freq phase len wgate wminus ovd play snap cnt clear "
             "usave uswap pmet")
ROUTE_UI = "route ledrec ledplay ledstop leddub status pos uact ract uind"
BUTTONS = [  # (varname, prepend selector, label)
    ("looper_btn_rec", "btnrec", "Rec"),
    ("looper_btn_play", "btnplay", "Play"),
    ("looper_btn_dub", "btndub", "Dub"),
    ("looper_btn_stop", "btnstop", "Stop"),
]


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


def find_by_prefix(boxes, prefix):
    return next((b["box"]["id"] for b in boxes
                 if str(b["box"].get("text", "")).startswith(prefix)), None)


def find_param(boxes, longname):
    for b in boxes:
        vo = b["box"].get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname") == longname:
            return b["box"]["id"]
    return None


def wire(patcher_text):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]
    lines = pat.setdefault("lines", [])

    if find_by_prefix(boxes, "buffer~ nam_loop") is not None:
        return p, 0, "loop core already present — no change"

    plugin = find_by_text(boxes, "plugin~")
    plugout = find_by_text(boxes, "plugout~")
    v8 = find_by_text(boxes, "v8")
    state = find_param(boxes, "State")
    state_out = find_param(boxes, "State Out")
    missing = [n for n, v in [("plugin~", plugin), ("plugout~", plugout), ("v8", v8),
                              ("State", state), ("State Out", state_out)] if v is None]
    if missing:
        raise SystemExit("cannot wire — missing objects/params: %r "
                         "(run js2max + amxd_setnames.py --int first?)" % missing)
    if find_by_prefix(boxes, "udpsend") is None:
        raise SystemExit("echo path missing (no udpsend) — run amxd_wire_udpsend.py "
                         "BEFORE this tool so the frozen report path exists")

    # v8 must declare 4 outlets or the saved outlet-3 cords are dropped at load
    for b in boxes:
        if b["box"]["id"] == v8:
            if b["box"].get("numoutlets", 0) < 4:
                b["box"]["numoutlets"] = 4
                b["box"]["outlettype"] = ["", "", "", ""]

    counter = [next_id(boxes)]

    def add(text, ins, outs, x, y, w=110, outlettype=None):
        counter[0] += 1
        nid = "obj-%d" % counter[0]
        boxes.append({"box": {
            "id": nid, "maxclass": "newobj", "text": text,
            "numinlets": ins, "numoutlets": outs,
            "outlettype": outlettype if outlettype is not None
            else (["signal" if "~" in text.split()[0] else ""] * outs),
            "patching_rect": [float(x), float(y), float(w), 22.0],
        }})
        return nid

    def add_box(box):
        counter[0] += 1
        box["id"] = "obj-%d" % counter[0]
        boxes.append({"box": box})
        return box["id"]

    def link(src, so, dst, di):
        for l in lines:
            pl = l["patchline"]
            if pl["source"] == [src, so] and pl["destination"] == [dst, di]:
                return
        lines.append({"patchline": {"source": [src, so], "destination": [dst, di]}})

    # ---- 1. AUDIO CORE ------------------------------------------------------
    buf = add("buffer~ nam_loop 60000", 1, 2, 700, 40, 160)
    monoin = add("*~ 0.5", 2, 1, 700, 100)          # L+R sum (cords sum) * 0.5
    cnt = add("count~", 3, 2, 860, 100)             # fresh-record sample index
    phas = add("phasor~", 2, 1, 700, 150)           # loop index driver
    lenmul = add("*~ 0.", 2, 1, 700, 190)           # phase 0..1 -> samples
    sel = add("selector~ 2", 3, 1, 780, 240)        # 1=count~  2=phasor*len
    readi = add("index~ nam_loop", 1, 2, 780, 290, 130)
    ovdmul = add("*~ 0.", 2, 1, 920, 340)           # read * overdub-feedback
    wsum = add("+~", 2, 1, 700, 390)                # write value = monoin + ovd*read
    wmul = add("*~ 0.", 2, 1, 1080, 290)            # idx * wgate
    wadd = add("+~ -1.", 2, 1, 1080, 340)           # + (wgate-1)  -> -1 disables poke~
    poke = add("poke~ nam_loop", 3, 0, 700, 440, 130)
    playln = add("line~", 2, 2, 920, 390)           # click-free play gate
    playmul = add("*~", 2, 1, 780, 440)             # read * playgate -> out
    snap = add("snapshot~", 2, 1, 860, 150)         # length capture on bang
    psamps = add("prepend samps", 1, 1, 860, 190, 100)
    tclear = add("t clear", 1, 1, 1200, 190, 60)
    rdsp = add(ROUTE_DSP, 1, 15, 700, 520, 560,
               outlettype=[""] * 15)

    # v2.1 UNDO: shadow + tmp buffers; instant control-rate copies via buffer~'s
    # `duplicate <source>` message (VERIFY-ON-RIG; fallback = v8 Buffer peek/poke).
    buf_undo = add("buffer~ nam_loop_undo 60000", 1, 2, 1200, 40, 190)
    buf_tmp = add("buffer~ nam_loop_tmp 60000", 1, 2, 1200, 80, 190)
    musave = add_box({"maxclass": "message", "text": "duplicate nam_loop",
                      "numinlets": 2, "numoutlets": 1, "outlettype": [""],
                      "patching_rect": [1200.0, 240.0, 140.0, 22.0]})
    # 3-way swap, strict order via trigger (fires RIGHT to LEFT):
    #   (1) tmp <- live   (2) live <- shadow   (3) shadow <- tmp
    tswap = add("t b b b", 1, 3, 1200, 290, 70, outlettype=["bang"] * 3)
    mswap1 = add_box({"maxclass": "message", "text": "duplicate nam_loop",
                      "numinlets": 2, "numoutlets": 1, "outlettype": [""],
                      "patching_rect": [1360.0, 330.0, 140.0, 22.0]})
    mswap2 = add_box({"maxclass": "message", "text": "duplicate nam_loop_undo",
                      "numinlets": 2, "numoutlets": 1, "outlettype": [""],
                      "patching_rect": [1280.0, 370.0, 170.0, 22.0]})
    mswap3 = add_box({"maxclass": "message", "text": "duplicate nam_loop_tmp",
                      "numinlets": 2, "numoutlets": 1, "outlettype": [""],
                      "patching_rect": [1200.0, 410.0, 165.0, 22.0]})

    # v2.1 POSITION: 50 ms ticker sampling the SHARED index signal (the same
    # signal that writes and reads — the bar cannot disagree with the audio).
    pmet = add("metro 50", 2, 1, 940, 240, 70)
    possnap = add("snapshot~", 2, 1, 940, 290)
    ppos = add("prepend pos", 1, 1, 940, 330, 90)

    # input: both plugin~ channels sum into the mono stage
    link(plugin, 0, monoin, 0)
    link(plugin, 1, monoin, 0)
    # index sources
    link(cnt, 0, sel, 1)
    link(phas, 0, lenmul, 0)
    link(lenmul, 0, sel, 2)
    # read + write
    link(sel, 0, readi, 0)
    link(sel, 0, wmul, 0)
    link(readi, 0, ovdmul, 0)
    link(monoin, 0, wsum, 0)
    link(ovdmul, 0, wsum, 1)
    link(wsum, 0, poke, 0)
    link(wmul, 0, wadd, 0)
    link(wadd, 0, poke, 1)
    # playback (sums with the untouched dry passthrough cords at plugout~)
    link(readi, 0, playmul, 0)
    link(playln, 0, playmul, 1)
    link(playmul, 0, plugout, 0)
    link(playmul, 0, plugout, 1)
    # length capture: count~ -> snapshot~ -(bang)-> prepend samps -> v8
    link(cnt, 0, snap, 0)
    link(snap, 0, psamps, 0)
    link(psamps, 0, v8, 0)
    # v2.1 position: shared index -> snapshot~ <- metro 50 -> prepend pos -> v8
    link(sel, 0, possnap, 0)
    link(pmet, 0, possnap, 0)
    link(possnap, 0, ppos, 0)
    link(ppos, 0, v8, 0)
    # v2.1 undo: usave copies live -> shadow; uswap 3-way swaps (right-to-left)
    link(musave, 0, buf_undo, 0)
    link(tswap, 2, mswap1, 0)          # (1) tmp    <- live
    link(mswap1, 0, buf_tmp, 0)
    link(tswap, 1, mswap2, 0)          # (2) live   <- shadow
    link(mswap2, 0, buf, 0)
    link(tswap, 0, mswap3, 0)          # (3) shadow <- tmp
    link(mswap3, 0, buf_undo, 0)
    # v8 DSP control fan-out (outlet order == ROUTE_DSP word order)
    link(v8, 0, rdsp, 0)
    link(rdsp, 0, sel, 0)        # srcsel
    link(rdsp, 1, phas, 0)       # freq
    link(rdsp, 2, phas, 1)       # phase
    link(rdsp, 3, lenmul, 1)     # len
    link(rdsp, 4, wmul, 1)       # wgate
    link(rdsp, 5, wadd, 1)       # wminus
    link(rdsp, 6, ovdmul, 1)     # ovd
    link(rdsp, 7, playln, 0)     # play (list: target ms)
    link(rdsp, 8, snap, 0)       # snap (bang)
    link(rdsp, 9, cnt, 0)        # cnt (bang restarts the counter)
    link(rdsp, 10, tclear, 0)    # clear
    link(rdsp, 11, musave, 0)    # usave (bang -> duplicate message)
    link(rdsp, 12, tswap, 0)     # uswap
    link(rdsp, 13, pmet, 0)      # pmet (1/0 starts/stops the position metro)
    link(tclear, 0, buf, 0)

    # ---- 2. HUMAN UI --------------------------------------------------------
    x = 40
    for varname, selword, label in BUTTONS:
        bid = add_box({
            "maxclass": "live.text", "varname": varname,
            "mode": 0,                                # toggle: latches = highlight
            "text": label, "texton": label,
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect": [float(x), 640.0, 70.0, 22.0],
            "saved_attribute_attributes": {"valueof": {"parameter_enable": 0}},
        })
        pre = add("prepend " + selword, 1, 1, x, 680, 90)
        link(bid, 0, pre, 0)
        link(pre, 0, v8, 0)
        x += 110
    clear_btn = add_box({
        "maxclass": "live.text", "varname": "looper_btn_clear",
        "mode": 1,                                    # momentary button
        "text": "Clear", "texton": "Clear",
        "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
        "patching_rect": [float(x), 640.0, 70.0, 22.0],
        "saved_attribute_attributes": {"valueof": {"parameter_enable": 0}},
    })
    pclear = add("prepend btnclear", 1, 1, x, 680, 100)
    link(clear_btn, 0, pclear, 0)
    link(pclear, 0, v8, 0)
    x += 110

    # v2.1/v2.2 Undo + Redo (single-level history; content-only, never touch State)
    undo_btn = add_box({
        "maxclass": "live.text", "varname": "looper_btn_undo",
        "mode": 1,                                    # momentary button
        "text": "Undo", "texton": "Undo",
        "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
        "patching_rect": [float(x), 640.0, 70.0, 22.0],
        "saved_attribute_attributes": {"valueof": {"parameter_enable": 0}},
    })
    pundo = add("prepend btnundo", 1, 1, x, 680, 100)
    link(undo_btn, 0, pundo, 0)
    link(pundo, 0, v8, 0)
    x += 110
    redo_btn = add_box({
        "maxclass": "live.text", "varname": "looper_btn_redo",
        "mode": 1,                                    # momentary button
        "text": "Redo", "texton": "Redo",
        "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
        "patching_rect": [float(x), 640.0, 70.0, 22.0],
        "saved_attribute_attributes": {"valueof": {"parameter_enable": 0}},
    })
    predo = add("prepend btnredo", 1, 1, x, 680, 100)
    link(redo_btn, 0, predo, 0)
    link(predo, 0, v8, 0)

    status = add_box({
        "maxclass": "comment", "varname": "looper_status",
        "text": "STOPPED \u00b7 empty",
        "numinlets": 1, "numoutlets": 0,
        "patching_rect": [40.0, 720.0, 220.0, 22.0],
    })

    # v2.2 take indicator: which version is live ("take: current"/"take: undone")
    takeind = add_box({
        "maxclass": "comment", "varname": "looper_undo_ind",
        "text": " ",
        "numinlets": 1, "numoutlets": 0,
        "patching_rect": [40.0, 745.0, 160.0, 22.0],
    })

    # v2.1 position bar: plain (non-parameter) slider, set-without-output.
    # floatoutput+size 1.0 -> a 0..1 float slider; nothing is wired FROM it.
    posbar = add_box({
        "maxclass": "slider", "varname": "looper_pos_bar",
        "floatoutput": 1, "size": 1.0, "min": 0.0,
        "numinlets": 1, "numoutlets": 1, "outlettype": [""],
        "patching_rect": [300.0, 720.0, 140.0, 20.0],
    })

    rui = add(ROUTE_UI, 1, 10, 40, 780, 480, outlettype=[""] * 10)
    link(v8, 3, rui, 0)
    # ROUTE_UI word order: ledrec ledplay ledstop leddub status pos uact ract uind
    led_targets = [("looper_btn_rec", 0), ("looper_btn_play", 1),
                   ("looper_btn_stop", 2), ("looper_btn_dub", 3)]
    ids = {b["box"].get("varname"): b["box"]["id"] for b in boxes}
    for varname, out_idx in led_targets:
        pset = add("prepend set", 1, 1, 40 + out_idx * 90, 820, 80)
        link(rui, out_idx, pset, 0)
        link(pset, 0, ids[varname], 0)
    pstat = add("prepend set", 1, 1, 400, 820, 80)
    link(rui, 4, pstat, 0)
    link(pstat, 0, status, 0)
    ppset = add("prepend set", 1, 1, 490, 820, 80)   # pos -> set -> slider
    link(rui, 5, ppset, 0)
    link(ppset, 0, posbar, 0)
    puact = add("prepend active", 1, 1, 580, 820, 90)  # uact -> grey/un-grey Undo
    link(rui, 6, puact, 0)
    link(puact, 0, undo_btn, 0)
    pract = add("prepend active", 1, 1, 675, 820, 90)  # ract -> grey/un-grey Redo
    link(rui, 7, pract, 0)
    link(pract, 0, redo_btn, 0)
    pind = add("prepend set", 1, 1, 770, 820, 80)      # uind -> take indicator
    link(rui, 8, pind, 0)
    link(pind, 0, takeind, 0)

    return p, counter[0], ("injected loop core + UI: buffer~/poke~/index~ graph "
                           "+ undo shadow/tmp buffers + position ticker, "
                           "4 transport toggles + Clear + Undo/Redo + take "
                           "indicator + status readout + position bar, "
                           "%d cords total" % len(lines))


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

    patcher, _, msg = wire(json_bytes.decode("utf-8"))
    print(msg)

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
