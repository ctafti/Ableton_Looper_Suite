#!/usr/bin/env python3
"""
tone3000_bridge.py — browse TONE3000, click a tone, and it lands on the amp.

WHAT IT IS: the hub's TONE3000 module arriving early, as a standalone localhost
bridge (Python stdlib only, no installs). The M4L device stays OFFLINE — its
"Browse" button just opens this bridge in your browser. Flow:

  Browse button on the amp
    -> http://localhost:7333  (this bridge)
    -> redirects to TONE3000's own catalog (Select OAuth flow, PKCE,
       architecture=2 = NAM A2; their docs recommend this over the
       rate-limited search endpoint)
    -> you browse & pick a tone on tone3000.com
    -> TONE3000 redirects back here with tone_id (+ model_id if you picked one)
    -> bridge exchanges the code, lists the tone's A2 models, downloads them
       (Bearer auth) into the models folder ROOT as .nam
    -> bridge sets Rescan=1 over AbletonOSC -> the DEVICE adopts the files into
       models.json (drop-and-Reload, REV 2026-07-05b) -> bridge reads the
       manifest to learn the new index -> sets Model=<index> -> the tone plays.

SETUP (once):
  1) Get your publishable API key from tone3000.com account settings.
  2) echo 'YOUR_KEY' > ~/Aibleton/Aibleton/.tone3000_key
     (or export TONE3000_KEY=...)
  3) In TONE3000 Settings -> API Keys, localhost redirect URIs are allowed in
     dev automatically; otherwise add http://localhost:7333/callback

RUN:
  python3 tone3000_bridge.py                # serves http://localhost:7333
  python3 tone3000_bridge.py --no-osc       # download only; you hit Reload+Model
  options: --port 7333  --models-dir ~/Aibleton/Aibleton/models
           --track 0 --device 0             # where the amp sits in Live

Tokens are cached in ~/.t3k_tokens.json (refresh supported). The device's param
indices are resolved BY NAME over OSC (never assumed).
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

T3K = "https://www.tone3000.com"
ARCH_A2 = 2

# TONE3000 gear slugs -> the folder labels used by the device's Gear dropdown.
# Field read defensively (tone.gears list, tone.gear string); unknown slugs get
# title-cased; missing -> "Other". The bridge status line prints the label so
# the rig teaches us the real field name on first use.
GEAR_LABELS = {
    "amp": "Amp Head", "amp-head": "Amp Head",
    "full-rig": "Amp + Cab", "amp-cab": "Amp + Cab", "full_rig": "Amp + Cab",
    "cab": "Cabinet", "cabinet": "Cabinet",
    "pedal": "Pedal", "outboard": "Outboard",
    "space": "Spaces", "spaces": "Spaces",
    "experimental": "Experimental",
}


def gear_label(tone):
    g = tone.get("gears") or tone.get("gear")
    if isinstance(g, (list, tuple)) and g:
        g = g[0]
    if isinstance(g, dict):
        g = g.get("slug") or g.get("name")
    if not isinstance(g, str) or not g.strip():
        return "Other"
    slug = g.strip().lower().replace(" ", "-")
    return GEAR_LABELS.get(slug, g.strip().title())

CFG = {
    "port": 7333,
    "models_dir": os.path.expanduser("~/Aibleton/Aibleton/models"),
    "track": 0, "device": 0,
    "osc_host": "127.0.0.1", "osc_send_port": 11000, "osc_recv_port": 11001,
    "no_osc": False,
}
TOKENS_PATH = os.path.expanduser("~/.t3k_tokens.json")
STATE = {"verifier": None, "state": None, "last": "idle"}


# ─── PKCE ─────────────────────────────────────────────────────────────────────
def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def make_pkce():
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state = b64url(secrets.token_bytes(16))
    return verifier, challenge, state


def authorize_url(key, redirect_uri, challenge, state):
    q = {
        "client_id": key,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "prompt": "select_tone",
        # PLAYABILITY filter (2026-07-06f): format=nam scopes the catalog to
        # NAM-format tones — everything the amp can actually play — instead of
        # filtering by gear category (which cut off Full Rigs before). IR-only
        # tones (most Spaces) won't appear; a Spaces tone that IS a NAM capture
        # will, correctly. No `gears` filter. AIDA-X (also neural~-playable) is
        # deliberately excluded until tested end-to-end; widen to
        # "format": "nam_aida-x" then. architecture=2 (A2) stays explicit.
        "format": "nam",
        "architecture": str(ARCH_A2),
    }
    return T3K + "/api/v1/oauth/authorize?" + urllib.parse.urlencode(q)


# ─── HTTP to TONE3000 ─────────────────────────────────────────────────────────
def http_json(url, data=None, headers=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    if data:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def exchange_code(key, code, verifier, redirect_uri):
    return http_json(T3K + "/api/v1/oauth/token", data={
        "grant_type": "authorization_code", "code": code,
        "code_verifier": verifier, "redirect_uri": redirect_uri,
        "client_id": key,
    })


def refresh(key, refresh_token):
    return http_json(T3K + "/api/v1/oauth/token", data={
        "grant_type": "refresh_token", "refresh_token": refresh_token,
        "client_id": key,
    })


def load_tokens():
    try:
        return json.load(open(TOKENS_PATH))
    except Exception:
        return None


def save_tokens(t):
    t = dict(t)
    if "expires_in" in t:
        t["expires_at"] = time.time() + t["expires_in"]
    json.dump(t, open(TOKENS_PATH, "w"))
    return t


def bearer(key):
    t = load_tokens()
    if not t:
        return None
    if t.get("expires_at", 0) < time.time() + 60 and t.get("refresh_token"):
        try:
            t = save_tokens(refresh(key, t["refresh_token"]))
        except Exception as e:
            print("token refresh failed:", e)
            return None
    return t.get("access_token")


def api_get(key, path):
    tok = bearer(key)
    req = urllib.request.Request(T3K + path, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def choose_filename(model_url, content_disposition, blob, display_name):
    """PURE: decide the saved filename. Authority order:
       1) BYTE SNIFF — the file itself cannot lie:
          RIFF->.wav  FORM->.aif  JSON({)->.nam (NAM models ARE json)
       2) the server's Content-Disposition filename (TONE3000's own name;
          used as the base name too)
       3) the URL path's extension
       Never invent .nam: unrecognized bytes get .bin (and the caller warns).
       .model -> .nam is the one legitimate rename (same format).
       Returns (filename, is_nam)."""
    cd_name = ""
    m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?", content_disposition or "")
    if m:
        cd_name = urllib.parse.unquote(m.group(1)).strip().replace("/", "-")
    url_name = urllib.parse.urlparse(model_url).path.rsplit("/", 1)[-1]

    def ext_of(name):
        return ("." + name.rsplit(".", 1)[1].lower()) if "." in name else ""

    ext = ext_of(cd_name) or ext_of(url_name)
    if ext == ".model":
        ext = ".nam"

    head = blob[:8] if blob else b""
    if head[:4] == b"RIFF":
        ext = ".wav"
    elif head[:4] == b"FORM":
        ext = ".aif"
    elif head[:1] in (b"{", b"["):
        ext = ".nam"                      # NAM model files are JSON
    elif ext in ("", ".nam"):
        ext = ".bin"                      # unknown bytes: NEVER fake .nam

    if cd_name:
        base = cd_name.rsplit(".", 1)[0]
    else:
        base = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", display_name.lower())) or "tone"
    return base + ext, ext == ".nam"


def download_model(key, model_url, dest_dir, display_name):
    """Fetch model_url with Bearer auth; name via choose_filename (byte-sniffed,
    server-named). Returns (filename, is_nam)."""
    tok = bearer(key)
    req = urllib.request.Request(model_url, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=120) as r:
        blob = r.read()
        cd = r.headers.get("Content-Disposition")
    fname, is_nam = choose_filename(model_url, cd, blob, display_name)
    if fname.endswith(".bin"):
        print("WARNING: unrecognized file type from %s (saved as %s)" % (model_url[:60], fname))
    base, ext = fname.rsplit(".", 1)
    path = os.path.join(dest_dir, fname)
    i = 2
    while os.path.exists(path):
        fname = "%s-%d.%s" % (base, i, ext)
        path = os.path.join(dest_dir, fname)
        i += 1
    with open(path, "wb") as f:
        f.write(blob)
    return fname, is_nam


# ─── minimal OSC (stock AbletonOSC) ───────────────────────────────────────────
def osc_pack(addr, args):
    def pad(b):
        return b + b"\x00" * (4 - len(b) % 4 if len(b) % 4 else 0)
    msg = pad(addr.encode() + b"\x00")
    tags = ","
    payload = b""
    for a in args:
        if isinstance(a, int):
            tags += "i"; payload += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"; payload += struct.pack(">f", a)
        else:
            tags += "s"; payload += pad(str(a).encode() + b"\x00")
    return msg + pad(tags.encode() + b"\x00") + payload


def osc_unpack(data):
    i = data.index(b"\x00")
    addr = data[:i].decode()
    j = (i + 4) & ~3
    k = data.index(b"\x00", j)
    tags = data[j + 1:k].decode()
    p = (k + 4) & ~3
    out = []
    for t in tags:
        if t == "i":
            out.append(struct.unpack(">i", data[p:p + 4])[0]); p += 4
        elif t == "f":
            out.append(struct.unpack(">f", data[p:p + 4])[0]); p += 4
        elif t == "s":
            e = data.index(b"\x00", p)
            out.append(data[p:e].decode()); p = (e + 4) & ~3
    return addr, out


class Osc:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", CFG["osc_recv_port"]))
        self.sock.settimeout(3.0)

    def send(self, addr, args):
        self.sock.sendto(osc_pack(addr, args), (CFG["osc_host"], CFG["osc_send_port"]))

    def request(self, addr, args, reply_contains):
        self.send(addr, args)
        t0 = time.time()
        while time.time() - t0 < 3.0:
            try:
                data, _ = self.sock.recvfrom(65536)
            except socket.timeout:
                break
            raddr, rargs = osc_unpack(data)
            if reply_contains in raddr:
                return rargs
        return None

    def close(self):
        self.sock.close()


def amp_param_indices(osc):
    """Resolve the amp's param indices BY NAME (never assumed)."""
    r = osc.request("/live/device/get/parameters/name", [CFG["track"], CFG["device"]],
                    "parameters/name")
    if not r:
        return None
    names = [a for a in r[2:] if isinstance(a, str)]
    return {n: i for i, n in enumerate(names)}


def poke_amp_after_download(n_files):
    """Rescan (device adopts) -> read manifest for the new index -> Model=idx.
    Returns (ok, message)."""
    if CFG["no_osc"]:
        return True, "downloaded %d file(s); click Reload on the amp, then dial Model" % n_files
    try:
        osc = Osc()
    except OSError as e:
        return False, "OSC recv port busy (%s) — files downloaded; click Reload + dial Model" % e
    try:
        idx = amp_param_indices(osc)
        if not idx or "Rescan" not in idx or "Model" not in idx:
            return False, "amp params not readable over OSC — files downloaded; click Reload + dial Model"
        osc.send("/live/device/set/parameter", [CFG["track"], CFG["device"], idx["Rescan"], 1])
        time.sleep(1.0)  # device adopts + writes the manifest
        try:
            m = json.load(open(os.path.join(CFG["models_dir"], "models.json")))
            new_index = max(e["index"] for e in m["entries"])
        except Exception as e:
            return True, ("downloaded; adoption poked but manifest not readable yet (%s) - "
                          "pick the tone from the device dropdowns" % e)
        osc.send("/live/device/set/parameter", [CFG["track"], CFG["device"], idx["Model"], new_index])
        # poll Load OK (observed truth, never assumed)
        ok_val = None
        if "Load OK" in idx:
            for _ in range(20):
                r = osc.request("/live/device/get/parameter/value",
                                [CFG["track"], CFG["device"], idx["Load OK"]], "parameter/value")
                if r and len(r) >= 4:
                    ok_val = int(r[3])
                    if ok_val == 1:
                        break
                time.sleep(0.2)
        if ok_val == 1:
            return True, "loaded as Model %d (Load OK = 1)" % new_index
        return True, "set Model %d; Load OK read %s — check the amp" % (new_index, ok_val)
    finally:
        osc.close()


# ─── the local web app ────────────────────────────────────────────────────────
PAGE = """<!doctype html><meta charset="utf-8">
<title>NAM A2 — TONE3000 bridge</title>
<body style="font-family:-apple-system,Helvetica,sans-serif;background:#1a1a1a;
color:#eee;display:flex;justify-content:center;padding-top:10vh">
<div style="max-width:560px">
<h2 style="color:#f2b341">NAM A2 &nbsp;&middot;&nbsp; TONE3000 bridge</h2>
<p style="color:#aaa">%s</p>%s
<p><a href="/browse" style="display:inline-block;background:#f2b341;color:#111;
padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600">
Browse TONE3000</a></p>
<p style="color:#666;font-size:12px">Pick a tone on tone3000.com &rarr; it downloads
into the models folder &rarr; the amp adopts + loads it automatically.</p>
</div>"""


def get_key():
    k = os.environ.get("TONE3000_KEY")
    if k:
        return k.strip()
    p = os.path.join(os.path.dirname(CFG["models_dir"].rstrip("/")), ".tone3000_key")
    if os.path.isfile(p):
        return open(p).read().strip()
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _html(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        key = get_key()
        redirect_uri = "http://localhost:%d/callback" % CFG["port"]

        if u.path == "/":
            note = ("<p style='color:#e66'>No API key found — put it in "
                    "~/Aibleton/Aibleton/.tone3000_key or export TONE3000_KEY.</p>") if not key else ""
            return self._html(200, PAGE % (STATE["last"], note))

        if u.path == "/browse":
            if not key:
                return self._html(400, PAGE % ("no API key configured", ""))
            v, c, s = make_pkce()
            STATE["verifier"], STATE["state"] = v, s
            self.send_response(302)
            self.send_header("Location", authorize_url(key, redirect_uri, c, s))
            self.end_headers()
            return

        if u.path == "/callback":
            q = urllib.parse.parse_qs(u.query)
            if q.get("state", [None])[0] != STATE["state"]:
                return self._html(400, PAGE % ("state mismatch — try again", ""))
            if "error" in q or "code" not in q:
                return self._html(200, PAGE % ("canceled / error: %s" % q.get("error", ["?"])[0], ""))
            try:
                tokens = exchange_code(key, q["code"][0], STATE["verifier"], redirect_uri)
                save_tokens(tokens)
                tone_id = q.get("tone_id", [None])[0]
                model_id = q.get("model_id", [None])[0]
                tone = api_get(key, "/api/v1/tones/%s?architecture=%d" % (tone_id, ARCH_A2))
                tone_name = tone.get("title") or tone.get("name") or ("tone %s" % tone_id)
                glabel = gear_label(tone)
                if model_id:                       # user picked a specific model
                    models = [api_get(key, "/api/v1/models/%s" % model_id)]
                else:                              # take the tone's A2 models
                    models = api_get(key, "/api/v1/models?tone_id=%s&architecture=%d&page_size=10"
                                     % (tone_id, ARCH_A2)).get("data", [])
                if not models:
                    return self._html(200, PAGE % ("no A2 models on that tone — pick another", ""))
                # Two-level filing: models/<Gear>/<Tone Pack>/<file>.nam — the
                # device's three dropdowns (Gear -> Pack -> Tone) mirror this.
                sub = re.sub(r"^-|-$", "", re.sub(r"[^a-zA-Z0-9+]+", " ", tone_name).strip())
                dest = os.path.join(CFG["models_dir"], glabel, sub or "pack")
                os.makedirs(dest, exist_ok=True)
                nams, others = [], []
                for mm in models:
                    nm = mm.get("name") or tone_name
                    fname, is_nam = download_model(key, mm["model_url"], dest, nm)
                    (nams if is_nam else others).append(fname)
                if nams:
                    ok, msg = poke_amp_after_download(len(nams))
                else:
                    ok, msg = True, "no NAM files in this tone (IR-only? e.g. Spaces) - nothing for the amp to load"
                extra = (" + %d non-NAM file(s) kept for a future IR loader" % len(others)) if others else ""
                STATE["last"] = "%s [%s]: %d NAM file(s)%s — %s" % (tone_name, glabel, len(nams), extra, msg)
                return self._html(200, PAGE % (STATE["last"], ""))
            except Exception as e:
                STATE["last"] = "failed: %s" % e
                return self._html(500, PAGE % (STATE["last"], ""))

        self._html(404, PAGE % ("not found", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=CFG["port"])
    ap.add_argument("--models-dir", default=CFG["models_dir"])
    ap.add_argument("--track", type=int, default=0)
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--no-osc", action="store_true")
    a = ap.parse_args()
    CFG.update(port=a.port, models_dir=os.path.abspath(os.path.expanduser(a.models_dir)),
               track=a.track, device=a.device, no_osc=a.no_osc)
    if not os.path.isdir(CFG["models_dir"]):
        raise SystemExit("models dir not found: %s" % CFG["models_dir"])
    print("TONE3000 bridge on http://localhost:%d  (models: %s, amp: track %d device %d)"
          % (CFG["port"], CFG["models_dir"], CFG["track"], CFG["device"]))
    if not get_key():
        print("WARNING: no API key — put it in .tone3000_key next to the models dir, "
              "or export TONE3000_KEY")
    HTTPServer(("127.0.0.1", CFG["port"]), Handler).serve_forever()


if __name__ == "__main__":
    main()
