#!/usr/bin/env python3
"""Warm Piper voice for JARVIS.

Loading a 73 MB ONNX model costs about a second, and the CLI pays that on EVERY
invocation: measured 1.55s to synthesise a 7.35s line, nearly all of it startup.
Spoken replies are short and frequent, so that overhead is the whole latency
budget. This holds the model in memory and answers one line at a time.

Protocol is JSON lines, because the alternative is inventing a framing for text
that may contain anything he says:

    stdin   {"text": "...", "out": "/abs/path.wav"}        one per line
    stdout  {"ready": true, "voice": "...", "ms": 1234}    once, at startup
            {"ok": true, "ms": 42}                          per request
            {"ok": false, "error": "..."}                   per failed request

Failures are reported and the process stays up: one unpronounceable line must
not take the voice down until the next restart. The caller (voice.js) owns the
queue, the timeout and the restart policy — this end stays deliberately dumb.
"""
import json
import os
import sys
import time
import wave


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    model = os.environ.get("PIPER_MODEL", "")
    if not model or not os.path.exists(model):
        emit({"ready": False, "error": "model not found: " + model})
        return 1

    started = time.time()
    try:
        from piper import PiperVoice, SynthesisConfig
    except Exception as e:                      # piper not installed in this interpreter
        emit({"ready": False, "error": "import piper failed: " + str(e)})
        return 1

    try:
        voice = PiperVoice.load(model)
    except Exception as e:
        emit({"ready": False, "error": "load failed: " + str(e)})
        return 1

    # speaker_id only means anything on a multi-speaker checkpoint; en_GB-semaine
    # carries four and obadiah is 2. length_scale is PHONEME DURATION, so larger
    # is slower — the measured cadence is most of what separates a butler from a
    # screen reader, and it is the one knob worth exposing.
    syn = SynthesisConfig(
        speaker_id=int(os.environ.get("PIPER_SPEAKER", "0") or 0),
        length_scale=float(os.environ.get("PIPER_LENGTH_SCALE", "1.0") or 1.0),
    )
    emit({"ready": True, "voice": os.path.basename(model),
          "speaker": syn.speaker_id, "length_scale": syn.length_scale,
          "ms": int((time.time() - started) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        t0 = time.time()
        try:
            req = json.loads(line)
            text = str(req.get("text") or "")
            out = str(req.get("out") or "")
            if not text or not out:
                emit({"ok": False, "error": "text and out are both required"})
                continue
            with wave.open(out, "wb") as wav:
                voice.synthesize_wav(text, wav, syn_config=syn)
            emit({"ok": True, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            emit({"ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
