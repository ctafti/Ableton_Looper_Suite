# ============================================================================
# NAM A2 RIG — ENGINE EXTENSION (drop-in AbletonOSC handler)
#
# Implements every [EXT] address in Contract 2 (contracts/types/osc.ts), so the
# rig-gated harnesses (harnesses/) have a real engine to talk to on day one.
# Install: run engine/install.sh (copies this file into AbletonOSC/abletonosc/
# and registers the handler). See engine/README.md.
#
# GROUNDING: written against the real AbletonOSC source (handler.py /
# osc_server.py conventions, verified 2026-07-02):
#   - a handler registers callbacks via self.osc_server.add_handler(addr, fn)
#   - fn receives the OSC params tuple; RETURNING a tuple auto-replies on the
#     SAME address to the sender (port 11001) — that's the echo/receipt path
#   - self.song is the Live Song object (via the ControlSurface Component)
#
# The Live-API calls used here are the ones audited in reports/API-REALITY.md:
#   - AutomationEnvelope.insert_step / value_at_time, Clip.automation_envelope
#     (+ create_automation_envelope on Live 10+): confirmed present in the
#     Python Remote-Script API across Live 9-11; the Live-12 signature is the
#     PROVISIONAL item harness 03 confirms (seam #1).
#   - Clip.clear_envelope, warp-marker methods, Song.is_ableton_link_enabled:
#     official LOM.
#   - Application.browser + load_item: confirmed in the control-surface API;
#     reliability is seam #2 (harness 02).
#   - The looper State parameter: our own M4L device (seam #3, harness 04).
#
# STYLE NOTE FOR THE NON-CODER BUILDER: every handler is small, logs what it
# does, and replies honestly — failures reply with ok=0 + a reason string, so
# the hub/AI can never mistake silence or a lie for success (arch §11 stage 3).
# ============================================================================

import Live
import logging

from .handler import AbletonOSCHandler

ENGINE_VERSION = "0.1.0"
PROTOCOL = 1  # mirrors WS_PROTOCOL_VERSION / Contract 3


class ExtensionHandler(AbletonOSCHandler):
    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "engine"

    def init_api(self):
        self.logger = logging.getLogger("abletonosc")

        # Browser index: name_lower -> (display_name, uri); uri -> item object.
        # Built LAZILY (first query/load/rescan), because walking the browser at
        # Live boot is slow and arch §11 says cache + rebuild on explicit rescan.
        self._browser_names = None
        self._browser_items = None

        # ------------------------------------------------------------------
        # /live/engine/hello + /live/engine/ping   (arch §13 "hello on init")
        # ------------------------------------------------------------------
        def hello_tuple():
            return (ENGINE_VERSION, PROTOCOL)

        def ping(_params):
            return hello_tuple()

        self.osc_server.add_handler("/live/engine/ping", ping)
        # Unsolicited hello so the hub learns instantly, not just by polling:
        try:
            self.osc_server.send("/live/engine/hello", hello_tuple())
        except Exception as e:
            self.logger.warning("engine: could not send hello: %s" % e)

        # ------------------------------------------------------------------
        # Small index helpers (raw indices live HERE and below — Contract 1)
        # ------------------------------------------------------------------
        def track_at(i):
            return self.song.tracks[int(i)]

        def clip_at(t, c):
            return track_at(t).clip_slots[int(c)].clip

        def param_at(t, d, p):
            return track_at(t).devices[int(d)].parameters[int(p)]

        def envelope_for(t, c, d, p):
            """Get (create if needed) the clip's automation envelope for the
            parameter — Clip.automation_envelope(param), plus Live 10+'s
            create_automation_envelope when none exists yet (arch §10)."""
            clip = clip_at(t, c)
            param = param_at(t, d, p)
            env = clip.automation_envelope(param)
            if env is None and hasattr(clip, "create_automation_envelope"):
                env = clip.create_automation_envelope(param)
            return clip, param, env

        def undo_wrap(fn):
            """One atomic undo step around fn() — a voice command is ONE Cmd-Z
            (arch §10). Tolerates older/newer begin/end_undo_step signatures."""
            began = False
            try:
                self.song.begin_undo_step()
                began = True
            except Exception:
                pass
            try:
                return fn()
            finally:
                if began:
                    try:
                        self.song.end_undo_step()
                    except Exception:
                        pass

        # ------------------------------------------------------------------
        # AUTOMATION WRITE (Contract 2 insertStep / insertSteps / getEnvelope /
        # clearEnvelope; seam #1, harness 03)
        # ------------------------------------------------------------------
        def clip_insert_step(params):
            # (track, clip, device, param, time, duration, value)
            t, c, d, p = params[0], params[1], params[2], params[3]
            time, duration, value = float(params[4]), float(params[5]), float(params[6])
            try:
                _clip, _param, env = envelope_for(t, c, d, p)
                if env is None:
                    return (int(t), int(c), 0, "no envelope (clip missing or param unautomatable)")
                undo_wrap(lambda: env.insert_step(time, duration, value))
                return (int(t), int(c), 1, "")
            except Exception as e:
                self.logger.warning("engine insert_step failed: %s" % e)
                return (int(t), int(c), 0, str(e))

        def clip_insert_steps(params):
            # (track, clip, device, param, then (time, duration, value) TRIPLES)
            t, c, d, p = params[0], params[1], params[2], params[3]
            triples = params[4:]
            if len(triples) < 3 or len(triples) % 3 != 0:
                return (int(t), int(c), 0, "args after indices must be (time,duration,value) triples")
            try:
                _clip, _param, env = envelope_for(t, c, d, p)
                if env is None:
                    return (int(t), int(c), 0, "no envelope (clip missing or param unautomatable)")

                def write_all():
                    for i in range(0, len(triples), 3):
                        env.insert_step(float(triples[i]), float(triples[i + 1]), float(triples[i + 2]))

                undo_wrap(write_all)  # the whole batch = ONE undo step
                return (int(t), int(c), 1, "")
            except Exception as e:
                self.logger.warning("engine insert_steps failed: %s" % e)
                return (int(t), int(c), 0, str(e))

        def clip_get_envelope(params):
            # (track, clip, device, param, time0, time1, ...) ->
            # (track, clip, device, param, time0, value0, ...)   [the receipt]
            t, c, d, p = params[0], params[1], params[2], params[3]
            times = [float(x) for x in params[4:]]
            try:
                _clip, _param, env = envelope_for(t, c, d, p)
                if env is None:
                    return (int(t), int(c), int(d), int(p))  # no points -> empty readback
                out = [int(t), int(c), int(d), int(p)]
                for tm in times:
                    out.append(tm)
                    out.append(float(env.value_at_time(tm)))
                return tuple(out)
            except Exception as e:
                self.logger.warning("engine get/envelope failed: %s" % e)
                return (int(t), int(c), int(d), int(p))

        def clip_clear_envelope(params):
            # (track, clip, device, param) — official LOM Clip.clear_envelope
            t, c, d, p = params[0], params[1], params[2], params[3]
            try:
                clip = clip_at(t, c)
                param = param_at(t, d, p)
                undo_wrap(lambda: clip.clear_envelope(param))
                return (int(t), int(c), 1, "")
            except Exception as e:
                self.logger.warning("engine clear_envelope failed: %s" % e)
                return (int(t), int(c), 0, str(e))

        self.osc_server.add_handler("/live/clip/insert_step", clip_insert_step)
        self.osc_server.add_handler("/live/clip/insert_steps", clip_insert_steps)
        self.osc_server.add_handler("/live/clip/get/envelope", clip_get_envelope)
        self.osc_server.add_handler("/live/clip/clear_envelope", clip_clear_envelope)

        # ------------------------------------------------------------------
        # WARP MARKERS (Contract 2, official LOM — FREEZE)
        # NOTE: the exact Python calling convention for add_warp_marker varies
        # across Live versions (positional vs dict); we try both and report
        # honestly. Bench-confirm on the rig (cheap — it's a one-line finding).
        # ------------------------------------------------------------------
        def clip_add_warp_marker(params):
            # (track, clip, beat_time[, sample_time])
            t, c = params[0], params[1]
            beat_time = float(params[2])
            sample_time = float(params[3]) if len(params) > 3 else None
            try:
                clip = clip_at(t, c)
                try:
                    if sample_time is None:
                        clip.add_warp_marker(beat_time)
                    else:
                        clip.add_warp_marker(beat_time, sample_time)
                except TypeError:
                    # dict-style convention used by some Live versions
                    marker = {"beat_time": beat_time}
                    if sample_time is not None:
                        marker["sample_time"] = sample_time
                    clip.add_warp_marker(marker)
                return (int(t), int(c), 1, "")
            except Exception as e:
                self.logger.warning("engine add_warp_marker failed: %s" % e)
                return (int(t), int(c), 0, str(e))

        def clip_move_warp_marker(params):
            # (track, clip, beat_time, distance)
            t, c = params[0], params[1]
            try:
                clip_at(t, c).move_warp_marker(float(params[2]), float(params[3]))
                return (int(t), int(c), 1, "")
            except Exception as e:
                return (int(t), int(c), 0, str(e))

        def clip_remove_warp_marker(params):
            # (track, clip, beat_time)
            t, c = params[0], params[1]
            try:
                clip_at(t, c).remove_warp_marker(float(params[2]))
                return (int(t), int(c), 1, "")
            except Exception as e:
                return (int(t), int(c), 0, str(e))

        self.osc_server.add_handler("/live/clip/add_warp_marker", clip_add_warp_marker)
        self.osc_server.add_handler("/live/clip/move_warp_marker", clip_move_warp_marker)
        self.osc_server.add_handler("/live/clip/remove_warp_marker", clip_remove_warp_marker)

        # ------------------------------------------------------------------
        # BROWSER: index + query + load-and-verify (arch §11; seam #2)
        # ------------------------------------------------------------------
        def build_browser_index():
            """Walk Application.browser once; cache name->uri and uri->item.
            (arch §11 stage 1: index at boot/first use, rebuild on rescan.)"""
            app = Live.Application.get_application()
            browser = app.browser
            names, items = {}, {}
            categories = []
            for cat in ("audio_effects", "instruments", "midi_effects",
                        "plugins", "drums", "sounds", "packs", "user_library"):
                node = getattr(browser, cat, None)
                if node is not None:
                    categories.append(node)

            def walk(item, depth=0):
                if depth > 8:
                    return
                try:
                    if getattr(item, "is_loadable", False):
                        name = str(item.name)
                        uri = str(item.uri)
                        names.setdefault(name.lower(), (name, uri))
                        items[uri] = item
                    for child in getattr(item, "children", []) or []:
                        walk(child, depth + 1)
                except Exception:
                    pass  # individual bad nodes must not kill the index

            for node in categories:
                walk(node)
            self._browser_names, self._browser_items = names, items
            self.logger.info("engine: browser index built (%d loadable items)" % len(items))
            return len(items)

        def ensure_index():
            if self._browser_items is None:
                build_browser_index()

        def browser_rescan(_params):
            count = build_browser_index()
            return (count,)

        def browser_query(params):
            # (query, maxResults) -> (query, name0, uri0, name1, uri1, ...)
            query = str(params[0]).lower()
            max_results = int(params[1]) if len(params) > 1 else 8
            ensure_index()
            out = [str(params[0])]
            # exact match first, then substring matches (arch §11 fuzzy resolve
            # stays hub-side; this is the honest raw lookup)
            hits = []
            if query in self._browser_names:
                hits.append(self._browser_names[query])
            for key, val in self._browser_names.items():
                if len(hits) >= max_results:
                    break
                if query in key and val not in hits:
                    hits.append(val)
            for name, uri in hits[:max_results]:
                out.append(name)
                out.append(uri)
            return tuple(out)

        def browser_load_item(params):
            # (track, uri) -> (track, ok, added_device_index|-1, added_name|reason)
            # Load-and-verify, arch §11 stages 2-3: select track via LOM, snapshot
            # the device list BEFORE, load, re-read and DIFF. The diff IS the
            # receipt; we never report success without it.
            t = int(params[0])
            uri = str(params[1])
            try:
                ensure_index()
                item = self._browser_items.get(uri)
                if item is None:
                    return (t, 0, -1, "uri not in browser index (rescan? version-varying URI?)")
                track = track_at(t)
                before = [str(dv.name) for dv in track.devices]

                self.song.view.selected_track = track  # engine CONTROLS selection
                app = Live.Application.get_application()
                app.browser.load_item(item)

                after = [str(dv.name) for dv in track.devices]
                if len(after) == len(before) + 1:
                    # loads land at chain end (arch §11) — verify + report it
                    added_index = len(after) - 1
                    return (t, 1, added_index, after[added_index])
                return (t, 0, -1,
                        "device count %d -> %d (expected +1)" % (len(before), len(after)))
            except Exception as e:
                self.logger.warning("engine load_item failed: %s" % e)
                return (t, 0, -1, str(e))

        self.osc_server.add_handler("/live/browser/rescan", browser_rescan)
        self.osc_server.add_handler("/live/browser/query", browser_query)
        self.osc_server.add_handler("/live/browser/load_item", browser_load_item)

        # ------------------------------------------------------------------
        # CUSTOM M4L LOOPER STATE (Contract 2 looperSetState/GetState; seam #3)
        # The looper's State is a NORMAL settable device parameter named "State"
        # (the whole point of §15). We map by NAME, not index — parameter order
        # can differ across device versions (same reason as Contract 1 ParamRef).
        # ------------------------------------------------------------------
        def find_state_param(t, d):
            device = track_at(t).devices[int(d)]
            for param in device.parameters:
                if str(param.name).lower() == "state":
                    return param
            return None

        def looper_set_state(params):
            # (track, device, state) -> (track, device, observed_state)
            t, d, state = int(params[0]), int(params[1]), float(params[2])
            param = find_state_param(t, d)
            if param is None:
                self.logger.warning("engine looper set_state: no 'State' param on device %d/%d" % (t, d))
                return (t, d, -1)  # -1 = no State param found (device missing / not our looper)
            param.value = state
            return (t, d, int(param.value))  # echo the OBSERVED value, not the request

        def looper_get_state(params):
            # (track, device) -> (track, device, state)
            t, d = int(params[0]), int(params[1])
            param = find_state_param(t, d)
            if param is None:
                return (t, d, -1)
            return (t, d, int(param.value))

        self.osc_server.add_handler("/live/looper/set_state", looper_set_state)
        self.osc_server.add_handler("/live/looper/get/state", looper_get_state)

        # ------------------------------------------------------------------
        # ABLETON LINK ENABLE (Contract 2 setLinkEnabled — LOM-settable, FREEZE;
        # caveat: Live's Link transport-bar control must be visible, arch §14)
        # ------------------------------------------------------------------
        def set_link_enabled(params):
            try:
                self.song.is_ableton_link_enabled = bool(int(params[0]))
                return (1 if self.song.is_ableton_link_enabled else 0,)
            except Exception as e:
                self.logger.warning("engine set link enabled failed: %s" % e)
                return (-1,)

        self.osc_server.add_handler("/live/song/set/is_ableton_link_enabled", set_link_enabled)
