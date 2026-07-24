#!/usr/bin/env python3
"""
amxd_strip_browser.py — remove the load-time "open the TONE3000 bridge in a
browser" convenience from NAM_A2_Amp.amxd (owner finding 2026-07-24: every
duplicated chain's amp instance fired it, opening a tab per add_chain).

Surgical: deletes every box whose text mentions `launchbrowser`, plus any
patchlines touching those boxes. Everything else — params, wiring, UI —
untouched. Reuses the proven mx@c container handling from the wire script.

    python3 amxd_strip_browser.py NAM_A2_Amp.amxd [OUT.amxd]

Then RELOAD the Set (rebuilt .amxd is only picked up on Set reload — 07-22).
"""
import json
import struct
import sys

from amxd_wire_spectral import load, find_ptch, split_mxc, set_dlst_sz32


def strip(patcher_text):
    p = json.loads(patcher_text)

    def walk(pat):
        removed = 0
        boxes = pat.get("boxes", [])
        bad_ids = set()
        for b in boxes:
            if "launchbrowser" in str(b.get("box", {}).get("text", "")):
                bad_ids.add(b["box"]["id"])
        if bad_ids:
            pat["boxes"] = [b for b in boxes if b["box"]["id"] not in bad_ids]
            lines = pat.get("lines", [])
            pat["lines"] = [
                ln for ln in lines
                if ln["patchline"]["source"][0] not in bad_ids
                and ln["patchline"]["destination"][0] not in bad_ids
            ]
            removed += len(bad_ids)
        # subpatchers too — the convenience may live one level down
        for b in pat.get("boxes", []):
            sub = b.get("box", {}).get("patcher")
            if sub:
                removed += walk(sub)
        return removed

    removed = walk(p["patcher"])
    return p, removed


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        raise SystemExit(__doc__)
    src = args[0]
    dst = args[1] if len(args) > 1 else src

    d, chunks = load(src)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    json_off, reserved, dlst, json_bytes, term = split_mxc(payload)

    patcher, removed = strip(json_bytes.decode("utf-8"))
    if removed == 0:
        print("no launchbrowser boxes found — device already clean, unchanged")
        return
    print("removed %d launchbrowser box(es) (+ their patchlines)" % removed)

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + term
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", json_off + len(new_blob))
    new_payload = header + new_blob + set_dlst_sz32(dlst, len(new_blob))
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:po] + new_ptch)
    print("stripped -> %s  (now RELOAD the Set so every amp instance picks it up)" % dst)


if __name__ == "__main__":
    main()
