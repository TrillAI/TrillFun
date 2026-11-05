// Audio helpers: WAV writing, an adaptive energy VAD tuned for radio/phone
// audio, and a cheap pitch estimate used for speaker separation.
//
// Everything here operates on 16-bit little-endian mono PCM at 16 kHz, which is
// what both the browser capture path and the ffmpeg pull path produce.

export const SAMPLE_RATE = 16000;

/** Build a 44-byte PCM WAV header for `length` bytes of 16-bit mono audio. */
export function wavHeader(length, sampleRate = SAMPLE_RATE) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + length, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(length, 40);
  return b;
}

export function wavFile(pcm, sampleRate = SAMPLE_RATE) {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

/** RMS level (0..1) of a PCM16 buffer. */
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Peak level (0..1). */
export function peak(pcm) {
  let p = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
    if (v > p) p = v;
  }
  return p;
}

/** Decibels for a 0..1 amplitude. */
export const toDb = (amp) => (amp <= 0 ? -100 : 20 * Math.log10(amp));

/**
 * Adaptive voice activity detector.
 *
 * Radio traffic is mostly silence/squelch with short clipped transmissions, and
 * the noise floor moves (engine noise, wind, open mic). A fixed threshold fails,
 * so the floor is tracked with a slow-moving minimum and speech is anything
 * clearly above it. Frames are 20 ms.
 */
export class EnergyVad {
  constructor({
    thresholdDb = 10, // dB above the rolling noise floor to count as speech
    weakDb = 5, // softer threshold, accepted only if it holds for a moment
    floorDb = -52, // never treat anything quieter than this as speech
    peakDb = -6, // frames this far above the floor are always speech
    fastFrames = 75, // 1.5 s window: tracks squelch tails / AGC pumping
    slowFrames = 500, // 10 s window: stable floor between transmissions
  } = {}) {
    this.thresholdDb = thresholdDb;
    this.weakDb = weakDb;
    this.floorDb = floorDb;
    this.peakDb = peakDb;
    this.fastFrames = fastFrames;
    this.slowFrames = slowFrames;
    this.fast = [];
    this.slow = [];
    this.noiseFloorDb = -60;
    this.weakRun = 0;
    this.silenceGrace = 12;
  }

  #min(window, frames) {
    window.push(frames.level);
    if (window.length > this.maxWindow(window)) window.shift();
    let m = Infinity;
    for (const v of window) if (v < m) m = v;
    return m;
  }

  maxWindow(win) {
    return win === this.fast ? this.fastFrames : this.slowFrames;
  }

  /**
   * Two noise estimates:
   *   fast - short rolling minimum, catches squelch tails and AGC pumping so a
   *          transmission that starts loud still opens a segment
   *   slow - long rolling minimum, the floor between transmissions
   * The floor used for gating is the quieter of the two, clamped so a long
   * continuous talker cannot drive it into the ground.
   */
  /** Feed one frame (20 ms of PCM), get detection state. */
  push(frame) {
    const level = toDb(rms(frame));
    this.fast.push(level);
    if (this.fast.length > this.fastFrames) this.fast.shift();
    this.slow.push(level);
    if (this.slow.length > this.slowFrames) this.slow.shift();
    let fastMin = Infinity;
    for (const v of this.fast) if (v < fastMin) fastMin = v;
    let slowMin = Infinity;
    for (const v of this.slow) if (v < slowMin) slowMin = v;
    const floor = Math.max(-70, Math.min(-25, Math.min(fastMin, slowMin)));
    this.noiseFloorDb = floor;

    const strongThreshold = Math.max(this.floorDb, floor + this.thresholdDb);
    const weakThreshold = Math.max(this.floorDb - 6, floor + this.weakDb);
    const strong = level > strongThreshold || level > floor + Math.abs(this.peakDb);
    if (strong) this.weakRun = 2;
    else if (level > weakThreshold) this.weakRun = Math.min(3, this.weakRun + 1);
    else this.weakRun = 0;

    const voiced = strong || this.weakRun >= 3;
    const threshold = strong ? strongThreshold : weakThreshold;
    let speechStart = false;
    if (voiced) {
      this.speechRun = (this.speechRun || 0) + 1;
      this.silenceRun = 0;
      if (this.speechRun === 2) speechStart = true;
    } else {
      this.silenceRun = (this.silenceRun || 0) + 1;
      this.speechRun = 0;
    }
    return {
      speech: voiced || this.silenceRun < this.silenceGrace,
      voiced,
      level,
      threshold,
      noiseFloor: floor,
      speechStart,
      speechEnd: this.silenceRun === this.silenceGrace,
    };
  }
}

/**
 * Segments a continuous PCM stream into utterances.
 *
 * A segment closes when either
 *   - the caller sees a sustained pause (silenceRun frames), or
 *   - it reaches maxSeconds (continuous talking / open mic).
 * Short blips under minSeconds are discarded as squelch noise.
 */
export class Segmenter {
  constructor({
    sampleRate = SAMPLE_RATE,
    frameMs = 20,
    silenceMs = 850,
    minSpeechMs = 400,
    maxSeconds = 60,
    hardSliceSeconds = 0,
    preRollMs = 300,
    onSegment,
    onLevel,
    vadOptions = {},
  } = {}) {
    this.sampleRate = sampleRate;
    // frameBytes counts *samples* first: 20 ms @16 kHz = 320 samples = 640 bytes
    this.frameBytes = Math.round((sampleRate * frameMs) / 1000) * 2;
    this.frameMs = frameMs;
    this.silenceFramesTarget = Math.max(1, Math.round(silenceMs / frameMs));
    this.maxSeconds = maxSeconds;
    this.hardSliceBytes = hardSliceSeconds ? hardSliceSeconds * sampleRate * 2 : 0;
    this.minSpeechFrames = Math.round(minSpeechMs / frameMs);
    this.maxBytes = maxSeconds * sampleRate * 2;
    this.preRollBytes = Math.round((sampleRate * preRollMs) / 1000) * 2;
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.vad = new EnergyVad(vadOptions);
    this.reset();
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.segment = [];
    this.segmentBytes = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.active = false;
    this.segmentStart = null;
    this.preRoll = [];
    this.totalFrames = 0;
  }

  /** Push a chunk of PCM (any length, may be odd-sized; leftovers are kept). */
  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= this.frameBytes) {
      const frame = this.pending.subarray(0, this.frameBytes);
      this.pending = this.pending.subarray(this.frameBytes);
      this.#frame(frame);
    }
  }

  #frame(frame) {
    const v = this.vad.push(frame);
    this.totalFrames += 1;
    this.onLevel?.({
      level: v.level,
      threshold: v.threshold,
      noiseFloor: v.noiseFloor,
      speech: v.speech,
      active: this.active,
      t: Date.now(),
    });

    if (!this.active) {
      // keep a small pre-roll so the first syllable is never clipped
      this.preRoll.push(frame);
      const maxPre = Math.max(1, Math.ceil(this.preRollBytes / this.frameBytes));
      while (this.preRoll.length > maxPre) this.preRoll.shift();
      // open on the 2nd voiced frame in a row (v.speechRun is the VAD's own
      // consecutive counter; tracked separately here because segments reset)
      if (v.voiced) this.voicedRun = (this.voicedRun || 0) + 1;
      else this.voicedRun = 0;
      if (this.voicedRun >= 2) {
        this.active = true;
        this.segment = this.preRoll.slice(); // includes the 2 voiced frames + pre-roll
        this.preRoll = [];
        this.segmentBytes = this.segment.reduce((n, f) => n + f.length, 0);
        this.speechFrames = 2;
        this.voicedRun = 0;
        this.silenceFrames = 0;
        this.segmentStart = Date.now();
      }
      return;
    }

    this.segment.push(frame);
    this.segmentBytes += frame.length;
    if (v.voiced) {
      this.speechFrames += 1;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames += 1;
    }

    // Close the segment when the speaker pauses, or when it has run long
    // enough that waiting for a pause would stall the transcript. Never slice
    // on a fixed byte count: cutting mid-word is what makes the recogniser
    // loop and repeat itself.
    const longEnoughToSlice = this.segmentBytes >= (this.hardSliceBytes || Infinity);
    const atPause = this.silenceFrames >= this.silenceFramesTarget;
    if (atPause || this.segmentBytes >= this.maxBytes || longEnoughToSlice) {
      this.flush({ force: true });
    }
  }

  /** Close the current segment (also used to flush on stream stop). */
  flush({ force = false } = {}) {
    if (!this.active) return null;
    const pcm = Buffer.concat(this.segment);
    const seconds = pcm.length / (this.sampleRate * 2);
    const speechSeconds = (this.speechFrames * this.frameMs) / 1000;
    const info = {
      pcm,
      seconds,
      speechSeconds,
      start: this.segmentStart ?? Date.now(),
      end: Date.now(),
      silentFrames: this.silenceFrames,
    };
    this.reset();
    if (!force && (speechSeconds < (this.minSpeechFrames * this.frameMs) / 1000 || seconds < 0.25)) {
      return null;
    }
    this.onSegment?.(info);
    return info;
  }
}

/**
 * Very small pitch tracker (autocorrelation on 40 ms windows) used to tell
 * voices apart in phone calls. Returns median F0 in Hz, or null when unvoiced.
 */
export function estimatePitch(pcm, sampleRate = SAMPLE_RATE) {
  const win = Math.round(sampleRate * 0.04);
  const n = Math.floor(pcm.length / 2 / win);
  if (n < 2) return null;
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.floor(sampleRate / 70);
  const f0s = [];
  for (let w = 0; w < n; w++) {
    const off = w * win;
    let energy = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm.readInt16LE((off + i) * 2) / 32768;
      energy += v * v;
    }
    if (energy / win < 1e-4) continue;
    let bestLag = 0;
    let best = 0;
    for (let lag = minLag; lag <= Math.min(maxLag, win - 1); lag++) {
      let acc = 0;
      let norm = 0;
      for (let i = 0; i < win - lag; i += 2) {
        const a = pcm.readInt16LE((off + i) * 2);
        const b = pcm.readInt16LE((off + i + lag) * 2);
        acc += a * b;
        norm += a * a + b * b;
      }
      const score = norm ? acc / norm : 0;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }
    if (best > 0.35 && bestLag) f0s.push(sampleRate / bestLag);
  }
  if (f0s.length < 2) return null;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}
