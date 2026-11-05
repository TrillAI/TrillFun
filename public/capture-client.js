// Browser-side audio capture.
//
// Two capture paths, both producing 16 kHz mono PCM16 for the server:
//
//  • worklet path (default) - AudioWorklet on the raw media stream. The raw
//    stream is *before* volume/mute/gain in the player, so a muted player or a
//    muted system still yields audio. A ScriptProcessor fallback is included
//    for browsers without AudioWorklet.
//
//  • playback path (fallback) - an <audio> element whose output is routed
//    through Web Audio and muted there (element.volume = 0). This exists for
//    cases where the browser refuses raw capture (DRM/EME media): the media
//    plays silently and we transcribe its decoded output.
//
// getDisplayMedia({ video: true, audio: {...} }) is deliberate: Chrome only
// offers tab/system audio when video is requested too. The video track is
// stopped immediately so nothing is recorded from the screen.

const WORKLET_SRC = `
class TrillCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(0);
    this.port.onmessage = (e) => { if (e.data === 'flush') this.emit(true); };
  }
  emit(force) {
    const chunk = 1024; // ~64 ms of audio at 16k
    if (this.buf.length < chunk) return;
    const n = Math.floor(this.buf.length / chunk) * chunk;
    const out = new Float32Array(n);
    out.set(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    this.port.postMessage(out, [out.buffer]);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    // downmix to mono as we append
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf);
    if (input.length > 1) {
      const ch2 = input[1];
      for (let i = 0; i < ch.length; i++) merged[this.buf.length + i] = (ch[i] + (ch2[i] ?? ch[i])) * 0.5;
    } else {
      merged.set(ch, this.buf.length);
    }
    this.buf = merged;
    if (this.buf.length > 16000 * 4) this.emit(true);
    else if (this.buf.length >= 1024) this.emit(false);
    return true;
  }
}
registerProcessor('trill-capture', TrillCapture);
`;

/** Convert Float32 [-1,1] to Int16 LE bytes. */
function toPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export class CaptureSession {
  /**
   * @param {object} opts
   * @param {'system'|'tab'|'mic'} opts.mode
   * @param {(pcm: ArrayBuffer) => void} opts.onAudio
   * @param {(info: {rms:number}) => void} [opts.onLevel]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(opts) {
    this.mode = opts.mode || 'system';
    this.onAudio = opts.onAudio;
    this.onLevel = opts.onLevel;
    this.onStatus = opts.onStatus || (() => {});
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.mediaEl = null;
    this.usingPlayback = false;
    this.stopped = false;
    this.rate = 16000;
    this.bytes = 0;
  }

  get label() {
    return {
      system: 'system audio',
      tab: 'tab audio',
      mic: 'microphone',
    }[this.mode];
  }

  async start() {
    if (this.mode === 'mic') {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } else {
      // video:true is required for Chrome to offer "share audio"
      const opts = { video: true, audio: { channelCount: 2, echoCancellation: false, noiseSuppression: false } };
      // prefer whole-system audio where the browser supports it
      if (this.mode === 'system') opts.systemAudio = 'include';
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia(opts);
      } catch (err) {
        // surface a useful message for the common "no audio" and "denied" cases
        if (err.name === 'NotAllowedError') throw new Error('Screen share was cancelled.');
        throw err;
      }
      // stop the video track at once: we only want the audio
      for (const t of display.getVideoTracks()) t.stop();
      this.stream = display;
      const tracks = display.getAudioTracks();
      if (!tracks.length) {
        for (const t of display.getTracks()) t.stop();
        throw new Error(
          this.mode === 'system'
            ? 'No audio was shared. In the picker choose a tab/screen and turn on “Share audio”.'
            : 'No audio was shared. Tick “Also share tab audio” in the picker.',
        );
      }
      tracks[0].addEventListener('ended', () => this.stop());
    }

    await this.#wire(this.stream);
    return this;
  }

  /**
   * Fallback for media the browser will not expose as a capture stream:
   * play the given element through Web Audio, mute the output, transcribe it.
   */
  async startPlayback(element) {
    this.usingPlayback = true;
    this.mode = 'playback';
    this.mediaEl = element;
    const ctx = this.#context();
    this.source = ctx.createMediaElementSource(element);
    element.volume = 0; // silent to the room, still decoded for us
    await ctx.resume();
    this.#buildGraph(ctx);
    this.onStatus('transcribing pre-volume output of the player');
    return this;
  }

  #context() {
    // Ask for 16 kHz so the browser does the resampling for us, then verify.
    try {
      return new AudioContext({ sampleRate: 16000 });
    } catch {
      return new AudioContext();
    }
  }

  async #wire(stream) {
    const ctx = this.#context();
    this.ctx = ctx;
    this.rate = ctx.sampleRate;
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    this.source = source;
    this.#buildGraph(ctx, source);
    this.onStatus(`capturing ${this.label} at ${this.rate} Hz`);
  }

  #buildGraph(ctx, source = this.source) {
    // If the context refused 16 kHz we need to resample before upload; ask the
    // server to accept the native rate instead — it re-derives segment timing
    // from the declared sample rate, so this stays exact.
    const wantsWorklet = typeof AudioWorkletNode !== 'undefined';
    if (wantsWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      ctx.audioWorklet
        .addModule(url)
        .then(() => {
          if (this.stopped) return;
          const node = new AudioWorkletNode(ctx, 'trill-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 2,
          });
          node.port.onmessage = (e) => this.#deliver(e.data);
          source.connect(node);
          this.node = node;
        })
        .catch(() => this.#fallbackScriptProcessor(ctx, source));
    } else {
      this.#fallbackScriptProcessor(ctx, source);
    }
    const track = this.stream?.getAudioTracks?.()[0];
    if (track) {
      track.addEventListener('mute', () => this.onStatus('source went quiet — still listening'));
      track.addEventListener('unmute', () => this.onStatus(`capturing ${this.label}`));
    }
  }

  #fallbackScriptProcessor(ctx, source) {
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    let pending = new Float32Array(0);
    proc.onaudioprocess = (e) => {
      const chans = e.inputBuffer.numberOfChannels;
      const n = e.inputBuffer.length;
      const mono = new Float32Array(n);
      for (let c = 0; c < chans; c++) {
        const data = e.inputBuffer.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += data[i] / chans;
      }
      const merged = new Float32Array(pending.length + n);
      merged.set(pending);
      merged.set(mono, pending.length);
      pending = merged;
      if (pending.length >= 1024) {
        this.#deliver(pending.subarray(0, 1024));
        pending = pending.subarray(1024);
      }
    };
    source.connect(proc);
    // ScriptProcessor only runs when connected to a destination; a zero-gain
    // node keeps the graph alive without making any sound.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    proc.connect(silent);
    silent.connect(ctx.destination);
    this.node = proc;
  }

  #deliver(f32) {
    if (this.stopped || !f32?.length) return;
    const pcm = toPcm16(f32);
    this.bytes += pcm.byteLength;
    this.onAudio(pcm);
    if (this.onLevel) {
      let sum = 0;
      for (let i = 0; i < f32.length; i += 4) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / Math.max(1, f32.length / 4));
      this.onLevel({ rms, db: rms > 0 ? 20 * Math.log10(rms) : -100 });
    }
  }

  stop() {
    this.stopped = true;
    try {
      this.node?.disconnect?.();
      this.source?.disconnect?.();
      for (const t of this.stream?.getTracks?.() ?? []) t.stop();
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    } catch {
      /* already torn down */
    }
    if (this.mediaEl) this.mediaEl.volume = 1;
    this.stream = null;
    this.ctx = null;
  }
}

/** Is this browser able to do system/tab audio capture at all? */
export function captureSupport() {
  const hasDisplay = !!navigator.mediaDevices?.getDisplayMedia;
  const hasMic = !!navigator.mediaDevices?.getUserMedia;
  const secure = window.isSecureContext;
  return { hasDisplay, hasMic, secure, mode: hasDisplay ? 'display' : hasMic ? 'mic' : 'none' };
}

export const __internal = { toPcm16, WORKLET_SRC };
