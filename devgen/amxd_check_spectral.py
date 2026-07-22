#!/usr/bin/env python3
"""
amxd_check_spectral.py — off-rig STRUCTURAL regression gate for
NAM_A2_Spectral.amxd (Phase 4). Asserts, without Live:

  FROZEN surface:
    F1. ZERO Live parameters (the device is a pure telemetry tap; only the
        implicit "Device On" exists — no parameter_longname anywhere).
    F2. The dry passthrough cords plugin~ -> plugout~ (L and R) are untouched.

  ANALYSIS graph (arch §3 / Contract 6):
    A1. Core objects present: buffer~ ---spec, fft~ 4096 4096 0, poke~ ---spec,
        the mono sum, the two squarers, +~, sqrt~.
    A2. Signal path cords: plugin~ L+R -> mono sum; (windowed) input -> fft~;
        re/im -> squarers -> +~ -> sqrt~ -> poke~ value; fft~ sync -> poke~
        index.
    A3. Hann window chain (unless built --no-window): fft~ sync -> /~ 4096. ->
        cos~ -> *~ -0.5 -> +~ 0.5 -> send~ ---win; receive~ ---win -> window
        multiply -> fft~.
    A4. v8 feed: loadbang -> "setbuf ---spec" message -> v8; live.thisdevice
        -> v8.
    A5. Sender: node.script spectral-sender.js @autostart 1 present; v8
        outlet 0 -> its inlet.
    A6. devicewidth pinned.

    python3 amxd_check_spectral.py BUILT.amxd [--no-window]
Exit 0 = all green (prints each check); nonzero = first failure.
"""
import json
import sys

from amxd_setnames import load, find_ptch, split_mxc

FAILED = []


def check(name, cond, detail=""):
    mark = "\u2713" if cond else "\u2717"
    print("  %s %s%s" % (mark, name, (" — " + detail) if (detail and not cond) else ""))
    if not cond:
        FAILED.append(name)


def patcher_of(path):
    d, chunks = load(path)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    _, _, _, jb, _ = split_mxc(payload)
    return json.loads(jb.decode("utf-8"))["patcher"]


def index(pat):
    boxes = {b["box"]["id"]: b["box"] for b in pat["boxes"]}
    lines = {(l["patchline"]["source"][0], l["patchline"]["source"][1],
              l["patchline"]["destination"][0], l["patchline"]["destination"][1])
             for l in pat.get("lines", [])}
    params = {}
    for bid, bx in boxes.items():
        vo = bx.get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname"):
            params[vo["parameter_longname"]] = bid
    return boxes, lines, params


def first(boxes, prefix):
    return next((bid for bid, bx in boxes.items()
                 if str(bx.get("text", "")).startswith(prefix)), None)


def exact(boxes, text):
    return next((bid for bid, bx in boxes.items() if bx.get("text") == text), None)


def has_cord(lines, s, so, d, di):
    return (s, so, d, di) in lines


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    window = "--no-window" not in sys.argv
    if not args:
        raise SystemExit(__doc__)

    pat = patcher_of(args[0])
    boxes, lines, params = index(pat)

    print("FROZEN surface:")
    check("F1 zero Live parameters", not params, "found %r" % sorted(params))
    plugin = exact(boxes, "plugin~")
    plugout = exact(boxes, "plugout~")
    check("F2 dry passthrough L", plugin and plugout and has_cord(lines, plugin, 0, plugout, 0))
    check("F2 dry passthrough R", plugin and plugout and has_cord(lines, plugin, 1, plugout, 1))

    print("analysis graph:")
    buf = first(boxes, "buffer~ ---spec")
    fft = exact(boxes, "fft~ 4096 4096 0")
    poke = first(boxes, "poke~ ---spec")
    monoin = exact(boxes, "*~ 0.5")
    root = exact(boxes, "sqrt~")
    magsum = exact(boxes, "+~")
    check("A1 core objects present",
          all(x is not None for x in (buf, fft, poke, monoin, root, magsum)),
          "missing %r" % [n for n, x in [("buffer~ ---spec", buf), ("fft~", fft),
                                         ("poke~ ---spec", poke), ("*~ 0.5", monoin),
                                         ("sqrt~", root), ("+~", magsum)] if x is None])
    check("A2 plugin~ L+R -> mono sum",
          has_cord(lines, plugin, 0, monoin, 0) and has_cord(lines, plugin, 1, monoin, 0))
    # squarers: two plain *~ boxes each self-multiplying an fft~ outlet
    sqre = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                 and has_cord(lines, fft, 0, bid, 0) and has_cord(lines, fft, 0, bid, 1)), None)
    sqim = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                 and has_cord(lines, fft, 1, bid, 0) and has_cord(lines, fft, 1, bid, 1)), None)
    check("A2 re/im squarers wired", sqre is not None and sqim is not None)
    check("A2 squares -> +~ -> sqrt~ -> poke~ value",
          sqre and sqim
          and has_cord(lines, sqre, 0, magsum, 0) and has_cord(lines, sqim, 0, magsum, 1)
          and has_cord(lines, magsum, 0, root, 0) and has_cord(lines, root, 0, poke, 0))
    check("A2 fft~ sync -> poke~ index", has_cord(lines, fft, 2, poke, 1))
    check("A2 poke~ carries varname spec_poke (v8 self-namespacing hook)",
          poke is not None and boxes[poke].get("varname") == "spec_poke")

    if window:
        winmul = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                       and has_cord(lines, monoin, 0, bid, 0)
                       and has_cord(lines, bid, 0, fft, 0)), None)
        wdiv = exact(boxes, "/~ 4096.")
        wcos = exact(boxes, "cos~")
        wneg = exact(boxes, "*~ -0.5")
        woff = exact(boxes, "+~ 0.5")
        wsend = first(boxes, "send~ ---win")
        wrecv = first(boxes, "receive~ ---win")
        check("A3 window chain objects",
              all(x is not None for x in (winmul, wdiv, wcos, wneg, woff, wsend, wrecv)))
        check("A3 sync -> Hann -> send~",
              wdiv and wcos and wneg and woff and wsend
              and has_cord(lines, fft, 2, wdiv, 0) and has_cord(lines, wdiv, 0, wcos, 0)
              and has_cord(lines, wcos, 0, wneg, 0) and has_cord(lines, wneg, 0, woff, 0)
              and has_cord(lines, woff, 0, wsend, 0))
        check("A3 receive~ -> window multiply", wrecv and winmul and has_cord(lines, wrecv, 0, winmul, 1))
    else:
        check("A3 windowless: mono sum -> fft~ direct", has_cord(lines, monoin, 0, fft, 0))

    v8 = exact(boxes, "v8")
    thisdev = exact(boxes, "live.thisdevice")
    lb = exact(boxes, "loadbang")
    msg = next((bid for bid, bx in boxes.items() if bx.get("maxclass") == "message"
                and bx.get("text") == "setbuf ---spec"), None)
    check("A4 loadbang -> setbuf message -> v8",
          lb and msg and v8 and has_cord(lines, lb, 0, msg, 0) and has_cord(lines, msg, 0, v8, 0))
    check("A4 live.thisdevice -> v8", thisdev and v8 and has_cord(lines, thisdev, 0, v8, 0))

    node = first(boxes, "node.script ")
    check("A5 node.script sender present (@autostart 1)",
          node is not None and "spectral-sender" in boxes[node]["text"]
          and "@autostart 1" in boxes[node]["text"])
    check("A5 v8 -> node.script", node and v8 and has_cord(lines, v8, 0, node, 0))

    print("layout:")
    check("A6 devicewidth pinned", pat.get("devicewidth") == 120.0,
          "devicewidth=%r" % pat.get("devicewidth"))

    print()
    if FAILED:
        raise SystemExit("STRUCTURAL GATE FAILED: %r" % FAILED)
    print("structural gate: ALL GREEN")


if __name__ == "__main__":
    main()
