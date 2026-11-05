#!/usr/bin/env python3
"""TrillFun ASR worker.

Long-lived speech recognition process driven by the Node server.

Why a separate Python process:
  * faster-whisper (CTranslate2) is the most accurate CPU English recognizer we
    can run locally without a GPU, and it is far more robust on noisy radio and
    telephone audio than browser SpeechRecognition
  * the model loads once and stays hot for the whole 24/7 session
  * a worker crash can never take the web UI / transcript store down

Protocol: newline-delimited JSON on stdin/stdout.

  -> {"id":"s1","op":"transcribe","path":"/tmp/x.wav","preset":"radio",
      "prompt":"...","language":"en"}
  -> {"id":"s2","op":"nudge","text":"... previous transcript ..."}
      <- {"type":"nudged"}    (next decode is primed with this text)
  <- {"type":"progress","id":"s1","stage":"transcribing"}
  <- {"type":"result","id":"s1","text":"...","segments":[...],"language":"en",
      "duration":12.3,"rtf":0.4,"speaker":null}
  <- {"type":"error","id":"s1","message":"..."}
  -> {"id":"m1","op":"ping"}   <- {"type":"pong","id":"m1"}
"""
import json
import os
import sys
import time
import traceback

MODEL_CACHE = {}
STATE = {
    "model": None,
    "model_path": None,
    "compute": "int8",
    "threads": 4,
    "language": "en",
    "loaded_at": None,
}


# Text used to prime the *next* decode. Long-lived streams benefit from this:
# the model keeps the previous line in context (call signs, topic, spelling)
# without enabling condition_on_previous_text, which is what causes 24/7 loops.
NEXT_PROMPT = {"text": None}

# How much previous transcript to feed back. Whisper's prompt window is small;
# more than a couple of lines just displaces the preset prompt.
NUDGE_CHARS = 160


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model(path, compute_type, cpu_threads):
    from faster_whisper import WhisperModel

    key = (path, compute_type, cpu_threads)
    if key in MODEL_CACHE:
        return MODEL_CACHE[key]
    t0 = time.time()
    model = WhisperModel(
        path,
        device="cpu",
        compute_type=compute_type,
        cpu_threads=max(1, int(cpu_threads)),
        num_workers=1,
    )
    log(f"[asr] model loaded in {time.time() - t0:.1f}s: {path} ({compute_type}, {cpu_threads} threads)")
    MODEL_CACHE[key] = model
    return model


def dedupe_repeats(text, min_words=6, max_repeats=12):
    """Collapse the repeated phrase loops Whisper produces on long segments.

    On a 25 s slice of continuous audio the decoder sometimes emits the same
    clause over and over ("... mile marker twelve, ... mile marker twelve").
    A human repeating a phrase verbatim six times in a row is not a thing on
    dispatch audio, so collapse exact runs of the same n-word block, longest
    block first. Single word stutters ("four, four") are left alone.
    """
    words = text.split()
    if len(words) < min_words * 2:
        return text
    for n in range(min(12, len(words) // 2), min_words - 1, -1):
        out = []
        i = 0
        changed = False
        while i < len(words):
            block = words[i:i + n]
            reps = 1
            while len(block) == n and words[i + reps * n:i + (reps + 1) * n] == block:
                reps += 1
            if reps >= 2:
                changed = True
                out.extend(block)
                i += reps * n
            else:
                out.append(words[i])
                i += 1
        words = out
    # collapse a word repeated more than max_repeats times in a row
    out = []
    for w in words:
        if len(out) >= max_repeats and all(x == w for x in out[-max_repeats:]):
            continue
        out.append(w)
    return " ".join(out)


def handle_transcribe(req):
    model = load_model(req["model"], req.get("compute", "int8"), req.get("threads", 4))
    path = req["path"]
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    emit({"type": "progress", "id": req["id"], "stage": "transcribing"})
    t0 = time.time()

    prompt = req.get("prompt") or None
    nudge = NEXT_PROMPT.get("text")
    if nudge:
        # previous line first (most recent context), then the preset vocabulary
        prompt = f"{nudge} {prompt}" if prompt else nudge
        prompt = prompt[-400:]

    kwargs = dict(
        language=req.get("language", "en"),
        task="transcribe",
        beam_size=int(req.get("beam_size", 5)),
        best_of=int(req.get("beam_size", 5)),
        temperature=[0.0, 0.2, 0.4],
        condition_on_previous_text=False,  # avoids 24/7 drift/repetition loops
        initial_prompt=prompt,
        hotwords=req.get("hotwords") or None,
        vad_filter=bool(req.get("vad", False)),
        word_timestamps=bool(req.get("word_timestamps", False)),
        without_timestamps=not req.get("word_timestamps", False),
    )
    if kwargs["vad_filter"]:
        kwargs["vad_parameters"] = dict(min_silence_duration_ms=250, speech_pad_ms=120)

    segments, info = model.transcribe(path, **kwargs)
    out_segments = []
    pieces = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        pieces.append(text)
        item = {
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": text,
            "no_speech": round(getattr(seg, "no_speech_prob", 0.0), 3),
            "avg_logprob": round(getattr(seg, "avg_logprob", 0.0), 3),
        }
        if kwargs["word_timestamps"] and getattr(seg, "words", None):
            item["words"] = [
                {"w": w.word, "start": round(w.start, 2), "end": round(w.end, 2)}
                for w in seg.words
            ]
        out_segments.append(item)

    elapsed = time.time() - t0
    text = dedupe_repeats(" ".join(pieces).strip())
    # remember the tail of this line for the next decode
    if text and req.get("nudge", True):
        NEXT_PROMPT["text"] = text[-NUDGE_CHARS:]
    # crude but useful confidence: mean segment logprob mapped to 0..1
    logprobs = [s["avg_logprob"] for s in out_segments] or [-1.0]
    conf = max(0.0, min(1.0, 1.0 + sum(logprobs) / len(logprobs)))

    emit(
        {
            "type": "result",
            "id": req["id"],
            "text": text,
            "segments": out_segments,
            "language": getattr(info, "language", req.get("language", "en")),
            "language_probability": round(float(getattr(info, "language_probability", 0.0)), 3),
            "duration": round(float(getattr(info, "duration", 0.0)), 2),
            "elapsed": round(elapsed, 2),
            "rtf": round(elapsed / max(0.1, getattr(info, "duration", 1.0)), 3),
            "confidence": round(conf, 3),
        }
    )


def handle_download(req):
    """Fetch a model from the Hugging Face hub (used by scripts/setup.py offline path)."""
    from huggingface_hub import snapshot_download

    t0 = time.time()
    path = snapshot_download(req["repo_id"], local_dir=req.get("target"))
    emit({"type": "downloaded", "id": req["id"], "path": path, "elapsed": round(time.time() - t0, 1)})


def main():
    emit({"type": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"type": "error", "message": f"bad request: {e}"})
            continue
        op = req.get("op", "transcribe")
        req_id = req.get("id")
        try:
            if op == "transcribe":
                handle_transcribe(req)
            elif op == "nudge":
                NEXT_PROMPT["text"] = (req.get("text") or "")[-NUDGE_CHARS:] or None
                emit({"type": "nudged", "id": req_id})
            elif op == "ping":
                emit({"type": "pong", "id": req_id})
            elif op == "download":
                handle_download(req)
            elif op == "shutdown":
                emit({"type": "bye", "id": req_id})
                return
            else:
                emit({"type": "error", "id": req_id, "message": f"unknown op {op}"})
        except Exception as e:
            log("[asr] error:", traceback.format_exc())
            emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
