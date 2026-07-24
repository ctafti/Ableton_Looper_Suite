#!/usr/bin/env python3
"""
amxd_check_spectral.py — off-rig STRUCTURAL regression gate for
NAM_A2_Spectral.amxd (Phase 4). Asserts, without Live:

  FROZEN surface:
    F1. ZERO Live parameters (the device is a pure telemetry tap; only the
        implicit "Device On" exists — no parameter_longname anywhere).
    F2. The dry passthrough cords plugin~ -> plugout~ (L and R) are untouched.

  ANALYSIS graph (arch §3 / Contract 6 · rev 2026-07-22 = 4x OVERLAP):
    A1. Core objects: buffer~ ---spec, mono sum, and FOUR phase-staggered
        fft~ 4096 4096 {0,1024,2048,3072} instances.
    A2. Per instance: re/im -> squarers -> +~ -> sqrt~ -> poke~ value; that
        fft~'s sync -> its poke~ index; poke~ varnames spec_poke{,1,2,3}
        (v8 retargets ALL of them at load). Plus plugin~ L+R -> mono sum.
    A3. Per instance Hann chain (unless --no-window): sync -> /~ 4096. ->
        cos~ -> *~ -0.5 -> +~ 0.5 -> send~ ---win{j}; receive~ ---win{j} ->
        that instance's window multiply -> its fft~.
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

    print("analysis graph (4x overlap, rev 2026-07-22):")
    buf = first(boxes, "buffer~ ---spec")
    monoin = exact(boxes, "*~ 0.5")
    check("A1 buffer~ ---spec + mono sum present", buf is not None and monoin is not None)
    check("A2 plugin~ L+R -> mono sum",
          monoin and has_cord(lines, plugin, 0, monoin, 0) and has_cord(lines, plugin, 1, monoin, 0))

    def follow(src_id, src_out, text=None, maxclass=None):
        """First box the (src,out) cord lands on, optionally filtered."""
        for (s, so, d, di) in lines:
            if s == src_id and so == src_out:
                bx = boxes.get(d, {})
                if text is not None and bx.get("text") != text:
                    continue
                if maxclass is not None and bx.get("maxclass") != maxclass:
                    continue
                return d
        return None

    OFFSETS = (0, 1024, 2048, 3072)
    for j, off in enumerate(OFFSETS):
        sfx = "" if j == 0 else str(j)
        fft = exact(boxes, "fft~ 4096 4096 %d" % off)
        check("A1 fft~ 4096 4096 %d present" % off, fft is not None)
        if fft is None:
            continue
        sqre = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                     and has_cord(lines, fft, 0, bid, 0) and has_cord(lines, fft, 0, bid, 1)), None)
        sqim = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                     and has_cord(lines, fft, 1, bid, 0) and has_cord(lines, fft, 1, bid, 1)), None)
        magsum = sqre and follow(sqre, 0, text="+~")
        root = magsum and follow(magsum, 0, text="sqrt~")
        poke = root and follow(root, 0)
        check("A2[%d] squarers -> +~ -> sqrt~ -> poke~ value" % off,
              sqre and sqim and magsum and root and poke
              and str(boxes[poke].get("text", "")).startswith("poke~ ---spec")
              and has_cord(lines, sqim, 0, magsum, 1))
        check("A2[%d] own sync -> own poke~ index" % off,
              poke is not None and has_cord(lines, fft, 2, poke, 1))
        check("A2[%d] poke~ varname spec_poke%s (v8 retarget hook)" % (off, sfx),
              poke is not None and boxes[poke].get("varname") == "spec_poke%s" % sfx)

        if window:
            winmul = next((bid for bid, bx in boxes.items() if bx.get("text") == "*~"
                           and has_cord(lines, monoin, 0, bid, 0)
                           and has_cord(lines, bid, 0, fft, 0)), None)
            wdiv = follow(fft, 2, text="/~ 4096.")
            wcos = wdiv and follow(wdiv, 0, text="cos~")
            wneg = wcos and follow(wcos, 0, text="*~ -0.5")
            woff = wneg and follow(wneg, 0, text="+~ 0.5")
            wsend = woff and follow(woff, 0)
            wrecv = next((bid for bid, bx in boxes.items()
                          if bx.get("text") == "receive~ ---win%s" % sfx), None)
            check("A3[%d] sync -> Hann -> send~ ---win%s" % (off, sfx),
                  wdiv and wcos and wneg and woff and wsend
                  and boxes[wsend].get("text") == "send~ ---win%s" % sfx)
            check("A3[%d] receive~ ---win%s -> window multiply -> fft~" % (off, sfx),
                  wrecv is not None and winmul is not None
                  and has_cord(lines, wrecv, 0, winmul, 1))
        else:
            check("A3[%d] windowless: mono sum -> fft~ direct" % off,
                  has_cord(lines, monoin, 0, fft, 0))

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
