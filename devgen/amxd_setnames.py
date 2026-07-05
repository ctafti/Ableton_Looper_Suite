#!/usr/bin/env python3
"""
amxd_setnames.py — make a js2max-generated .amxd's parameters addressable BY NAME.

THE PROBLEM (verified on the rig 2026-07-05):
  js2max writes parameter_longname / parameter_shortname / parameter_type into
  each live.* box's `saved_object_attributes`. Ableton Live reads parameter names
  from `saved_attribute_attributes.valueof`. So Live IGNORES the intended name and
  falls back to the object's default scripting name (e.g. "live.dial"), and the
  hub — which matches parameters by exact Long Name — can't find them.

THE FIX:
  Move every `parameter*` attribute from `saved_object_attributes` into
  `saved_attribute_attributes.valueof` (the bucket Live reads), then repackage the
  .amxd, recomputing the mx@c container's size/offset fields so the file stays
  valid. Optionally force integer parameters (`--int`).

  This reads whatever Long Name js2max already intended (from `@ui "..."`), so no
  per-device name map is needed — it's generic across generated devices.

USAGE:
  python3 amxd_setnames.py IN.amxd [OUT.amxd] [--int]
    IN.amxd   the js2max output
    OUT.amxd  where to write (default: overwrite IN.amxd)
    --int     also set parameter_type=1 (Int) on every relocated parameter

Container layout (reverse-engineered + verified against js2max@1.1.2 output):
  file  = 'ampf' u32(4) 'aaaa'  |  'meta' u32 <payload>  |  'ptch' u32 <mx@c blob>
  mx@c  = 'mx@c' BE32(json_off=16) BE32(reserved) BE32(dir_off)
          <json bytes> '\n' '\0'                      (== the blob, size = sz32)
          'dlst' directory: … 'sz32'=blob size … 'of32'=json offset(16) …
Only the JSON changes; json_off stays 16, dir_off and sz32 are recomputed.
"""
import json
import struct
import sys


def load(path):
    d = open(path, "rb").read()
    if d[:4] != b"ampf":
        raise SystemExit("not an .amxd (missing 'ampf' magic)")
    # chunks start after the 12-byte ampf header ('ampf' u32 'aaaa')
    off, chunks = 12, []
    while off + 8 <= len(d):
        typ = d[off:off + 4]
        ln = struct.unpack("<I", d[off + 4:off + 8])[0]
        chunks.append((typ, off, ln))
        off += 8 + ln
    return d, chunks


def find_ptch(d, chunks):
    for typ, off, ln in chunks:
        if typ == b"ptch":
            return off, ln
    raise SystemExit("no 'ptch' chunk found")


def split_mxc(payload):
    if payload[:4] != b"mx@c":
        raise SystemExit("ptch payload is not an 'mx@c' container "
                         "(frozen device? this tool expects unfrozen generator output)")
    json_off = struct.unpack(">I", payload[4:8])[0]
    reserved = struct.unpack(">I", payload[8:12])[0]
    dir_off = struct.unpack(">I", payload[12:16])[0]
    blob = payload[json_off:dir_off]           # json bytes + terminator
    dlst = payload[dir_off:]                    # the directory
    # json text ends at the last '}'; the rest of blob is the terminator ('\n\0')
    je = blob.rfind(b"}")
    return json_off, reserved, dlst, blob[:je + 1], blob[je + 1:]


def relocate(patcher_text, force_int):
    p = json.loads(patcher_text)
    moved = 0
    for b in p.get("patcher", {}).get("boxes", []):
        bx = b["box"]
        soa = bx.get("saved_object_attributes")
        if not soa:
            continue
        pk = {k: v for k, v in soa.items() if k.startswith("parameter")}
        if "parameter_longname" not in pk:
            continue
        vo = bx.setdefault("saved_attribute_attributes", {}).setdefault("valueof", {})
        for k, v in pk.items():
            vo[k] = v
            del soa[k]
        if force_int:
            vo["parameter_type"] = 1          # 0=float 1=int 2=enum
        if not soa:
            del bx["saved_object_attributes"]
        moved += 1
    return p, moved


def set_dlst_sz32(dlst, new_sz):
    out = bytearray(dlst)
    i = out.find(b"sz32")
    if i < 0:
        raise SystemExit("dlst directory has no 'sz32' entry")
    struct.pack_into(">I", out, i + 8, new_sz)   # tag(4) + BE32 total-len(4) + BE32 value
    return bytes(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force_int = "--int" in sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    src = args[0]
    dst = args[1] if len(args) > 1 else src

    d, chunks = load(src)
    ptch_off, ptch_len = find_ptch(d, chunks)
    payload = d[ptch_off + 8: ptch_off + 8 + ptch_len]

    json_off, reserved, dlst, json_bytes, terminator = split_mxc(payload)

    patcher, moved = relocate(json_bytes.decode("utf-8"), force_int)
    if moved == 0:
        print("WARNING: no js2max parameters found to relocate "
              "(already fixed, or hand-authored device).")

    new_json = json.dumps(patcher, ensure_ascii=True).encode("utf-8")
    new_blob = new_json + terminator             # keep the SAME terminator bytes
    new_sz = len(new_blob)
    new_dir_off = json_off + new_sz

    header = b"mx@c" + struct.pack(">I", json_off) + struct.pack(">I", reserved) \
        + struct.pack(">I", new_dir_off)
    new_payload = header + new_blob + set_dlst_sz32(dlst, new_sz)
    new_ptch = b"ptch" + struct.pack("<I", len(new_payload)) + new_payload
    out = d[:ptch_off] + new_ptch                # ampf + meta chunks unchanged

    open(dst, "wb").write(out)
    print("relocated %d parameter(s)%s -> %s"
          % (moved, " (forced Int)" if force_int else "", dst))


if __name__ == "__main__":
    main()
