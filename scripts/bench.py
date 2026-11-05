#!/usr/bin/env python3
"""Accuracy benchmark for TrillFun's speech engine.

    ./.venv/bin/python scripts/bench.py [--preset radio,phone,clean] [--model small.en]

Runs every phrase in tests/corpus through faster-whisper with the same decoding
settings the server uses, optionally after the app's own audio conditioning
chain, and reports word error rate plus 10-code accuracy.

Used to choose defaults (beam size, prompts, hot words) - not a unit test.
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(ROOT, "tests", "corpus")
sys.path.insert(0, os.path.join(ROOT, "src"))


def ffmpeg():
    p = os.path.join(ROOT, "node_modules", "@ffmpeg-installer", "linux-x64", "ffmpeg")
    return p if os.path.exists(p) else "ffmpeg"


def norm(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return " ".join(s.split())


def wer(ref, hyp):
    a, b = norm(ref).split(), norm(hyp).split()
    sm = difflib.SequenceMatcher(None, a, b)
    err = sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal")
    return err, len(b)


def codes(text):
    out = []
    t = text.lower()
    for m in re.finditer(r"\b(?:ten|10)[\s-]*(four|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|five|six|seven|eight|nine|\d{1,3})\b", t):
        out.append(m.group(1))
    return out


PROMPTS = {
    "radio": (
        "Radio dispatch traffic. Ten codes like ten four, ten twenty, ten fifty four. "
        "Units respond, en route, copy, stand by, dispatch, mile marker, northbound."
    ),
    "phone": (
        "Telephone conversation. Thank you for calling, how may I help you, appointment, "
        "policy number, running late, ten minutes, see you soon, thank you, goodbye."
    ),
    "auto": (
        "Radio dispatch and telephone conversation. Ten codes like ten four, ten twenty, ten fifty four. "
        "Units respond, en route, copy, stand by, dispatch. Thank you for calling, appointment, policy number."
    ),
}


def build_prompt(preset="radio"):
    """Keep prompts short: the initial_prompt window is small and long prompts
    both bias the transcript and slow decoding. Mirrors src/asr.js."""
    return PROMPTS.get(preset, PROMPTS["auto"])


HOTWORDS = (
    "ten four, ten twenty, ten twenty three, ten fifty two, ten fifty four, ten eighty, ten ninety nine, "
    "dispatch, unit, en route, copy, stand by, backup, mile marker, northbound, southbound, eastbound, "
    "interstate, pursuit, ambulance, policy number, appointment"
)


def condition(src, preset):
    dst = src.replace(".wav", f".pre-{preset}.wav")
    if os.path.exists(dst):
        return dst
    from ffmpeg_chain import chain_for
    subprocess.run(
        [ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-i", src,
         "-af", chain_for(preset), "-ar", "16000", "-ac", "1", dst],
        check=True,
    )
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="none,radio,phone")
    ap.add_argument("--model", default=os.environ.get("TRILL_ASR_MODEL", "small.en"))
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--no-prompt", action="store_true")
    ap.add_argument("--no-hotwords", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    model_path = os.path.join(ROOT, ".models", args.model)
    manifest = json.load(open(os.path.join(CORPUS, "manifest.json")))

    t0 = time.time()
    model = WhisperModel(model_path, device="cpu", compute_type="int8", cpu_threads=4)
    load = time.time() - t0
    print(f"model {args.model} loaded in {load:.1f}s", file=sys.stderr)

    results = []
    total_audio = 0.0
    total_time = 0.0
    for preset in args.preset.split(","):
        err = tot = 0
        code_hit = code_tot = 0
        t_start = time.time()
        for item in manifest:
            src = os.path.join(CORPUS, f"{item['id']}.{'wav' if preset == 'none' else preset + '.wav'}"
                               if preset in ("radio", "phone") else f"{item['id']}.wav")
            if preset == "none":
                audio = os.path.join(CORPUS, f"{item['id']}.radio.wav")  # realistic input
                decode = os.path.join(CORPUS, f"{item['id']}.wav")
                audio = decode  # measure the model's ceiling on clean audio
            else:
                audio = os.path.join(CORPUS, f"{item['id']}.{preset}.wav")
            prompt = build_prompt(preset)
            t = time.time()
            segs, info = model.transcribe(
                audio,
                language="en",
                beam_size=args.beam,
                best_of=args.beam,
                temperature=[0.0, 0.2, 0.4],
                condition_on_previous_text=False,
                initial_prompt=None if args.no_prompt else prompt,
                hotwords=None if args.no_hotwords else HOTWORDS,
                without_timestamps=True,
                vad_filter=False,
            )
            text = " ".join(s.text.strip() for s in segs)
            total_time += time.time() - t
            total_audio += info.duration
            e, n = wer(item["text"], text)
            err += e
            tot += n
            # 10-code accuracy: did each spoken code appear, in canonical form?
            from tencodes import expected_codes  # noqa: E402  (src/tencodes.py)
            want = expected_codes(item["text"])
            got = expected_codes(text)
            for c in want:
                code_tot += 1
                if c in got:
                    code_hit += 1
            results.append({
                "id": item["id"], "preset": preset, "ref": item["text"], "hyp": text,
                "errors": e, "words": n, "codes": want, "codesPresent": got,
            })
        elapsed = time.time() - t_start
        print(
            f"{preset:>6}: WER {err / max(1, tot) * 100:5.1f}%   "
            f"10-codes {code_hit}/{code_tot}   "
            f"{total_audio:5.1f}s audio in {elapsed:5.1f}s ({total_audio / max(elapsed, .01):.1f}x realtime)"
        )
    if args.json:
        with open(os.path.join(ROOT, "tests", "bench-results.json"), "w") as f:
            json.dump(results, f, indent=1)
        print("wrote tests/bench-results.json", file=sys.stderr)


if __name__ == "__main__":
    main()
