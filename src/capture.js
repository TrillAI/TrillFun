// Always-on capture engine.
//
// The core promise of TrillFun: once a stream is selected, transcription keeps
// running whether or not the page is open. The browser is only needed to hand
// over audio it has privileged access to (system/tab/mic). Everything else —
// segmentation, recognition, history — runs here, on the server, and survives
// reloads and restarts.
//
// Capture types
// -------------
//  tuner      : this server pulls an audio stream URL itself (radio scanner
//               feed, internet radio, icecast/mp3/aac, hls). Keeps running with
//               every browser closed, forever. ffmpeg reconnects on failure.
//  file       : an uploaded or local recording (police scanner archive, call
//               recording) played through once.
//  system/tab/mic : audio produced by the user's machine, pushed from the
//               browser as PCM over the websocket. This is what captures a
//               *muted* media player, because the capture is taken from the
//               media graph/system mixer before the volume stage.
//
// Audio flow
// ----------
//   source --pcm16 @16k--> Segmenter (VAD) --> wav file --> Asr --> postProcess
//          --> Store (durable) --> bus events --> websockets to every open page
//
// If the browser goes away while the server still has a live source (tuner/file
// or a pushed stream that is still delivering), capture continues. Pushed
// streams that stop arriving are resumed automatically when the page reconnects
// (see resumePushed / /api/capture/pending).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { buildPcmArgs, filterChain, findFfmpeg } from './ffmpeg.js';
import { Segmenter, wavFile, estimatePitch, toDb, rms } from './audio.js';
import { postProcess, codesIn, looksLikeRadio } from './tenCodes.js';

const MIN_SEGMENT_SECONDS = 0.35;

export class Capture extends EventEmitter {
  constructor({ store, asr, audioDir, config }) {
    super();
    this.store = store;
    this.asr = asr;
    this.audioDir = audioDir;
    this.config = config;
    this.sessions = new Map(); // streamId -> session
    fs.mkdirSync(audioDir, { recursive: true });
  }

  // ---- public API ----------------------------------------------------------

  startTuner(streamId, url, preset = 'radio') {
    const session = this.#newSession(streamId, { type: 'tuner', url, preset });
    this.#runFfmpegSource(session);
    return this.describe(streamId);
  }

  startFile(streamId, filePath, preset = 'auto') {
    const session = this.#newSession(streamId, { type: 'file', filePath, preset });
    this.#runFfmpegSource(session);
    return this.describe(streamId);
  }

  /** A page connected and is going to push PCM for this stream. */
  openPushed(streamId, { type = 'system', preset = 'auto', sampleRate = 16000 } = {}) {
    const existing = this.sessions.get(streamId);
    if (existing) {
      existing.lastPushAt = Date.now();
      existing.paused = false;
      existing.preset = preset || existing.preset;
      if (existing.segmenter) existing.segmenter.preset = existing.preset;
      return this.describe(streamId);
    }
    const session = this.#newSession(streamId, { type, preset, sampleRate, pushed: true });
    return this.describe(streamId);
  }

  /** PCM arrives from a browser (raw s16le mono @ sampleRate). */
  pushAudio(streamId, pcm, sampleRate = 16000) {
    const session = this.sessions.get(streamId);
    if (!session) return false;
    if (session.closed) return false;
    session.lastPushAt = Date.now();
    session.bytesIn += pcm.length;
    if (!session.segmenter || session.sampleRate !== sampleRate) {
      session.sampleRate = sampleRate;
      session.segmenter = this.#makeSegmenter(session);
    }
    session.segmenter.push(pcm);
    this.#armIdleFlush(session);
    return true;
  }

  /** Mark that a pushing client went quiet without closing cleanly. */
  pause(streamId, reason = 'paused') {
    const s = this.sessions.get(streamId);
    if (!s) return;
    // close whatever was mid-transmission so it is not lost while paused
    s.segmenter?.flush({ force: true });
    s.paused = true;
    s.pauseReason = reason;
    this.emit('status', this.describe(streamId));
  }

  resume(streamId) {
    const s = this.sessions.get(streamId);
    if (!s) return null;
    s.paused = false;
    s.pauseReason = null;
    s.lastPushAt = Date.now();
    this.emit('status', this.describe(streamId));
    return this.describe(streamId);
  }

  stop(streamId, { reason = 'stopped' } = {}) {
    const s = this.sessions.get(streamId);
    if (!s) return false;
    s.closed = true;
    s.paused = true;
    s.reason = reason;
    clearTimeout(s.idleTimer);
    if (s.ffmpeg) {
      try {
        s.ffmpeg.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      s.ffmpeg = null;
    }
    s.segmenter?.flush({ force: true });
    s.segmenter = null;
    this.sessions.delete(streamId);
    this.emit('status', { streamId, status: 'stopped', reason });
    return true;
  }

  isActive(streamId) {
    const s = this.sessions.get(streamId);
    return !!s && !s.closed;
  }

  /** Everything the server knows about a live session, for the UI. */
  describe(streamId) {
    const s = this.sessions.get(streamId);
    if (!s) return null;
    return {
      streamId,
      type: s.type,
      preset: s.preset,
      state: s.closed ? 'stopped' : s.paused ? 'paused' : 'live',
      startedAt: s.startedAt,
      bytesIn: s.bytesIn,
      dropped: s.dropped,
      segments: s.segments,
      lastSegmentAt: s.lastSegmentAt,
      lastPushAt: s.lastPushAt,
      speaking: !!s.segmenter?.active,
      pendingSeconds: s.segmenter
        ? +((s.segmenter.segmentBytes || 0) / (s.sampleRate * 2)).toFixed(2)
        : 0,
      level: s.level,
      error: s.error,
    };
  }

  describeAll() {
    return [...this.sessions.keys()].map((id) => this.describe(id));
  }

  // ---- internals -----------------------------------------------------------

  #newSession(streamId, opts) {
    const existing = this.sessions.get(streamId);
    if (existing && !existing.closed) return existing;
    const session = {
      streamId,
      type: opts.type,
      preset: opts.preset || 'auto',
      sampleRate: opts.sampleRate || 16000,
      startedAt: Date.now(),
      lastPushAt: Date.now(),
      bytesIn: 0,
      dropped: 0,
      segments: 0,
      lastSegmentAt: null,
      paused: false,
      closed: false,
      level: -60,
      ffmpeg: null,
      segmenter: null,
      queue: Promise.resolve(),
      url: opts.url,
      filePath: opts.filePath,
      pushed: !!opts.pushed,
      reconnectDelay: 1000,
    };
    this.sessions.set(streamId, session);
    session.segmenter = this.#makeSegmenter(session);
    this.emit('status', this.describe(streamId));
    return session;
  }

  /**
   * If a browser stops sending audio mid-transmission (tab throttled, capture
   * stopped, laptop slept) the open segment would sit in memory forever.
   * Flush it after a few seconds so it lands in history.
   */
  #armIdleFlush(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      const s = this.sessions.get(session.streamId);
      if (!s || s.closed) return;
      if (s.segmenter?.active) s.segmenter.flush({ force: true });
    }, 3000);
    session.idleTimer.unref?.();
  }

  #makeSegmenter(session) {
    const seg = new Segmenter({
      sampleRate: session.sampleRate,
      silenceMs: session.preset === 'radio' ? 700 : 900,
      minSpeechMs: 350,
      maxSeconds: this.config.capture.maxSegmentSeconds,
      // Once the decoder is behind, close at this length even without a pause.
      // A 25 s slice is still one utterance, and it keeps latency bounded on a
      // 24/7 stream (a single endless segment would never appear on screen).
      hardSliceSeconds: this.config.capture.hardSliceSeconds,
      onLevel: (l) => {
        session.level = Math.round(l.level);
        session.levelMeta = { threshold: Math.round(l.threshold), noise: Math.round(l.noiseFloor) };
        this.emit('level', { streamId: session.streamId, ...l });
      },
      onSegment: (info) => this.#enqueueSegment(session, info),
    });
    seg.preset = session.preset;
    return seg;
  }

  #enqueueSegment(session, info) {
    // serialize recognition per stream: keeps transcript order stable even when
    // segments are produced faster than the CPU can decode them
    session.queue = session.queue.then(() => this.#recognize(session, info)).catch((err) => {
      this.emit('error', { streamId: session.streamId, message: err.message });
    });
  }

  async #recognize(session, info) {
    if (session.closed && !info.pcm?.length) return;
    if (!info.pcm || info.pcm.length / (session.sampleRate * 2) < MIN_SEGMENT_SECONDS) return;

    const streamId = session.streamId;
    const id = crypto.randomUUID().slice(0, 8);
    const file = path.join(this.audioDir, `${streamId}-${info.start}-${id}.wav`);
    try {
      fs.writeFileSync(file, wavFile(info.pcm, session.sampleRate));
    } catch (err) {
      this.emit('error', { streamId, message: `cannot write segment: ${err.message}` });
      return;
    }

    const rmsAmp = rms(info.pcm);
    const peakDb = toDb(rmsAmp);
    // If a segment is essentially silence after a squelch burst, skip the model.
    if (peakDb < -46 && info.speechSeconds < 0.6) {
      fs.rm(file, { force: true }, () => {});
      return;
    }

    const preset = session.preset;
    let result;
    try {
      result = await this.asr.transcribe(
        {
          path: file,
          preset,
          prompt: this.#promptFor(session),
        },
        { priority: 0 },
      );
    } catch (err) {
      this.emit('error', { streamId, message: `recognizer: ${err.message}` });
      // keep the audio for a retry once the engine is back
      this.emit('segment-failed', { streamId, file, error: err.message });
      return;
    }

    const raw = (result.text || '').trim();
    const text = postProcess(raw);
    const nonEmpty = text.replace(/[^a-z0-9]/gi, '').length > 1;

    if (!nonEmpty) {
      fs.rm(file, { force: true }, () => {});
      this.emit('silence', { streamId, duration: info.seconds });
      return;
    }

    const speaker = this.#speakerFor(session, info.pcm, text);
    const codes = codesIn(text);
    const stored = this.store.addSegment({
      streamId,
      text,
      rawText: raw !== text ? raw : null,
      speaker,
      preset,
      codes,
      confidence: result.confidence,
      duration: +(result.duration || info.seconds).toFixed(2),
      audio: this.config.capture.keepAudio ? file : null,
      ts: info.start,
      endedAt: info.end,
    });

    session.segments += 1;
    session.lastSegmentAt = Date.now();
    session.bytesIn += 0; // counted on push
    if (!this.config.capture.keepAudio) fs.rm(file, { force: true }, () => {});

    this.store.updateStream(streamId, { detail: text.slice(0, 120) });
    this.emit('segment', { ...stored, streamId, streamTitle: session.title ?? null });
    this.#scheduleRetention();
  }

  #promptFor(session) {
    // per-preset context prompt (see asr.js: measured, do not "improve" blind)
    return session.basePrompt || null; // null -> Asr picks by preset
  }

  /**
   * Assign a speaker label. Radio traffic uses call signs detected in the text
   * ("Dispatch", "Unit 7"); phone audio uses a light pitch-based A/B split,
   * which is enough to show "Speaker 1 / Speaker 2" turn-taking.
   */
  #speakerFor(session, pcm, text) {
    const m = /^\s*(dispatch|unit\s*\d+|car\s*\d+|engine\s*\d+|medic\s*\d+|rescue\s*\d+|truck\s*\d+|ladder\s*\d+)/i.exec(text);
    if (m) {
      const label = m[1].replace(/\s+/g, ' ').trim();
      session.speaker = label;
      return label;
    }
    if (/^(dispatch|copy|roger|ten[- ]\d)/i.test(text) && session.lastSpeaker === 'Dispatch') {
      return 'Dispatch';
    }
    if (session.preset === 'phone' || session.preset === 'auto') {
      const f0 = estimatePitch(pcm, session.sampleRate);
      if (f0) {
        // running median per "voice bucket"
        const bucket = f0 < 165 ? 'Speaker A' : 'Speaker B';
        session.lastPitch = f0;
        return bucket;
      }
    }
    return session.speaker || null;
  }

  #runFfmpegSource(session) {
    if (session.closed) return;
    const filter = filterChain(session.preset);
    const isFile = session.type === 'file';
    const args = buildPcmArgs(session.url ?? session.filePath, {
      filter,
      sampleRate: session.sampleRate,
      inputOptions: isFile
        ? []
        : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'],
    });
    let child;
    try {
      child = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      session.error = err.message;
      this.emit('error', { streamId: session.streamId, message: err.message });
      return;
    }
    session.ffmpeg = child;
    if (isFile) {
      // never let a stuck file read spin forever; files are also capped by the
      // decoder finishing normally, this is the belt-and-braces limit
      session.fileLimitBytes = this.config.capture.fileLimitSeconds * session.sampleRate * 2;
    }
    child.stdout.on('data', (chunk) => {
      if (session.closed) return;
      session.lastPushAt = Date.now();
      session.bytesIn += chunk.length;
      session.segmenter?.push(chunk);
      if (isFile && session.fileLimitBytes && session.bytesIn >= session.fileLimitBytes) {
        session.segmenter?.flush({ force: true });
        this.emit('source-ended', { streamId: session.streamId, code: 0, detail: 'end of file' });
        this.stop(session.streamId, { reason: 'end-of-file' });
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
    });
    child.on('error', (err) => {
      session.error = err.message;
      this.emit('error', { streamId: session.streamId, message: err.message });
    });
    child.on('close', (code) => {
      session.ffmpeg = null;
      if (session.closed) return;
      if (isFile) {
        session.segmenter?.flush({ force: true });
        this.emit('source-ended', { streamId: session.streamId, code, detail: errBuf.slice(-300) });
        this.stop(session.streamId, { reason: 'end-of-file' });
        return;
      }
      // live stream dropped: reconnect with backoff, forever
      session.error = `stream dropped (ffmpeg ${code}) — reconnecting`;
      this.emit('status', this.describe(session.streamId));
      const delay = Math.min(30_000, session.reconnectDelay);
      session.reconnectDelay = Math.min(30_000, session.reconnectDelay * 1.7);
      session.reconnectTimer = setTimeout(() => {
        if (!session.closed) this.#runFfmpegSource(session);
      }, delay);
    });
    this.emit('status', this.describe(session.streamId));
  }

  #scheduleRetention() {
    if (this.retentionTimer) return;
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = null;
      this.pruneAudio();
    }, 6 * 3600_000);
    this.retentionTimer.unref?.();
  }

  /** Delete audio files older than the configured retention window. */
  pruneAudio() {
    const cutoff = Date.now() - this.config.capture.audioRetentionHours * 3600_000;
    let removed = 0;
    for (const f of fs.readdirSync(this.audioDir)) {
      const full = path.join(this.audioDir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* raced with another cleanup */
      }
    }
    return removed;
  }

  shutdown() {
    for (const id of [...this.sessions.keys()]) this.stop(id, { reason: 'shutdown' });
  }
}

export default Capture;
