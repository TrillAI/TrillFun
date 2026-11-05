// Shared configuration for TrillFun.
// Everything can be overridden with environment variables.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = {
  // ---- server -------------------------------------------------------------
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.TRILL_DATA_DIR || path.join(ROOT, 'data'),
  modelDir: process.env.TRILL_MODEL_DIR || path.join(ROOT, '.models'),
  venvDir: process.env.TRILL_VENV_DIR || path.join(ROOT, '.venv'),
  python: process.env.TRILL_PYTHON || null, // auto-detected when null

  // ---- speech recognition --------------------------------------------------
  asr: {
    // tiny.en < base.en < small.en < medium.en in accuracy; small is the
    // best default for noisy radio/phone audio on a normal CPU.
    model: process.env.TRILL_ASR_MODEL || 'small.en',
    computeType: process.env.TRILL_ASR_COMPUTE || 'int8',
    cpuThreads: num(process.env.TRILL_ASR_THREADS, Math.max(2, Math.min(8, os.cpus().length))),
    beamSize: num(process.env.TRILL_ASR_BEAM, 5),
    language: process.env.TRILL_ASR_LANG || 'en',
    // lower = faster, higher = more accurate
    vadThreshold: Number(process.env.TRILL_VAD_THRESHOLD ?? 0.45),
  },

  // ---- capture -------------------------------------------------------------
  capture: {
    sampleRate: 16000,
    channels: 1,
    segmentSeconds: num(process.env.TRILL_SEGMENT_SECONDS, 30),
    // a segment is force-closed after this many seconds even if people keep talking
    maxSegmentSeconds: num(process.env.TRILL_MAX_SEGMENT_SECONDS, 60),
    // slice length while audio keeps coming without a pause (continuous talker,
    // open mic, music bed). Keeps transcript latency honest on 24/7 streams.
    hardSliceSeconds: num(process.env.TRILL_HARD_SLICE_SECONDS, 45),
    // audio kept on disk around each transcript (for re-play / re-transcribe)
    keepAudio: process.env.TRILL_KEEP_AUDIO !== 'false',
    audioRetentionHours: num(process.env.TRILL_AUDIO_RETENTION_HOURS, 72),
  },

  retentionDays: num(process.env.TRILL_RETENTION_DAYS, 30),
  maxSegmentsPerPage: 200,
};

export default config;
