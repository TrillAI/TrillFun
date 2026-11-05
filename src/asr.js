// Bridge between the Node server and the persistent Python recognizer.
//
// The worker is started lazily, kept hot for 24/7 use, restarted on crash, and
// every request is matched to its response by id. Only one transcription runs
// at a time (the CPU does not get faster with more parallel decodes), so
// requests queue, with the most recent live capture taking priority.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { config, ROOT } from './config.js';

const WORKER = path.join(ROOT, 'src', 'asr_worker.py');

/**
 * Context prompts whispered into the recognizer's decoder.
 *
 * Kept short on purpose: Whisper's prompt window is ~224 tokens and a long
 * prompt both biases the transcript and slows decoding. Measured on
 * tests/corpus (12 phrases x radio/phone) with scripts/bench.py:
 *
 *   no prompt at all ..................... 27.7% WER   (radio)
 *   one generic long prompt ..............  6.2% WER   (radio) / 6.2% (phone)
 *   per-preset short prompts (these) .....  5.7% WER   (radio) / 5.3% (phone)
 *
 * Changing these strings changes accuracy — re-run `npm run bench` if you do.
 */
export const RADIO_PROMPT =
  'Radio dispatch traffic. Ten codes like ten four, ten twenty, ten fifty four. ' +
  'Units respond, en route, copy, stand by, dispatch, mile marker, northbound.';

export const PHONE_PROMPT =
  'Telephone conversation. Thank you for calling, how may I help you, appointment, ' +
  'policy number, running late, ten minutes, see you soon, thank you, goodbye.';

export const AUTO_PROMPT =
  'Radio dispatch and telephone conversation. Ten codes like ten four, ten twenty, ten fifty four. ' +
  'Units respond, en route, copy, stand by, dispatch. Thank you for calling, appointment, policy number.';

export function promptFor(preset) {
  if (preset === 'radio') return RADIO_PROMPT;
  if (preset === 'phone') return PHONE_PROMPT;
  return AUTO_PROMPT;
}

/** Kept for backwards compatibility with older callers. */
export const CONTEXT_PROMPT = AUTO_PROMPT;

export const HOTWORDS =
  'ten four, ten twenty, ten twenty three, ten fifty two, ten fifty four, ten eighty, ten ninety nine, ' +
  'dispatch, unit, en route, copy, stand by, backup, mile marker, northbound, southbound, eastbound, ' +
  'interstate, pursuit, ambulance, policy number, appointment';

export function findPython() {
  if (config.python) return config.python;
  const venv = path.join(config.venvDir, 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  const win = path.join(config.venvDir, 'Scripts', 'python.exe');
  if (fs.existsSync(win)) return win;
  return 'python3';
}

export class Asr extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.modelName = opts.model || config.asr.model;
    this.modelPath = opts.modelPath || path.join(config.modelDir, this.modelName);
    this.python = opts.python || findPython();
    this.threads = config.asr.cpuThreads;
    this.compute = config.asr.computeType;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.queue = [];
    this.running = false;
    this.ready = false;
    this.restarts = 0;
    this.lastError = null;
    this.stats = { transcriptions: 0, audioSeconds: 0, elapsed: 0 };
  }

  get available() {
    return fs.existsSync(path.join(this.modelPath, 'config.json'));
  }

  get status() {
    const wav = path.join(this.modelPath, 'model.bin');
    return {
      ready: this.ready,
      model: this.modelName,
      modelPath: this.modelPath,
      modelMB: fs.existsSync(wav) ? Math.round(fs.statSync(wav).size / 1048576) : 0,
      compute: this.compute,
      threads: this.threads,
      restarts: this.restarts,
      error: this.lastError,
      queue: this.queue.length,
      ...this.stats,
      rtf: this.stats.audioSeconds ? +(this.stats.elapsed / this.stats.audioSeconds).toFixed(2) : null,
    };
  }

  start() {
    if (this.proc) return this;
    if (!this.available) {
      this.lastError = `speech model not installed at ${this.modelPath} — run: npm run setup`;
      this.emit('unavailable', this.lastError);
      return this;
    }
    const args = [WORKER];
    this.proc = spawn(this.python, args, {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: String(this.threads) },
    });

    this.proc.on('error', (err) => {
      this.lastError = `cannot start ${this.python}: ${err.message}`;
      this.emit('error', this.lastError);
    });

    this.proc.on('exit', (code, sig) => {
      this.proc = null;
      this.ready = false;
      this.running = false;
      for (const [, req] of this.pending) req.reject(new Error('recognizer stopped'));
      this.pending.clear();
      if (code !== 0 && this.shuttingDown !== true) {
        this.restarts += 1;
        setTimeout(() => {
          this.start();
          this.warm();
        }, Math.min(30_000, 1000 * this.restarts)); // back off, but keep trying
      }
      this.emit('exit', { code, sig });
    });

    this.proc.stderr.on('data', (d) => {
      const text = d.toString();
      this.emit('log', text);
      if (process.env.TRILL_DEBUG) process.stderr.write(`[asr] ${text}`);
      if (/model loaded/.test(text)) this.emit('warm', this.status);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.#handleLine(line));
    return this;
  }

  #handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      this.ready = true;
      this.emit('ready', this.status);
      return;
    }
    if (msg.type === 'progress') {
      this.pending.get(msg.id)?.onProgress?.(msg);
      return;
    }
    const req = msg.id ? this.pending.get(msg.id) : null;
    if (!req) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') req.reject(new Error(msg.message || 'recognizer error'));
    else req.resolve(msg);
  }

  /** Ask the worker to load the model now, so the first real segment is fast. */
  warm() {
    if (!this.proc) this.start();
    if (!this.proc || this.warming) return;
    this.warming = true;
    this.request({ op: 'ping' }).finally(() => {
      this.warming = false;
      this.emit('warm', this.status);
    });
  }

  /**
   * Queue a transcription. `priority` 0 = live capture (jumps the queue),
   * 1 = history/retry jobs.
   */
  transcribe(job, { priority = 1 } = {}) {
    return new Promise((resolve, reject) => {
      const item = { job, priority, resolve, reject };
      if (priority === 0) this.queue.unshift(item);
      else this.queue.push(item);
      this.#drain();
    });
  }

  async #drain() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      try {
        const res = await this.request({
          op: 'transcribe',
          path: item.job.path,
          preset: item.job.preset,
          prompt: item.job.prompt || promptFor(item.job.preset),
          hotwords: item.job.hotwords ?? HOTWORDS,
          language: item.job.language ?? config.asr.language,
          beam_size: item.job.beamSize ?? config.asr.beamSize,
          threads: this.threads,
          compute: this.compute,
          model: this.modelPath,
          vad: false,
          word_timestamps: false,
        });
        this.stats.transcriptions += 1;
        this.stats.audioSeconds += res.duration || 0;
        this.stats.elapsed += res.elapsed || 0;
        item.resolve(res);
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }

  request(payload, { timeoutMs = 15 * 60_000 } = {}) {
    if (!this.proc) this.start();
    if (!this.proc) return Promise.reject(new Error(this.lastError || 'recognizer unavailable'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`recognizer timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        onProgress: payload.onProgress,
      });
      this.proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stop() {
    this.shuttingDown = true;
    if (this.proc) {
      try {
        this.proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
      } catch {
        /* ignore */
      }
      this.proc.kill('SIGTERM');
      setTimeout(() => this.proc?.kill('SIGKILL'), 3000);
    }
  }
}

export default Asr;
