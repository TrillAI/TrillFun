# TrillFun

Universal audio transcription workspace — built for radio chatter (10-codes, call signs, clipped PTT
audio), phone calls, and live streams that keep transcribing 24/7 even when the page is closed.

> **Status: work in progress.** The project scaffold is landing on this branch; the application code
> (capture pipeline, ASR engine, radio/telephony audio conditioning, 10-code dictionary, transcript
> history) follows in the next commits.

## Planned layout

```
src/            Node server: audio capture, ASR, transcript store, websocket stream
public/         Web app: live transcript, history, settings, system-audio capture
```

## Getting started

```bash
npm install
npm start
```

Then open http://localhost:8787.

