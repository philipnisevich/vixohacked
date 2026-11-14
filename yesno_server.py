#!/usr/bin/env python3
"""Ask Vexo: the yes/no band with a web page.

    .venv/bin/python yesno_server.py            real band 9 over Bluetooth
    .venv/bin/python yesno_server.py --usb      real band on the USB cable
    .venv/bin/python yesno_server.py --sim      pretend band

Then open http://localhost:8765/ in any browser.

This program holds the band (one Bluetooth connection) and the OpenAI key. The page only
gets the state (pushed over Server-Sent Events) and sends three commands: ask, send, typed
question. The key never reaches the page. The server listens on 127.0.0.1 only.
"""
import argparse
import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yesno
from yesno import BAND, COLOURS, KIT, RECORDINGS, Band, Realtime, ai, audio

UI = Path(__file__).resolve().parent / "yesno-ui"
WORKSPACE = Path(__file__).resolve().parent / "workspace"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".opus": "audio/ogg"}
PORT = 8765


# ---------- shared state, pushed to every open page ----------
class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients = []
        self.latest = {}
        self.state = {"band": "Vexo-HACK-%02d" % BAND, "link": "starting", "phase": "starting",
                      "heard": "", "answer": None, "reason": "", "error": "", "history": [], "model": ""}

    def set(self, **changes):
        with self.lock:
            self.state.update(changes)
            msg = json.dumps({"type": "state", "state": self.state})
        self._push(msg)

    def sensor(self, kind, data):
        msg = json.dumps({"type": "sensor", "kind": kind, "data": data})
        if kind in ("battery", "temperature", "link", "activity"):
            self.latest[kind] = msg                      # replayed to pages that open later
        self._push(msg)

    def level(self, db, floor):
        self._push(json.dumps({"type": "level", "db": round(db, 1), "floor": round(floor, 1)}))

    def _push(self, msg):
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass

    def subscribe(self):
        q = queue.Queue(maxsize=400)
        with self.lock:
            self.clients.append(q)
            q.put_nowait(json.dumps({"type": "state", "state": self.state}))
            for msg in self.latest.values():
                q.put_nowait(msg)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)


hub = Hub()
commands = queue.Queue()          # ("ask",) or ("text", question) — run on the band's thread
stop_listening = threading.Event()


# ---------- web server ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", kind="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/events":
            return self._events()
        if path == "/last-question.wav":
            f = RECORDINGS / "last-question.wav"
            return self._send(200, f.read_bytes(), "audio/wav") if f.exists() else self._send(404)
        files = {"/": "index.html", "/index.html": "index.html"}
        if path in files:
            return self._send(200, (UI / files[path]).read_bytes(), "text/html; charset=utf-8")
        if path == "/workspace":
            self.send_response(302); self.send_header("Location", "/workspace/?live=1"); self.end_headers(); return
        for prefix, folder in (("/workspace/", WORKSPACE), ("/vexo-open-kit/js/src/", KIT / "js" / "src")):
            if path.startswith(prefix):
                name = path[len(prefix):] or "index.html"
                target = (folder / name).resolve()
                if folder.resolve() in target.parents and target.is_file():   # nothing outside these folders
                    kind = TYPES.get(target.suffix, "application/octet-stream")
                    return self._send(200, target.read_bytes(), kind)
        self._send(404, b"not found")

    def do_POST(self):
        # only pages served from this server may send commands
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://localhost:%d" % PORT, "http://127.0.0.1:%d" % PORT):
            return self._send(403, b"forbidden")
        length = min(int(self.headers.get("Content-Length") or 0), 4000)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        if self.path == "/ask":
            commands.put(("ask",))
        elif self.path == "/send":
            stop_listening.set()
        elif self.path == "/text":
            q = str(body.get("question", "")).strip()[:500]
            if not q:
                return self._send(400, b"empty question")
            commands.put(("text", q))
        else:
            return self._send(404)
        self._send(204)

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        if self.headers.get("Origin") in ("http://localhost:8000", "http://127.0.0.1:8000"):
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin"))
        self.end_headers()
        q = hub.subscribe()
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(b"data: " + msg.encode() + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            hub.unsubscribe(q)


# ---------- band loop (all band calls happen on this thread) ----------
def answer_on_band(band, result, source):
    ans = result.get("answer", "unsure")
    if ans == "unsure":
        band.set_led(COLOURS[ans], pattern="blink", period=400)
    else:
        band.set_led(COLOURS[ans], brightness=1.0)
    entry = {"time": time.strftime("%H:%M:%S"), "heard": result.get("question_heard", ""),
             "answer": ans, "reason": result.get("reason", ""), "source": source,
             "search": hub.state.get("search", "")}
    hist = ([entry] + hub.state["history"])[:30]
    hub.set(phase="answer", heard=entry["heard"], answer=ans, reason=entry["reason"], history=hist, error="")
    print('  %s -> %s  (%s)' % (entry["heard"], ans.upper(), entry["reason"]))
    t = time.monotonic()
    while time.monotonic() - t < 5 and commands.empty():
        band.wait(0.1)


def searching(query, summary):
    """Called from the Realtime client while the model looks something up."""
    if summary is None:
        hub.set(phase="searching", search=query, found="")
    else:
        hub.set(phase="thinking", search=query, found=summary[:400])


def ask_by_voice(band, decoder, key, model):
    box = {}
    opener = threading.Thread(target=lambda: box.update(rt=yesno._try(lambda: Realtime(key, model, on_search=searching))), daemon=True)
    opener.start()
    hub.set(phase="listening", heard="", answer=None, reason="", error="", search="", found="")
    pcm, heard = yesno.listen(band, decoder, 10.0, False, stop=stop_listening, on_level=hub.level)
    opener.join()
    rt = box.get("rt")
    if isinstance(rt, Exception):
        raise rt
    try:
        if not heard or len(pcm) < 0.3 * 32000:           # under 0.3 s: nothing to send
            hub.set(phase="nothing", error="Did not hear a question. Speak closer to the band.")
            band.set_led(COLOURS["unsure"], pattern="blink", period=200)
            band.wait(2)
            return
        hub.set(phase="thinking", seconds=round(len(pcm) / 32000, 1))
        band.set_led("#3060ff", pattern="breathe", period=800)
        result = rt.ask_audio(yesno.upsample_16k_to_24k(audio.normalise(pcm)))
    finally:
        rt.close()
    answer_on_band(band, result, "voice")


def ask_by_text(band, question, key, model):
    hub.set(phase="thinking", heard=question, answer=None, reason="", error="", search="", found="")
    band.set_led("#3060ff", pattern="breathe", period=800)
    rt = Realtime(key, model, on_search=searching)
    try:
        result = rt.ask_text(question)
    finally:
        rt.close()
    answer_on_band(band, result, "typed")


def stream_sensors(band):
    """Turn on every non-microphone stream and forward it to the pages (the workspace shows it)."""
    ms = lambda e: round(e.time * 1000) if getattr(e, "time", None) else round(time.time() * 1000)
    i = band.info
    hub.set(info={"firmware": i.firmware, "protocol": i.protocol, "features": list(i.features or []),
                  "clock": band.clock, "link": band.transport_kind, "motion": 25})
    band.on("motion", lambda m: hub.sensor("motion", {"t": m.t, "time": ms(m), "n": m.n, "ax": m.ax, "ay": m.ay,
                                                      "az": m.az, "gx": m.gx, "gy": m.gy, "gz": m.gz}))
    band.on("event", lambda e: hub.sensor("event", {"t": e.t, "time": ms(e), "kind": e.kind, "arg": e.arg,
                                                    "face": getattr(e, "face", None)}))
    band.on("activity", lambda a: hub.sensor("activity", {"t": a.t, "time": ms(a), "steps": a.steps,
                                                          "cadence": a.cadence, "state": a.state, "motion": a.motion}))
    band.on("battery", lambda b: hub.sensor("battery", {"time": ms(b), "percent": b.percent, "millivolts": b.millivolts,
                                                        "state": b.state, "charging": b.charging}))
    band.on("temperature", lambda x: hub.sensor("temperature", {"t": x.t, "time": ms(x), "celsius": x.celsius}))
    band.on("link", lambda x: hub.sensor("link", {"t": x.t, "time": ms(x), "rssi": x.rssi,
                                                  "txPower": x.tx_power, "phy": x.phy}))
    band.on("notice", lambda n: hub.sensor("notice", {"time": ms(n), "kind": n.kind, "arg": n.arg}))
    streams = dict(motion=25, activity=True, battery=True, temperature=2)
    if band.transport_kind != "serial":
        streams["link"] = 1
    band.configure(**streams)


def band_loop(args, key, model):
    from vexo_open.sync import VexoError
    hub.set(link="searching", phase="searching", model=model)
    if args.sim:
        voice = KIT / "dashboard" / "speech" / "sample-speech.opus"
        from vexo_open.transports.sim import SimTransport
        band = Band.connect(BAND, transport=SimTransport(BAND, auto_tap=False, audio_packets=audio.ogg_packets(voice)))
    else:
        band = yesno.connect_patiently("serial" if args.usb else "ble", minutes=30)
    hub.set(link=band.transport_kind, phase="idle")
    print("Connected to %s." % band.name)
    band.on("double-tap", lambda e: commands.put(("ask",)))
    band.on("reconnecting", lambda e: hub.set(link="reconnecting"))
    band.on("reconnected", lambda e: hub.set(link=band.transport_kind))
    band.on("disconnect", lambda e: hub.set(link="disconnected", phase="disconnected",
                                            error="Band disconnected (%s). Restart the server." % e.reason))
    band.configure(events=True)
    stream_sensors(band)
    decoder = audio.PcmDecoder()
    while True:
        try:
            yesno.idle(band)
            hub.set(phase="idle")
            while True:
                try:
                    cmd = commands.get_nowait()
                    break
                except queue.Empty:
                    band.wait(0.1)
            if cmd[0] == "ask":
                ask_by_voice(band, decoder, key, model)
            elif cmd[0] == "text":
                ask_by_text(band, cmd[1], key, model)
        except (VexoError, ValueError, OSError) as error:
            print("  problem:", error)
            hub.set(phase="error", error=str(error))
            if not band.connected:
                return
            band.wait(2)


def main():
    import os
    p = argparse.ArgumentParser(description="Ask Vexo with a web page.")
    p.add_argument("--usb", action="store_true")
    p.add_argument("--sim", action="store_true")
    args = p.parse_args()
    model = os.environ.get("OPENAI_REALTIME_MODEL", "").strip() or yesno.MODEL
    key = ai.key()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("Open http://localhost:%d/" % PORT)
    print("Note: what the band's microphone hears is sent over the internet to OpenAI (openai.com), model %s." % model)
    try:
        band_loop(args, key, model)
        while True:          # band gone: keep the page up so it can show the error
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
