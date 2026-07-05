#!/usr/bin/env python3
"""
amxd_wire_udpsend.py — inject `[udpsend HOST PORT]` into a generated .amxd and
wire it to a v8 outlet, so a device can push OSC with no manual Max step.

    python3 amxd_wire_udpsend.py IN.amxd [OUT.amxd] [--host 127.0.0.1] [--port 11000] [--outlet 2]

Finds the `v8` box, adds a `newobj` running `udpsend HOST PORT`, and adds a
patchline from v8 outlet <--outlet> to the udpsend's inlet. Idempotent: if a
udpsend already wired to that outlet exists, it does nothing. Repackages the
mx@c container (recomputing size/offset fields), same as amxd_setnames.py.
"""
import json
import struct
import sys


def load(path):
    d = open(path, "rb").read()
    if d[:4] != b"ampf":
        raise SystemExit("not an .amxd")
    off, ptch = 12, None
    while off + 8 <= len(d):
        typ = d[off:off + 4]
        ln = struct.unpack("<I", d[off + 4:off + 8])[0]
        if typ == b"ptch":
            ptch = (off, ln)
        off += 8 + ln
    if not ptch:
        raise SystemExit("no ptch chunk")
    return d, ptch


def split_mxc(payload):
    if payload[:4] != b"mx@c":
        raise SystemExit("ptch payload not mx@c (frozen device?)")
    json_off = struct.unpack(">I", payload[4:8])[0]
    reserved = struct.unpack(">I", payload[8:12])[0]
    dir_off = struct.unpack(">I", payload[12:16])[0]
    blob = payload[json_off:dir_off]
    dlst = payload[dir_off:]
    je = blob.rfind(b"}")
    return json_off, reserved, dlst, blob[:je + 1], blob[je + 1:]


def set_dlst_sz32(dlst, new_sz):
    out = bytearray(dlst)
    i = out.find(b"sz32")
    if i < 0:
        raise SystemExit("dlst has no sz32")
    struct.pack_into(">I", out, i + 8, new_sz)
    return bytes(out)


def next_id(boxes):
    n = 0
    for b in boxes:
        bid = b["box"].get("id", "")
        if bid.startswith("obj-"):
            try:
                n = max(n, int(bid[4:]))
            except ValueError:
                pass
    return "obj-%d" % (n + 1)


def wire(patcher_text, host, port, outlet, cmd_port):
    p = json.loads(patcher_text)
    pat = p["patcher"]
    boxes = pat["boxes"]
    lines = pat.setdefault("lines", [])

    v8 = next((b["box"]["id"] for b in boxes if b["box"].get("text") == "v8"), None)
    if v8 is None:
        raise SystemExit("no v8 box found")

    added = 0

    def has_box(prefix):
        return next((b["box"]["id"] for b in boxes if b["box"].get("text", "").startswith(prefix)), None)

    def add_box(box):
        nid = next_id(boxes)
        box["id"] = nid
        boxes.append({"box": box})
        return nid

    def add_line(src, dst):
        for l in lines:
            if l["patchline"]["source"] == src and l["patchline"]["destination"] == dst:
                return
        lines.append({"patchline": {"source": src, "destination": dst}})

    # --- report OUT: v8 outlet -> [udpsend HOST PORT] --------------------------
    send_id = has_box("udpsend")
    if send_id is None:
        send_id = add_box({
            "maxclass": "newobj", "text": "udpsend %s %s" % (host, port),
            "numinlets": 1, "numoutlets": 0, "outlettype": [],
            "patching_rect": [10.0, 520.0, 200.0, 22.0],
        })
        added += 1
    add_line([v8, outlet], [send_id, 0])

    # --- command IN: [udpreceive CMD_PORT] -> [route /cmd] -> v8 inlet 0 -------
    recv_id = has_box("udpreceive")
    route_id = has_box("route /cmd")
    if recv_id is None:
        recv_id = add_box({
            "maxclass": "newobj", "text": "udpreceive %s" % cmd_port,
            "numinlets": 0, "numoutlets": 1, "outlettype": [""],
            "patching_rect": [10.0, 560.0, 120.0, 22.0],
        })
        added += 1
    if route_id is None:
        route_id = add_box({
            "maxclass": "newobj", "text": "route /cmd",
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect": [10.0, 590.0, 90.0, 22.0],
        })
        added += 1
    add_line([recv_id, 0], [route_id, 0])
    add_line([route_id, 0], [v8, 0])

    return p, added


def main():
    argv = sys.argv[1:]
    flags = {"--host": "127.0.0.1", "--port": "11000", "--outlet": "2", "--cmd-port": "11002"}
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in flags:
            flags[a] = argv[i + 1]; i += 2
        elif a.startswith("--") and "=" in a:
            k, v = a.split("=", 1); flags[k] = v; i += 1
        else:
            positional.append(a); i += 1
    if not positional:
        raise SystemExit(__doc__)
    src = positional[0]
    dst = positional[1] if len(positional) > 1 else src
    host = flags["--host"]
    port = flags["--port"]
    outlet = int(flags["--outlet"])
    cmd_port = flags["--cmd-port"]

    d, (ptch_off, ptch_len) = load(src)
    payload = d[ptch_off + 8:ptch_off + 8 + ptch_len]
    json_off, reserved, dlst, json_bytes, terminator = split_mxc(payload)

    patcher, added = wire(json_bytes.decode("utf-8"), host, port, outlet, cmd_port)
    if added == 0:
        print("OSC I/O already wired — no change.")

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + terminator
    new_sz = len(new_blob)
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) + struct.pack(">I", json_off + new_sz)
    new_payload = header + new_blob + set_dlst_sz32(dlst, new_sz)
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:ptch_off] + new_ptch)
    print("wired report OUT (v8 outlet %d -> udpsend %s %s) + command IN "
          "(udpreceive %s -> route /cmd -> v8 inlet 0)  ->  %s"
          % (outlet, host, port, cmd_port, dst))


if __name__ == "__main__":
    main()
