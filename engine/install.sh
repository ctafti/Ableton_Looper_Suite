#!/bin/bash
# ============================================================================
# NAM A2 RIG — engine extension installer
#
# What it does (idempotent — safe to re-run):
#   1. Finds (or clones) AbletonOSC in Live's Remote Scripts folder.
#   2. Copies engine/extension.py into AbletonOSC/abletonosc/.
#   3. Registers ExtensionHandler in abletonosc/__init__.py and manager.py.
#   4. Byte-compiles the file so a syntax error is caught HERE, not inside Live.
#
# After running: quit + reopen Live, re-select AbletonOSC as the Control
# Surface if needed. The engine sends /live/engine/hello on init; verify with:
#   cd harnesses && npm run pinger     (or ping /live/engine/ping)
#
# Override the Remote Scripts location if Live's Settings → Library shows a
# custom User Library path:
#   REMOTE_SCRIPTS="/custom/path/Remote Scripts" ./install.sh
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_SCRIPTS="${REMOTE_SCRIPTS:-$HOME/Music/Ableton/User Library/Remote Scripts}"
AOSC="$REMOTE_SCRIPTS/AbletonOSC"

echo "== NAM A2 engine extension installer =="

# --- 1. AbletonOSC present? ------------------------------------------------
if [ ! -d "$AOSC/abletonosc" ]; then
  echo "AbletonOSC not found at: $AOSC"
  echo "Cloning it (this is the same step as FIRST-MAC-SESSION 1.5)..."
  mkdir -p "$REMOTE_SCRIPTS"
  git clone https://github.com/ideoforms/AbletonOSC.git "$AOSC"
fi
echo "AbletonOSC: $AOSC"

# --- 2. Copy the extension --------------------------------------------------
cp "$HERE/extension.py" "$AOSC/abletonosc/extension.py"
echo "Copied extension.py -> abletonosc/extension.py"

# --- 3. Register the handler (idempotent text patches) ----------------------
python3 - "$AOSC" << 'PYEOF'
import sys, re, pathlib
root = pathlib.Path(sys.argv[1])

init = root / "abletonosc" / "__init__.py"
s = init.read_text()
if "from .extension import ExtensionHandler" not in s:
    s = s.replace(
        "from .midimap import MidiMapHandler",
        "from .midimap import MidiMapHandler\nfrom .extension import ExtensionHandler",
    )
    init.write_text(s)
    print("Patched abletonosc/__init__.py (import added)")
else:
    print("abletonosc/__init__.py already patched")

man = root / "manager.py"
s = man.read_text()
if "abletonosc.ExtensionHandler(self)" not in s:
    s = s.replace(
        "abletonosc.MidiMapHandler(self),",
        "abletonosc.MidiMapHandler(self),\n                abletonosc.ExtensionHandler(self),",
    )
    man.write_text(s)
    print("Patched manager.py (handler registered)")
else:
    print("manager.py already patched")

# sanity: both patches must now be present
assert "ExtensionHandler" in (root / "abletonosc" / "__init__.py").read_text()
assert "abletonosc.ExtensionHandler(self)" in (root / "manager.py").read_text()
PYEOF

# --- 4. Syntax check so failures surface here, not inside Live --------------
python3 -m py_compile "$AOSC/abletonosc/extension.py"
echo "extension.py byte-compiles clean."

echo ""
echo "DONE. Now: quit + reopen Ableton Live."
echo "Verify: Settings → Link, Tempo & MIDI shows AbletonOSC selected, then run"
echo "  cd harnesses && OSC_HOST=127.0.0.1 npm run pinger"
echo "The engine also announces itself with /live/engine/hello on every init."
