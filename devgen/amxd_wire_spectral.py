#!/usr/bin/env python3
"""
amxd_wire_spectral.py — inject the FFT ANALYSIS GRAPH + the Node-for-Max sender
into a generated NAM_A2_Spectral.amxd (Phase 4 spectral vertical), same
technique as amxd_wire_looper.py: add boxes + patchlines, repackage mx@c.

Run AFTER js2max (the device has NO Live params, so amxd_setnames.py is not
needed — nothing to relocate):

    python3 amxd_wire_spectral.py NAM_A2_Spectral.amxd [OUT.amxd] [--no-window]

WHAT IT INJECTS (arch §3 / Contract 6; v8 does no audio — the graph is dumb):

  1. ANALYSIS CHAIN (mono tap; the dry plugin~ -> plugout~ cords are untouched):
       plugin~ L+R -> [*~ 0.5] mono sum
       -> [*~] window multiply <- [receive~ ---win]
       -> [fft~ 4096 4096 0]
       fft~ sync -> [/~ 4096.] -> [cos~] -> [*~ -0.5] -> [+~ 0.5]
                 -> [send~ ---win]                    (Hann; send~/receive~
                                                       breaks the DSP cycle at
                                                       one vector's offset)
       fft~ re -> [*~ re] \\
       fft~ im -> [*~ im] -> [+~] -> [sqrt~] -> [poke~ ---spec] value
       fft~ sync ------------------------------> [poke~ ---spec] index
       [buffer~ ---spec 100]                     (100 ms @ 48 k >= 4096 samps)
     `---` is Max for Live's per-instance unique-name prefix, so every chain's
     device owns a private buffer (VERIFY-ON-RIG: identical spectra on two
     chains would mean the substitution failed).
     --no-window: rebuild without the Hann chain (escape hatch if the
     send~/receive~ cycle-break fails to load; record the finding).

  2. v8 FEED: [loadbang] -> message "setbuf ---spec" -> v8 inlet 0 (the message
     box text gets the SAME ---substitution, so v8 learns the resolved buffer
     name). Also ensures live.thisdevice -> v8 (bang on load) exists.

  3. SENDER: [node.script spectral-sender.js @autostart 1]; v8 outlet 0 -> its
     inlet. The .js file must be deployed NEXT TO the .amxd (see build script).

  4. Pins devicewidth (no faceplate — the device is invisible plumbing).

Idempotent: if a "buffer~ ---spec" box already exists it does nothing.
FROZEN-SURFACE GUARANTEE: adds ZERO live.* parameters; never touches the dry
passthrough cords.
"""
import json
import struct
import sys

from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32

DEVICE_WIDTH = 120.0


def find_by_text(boxes, text):
    return next((b["box"]["id"] for b in boxes if b["box"].get("text") == text), None)


def find_by_prefix(boxes, prefix):
    return next((b["box"]["id"] for b in boxes
                 if str(b["box"].get("text", "")).startswith(prefix)), None)


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


def wire(patcher_text, window=True, script_path="spectral-sender.js"):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]
    lines = pat.setdefault("lines", [])

    if find_by_prefix(boxes, "buffer~ ---spec") is not None:
        return p, 0, "analysis graph already present — no change"

    plugin = find_by_text(boxes, "plugin~")
    plugout = find_by_text(boxes, "plugout~")
    v8 = find_by_text(boxes, "v8")
    thisdev = find_by_text(boxes, "live.thisdevice")
    missing = [n for n, v in [("plugin~", plugin), ("plugout~", plugout),
                              ("v8", v8)] if v is None]
    if missing:
        raise SystemExit("cannot wire — missing objects: %r (run js2max first?)" % missing)

    counter = [next_id(boxes)]

    def add(text, ins, outs, x, y, w=130, outlettype=None):
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

    # ---- 1. ANALYSIS CHAIN --------------------------------------------------
    add("buffer~ ---spec 100", 1, 2, 700, 40, 160)
    monoin = add("*~ 0.5", 2, 1, 700, 100)
    link(plugin, 0, monoin, 0)
    link(plugin, 1, monoin, 0)                     # cords into one inlet sum

    fft_in_src, fft_in_out = monoin, 0
    if window:
        winmul = add("*~", 2, 1, 700, 150)
        wrecv = add("receive~ ---win", 0, 1, 860, 120, 130)
        link(monoin, 0, winmul, 0)
        link(wrecv, 0, winmul, 1)
        fft_in_src, fft_in_out = winmul, 0

    fft = add("fft~ 4096 4096 0", 2, 3, 700, 200, 140)
    link(fft_in_src, fft_in_out, fft, 0)

    if window:
        wdiv = add("/~ 4096.", 2, 1, 940, 250)
        wcos = add("cos~", 2, 1, 940, 290)
        wneg = add("*~ -0.5", 2, 1, 940, 330)
        woff = add("+~ 0.5", 2, 1, 940, 370)
        wsend = add("send~ ---win", 1, 0, 940, 410, 130)
        link(fft, 2, wdiv, 0)
        link(wdiv, 0, wcos, 0)
        link(wcos, 0, wneg, 0)
        link(wneg, 0, woff, 0)
        link(woff, 0, wsend, 0)

    sqre = add("*~", 2, 1, 660, 260)
    sqim = add("*~", 2, 1, 790, 260)
    link(fft, 0, sqre, 0)
    link(fft, 0, sqre, 1)
    link(fft, 1, sqim, 0)
    link(fft, 1, sqim, 1)
    magsum = add("+~", 2, 1, 700, 310)
    link(sqre, 0, magsum, 0)
    link(sqim, 0, magsum, 1)
    root = add("sqrt~", 1, 1, 700, 350)
    link(magsum, 0, root, 0)
    poke = add("poke~ ---spec", 3, 0, 700, 400, 130)
    # RIG FINDING 2026-07-21: `---` does NOT namespace in js2max-generated
    # devices (two-instance collision observed) — v8 self-namespaces at load:
    # creates a runtime buffer~ with a unique name and retargets this poke~
    # via its `set` message. The varname is how v8 finds it.
    next(b["box"] for b in boxes if b["box"]["id"] == poke)["varname"] = "spec_poke"
    link(root, 0, poke, 0)
    link(fft, 2, poke, 1)                          # sync index -> write index

    # ---- 2. v8 FEED ---------------------------------------------------------
    lb = add("loadbang", 1, 1, 460, 40, 70)
    counter[0] += 1
    msg = add_box({
        "maxclass": "message", "text": "setbuf ---spec",
        "numinlets": 2, "numoutlets": 1, "outlettype": [""],
        "patching_rect": [460.0, 80.0, 110.0, 22.0],
    })
    link(lb, 0, msg, 0)
    link(msg, 0, v8, 0)
    if thisdev is not None:
        link(thisdev, 0, v8, 0)                    # bang on load (idempotent)

    # ---- 3. SENDER ----------------------------------------------------------
    # RIG FINDING 2026-07-21: an EMBEDDED (non-editor) device does not get its
    # own folder on Max's search path, so a bare filename is only found while
    # "Edit in Max" is open. Bake the ABSOLUTE deployed path (machine-specific
    # — single-rig project, recorded; freeze-on-build is the eventual clean fix).
    # Max object boxes split text on spaces — quote a spacey path so it stays
    # ONE atom (rig finding 2026-07-21: an unquoted "User Library" path split
    # into junk args and node.script silently never started).
    sp = '"%s"' % script_path if " " in script_path else script_path
    node = add("node.script %s @autostart 1" % sp, 1, 2, 460, 140, 260,
               outlettype=["", ""])
    link(v8, 0, node, 0)

    # ---- 4. LAYOUT ----------------------------------------------------------
    pat["devicewidth"] = DEVICE_WIDTH

    return p, 1, "analysis graph + sender injected"


def main():
    argv = sys.argv[1:]
    window = "--no-window" not in argv
    script_path = "spectral-sender.js"
    if "--script-path" in argv:
        script_path = argv[argv.index("--script-path") + 1]
    positional = [a for a in argv if not a.startswith("--")
                  and (argv.index(a) == 0 or argv[argv.index(a) - 1] != "--script-path")]
    if not positional:
        raise SystemExit(__doc__)
    src = positional[0]
    dst = positional[1] if len(positional) > 1 else src
    if dst.endswith(".js"):
        raise SystemExit("REFUSING to write an .amxd over a .js file (%s) — "
                         "stale wire script + --script-path mixup? Get the "
                         "current amxd_wire_spectral.py." % dst)

    d, chunks = load(src)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    json_off, reserved, dlst, json_bytes, term = split_mxc(payload)

    patcher, added, note = wire(json_bytes.decode("utf-8"), window=window, script_path=script_path)
    print(note + ("" if window else " (NO WINDOW — record the finding)"))

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + term
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", json_off + len(new_blob))
    new_payload = header + new_blob + set_dlst_sz32(dlst, len(new_blob))
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:po] + new_ptch)
    print("wired -> %s" % dst)


if __name__ == "__main__":
    main()
