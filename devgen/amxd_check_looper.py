#!/usr/bin/env python3
"""
amxd_check_looper.py — off-rig STRUCTURAL regression gate for NAM_A2_Looper.amxd
v2 (LOOPER-HANDOFF R1/R4). Asserts, without Live:

  FROZEN (R1 — must hold or the build is rejected):
    F1. EXACTLY two Live parameters, Long Names "State" + "State Out", both Int,
        in saved_attribute_attributes.valueof (the bucket Live reads).
    F2. The echo path cords exist verbatim:
          State dial      -> v8 inlet 0
          v8 outlet 1     -> State Out dial
          v8 outlet 2     -> udpsend 127.0.0.1 11000
          udpreceive 11002 -> route /cmd -> v8 inlet 0
    F3. The dry passthrough cords plugin~ -> plugout~ (L and R) are untouched.
    F4. Every UI live.text has parameter_enable 0 (adds NO Live param).

  V2 (the new surface must be complete):
    V1. Loop core objects present: buffer~ nam_loop, poke~, index~, phasor~,
        count~, snapshot~, selector~, line~, and the DSP route.
    V2. v8 outlet 0 -> DSP route; all 11 route outlets wired.
    V3. Loop output reaches BOTH plugout~ inlets (sums with dry).
    V4. Buttons wired: each looper_btn_* -> prepend -> v8; v8 outlet 3 -> UI
        route -> prepend set -> each button + the status comment.
    V5. v8 box declares 4 outlets (else Max drops the saved outlet-3 cords).
    V6. Layout: devicewidth/height pinned; every presented rect in bounds;
        openinpresentation.

  Also DIFFS the frozen aspects against a reference v1 device if given.

    python3 amxd_check_looper.py BUILT.amxd [--ref V1.amxd]
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
    by_text_prefix = {}
    params = {}
    for bid, bx in boxes.items():
        t = str(bx.get("text", ""))
        if t.strip():
            by_text_prefix.setdefault(t.split()[0], []).append(bid)
            by_text_prefix.setdefault(t, []).append(bid)
        vo = bx.get("saved_attribute_attributes", {}).get("valueof", {})
        if vo.get("parameter_longname"):
            params[vo["parameter_longname"]] = (bid, vo)
    varnames = {bx.get("varname"): bid for bid, bx in boxes.items() if bx.get("varname")}
    return boxes, lines, by_text_prefix, params, varnames


def first(by, key):
    return by.get(key, [None])[0]


def has_cord(lines, s, so, d, di):
    return (s, so, d, di) in lines


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ref = None
    if "--ref" in sys.argv:
        ref = sys.argv[sys.argv.index("--ref") + 1]
    if not args:
        raise SystemExit(__doc__)

    pat = patcher_of(args[0])
    boxes, lines, by, params, varnames = index(pat)

    print("FROZEN surface (R1):")
    check("F1 exactly two params", sorted(params) == ["State", "State Out"],
          "found %r" % sorted(params))
    check("F1 both params Int (type 1)",
          all(params[n][1].get("parameter_type") == 1 for n in params))

    v8 = first(by, "v8")
    state_id = params.get("State", (None,))[0]
    state_out_id = params.get("State Out", (None,))[0]
    udpsend = first(by, "udpsend")
    udprecv = first(by, "udpreceive")
    route_cmd = first(by, "route /cmd")
    plugin = first(by, "plugin~")
    plugout = first(by, "plugout~")

    check("F2 State dial -> v8", has_cord(lines, state_id, 0, v8, 0))
    check("F2 v8[1] -> State Out dial", has_cord(lines, v8, 1, state_out_id, 0))
    check("F2 v8[2] -> udpsend 127.0.0.1 11000",
          udpsend is not None and has_cord(lines, v8, 2, udpsend, 0)
          and boxes[udpsend]["text"] == "udpsend 127.0.0.1 11000")
    check("F2 udpreceive 11002 -> route /cmd -> v8",
          udprecv is not None and route_cmd is not None
          and boxes[udprecv]["text"] == "udpreceive 11002"
          and has_cord(lines, udprecv, 0, route_cmd, 0)
          and has_cord(lines, route_cmd, 0, v8, 0))
    check("F3 dry passthrough L", has_cord(lines, plugin, 0, plugout, 0))
    check("F3 dry passthrough R", has_cord(lines, plugin, 1, plugout, 1))
    ui_texts = [bx for bx in boxes.values() if bx.get("maxclass") == "live.text"]
    check("F4 all live.text UI-only (parameter_enable 0, no params added)",
          all(bx.get("saved_attribute_attributes", {}).get("valueof", {})
                .get("parameter_enable") == 0 for bx in ui_texts)
          and len(ui_texts) == 7, "found %d live.text" % len(ui_texts))

    print("V2 surface:")
    core = ["buffer~", "poke~", "index~", "phasor~", "count~", "snapshot~",
            "selector~", "line~"]
    check("V1 loop core objects present", all(first(by, t) for t in core),
          "missing %r" % [t for t in core if not first(by, t)])
    rdsp = next((bid for bid, bx in boxes.items()
                 if str(bx.get("text", "")).startswith("route srcsel")), None)
    check("V2 v8[0] -> DSP route", rdsp is not None and has_cord(lines, v8, 0, rdsp, 0))
    if rdsp:
        wired = {so for (s, so, d, di) in lines if s == rdsp}
        check("V2 all 14 DSP route outlets wired", wired >= set(range(14)),
              "wired only %r" % sorted(wired))
    playmul_ok = any(has_cord(lines, s, 0, plugout, 0) and has_cord(lines, s, 0, plugout, 1)
                     for s in boxes if s != plugin
                     and str(boxes[s].get("text", "")).startswith("*~"))
    check("V3 loop output reaches both plugout~ inlets", playmul_ok)

    btns = ["looper_btn_rec", "looper_btn_play", "looper_btn_dub",
            "looper_btn_stop", "looper_btn_clear", "looper_btn_undo",
            "looper_btn_redo"]
    check("V4 all seven buttons present", all(v in varnames for v in btns),
          "missing %r" % [v for v in btns if v not in varnames])
    btn_to_v8 = True
    for v in btns:
        bid = varnames.get(v)
        pres = [d for (s, so, d, di) in lines if s == bid and so == 0]
        hop = pres and any(has_cord(lines, pr, 0, v8, 0) for pr in pres)
        if not hop:
            btn_to_v8 = False
    check("V4 every button -> prepend -> v8", btn_to_v8)
    rui = next((bid for bid, bx in boxes.items()
                if str(bx.get("text", "")).startswith("route ledrec")), None)
    check("V4 v8[3] -> UI route", rui is not None and has_cord(lines, v8, 3, rui, 0))
    if rui:
        fed = set()
        for (s, so, d, di) in lines:
            if s == rui:
                for (s2, so2, d2, di2) in lines:
                    if s2 == d:
                        fed.add(d2)
        targets = ({varnames[v] for v in btns[:4]}
                   | {varnames.get("looper_status"), varnames.get("looper_pos_bar"),
                      varnames.get("looper_btn_undo"), varnames.get("looper_btn_redo"),
                      varnames.get("looper_undo_ind")})
        check("V4 UI route feeds 4 buttons + status + bar + Undo/Redo + indicator",
              targets <= fed, "unfed: %r" % (targets - fed))
    check("V4 status comment present", "looper_status" in varnames)

    print("V2.1 surface (undo + position):")
    check("V7 all three loop buffers present",
          all(first(by, "buffer~ %s 60000" % n) for n in
              ("nam_loop", "nam_loop_undo", "nam_loop_tmp")),
          "missing %r" % [n for n in ("nam_loop", "nam_loop_undo", "nam_loop_tmp")
                          if not first(by, "buffer~ %s 60000" % n)])
    buf_live = first(by, "buffer~ nam_loop 60000")
    buf_undo = first(by, "buffer~ nam_loop_undo 60000")
    buf_tmp = first(by, "buffer~ nam_loop_tmp 60000")
    dup_msgs = {bid: bx["text"] for bid, bx in boxes.items()
                if bx.get("maxclass") == "message"
                and str(bx.get("text", "")).startswith("duplicate ")}
    def feeds(msg_text, target):
        return any(t == msg_text and has_cord(lines, bid, 0, target, 0)
                   for bid, t in dup_msgs.items())
    check("V7 usave copies live -> shadow",
          feeds("duplicate nam_loop", buf_undo))
    check("V7 uswap 3-way swap complete (tmp<-live, live<-shadow, shadow<-tmp)",
          feeds("duplicate nam_loop", buf_tmp)
          and feeds("duplicate nam_loop_undo", buf_live)
          and feeds("duplicate nam_loop_tmp", buf_undo))
    tswap = first(by, "t b b b")
    check("V7 uswap ordered by trigger", tswap is not None
          and len([1 for (s, so, d, di) in lines if s == tswap]) == 3)
    pmet = first(by, "metro 50")
    ppos = first(by, "prepend pos")
    check("V7 position ticker chain metro -> snapshot~ -> prepend pos -> v8",
          pmet is not None and ppos is not None
          and has_cord(lines, ppos, 0, v8, 0)
          and any(has_cord(lines, pmet, 0, s, 0)
                  and has_cord(lines, s, 0, ppos, 0)
                  for s in boxes
                  if str(boxes[s].get("text", "")).startswith("snapshot~")))
    check("V7 position bar present and non-param",
          "looper_pos_bar" in varnames
          and boxes[varnames["looper_pos_bar"]].get("maxclass") == "slider")
    check("V8 take indicator comment present",
          "looper_undo_ind" in varnames
          and boxes[varnames["looper_undo_ind"]].get("maxclass") == "comment")
    check("V5 v8 declares 4 outlets", boxes[v8].get("numoutlets") == 4,
          "numoutlets=%r" % boxes[v8].get("numoutlets"))

    print("layout:")
    check("V6 devicewidth/deviceheight pinned",
          pat.get("devicewidth") == 460.0 and pat.get("deviceheight") == 168.0,
          "%r x %r" % (pat.get("devicewidth"), pat.get("deviceheight")))
    check("V6 openinpresentation", pat.get("openinpresentation") == 1)
    oob = [bx.get("varname") or bx.get("maxclass") for bx in boxes.values()
           if bx.get("presentation") == 1 and bx.get("presentation_rect")
           and (bx["presentation_rect"][0] + bx["presentation_rect"][2] > 460.0
                or bx["presentation_rect"][1] + bx["presentation_rect"][3] > 168.0)]
    check("V6 every presented rect in bounds", not oob, "out of bounds: %r" % oob)

    if ref:
        print("diff vs reference v1 (%s):" % ref)
        rpat = patcher_of(ref)
        _, _, _, rparams, _ = index(rpat)
        check("frozen params identical to v1",
              sorted(rparams) == sorted(params)
              and all(rparams[n][1].get("parameter_type")
                      == params[n][1].get("parameter_type") for n in rparams))

    print()
    if FAILED:
        raise SystemExit("STRUCTURAL GATE FAILED: %r" % FAILED)
    print("structural gate: ALL GREEN")


if __name__ == "__main__":
    main()
