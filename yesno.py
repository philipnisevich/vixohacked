#!/usr/bin/env python3
"""Ask Vexo a yes-or-no question out loud. The band's light answers: green = yes, red = no.

    .venv/bin/python yesno.py                    the real band (number 9) over Bluetooth
    .venv/bin/python yesno.py --usb              the real band on the USB cable
    .venv/bin/python yesno.py --say "Is the sun a star?"   typed question, no microphone needed
    .venv/bin/python yesno.py --sim              pretend band (plays the kit's sample recording)

How it works:
    double-tap the band  ->  light goes solid blue: the microphone is on, ask your question
    stop talking         ->  about a second of quiet ends the question (or --max-seconds)
    band sound (Opus)    ->  decoded to 16 kHz PCM, made louder, resampled to 24 kHz
                         ->  OpenAI Realtime API (gpt-realtime-2.1), which hears the audio itself
                         ->  the model must call answer(yes | no | unsure)
                         ->  light: green (yes), red (no), blinking yellow (unsure / nothing heard)

Needs your team's OpenAI key in OPENAI_API_KEY, or in a .env file in this folder
(OPENAI_API_KEY=...). Never put the key in code, git or a chat.
While the light is solid blue the microphone is on, and what it hears is sent to OpenAI:
tell the people near you.
"""
import argparse
import array
import base64
import json
import socket
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = HERE / "vexo-open-kit"
sys.path.insert(0, str(KIT / "python"))                 # the band library
sys.path.insert(0, str(KIT / "examples" / "python"))    # the kit's helpers: ai.key(), tiny_websocket

import ai                                               # noqa: E402  reads OPENAI_API_KEY (env or .env)
from tiny_websocket import WebSocket, WebSocketError    # noqa: E402
from vexo_open import audio                             # noqa: E402
from vexo_open.sync import Band                         # noqa: E402

BAND = 9                                     # our band: Vexo-HACK-09. Never another team's.

MODEL = "gpt-realtime-2.1"                   # override with the environment variable OPENAI_REALTIME_MODEL
URL = "wss://api.openai.com/v1/realtime?model="

# Listening: dB below full scale of each 20 ms of sound (quiet room about -50, speech nearby about -30).
SPEECH_DB = -40                              # louder than this counts as talking
END_QUIET_S = 1.0                            # this much quiet after talking ends the question
NO_SPEECH_S = 6.0                            # give up if nobody talks this long

RECORDINGS = HERE / "recordings"             # the last question is saved here (gitignored)

COLOURS = {"yes": "#00ff40", "no": "#ff0000", "unsure": "#ffb000"}

def instructions() -> str:
    today = time.strftime("%A, %B %d, %Y, %H:%M")
    return (
        "You are Vexo, an assistant that lives in a wristband. The user speaks one yes-or-no question. "
        "It is now %s (local time, San Francisco). "
        "If the question depends on current or recent information (weather, news, prices, sports, "
        "companies, people, events, anything after your training data), first call `web_search` with a "
        "short search query, then decide. You may search at most twice. Otherwise answer from your own "
        "knowledge and common sense. "
        "Finish by calling the function `answer` exactly once. Use 'yes' or 'no' whenever a reasonable "
        "answer exists, including a best judgement from search results (for weather, 'sunny' means mostly "
        "sunny or clear). Use 'unsure' only if the audio is not a question, is unintelligible, or the "
        "search truly gave nothing to go on." % today
    )


SEARCH_TOOL = {
    "type": "function",
    "name": "web_search",
    "description": "Search the web for current information. Returns a short factual summary.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "A short web search query."}},
        "required": ["query"],
    },
}
MAX_SEARCHES = 2


def web_search(query: str) -> str:
    """One web search through OpenAI's Responses API (built-in web_search tool). Returns a short summary."""
    reply = ai.request({
        "input": query,
        "tools": [{"type": "web_search"}],
        "instructions": "Today is %s. Search the web and answer in at most 3 short factual sentences, "
                        "with dates where they matter." % time.strftime("%A, %B %d, %Y"),
    })
    return ai._text(reply) or "No results."
ANSWER_TOOL = {
    "type": "function",
    "name": "answer",
    "description": "Give the answer to the user's yes-or-no question. The band's light shows it.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_heard": {"type": "string", "description": "The question as you understood it, word for word."},
            "answer": {"type": "string", "enum": ["yes", "no", "unsure"]},
            "reason": {"type": "string", "description": "At most 12 words on why."},
        },
        "required": ["question_heard", "answer", "reason"],
    },
}


class Realtime:
    """One OpenAI Realtime session over a WebSocket, set up for text-only answers by tool call."""

    def __init__(self, key: str, model: str, on_search=None):
        self.on_search = on_search                           # on_search(query, summary_or_None): progress for a UI
        try:
            self.ws = WebSocket(URL + model, headers={"Authorization": "Bearer " + key}, timeout=10)
        except WebSocketError as error:
            hint = {401: "the key was not accepted", 403: "the key may not use this model",
                    404: "unknown model %s" % model, 429: "too many requests or budget used up"}.get(error.status, str(error))
            raise ai.AiError("OpenAI Realtime refused the connection: %s (status %d)." % (hint, error.status)) from None
        self._send({"type": "session.update", "session": {
            "type": "realtime",
            "model": model,
            "output_modalities": ["text"],
            "instructions": instructions(),
            "audio": {"input": {"format": {"type": "audio/pcm", "rate": 24000}, "turn_detection": None}},
            "tools": [ANSWER_TOOL, SEARCH_TOOL],
            "tool_choice": "required",
        }})

    def _send(self, event: dict) -> None:
        self.ws.send(json.dumps(event))

    def ask_audio(self, pcm24: bytes) -> dict:
        step = 24000 * 2 // 2                                    # half a second of 16-bit samples per message
        for i in range(0, len(pcm24), step):
            self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm24[i:i + step]).decode()})
        self._send({"type": "input_audio_buffer.commit"})
        self._send({"type": "response.create"})
        return self._wait()

    def ask_text(self, text: str) -> dict:
        self._send({"type": "conversation.item.create", "item": {
            "type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})
        self._send({"type": "response.create"})
        return self._wait()

    def _wait(self, timeout: float = 25.0) -> dict:
        deadline = time.monotonic() + timeout
        searches = 0
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ai.AiError("OpenAI Realtime did not answer within %d seconds." % timeout)
            try:
                raw = self.ws.recv(timeout=left)
            except socket.timeout:
                continue
            if raw is None:
                raise ai.AiError("OpenAI Realtime closed the connection.")
            event = json.loads(raw)
            kind = event.get("type")
            if kind == "error":
                err = event.get("error") or {}
                raise ai.AiError("OpenAI Realtime: %s (%s)" % (err.get("message", "error"), err.get("code", "")))
            if kind == "response.done":
                response = event.get("response") or {}
                calls = [i for i in response.get("output") or [] if i.get("type") == "function_call"]
                for item in calls:
                    if item.get("name") == "answer":
                        found = json.loads(item.get("arguments") or "{}")
                        if found.get("answer") not in COLOURS:
                            found["answer"] = "unsure"
                        found["searches"] = searches
                        return found
                searched = False
                for item in calls:
                    if item.get("name") != "web_search":
                        continue
                    query = str(json.loads(item.get("arguments") or "{}").get("query", "")).strip()[:200]
                    searches += 1
                    if searches > MAX_SEARCHES:
                        summary = "Search limit reached. Answer now with what you have."
                    else:
                        print('  Searching the web: "%s"' % query)
                        if self.on_search:
                            self.on_search(query, None)
                        try:
                            summary = web_search(query)
                        except ai.AiError as error:
                            summary = "The search failed (%s). Answer from your own knowledge." % error
                        if self.on_search:
                            self.on_search(query, summary)
                    self._send({"type": "conversation.item.create", "item": {
                        "type": "function_call_output", "call_id": item.get("call_id"), "output": summary}})
                    searched = True
                if searched:
                    self._send({"type": "response.create"})
                    deadline = time.monotonic() + timeout            # fresh time for the next step
                    continue
                raise ai.AiError("OpenAI Realtime answered without calling answer() (status %s)." % response.get("status"))

    def close(self) -> None:
        self.ws.close()


def upsample_16k_to_24k(pcm: bytes) -> bytes:
    """16-bit mono PCM, 16 kHz -> 24 kHz by linear interpolation (3 samples out for every 2 in)."""
    src = array.array("h")
    src.frombytes(pcm[:len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        src.byteswap()
    n = len(src)
    out = array.array("h", bytes(2 * (n * 3 // 2)))
    for j in range(len(out)):
        pos = j * 2 / 3
        i = int(pos)
        f = pos - i
        a = src[i]
        b = src[i + 1] if i + 1 < n else a
        out[j] = int(a + (b - a) * f)
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def listen(band: Band, decoder, max_seconds: float, debug: bool, stop=None, on_level=None) -> tuple:
    """Microphone on until the speaker stops. Returns (16 kHz PCM bytes, whether any speech was heard).
    `stop` (a threading.Event) ends it from elsewhere; `on_level(db, floor)` sees every 20 ms."""
    # A new decoder for every question: the band's packet numbers start again with each stream,
    # and a reused decoder would throw the new packets away as "late" (kit docs, "Sound").
    # The caller's first PcmDecoder() already paid the slow one-time load of `av`.
    decoder = audio.PcmDecoder()
    chunks = []
    state = {"speech": False, "quiet": 0.0, "elapsed": 0.0, "floor": None, "tapped": False}
    done = threading.Event()
    if stop is not None:
        stop.clear()

    def on_audio(a):                                         # keep it short: decode, measure, collect
        pcm = decoder.feed(a)
        if not pcm:
            return
        chunks.append(pcm)
        db = audio.level_db(pcm)
        state["elapsed"] += len(pcm) / 32000
        # the room's background level: follows the quietest moments, creeps up slowly
        floor = db if state["floor"] is None else min(db, state["floor"] + 0.03)
        state["floor"] = floor
        talking = db > max(SPEECH_DB, floor + 12)
        quiet = db < floor + 8
        if debug:
            print("  %6.1f dB (room %6.1f) %s" % (db, floor, "#" * max(0, int((db + 60) / 2))))
        if on_level:
            on_level(db, floor)
        if talking:
            state["speech"], state["quiet"] = True, 0.0
        elif state["speech"] and quiet:
            state["quiet"] += len(pcm) / 32000
        if (state["speech"] and state["quiet"] >= END_QUIET_S) or state["elapsed"] >= max_seconds \
                or (not state["speech"] and state["elapsed"] >= NO_SPEECH_S):
            done.set()

    def on_tap(e):                                           # a single tap ends the question
        if state["elapsed"] > 0.7:
            state["tapped"] = True
            state["speech"] = True                           # trust the person: they asked something
            done.set()

    band.on("tap", on_tap)
    band.on("audio", on_audio)
    band.configure(audio=True)                               # light: solid blue, microphone on
    started = time.monotonic()
    while not done.is_set() and time.monotonic() - started < max_seconds + 2:
        if stop is not None and stop.is_set():
            state["tapped"] = True
            state["speech"] = True
            break
        band.wait(0.05)
    band.configure(audio=False)                              # microphone off: the LED is ours again
    band.off("audio", on_audio)
    band.off("tap", on_tap)
    pcm = b"".join(chunks)
    RECORDINGS.mkdir(exist_ok=True)
    audio.write_wav(str(RECORDINGS / "last-question.wav"), pcm)
    print("  Captured %.1f s (%s), loudness %.0f dB, room %.0f dB -> recordings/last-question.wav" % (
        len(pcm) / 32000, "tap" if state["tapped"] else "silence" if state["quiet"] >= END_QUIET_S else "time limit",
        audio.level_db(pcm), state["floor"] if state["floor"] is not None else -100))
    return pcm, state["speech"]


def show(band: Band, result: dict) -> None:
    ans = result["answer"]
    print('  Heard:  "%s"' % result.get("question_heard", ""))
    print("  Answer: %s  (%s)" % (ans.upper(), result.get("reason", "")))
    if ans == "unsure":
        band.set_led(COLOURS[ans], pattern="blink", period=400)
    else:
        band.set_led(COLOURS[ans], brightness=1.0)
    band.wait(5)


def idle(band: Band) -> None:
    band.set_led("#ffffff", brightness=0.12, pattern="breathe", period=3000)


def main() -> None:
    p = argparse.ArgumentParser(description="Ask Vexo-HACK-09 a yes-or-no question. Green = yes, red = no.")
    p.add_argument("--usb", action="store_true", help="use the USB cable instead of Bluetooth")
    p.add_argument("--sim", action="store_true", help="pretend band (plays the kit's sample recording as its voice)")
    p.add_argument("--say", metavar="QUESTION", help="type the question instead of speaking it")
    p.add_argument("--max-seconds", type=float, default=8.0, help="longest question, in seconds (default 8)")
    p.add_argument("--debug", action="store_true", help="print the loudness of every 20 ms while listening")
    args = p.parse_args()

    import os
    model = os.environ.get("OPENAI_REALTIME_MODEL", "").strip() or MODEL
    key = ai.key()                                           # no key: stop here with one sentence that says how

    if args.sim:
        voice = KIT / "dashboard" / "speech" / "sample-speech.opus"
        band = Band.connect(BAND, transport="sim", audio_packets=audio.ogg_packets(voice))
    else:
        band = connect_patiently("serial" if args.usb else "ble")
    print("Connected to %s." % band.name)
    print("Note: what the band's microphone hears is sent over the internet to OpenAI (openai.com), model %s." % model)

    if args.say:
        band.set_led("#3060ff", pattern="breathe", period=800)
        rt = Realtime(key, model)
        try:
            show(band, rt.ask_text(args.say))
        finally:
            rt.close()
            band.disconnect()
        return

    print("Loading the sound decoder...")
    decoder = audio.PcmDecoder()
    tapped = threading.Event()
    band.on("double-tap", lambda e: tapped.set())
    band.configure(events=True)
    try:
        while True:
            idle(band)
            print("\nDouble-tap the band, ask a yes-or-no question close to it, then single-tap to send.  (Ctrl+C to quit)")
            tapped.clear()
            while not tapped.is_set():
                band.wait(0.1)

            box = {}                                         # open the OpenAI session while you talk
            opener = threading.Thread(target=lambda: box.update(rt=_try(lambda: Realtime(key, model))), daemon=True)
            opener.start()
            print("  Listening... (solid blue light)")
            pcm, heard = listen(band, decoder, args.max_seconds, args.debug)
            opener.join()
            rt = box.get("rt")
            if isinstance(rt, Exception):
                raise rt
            try:
                if not heard:
                    print("  Did not hear a question. Speak closer to the band, or try --debug to see the levels.")
                    band.set_led(COLOURS["unsure"], pattern="blink", period=200)
                    band.wait(2)
                    continue
                print("  Thinking... (%.1f s of sound)" % (len(pcm) / 32000))
                band.set_led("#3060ff", pattern="breathe", period=800)
                show(band, rt.ask_audio(upsample_16k_to_24k(audio.normalise(pcm))))
            finally:
                rt.close()
    except KeyboardInterrupt:
        print("\nBye.")
    finally:
        if band.connected:
            band.disconnect()


def connect_patiently(transport: str, minutes: float = 5.0) -> Band:
    """Keep looking for our band until it shows up, so the double-tap can come at any time."""
    from vexo_open.sync import VexoError
    deadline = time.monotonic() + minutes * 60
    print("Looking for Vexo-HACK-%02d. Double-tap the band (it blinks blue) and keep it close..." % BAND)
    while True:
        try:
            return Band.connect(BAND, transport=transport, auto_reconnect=True)
        except VexoError as error:
            if error.code not in ("not-found-nearby", "no-port") or time.monotonic() > deadline:
                raise
            print("  not found yet, still looking (double-tap the band; close the workspace tab if it is open)")
            time.sleep(2)


def _try(fn):
    try:
        return fn()
    except Exception as error:                               # handed to the main thread, raised there
        return error


if __name__ == "__main__":
    main()
