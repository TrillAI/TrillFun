// Locating and running ffmpeg.
//
// TrillFun needs ffmpeg for: decoding any input stream/file into the 16 kHz mono
// PCM that the speech recognizer wants, and for the radio/telephone audio
// conditioning chain. We prefer a system ffmpeg, then the statically linked
// binary shipped by @ffmpeg-installer/ffmpeg, then `ffmpeg` on PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './config.js';

const require = createRequire(import.meta.url);

let cached = null;

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    return null;
  }
}

export function findFfmpeg() {
  if (cached) return cached;

  if (process.env.TRILL_FFMPEG) {
    const p = exists(process.env.TRILL_FFMPEG);
    if (p) return (cached = p);
  }

  // Prefer a system ffmpeg (newer, more filters) over the bundled one, but
  // verify that it can actually run.
  const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const c of candidates) {
    const p = exists(c);
    if (p) return (cached = p);
  }

  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    const p = exists(installer.path);
    if (p) return (cached = p);
  } catch {
    /* optional dependency missing */
  }

  // fall back to PATH resolution
  return (cached = 'ffmpeg');
}

/** Spawn ffmpeg with sane, quiet defaults and return the child process. */
export function spawnFfmpeg(args, opts = {}) {
  const bin = findFfmpeg();
  return spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

/** Run ffmpeg to completion, resolving with stderr output. */
export function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawnFfmpeg(args, opts);
    let err = '';
    p.stderr?.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

/** Probe a media file/URL for duration and audio presence. */
export async function probeMedia(input) {
  const out = await runFfmpeg([
    '-i',
    input,
    '-f',
    'null',
    '-',
  ]).catch((e) => e.message);
  const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out || '');
  const hasAudio = /Stream #\d+:\d+.*Audio:/.test(out || '');
  return {
    duration: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : null,
    hasAudio,
  };
}

/**
 * Build the ffmpeg filter chain used to condition a stream for speech
 * recognition. Presets are intentionally simple to reason about:
 *
 *  - "radio":   land-mobile / dispatch audio. Narrow band (300–3000 Hz),
 *               heavy compression, noise floor removal, AGC. This is what
 *               makes squelch tails, hiss, engine noise and clipped PTT audio
 *               far more intelligible to the recognizer.
 *  - "phone":   telephone / VoIP audio (300–3400 Hz), louder hiss and codec
 *               artifacts, hands-free echo.
 *  - "noisy":   generic loud environments, TV, crowd noise.
 *  - "clean":   music-free podcasts, meetings, line-in audio.
 *  - "auto":    voice-grade, a good default for "any stream".
 */
export function filterChain(preset = 'auto', gainDb = 0) {
  const presets = {
    radio: [
      'highpass=f=280',
      'lowpass=f=3200',
      'afftdn=nr=14:nf=-40:tn=1',
      'acompressor=threshold=-26dB:ratio=5:attack=4:release=140:makeup=6',
      'alimiter=limit=0.95:level=disabled',
      'volume=2dB',
    ],
    phone: [
      'highpass=f=250',
      'lowpass=f=3600',
      'afftdn=nr=12:nf=-42:tn=1',
      'acompressor=threshold=-24dB:ratio=4:attack=5:release=180:makeup=5',
      'alimiter=limit=0.95:level=disabled',
    ],
    noisy: [
      'highpass=f=90',
      'afftdn=nr=10:nf=-38:tn=1',
      'acompressor=threshold=-22dB:ratio=3:attack=5:release=200:makeup=4',
      'alimiter=limit=0.97:level=disabled',
    ],
    clean: ['highpass=f=70', 'alimiter=limit=0.97:level=disabled'],
    auto: [
      'highpass=f=120',
      'lowpass=f=4200',
      'afftdn=nr=8:nf=-40:tn=1',
      'acompressor=threshold=-22dB:ratio=3:attack=5:release=180:makeup=4',
      'alimiter=limit=0.97:level=disabled',
    ],
  };
  const chain = presets[preset] || presets.auto;
  const extra = Number(gainDb) ? [`volume=${Number(gainDb)}dB`] : [];
  return [...chain, ...extra].join(',');
}

/**
 * Full ffmpeg arg list for decoding `input` to raw 16-bit mono PCM on stdout.
 * `extra` entries placed before -i are input options (reconnect flags etc),
 * the ones after are output options.
 */
export function buildPcmArgs(
  input,
  { sampleRate = 16000, filter = null, seek = 0, inputOptions = [], outputOptions = [] } = {},
) {
  const args = [];
  if (seek > 0) args.push('-ss', String(seek));
  args.push(...inputOptions);
  args.push('-i', input);
  if (filter) args.push('-af', filter);
  args.push('-vn', '-ac', '1', '-ar', String(sampleRate), ...outputOptions, '-f', 's16le', 'pipe:1');
  return args;
}

export const __paths = { ROOT, path };
