#!/usr/bin/env python3
"""
amxd_settype.py — set parameter_type per-parameter on a generated .amxd, BY NAME.

WHY THIS EXISTS (finding, 2026-07-05):
  `amxd_setnames.py --int` forces parameter_type=1 (Int) on EVERY relocated
  parameter. That was correct for the looper (its whole surface is int), but the
  amp host has a MIXED surface: Model / Rescan / Load OK are int, while
  Input Trim / Output Trim / Quality are FLOAT. Running `--int` on the amp would
  quantize the float trims/quality. So: run amxd_setnames.py WITHOUT --int
  (relocate the Long Names only), then run THIS to set types explicitly.

USAGE:
  python3 amxd_settype.py IN.amxd [OUT.amxd] \
        --int "Model" "Rescan" "Load OK" \
        --float "Input Trim" "Output Trim" "Quality"

  --int NAMES     set parameter_type=1 (Int)   on these Long Names
  --float NAMES   set parameter_type=0 (Float) on these Long Names
  --enum NAMES    set parameter_type=2 (Enum)  on these Long Names

Reuses amxd_setnames.py's verified mx@c container repack (same size/offset math).
Matches params by their relocated `parameter_longname` in saved_attribute_
attributes.valueof, so run AFTER amxd_setnames.py.
"""
import json
import struct
import sys

# reuse the proven container helpers
from amxd_setnames import load, find_ptch, split_mxc, set_dlst_sz32

TYPE = {"--int": 1, "--float": 0, "--enum": 2}


def parse_args(argv):
    positional, want = [], {}   # want: longname -> type code
    i, cur = 0, None
    while i < len(argv):
        a = argv[i]
        if a in TYPE:
            cur = TYPE[a]; i += 1
        elif a.startswith("--"):
            raise SystemExit("unknown flag %s\n%s" % (a, __doc__))
        elif cur is None:
            positional.append(a); i += 1
        else:
            want[a] = cur; i += 1
    return positional, want


def set_types(patcher_text, want):
    p = json.loads(patcher_text)
    seen, changed = set(), 0
    for b in p.get("patcher", {}).get("boxes", []):
        vo = b["box"].get("saved_attribute_attributes", {}).get("valueof", {})
        ln = vo.get("parameter_longname")
        if ln is None:
            continue
        seen.add(ln)
        if ln in want:
            if vo.get("parameter_type") != want[ln]:
                vo["parameter_type"] = want[ln]
                changed += 1
    missing = [n for n in want if n not in seen]
    if missing:
        raise SystemExit("ERROR: these names were not found as parameters: %r\n"
                         "found: %r\n(run amxd_setnames.py first?)" % (missing, sorted(seen)))
    return p, changed


def main():
    positional, want = parse_args(sys.argv[1:])
    if not positional or not want:
        raise SystemExit(__doc__)
    src = positional[0]
    dst = positional[1] if len(positional) > 1 else src

    d, chunks = load(src)
    po, pl = find_ptch(d, chunks)
    payload = d[po + 8: po + 8 + pl]
    json_off, reserved, dlst, json_bytes, term = split_mxc(payload)

    patcher, changed = set_types(json_bytes.decode("utf-8"), want)

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + term
    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", json_off + len(new_blob))
    new_payload = header + new_blob + set_dlst_sz32(dlst, len(new_blob))
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    open(dst, "wb").write(d[:po] + new_ptch)
    print("set types on %d parameter(s) -> %s" % (changed, dst))
    for n, t in sorted(want.items()):
        print("   %-14s type=%d (%s)" % (n, t, {0: "float", 1: "int", 2: "enum"}[t]))


if __name__ == "__main__":
    main()
