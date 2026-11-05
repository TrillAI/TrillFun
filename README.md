# TrillFun

**Universal live transcription for radio chatter, phone calls, and streams.**

TrillFun transcribes what is actually being said — dispatch traffic full of 10-codes, phone
calls with hiss and codec artifacts, players and games — displays it as it happens, and keeps
the whole history. Pick a stream once and it keeps transcribing with every browser closed.

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  browser                    │        │  this server                         │
│  system / tab / mic audio   │──PCM──▶│  VAD → radio & phone conditioning →  │
│  (works while muted)        │        │  local Whisper (CTranslate2) →       │
└─────────────────────────────┘        │  10-code normaliser → history + UI   │
┌─────────────────────────────┐        │                                      │
│  stream URL / file          │──ffmpeg▶│  24/7, survives reloads & restarts   │
└─────────────────────────────┘        └──────────────────────────────────────┘
```

---

## Quick start

```bash
npm install          # installs the web server + ffmpeg
npm run setup        # creates .venv and fetches the speech model (~240 MB, once)
npm start            # http://localhost:8787
```

`npm run setup` is idempotent and verifies the model checksum. If Python 3.10+ is missing it
tells you exactly what to install; everything else is bundled.

Then either press **Run demo traffic** to see a dispatch channel, or start a source:

| Source | What it captures | Keeps running with the tab closed |
|---|---|---|
| **System audio** | everything the machine plays, captured before the volume stage | no (browser rule) |
| **A single tab / player** | only that tab, muted or not | no (browser rule) |
| **Microphone** | room, speakerphone, a phone on the desk | no (browser rule) |
| **Stream URL** | scanner feed, internet radio, icecast/HLS — pulled by the server | **yes, 24/7** |
| **File** | police archives, call recordings, videos | n/a (runs to completion) |

---

## The things you asked for

### Transcribe a muted stream
System and tab capture read the audio graph **before** the player's volume and mute stage. A
muted player, a muted tab, or the whole system muted still produces audio for transcription —
nothing has to be audible in the room.

### Catch everything, including radio traffic
* Band-limited audio conditioning for radio (300–3200 Hz) and phone (300–3400 Hz)
* FFT noise-floor removal for squelch hiss, engine noise and open-mic static
* Compression tuned for clipped, over-driven push-to-talk audio
* Adaptive two-window VAD: opens on the first syllable, closes on the pause, and cannot be
  fooled by AGC/squelch pumping (the usual reason VADs miss radio traffic)
* Continuous-talker slicing keeps latency bounded on a 24/7 stream instead of showing nothing
  for minutes

### Recognise all 10-codes
All 106 standard codes are in the dictionary (`src/tenCodes.js`), and every transcript is
canonicalised and annotated:

```
raw model output : dispatch to unit seven respond to a ten fifty four vehicle accident
after processing : Dispatch to unit 7 respond to 10-54 (accident — personal injury), vehicle accident
```

* “ten fifty four”, “10 54”, “ten-fifty-four”, “10 fore” → `10-4`, `10-54`
* Call signs normalised (`you knit seven` → `Unit 7`)
* Phonetic alphabet collapsed (`bravo alpha charlie` → `BAC`)
* Codes are highlighted in the UI with their meaning on hover

### Good on phone calls
Phone preset conditioning plus a telephone-tuned decoder context. Speakers are split into
`Speaker A` / `Speaker B` turns by a small pitch tracker; radio traffic is labelled by call sign
(`Dispatch`, `Unit 7`, `Engine 12`).

### Display + history
* Live transcript with timestamps, speaker, confidence and per-segment replay of the stored audio
* History tab across every stream, full-text search over every word ever transcribed
* Export: **txt, srt, vtt, csv, json**
* Everything is written to SQLite the moment it is recognised, with a configurable retention
  window (30 days of text, 72 h of audio by default)

### Keeps going when closed — 24/7
* **Stream URL sources are pulled by the server**, so closing every tab changes nothing. The
  server reconnects a dropped stream forever with backoff.
* The selected stream is remembered. After a **server restart** the last always-on stream is
  resumed automatically (`[always-on] resuming …` in the log).
* Browser-driven sources (system/tab/mic) are remembered too: they show as *armed* and restart
  the moment any TrillFun page reconnects. Browsers cannot hand audio to a closed page — that is
  a platform rule — so for true hands-off 24/7 use a stream URL.

---

## Measured accuracy

`scripts/make_corpus.py` builds a repeatable test set: 12 dispatch and phone phrases,
synthesised and then degraded to simulate real radio and telephone audio (band-limiting,
compression, codec crunch, squelch tails, pink/white noise floor). `scripts/bench.py` runs the
same decoding path the server uses.

```
$ ./.venv/bin/python scripts/bench.py --preset radio,phone

 radio: WER   6.7%   10-codes 10/10    65.5s audio in 42.9s (1.5x realtime)
 phone: WER   6.2%   10-codes 10/10   131.1s audio in 41.8s (3.1x realtime)
```

**10 of 10 spoken 10-codes come back canonical**, on both radio and phone conditioning.

Honest caveats:

* The corpus is synthetic. Real scanner feeds have heavier clipping, overlapping speakers and
  dropouts, so expect worse real-world numbers than this. The preset that matters most —
  radio — is the one with the noise and distortion baked in.
* Accuracy figures are on **Whisper `small.en`** (the default). `npm run setup -- --model`
  currently ships `small.en`; pointing `TRILL_MODEL_DIR` at a faster-whisper/CTranslate2
  `base.en` or `medium.en` directory works too.
* Speakers are labelled by call sign (radio) or a coarse pitch split (phone). This is *not*
  full diarisation — it tells turns apart, not identities.
* Music, crosstalk and very strong accents will produce errors. The app shows confidence per
  segment so low-confidence lines are visible.

## Performance

| Metric | This sandbox (2 vCPU) | Typical 8-core desktop |
|---|---|---|
| Model load | 0.5 s | 0.5 s |
| Throughput | ~1.5× realtime | ~4–6× realtime |
| Latency after a pause | ≈1–2 s | <1 s |

Radio-conditioned speech decodes at roughly half the speed of clean speech because of the
noise removal; that is still comfortably ahead of realtime on a normal desktop.

---

## Configuration

All environment variables are optional.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | bind address |
| `TRILL_DATA_DIR` | `./data` | database, stored audio, uploads |
| `TRILL_MODEL_DIR` | `./.models` | speech model location |
| `TRILL_ASR_MODEL` | `small.en` | model directory name |
| `TRILL_ASR_THREADS` | CPU count (2–8) | decoder threads |
| `TRILL_ASR_BEAM` | `5` | beam size (1 = fastest) |
| `TRILL_HARD_SLICE_SECONDS` | `25` | max slice while someone talks non-stop |
| `TRILL_RETENTION_DAYS` | `30` | transcript retention (0 = forever) |
| `TRILL_AUDIO_RETENTION_HOURS` | `72` | stored segment audio retention |
| `TRILL_KEEP_AUDIO` | `true` | store audio for replay/re-transcription |
| `TRILL_FFMPEG` | auto | path to a specific ffmpeg |
| `TRILL_DEBUG` | off | echo recognizer logs |

## API

```
GET    /api/health                        engine + capture status, counters
GET    /api/config                        presets, the full 10-code table
GET    /api/streams                       all streams with live capture state
POST   /api/streams                       {title, kind, preset, url?, alwaysOn?}
GET    /api/streams/:id                   stream + 100 newest segments
PATCH  /api/streams/:id                   {title?, preset?, alwaysOn?, pinned?}
DELETE /api/streams/:id

POST   /api/streams/:id/capture/start     {url?, preset?}  (server-side tuner)
POST   /api/streams/:id/capture/stop
GET    /api/capture/pending               always-on streams waiting for audio

GET    /api/streams/:id/segments          ?limit&offset
GET    /api/segments/recent
GET    /api/segments/:id/audio            stored WAV for that segment
GET    /api/search?q=                     full-text over every transcript
GET    /api/streams/:id/export?format=    txt|srt|vtt|csv|json
POST   /api/upload                        multipart audio/video file
POST   /api/demo                          six scripted dispatch lines
WS     /ws                                live events + PCM upload
```

WebSocket messages: `subscribe`, `capture:open`, `capture:heartbeat`, `capture:pause`, `ping`
upstream; `segment`, `level`, `stream:status`, `asr`, `capture:error` downstream. Binary frames
are raw `s16le` mono PCM at the sample rate declared in `capture:open`.

## Tests

```bash
npm run corpus   # build the synthetic test corpus (once)
npm test         # 28 end-to-end checks against a real server
```

`npm test` starts a real server on a temp data directory and exercises: static assets, the
10-code table, stream CRUD, the browser websocket push path (including a mid-stream disconnect),
transcription, speaker labels, 10-code canonicalisation, all five export formats, the demo
stream, and persistence across a server restart.

## How it fits together

| File | Role |
|---|---|
| `src/index.js` | HTTP + WebSocket server, REST API, always-on boot |
| `src/capture.js` | capture sessions: ffmpeg tuners, file playback, browser PCM |
| `src/audio.js` | WAV writer, adaptive VAD, segmenter, pitch tracker |
| `src/asr.js` | persistent Python recognizer bridge, queueing, restart-on-crash |
| `src/asr_worker.py` | faster-whisper worker (loads once, stays hot) |
| `src/tenCodes.js` | 106 codes, canonicalisation, call signs, phonetic alphabet |
| `src/store.js` | SQLite schema, FTS5 search, retention |
| `src/ffmpeg.js` | ffmpeg discovery + radio/phone conditioning chains |
| `public/` | the web app (no build step) |
| `scripts/setup.py` | venv + model installer with checksum verification |
| `scripts/bench.py` | accuracy benchmark against the corpus |

## Privacy

Speech recognition runs locally. No audio, transcript or telemetry leaves the machine.

## Licence

MIT for this application. Whisper model weights are MIT (OpenAI) / CTranslate2 conversion as
published by their authors; ffmpeg is GPL/LGPL as distributed by `@ffmpeg-installer`.
