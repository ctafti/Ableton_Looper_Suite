# ============================================================================
# OFFLINE TEST for engine/extension.py — no Mac, no Ableton needed.
#
# Mocks just enough of the Live Python API + AbletonOSC plumbing to run every
# handler and assert its reply shape matches Contract 2. This does NOT replace
# the rig harnesses (they prove the REAL Live behaves); it proves OUR logic —
# arg parsing, reply shapes, the load-and-verify diff, the honest-failure
# paths — before the code ever touches the rig.
#
# Run:  python3 engine/test_offline.py     → prints PASS/FAIL per check
# ============================================================================
import sys
import types
import pathlib

# ----------------------------------------------------------------------------
# 1. Mock the `Live` module and the AbletonOSC framework imports
# ----------------------------------------------------------------------------
class MockParam:
    def __init__(self, name, value=0.0):
        self.name, self.value = name, value

class MockEnvelope:
    def __init__(self):
        self.steps = []
    def insert_step(self, time, duration, value):
        self.steps.append((time, duration, value))
    def value_at_time(self, t):
        # last step whose window contains t, else 0
        for (time, dur, val) in reversed(self.steps):
            if time <= t < time + dur:
                return val
        return 0.0

class MockClip:
    def __init__(self):
        self._env = {}
        self.warp_markers_added = []
    def automation_envelope(self, param):
        return self._env.get(param.name)
    def create_automation_envelope(self, param):
        self._env[param.name] = MockEnvelope()
        return self._env[param.name]
    def clear_envelope(self, param):
        self._env.pop(param.name, None)
    def add_warp_marker(self, beat_time, sample_time=None):
        self.warp_markers_added.append((beat_time, sample_time))
    def move_warp_marker(self, beat_time, distance):
        pass
    def remove_warp_marker(self, beat_time):
        pass

class MockClipSlot:
    def __init__(self):
        self.clip = MockClip()

class MockDevice:
    def __init__(self, name, params):
        self.name, self.parameters = name, params

class MockTrack:
    def __init__(self):
        self.clip_slots = [MockClipSlot() for _ in range(4)]
        self.devices = [
            MockDevice("NAM Rack", [MockParam("Gain", 0.5)]),
            MockDevice("NAM_A2_Looper", [MockParam("Speed", 1.0), MockParam("State", 0)]),
        ]

class MockView:
    selected_track = None

class MockSong:
    def __init__(self):
        self.tracks = [MockTrack(), MockTrack()]
        self.view = MockView()
        self.is_ableton_link_enabled = False
        self.undo_depth = 0
    def begin_undo_step(self):
        self.undo_depth += 1
    def end_undo_step(self):
        self.undo_depth -= 1

class MockBrowserItem:
    def __init__(self, name, uri, children=(), loadable=True):
        self.name, self.uri = name, uri
        self.children, self.is_loadable = list(children), loadable
        self.is_folder = not loadable

class MockBrowser:
    def __init__(self):
        reverb = MockBrowserItem("Reverb", "query:AudioFx#Reverb")
        echo = MockBrowserItem("Echo", "query:AudioFx#Echo")
        folder = MockBrowserItem("Audio Effects", "folder:fx", [reverb, echo], loadable=False)
        self.audio_effects = folder
        self._song = None  # set by the test to simulate loading
    def load_item(self, item):
        # simulate: device lands at END of the SELECTED track's chain (arch §11)
        track = self._song.view.selected_track
        track.devices.append(MockDevice(item.name, [MockParam("Dry/Wet", 0.5)]))

mock_browser = MockBrowser()

live_mod = types.ModuleType("Live")
live_mod.Application = types.SimpleNamespace(
    get_application=lambda: types.SimpleNamespace(browser=mock_browser)
)
sys.modules["Live"] = live_mod

# Fake the package context so `from .handler import AbletonOSCHandler` resolves
pkg = types.ModuleType("engpkg"); pkg.__path__ = []
sys.modules["engpkg"] = pkg
handler_mod = types.ModuleType("engpkg.handler")

class FakeOSCServer:
    def __init__(self):
        self.handlers, self.sent = {}, []
    def add_handler(self, addr, fn):
        self.handlers[addr] = fn
    def send(self, addr, params=(), remote_addr=None):
        self.sent.append((addr, tuple(params)))

class AbletonOSCHandler:  # matching the real base's surface that we use
    def __init__(self, manager):
        self.manager = manager
        self.osc_server = manager.osc_server
        self.song = manager.song
        self.init_api()

handler_mod.AbletonOSCHandler = AbletonOSCHandler
sys.modules["engpkg.handler"] = handler_mod

# Load extension.py AS engpkg.extension
src = (pathlib.Path(__file__).parent / "extension.py").read_text()
ext_mod = types.ModuleType("engpkg.extension")
ext_mod.__package__ = "engpkg"
sys.modules["engpkg.extension"] = ext_mod
exec(compile(src, "extension.py", "exec"), ext_mod.__dict__)

# ----------------------------------------------------------------------------
# 2. Instantiate + drive every handler; assert Contract-2 reply shapes
# ----------------------------------------------------------------------------
song = MockSong()
mock_browser._song = song
server = FakeOSCServer()
manager = types.SimpleNamespace(osc_server=server, song=song)
ext_mod.ExtensionHandler(manager)

failures = []
def check(label, cond):
    print(("PASS  " if cond else "FAIL  ") + label)
    if not cond:
        failures.append(label)

H = server.handlers

# hello sent unsolicited on init
check("hello on init", server.sent and server.sent[0][0] == "/live/engine/hello")
check("ping replies (version, protocol)", H["/live/engine/ping"](()) == (ext_mod.ENGINE_VERSION, ext_mod.PROTOCOL))

# batched insert_steps: writes all steps, one atomic undo, ok=1
rv = H["/live/clip/insert_steps"]((0, 0, 0, 0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.33, 2.0, 1.0, 0.66))
check("insert_steps ok reply (t,c,1,'')", rv == (0, 0, 1, ""))
env = song.tracks[0].clip_slots[0].clip._env["Gain"]
check("insert_steps wrote 3 (time,dur,value) steps", env.steps == [(0.0, 1.0, 0.0), (1.0, 1.0, 0.33), (2.0, 1.0, 0.66)])
check("undo balanced (begin==end)", song.undo_depth == 0)

# malformed triples rejected honestly
rv = H["/live/clip/insert_steps"]((0, 0, 0, 0, 1.0, 2.0))
check("insert_steps rejects non-triples with ok=0", rv[2] == 0)

# readback samples via value_at_time
rv = H["/live/clip/get/envelope"]((0, 0, 0, 0, 0.5, 1.5, 2.5))
check("get/envelope returns (idx*4 + time,value pairs)", rv == (0, 0, 0, 0, 0.5, 0.0, 1.5, 0.33, 2.5, 0.66))

# single insert_step + clear
rv = H["/live/clip/insert_step"]((1, 0, 0, 0, 0.0, 4.0, 0.9))
check("insert_step ok", rv == (1, 0, 1, ""))
rv = H["/live/clip/clear_envelope"]((1, 0, 0, 0))
check("clear_envelope ok", rv == (1, 0, 1, "") and "Gain" not in song.tracks[1].clip_slots[0].clip._env)

# warp markers
rv = H["/live/clip/add_warp_marker"]((0, 1, 4.0, 12345.0))
check("add_warp_marker ok", rv == (0, 1, 1, "") and song.tracks[0].clip_slots[1].clip.warp_markers_added == [(4.0, 12345.0)])

# browser: rescan -> query -> load-and-verify
rv = H["/live/browser/rescan"](())
check("rescan counts 2 loadable items", rv == (2,))
rv = H["/live/browser/query"](("rev", 5))
check("query finds Reverb by substring", rv == ("rev", "Reverb", "query:AudioFx#Reverb"))
n_before = len(song.tracks[1].devices)
rv = H["/live/browser/load_item"]((1, "query:AudioFx#Reverb"))
check("load_item verifies +1 device and names it", rv == (1, 1, n_before, "Reverb"))
check("load_item selected the target track first", song.view.selected_track is song.tracks[1])
rv = H["/live/browser/load_item"]((1, "query:AudioFx#Nonexistent"))
check("unknown uri fails honestly (ok=0)", rv[1] == 0 and "not in browser index" in rv[3])

# looper state: by-name param, observed echo, honest -1 when missing
rv = H["/live/looper/set_state"]((0, 1, 3))
check("looper set Overdub echoes observed 3", rv == (0, 1, 3))
rv = H["/live/looper/get/state"]((0, 1))
check("looper get reads 3", rv == (0, 1, 3))
rv = H["/live/looper/set_state"]((0, 0, 1))  # device 0 = amp, no State param
check("no State param -> state -1 (honest)", rv == (0, 0, -1))

# link enable
rv = H["/live/song/set/is_ableton_link_enabled"]((1,))
check("link enable set + echoed", rv == (1,) and song.is_ableton_link_enabled is True)

print()
if failures:
    print("%d FAILURE(S)" % len(failures)); sys.exit(1)
print("ALL CHECKS PASS — extension logic is sound; rig harnesses prove the real Live.")
