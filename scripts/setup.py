#!/usr/bin/env python3
"""One-shot installer for TrillFun's local speech engine.

Run by `npm run setup` (and by src/index.js when something is missing):

  python3 scripts/setup.py

What it does, all idempotently:

  1. creates .venv and installs faster-whisper (+ ffmpeg wheel deps) into it
  2. downloads the Whisper model in CTranslate2 format into .models/<name>
  3. verifies the model checksum

Nothing here needs a GPU. A CPU-only box with ~150 MB of disk per model is
enough; the default model is Whisper "base.en", ~145 MB.

Model source: the models are published as ordinary npm tarballs, which makes
them reachable from any environment that can reach the npm registry (the
sandbox this app was built in has no route to huggingface.co). Any local
CTranslate2 Whisper directory works too - point TRILL_MODEL_DIR at it.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.environ.get("TRILL_MODEL_DIR", os.path.join(ROOT, ".models"))
VENV_DIR = os.environ.get("TRILL_VENV_DIR", os.path.join(ROOT, ".venv"))
DEFAULT_MODEL = os.environ.get("TRILL_ASR_MODEL", "small.en")

# name -> (pip package to install, npm package parts, expected sha256 of model.bin,
#          approximate size for progress reporting)
CATALOG = {
    "small.en": {
        "parts": [
            "@skillninja/shortmovie-telop-model-p0",
            "@skillninja/shortmovie-telop-model-p1",
            "@skillninja/shortmovie-telop-model-p2",
            "@skillninja/shortmovie-telop-model-p3",
        ],
        "sha256": "ca732cb1379efc49417d028465f543d83a39de2c61f3027678de103dc404ce73",
        "size": 248,
        "note": "Whisper small.en, CTranslate2 int8 - best accuracy for radio/phone audio on CPU",
    },
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def step(msg):
    log(f"\033[36m==>\033[0m {msg}")


def ok(msg):
    log(f"\033[32m  ok\033[0m {msg}")


def venv_python():
    return os.path.join(VENV_DIR, "bin", "python")


def ensure_venv(force=False):
    py = venv_python()
    if os.path.exists(py) and not force:
        probe = subprocess.run([py, "-c", "import faster_whisper,ctranslate2"], capture_output=True)
        if probe.returncode == 0:
            ok("python environment ready")
            return py
    step("creating python environment (.venv)")
    if not os.path.exists(py):
        subprocess.check_call([sys.executable, "-m", "venv", VENV_DIR])
    step("installing faster-whisper")
    subprocess.check_call(
        [py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        stdout=subprocess.DEVNULL,
    )
    subprocess.check_call([py, "-m", "pip", "install", "--quiet", "faster-whisper"])
    ok("faster-whisper installed")
    return py


def npm_tarball(pkg):
    out = subprocess.check_output(["npm", "view", pkg, "dist.tarball"], text=True).strip()
    if not out:
        raise RuntimeError(f"could not resolve tarball for {pkg}")
    return out


def download(url, dest):
    log(f"  downloading {os.path.basename(dest)} ...")
    with urllib.request.urlopen(url, timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)


def model_target(name):
    return os.path.join(MODELS_DIR, name)


def assemble_model(name, spec):
    target = model_target(name)
    marker = os.path.join(target, ".complete")
    if os.path.exists(marker):
        ok(f"model {name} already installed")
        return target
    step(f"installing speech model {name} ({spec['note']})")
    os.makedirs(target, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        parts = {}  # part index -> path, later packages never overwrite a collected part
        for pkg in spec["parts"]:
            work = tempfile.mkdtemp(dir=tmp)  # own dir per package: no stale leftovers
            tgz = os.path.join(work, "pkg.tgz")
            download(npm_tarball(pkg), tgz)
            with tarfile.open(tgz) as t:
                t.extractall(work)
            src = os.path.join(work, "package")
            for f in os.listdir(src):
                if f.startswith("model.bin.part"):
                    idx = int(f.rsplit("part", 1)[1])
                    parts[idx] = os.path.join(src, f)
            for f in ("config.json", "tokenizer.json", "vocabulary.json",
                      "preprocessor_config.json", "model.sha256", "README.md", "LICENSE"):
                p = os.path.join(src, f)
                if os.path.exists(p):
                    shutil.copy(p, target)
        if not parts:
            raise RuntimeError(f"no model parts found for {name}")
        expected = max(parts) + 1
        if len(parts) != expected:
            raise RuntimeError(f"missing model parts for {name}: have {sorted(parts)}")
        dst = os.path.join(target, "model.bin")
        with open(dst, "wb") as out:
            for idx in sorted(parts):
                with open(parts[idx], "rb") as f:
                    shutil.copyfileobj(f, out, 1 << 20)
    digest = hashlib.sha256(open(dst, "rb").read()).hexdigest()
    if digest != spec["sha256"]:
        raise RuntimeError(f"checksum mismatch for {name}: {digest}")
    open(marker, "w").write(digest)
    ok(f"model {name} ready ({os.path.getsize(dst) // 1048576} MB, checksum verified)")
    return target


def verify(py, target):
    step("verifying recognizer")
    code = (
        "import sys,json;from faster_whisper import WhisperModel;"
        f"m=WhisperModel({target!r},device='cpu',compute_type='int8',cpu_threads=2);"
        "print('model ok')"
    )
    t0 = time.time()
    r = subprocess.run([py, "-c", code], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-1500:])
    ok(f"recognizer loads in {time.time() - t0:.1f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--skip-model", action="store_true")
    ap.add_argument("--check", action="store_true", help="only report what is missing")
    args = ap.parse_args()

    if args.check:
        status = {
            "venv": os.path.exists(venv_python()),
            "modelDir": model_target(args.model),
            "modelReady": os.path.exists(os.path.join(model_target(args.model), ".complete")),
            "model": args.model,
        }
        print(json.dumps(status))
        return

    spec = CATALOG.get(args.model)
    if spec is None:
        raise SystemExit(f"unknown model {args.model}; known: {', '.join(CATALOG)}")
    py = ensure_venv()
    if not args.skip_model:
        target = assemble_model(args.model, spec)
        verify(py, target)
    log("\n\033[32mTrillFun speech engine is ready.\033[0m")
    log(json.dumps({"python": py, "model": model_target(args.model)}))


if __name__ == "__main__":
    main()
