#!/usr/bin/env python3
"""Build a small, repeatable audio test corpus for TrillFun.

    ./.venv/bin/python scripts/make_corpus.py

Produces `tests/corpus/` (git-ignored) containing, for each phrase:

  <id>.wav        clean synthesized speech
  <id>.radio.wav  land-mobile radio simulation: 300-3000 Hz band, heavy
                  compression, codec crunch, squelch tail, pink noise floor
  <id>.phone.wav  telephone simulation: 300-3400 Hz band, hiss, AGC
  <id>.txt        the expected transcript

Speech is synthesized with espeak-ng (bundled in the espeakng-loader wheel,
no system install needed). It is robotic, which makes it a *harder* target than
human speech for the recognizer, so results are a conservative lower bound.

Used by `npm test` and by the accuracy report in the README.
"""
import ctypes
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "corpus")

PHRASES = [
    ("dispatch_call",
     "Dispatch to unit seven, respond to a ten fifty four, vehicle accident, mile marker twelve.",
     "en-us", 180, 45),
    ("unit_ack",
     "Unit seven copies, en route to mile marker twelve, ten four.",
     "en-us", 190, 38),
    ("dispatch_broadcast",
     "All units be advised, we have a ten fifty two, possible drunk driver eastbound on interstate forty.",
     "en-us", 175, 42),
    ("unit_request",
     "Three to dispatch, I have a ten twenty eight at the corner of Fifth and Main, requesting backup.",
     "en-gb", 172, 36),
    ("unit_eta",
     "Twelve en route, advise the complainant we will be there in about four minutes.",
     "en-us", 185, 50),
    ("dispatch_emergency",
     "Attention all units, ten thirty three at the warehouse on Industrial Parkway, all units respond.",
     "en-us", 165, 44),
    ("phone_late",
     "Hey it's me, I'm running about ten minutes late, can you start without me? I'll be there by six thirty.",
     "en-us", 178, 55),
    ("phone_office",
     "Thank you for calling Metro Dental, how may I help you today? I can look up your appointment right now.",
     "en-us", 190, 60),
    ("unit_plate",
     "Nine to dispatch, suspect vehicle is a blue pickup, tag bravo alpha charlie one two three, ten ninety nine.",
     "en-us", 180, 40),
    ("dispatch_pursuit",
     "Copy nine, ten eighty pursuit northbound, state patrol is en route, ETA eight minutes, keep the channel clear.",
     "en-us", 170, 47),
    ("phone_insurance",
     "I need to file a claim for the accident that happened on Tuesday, my policy number is four four seven two nine.",
     "en-us", 182, 58),
    ("radio_welfare",
     "Ten twenty three, I'm on scene now, requested a ten fifty two for the driver, stand by for the ten twenty.",
     "en-us", 176, 41),
]


_KEEP_ALIVE = {}  # ctypes handles must outlive the helper, or C code segfaults


def load_espeak():
    import espeakng_loader  # venv only dependency, used just for test audio

    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    _KEEP_ALIVE["lib"] = lib
    data = espeakng_loader.get_data_path().encode()
    cb_t = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
    chunks = []

    def _cb(wav, n, _events):
        chunks.append(ctypes.string_at(wav, n * 2))
        return 0

    cb = cb_t(_cb)
    _KEEP_ALIVE["cb"] = cb
    lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    lib.espeak_Initialize.restype = ctypes.c_int
    rate = lib.espeak_Initialize(2, 500, data, 0)  # AUDIO_OUTPUT_RETRIEVAL
    lib.espeak_SetSynthCallback.argtypes = [cb_t]
    lib.espeak_SetSynthCallback(cb)
    lib.espeak_Synth.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
                                 ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
    lib.espeak_SetParameter.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]

    def say(text, path, voice="en-us", speed=175, pitch=50):
        del chunks[:]
        lib.espeak_SetVoiceByName(voice.encode())
        lib.espeak_SetParameter(1, speed, 0)
        lib.espeak_SetParameter(3, pitch, 0)
        b = text.encode()
        lib.espeak_Synth(b, len(b) + 1, 0, 1, 0, 0, None, None)
        import wave

        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"".join(chunks))

    return say


def ffmpeg():
    try:
        sys.path.insert(0, os.path.join(ROOT, "node_modules", "@ffmpeg-installer", "linux-x64"))
        return os.path.join(ROOT, "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg")
    except Exception:
        return "ffmpeg"


def run(args):
    subprocess.run([ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def condition(src, dst, preset):
    if preset == "radio":
        chain = (
            "highpass=f=320,highpass=f=320,lowpass=f=2900,lowpass=f=2900,"
            "acompressor=threshold=-26dB:ratio=7:attack=3:release=70:makeup=7,"
            "acrusher=level_in=1.1:level_out=0.9:bits=9:mode=log:aa=0.6,"
            "dynaudnorm=f=201:g=7"
        )
        noise = "anoisesrc=color=pink:amplitude=0.035"
        weights = "1 0.5"
    else:
        chain = (
            "highpass=f=280,lowpass=f=3500,"
            "acompressor=threshold=-24dB:ratio=4:attack=6:release=150:makeup=5,"
            "dynaudnorm=f=251:g=5"
        )
        noise = "anoisesrc=color=white:amplitude=0.02"
        weights = "1 0.35"
    tmp = dst + ".tmp.wav"
    # everything in the corpus is normalized to 16 kHz mono so the test client
    # can push raw PCM exactly like the browser capture does
    run(["-i", src, "-af", chain, "-ac", "1", "-ar", "16000", tmp])
    run([
        "-i", tmp, "-f", "lavfi", "-i", f"{noise}:d=90",
        "-filter_complex", f"[0:a][1:a]amix=inputs=2:duration=first:weights={weights}[o]",
        "-map", "[o]", "-ac", "1", "-ar", "16000", dst,
    ])
    os.unlink(tmp)


def main():
    os.makedirs(OUT, exist_ok=True)
    say = load_espeak()
    manifest = []
    for pid, text, voice, speed, pitch in PHRASES:
        clean = os.path.join(OUT, f"{pid}.wav")
        say(text, clean, voice=voice, speed=speed, pitch=pitch)
        radio = os.path.join(OUT, f"{pid}.radio.wav")
        phone = os.path.join(OUT, f"{pid}.phone.wav")
        condition(clean, radio, "radio")
        condition(clean, phone, "phone")
        with open(os.path.join(OUT, f"{pid}.txt"), "w") as f:
            f.write(text + "\n")
        manifest.append({"id": pid, "text": text, "seconds": 0})
        print(f"  {pid}", flush=True)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"\ncorpus ready: {OUT} ({len(manifest)} phrases x clean/radio/phone)")


if __name__ == "__main__":
    main()
