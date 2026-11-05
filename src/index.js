// TrillFun server
//
//   API      : streams, transcripts, search, export, capture control
//   WS       : live transcript feed + PCM upload from the browser
//   always-on: resumes the last selected stream on boot (tuner sources run in
//              this process, so closing every tab does not stop transcription)
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { config, ROOT } from './config.js';
import { Store } from './store.js';
import { Asr } from './asr.js';
import { Capture } from './capture.js';
import { TEN_CODES, postProcess, normalizeTenCodes, codesIn } from './tenCodes.js';
import { runFfmpeg, probeMedia } from './ffmpeg.js';

const dataDir = config.dataDir;
const audioDir = path.join(dataDir, 'audio');
const uploadDir = path.join(dataDir, 'uploads');
const exportDir = path.join(dataDir, 'exports');
for (const d of [dataDir, audioDir, uploadDir, exportDir]) fs.mkdirSync(d, { recursive: true });

const store = new Store(path.join(dataDir, 'trillfun.db'), { retentionDays: config.retentionDays });
const asr = new Asr();
const capture = new Capture({ store, asr, audioDir, config });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// websocket hub: live transcript broadcast + browser PCM ingest
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, at: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.subscribed = new Set();
  ws.captureStream = null;
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', payload: { serverTime: Date.now(), asr: asr.status } }));

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // raw PCM16LE mono from a browser capture session
      if (ws.captureStream) capture.pushAudio(ws.captureStream, Buffer.from(raw), ws.captureRate || 16000);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'subscribe':
        if (msg.streamId) ws.subscribed.add(msg.streamId);
        if (msg.all) ws.subscribed.add('*');
        break;
      case 'capture:open': {
        ws.captureStream = msg.streamId;
        ws.captureRate = msg.sampleRate || 16000;
        capture.openPushed(msg.streamId, {
          type: msg.source || 'system',
          preset: msg.preset,
          sampleRate: ws.captureRate,
        });
        store.updateStream(msg.streamId, { status: 'live', source: msg.source || 'system' });
        broadcast('stream:status', capture.describe(msg.streamId));
        break;
      }
      case 'capture:heartbeat':
        if (ws.captureStream) capture.resume(ws.captureStream);
        break;
      case 'capture:pause':
        if (ws.captureStream) capture.pause(ws.captureStream, msg.reason || 'client paused');
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (ws.captureStream) {
      // The page is gone. If the source was a server-side stream (tuner/file)
      // capture keeps running. If it was browser audio, the stream is marked
      // paused and will restart as soon as any page reconnects.
      const info = capture.describe(ws.captureStream);
      if (info && info.type !== 'tuner' && info.type !== 'file') {
        capture.pause(ws.captureStream, 'browser disconnected');
        store.updateStream(ws.captureStream, { status: 'waiting', detail: 'waiting for browser audio' });
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// events -> sockets + stream bookkeeping
// ---------------------------------------------------------------------------
capture.on('segment', (seg) => {
  broadcast('segment', seg);
});

capture.on('level', (l) => {
  // throttle: levels are only useful as a meter at ~8 fps
  const now = Date.now();
  if (!capture._lastLevel || now - capture._lastLevel > 120) {
    capture._lastLevel = now;
    broadcast('level', l);
  }
});

capture.on('status', (info) => {
  if (!info?.streamId) return;
  broadcast('stream:status', info);
});

capture.on('error', (e) => broadcast('capture:error', e));

capture.on('source-ended', async ({ streamId, detail }) => {
  store.updateStream(streamId, { status: 'finished', detail: detail || null });
  broadcast('stream:status', { streamId, state: 'finished' });
});

asr.on('warm', (s) => broadcast('asr', s));
asr.on('error', (e) => broadcast('asr:error', { message: e }));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
const api = express.Router();
app.use('/api', api);

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    asr: asr.status,
    capture: capture.describeAll(),
    stats: store.stats(),
    version: 1,
  });
});

api.get('/config', (req, res) => {
  res.json({
    presets: ['auto', 'radio', 'phone', 'noisy', 'clean'],
    tenCodes: TEN_CODES,
    limits: {
      maxSegmentSeconds: config.capture.maxSegmentSeconds,
      retentionDays: config.retentionDays,
      audioRetentionHours: config.capture.audioRetentionHours,
      uploadMB: 4096,
    },
  });
});

// ---- streams --------------------------------------------------------------
api.get('/streams', (req, res) => {
  const streams = store.listStreams().map((s) => ({
    ...s,
    live: capture.describe(s.id),
  }));
  res.json({ streams, active: capture.describeAll() });
});

api.post('/streams', (req, res) => {
  const { title, kind = 'stream', preset = 'auto', url = null, alwaysOn = true } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (url && !/^(https?|rtsp|rtmp|udp|tcp|mms|ftp):\/\//i.test(url)) {
    return res.status(400).json({ error: 'url must be an http(s)/rtsp/rtmp/udp audio stream' });
  }
  const stream = store.createStream({ title, kind, preset, source: url, alwaysOn });
  if (url) {
    store.updateStream(stream.id, { status: 'live', source: url });
    capture.startTuner(stream.id, url, preset);
  }
  res.status(201).json({ stream: store.getStream(stream.id) });
});

api.get('/streams/:id', (req, res) => {
  const stream = store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'not found' });
  res.json({
    stream,
    live: capture.describe(stream.id),
    segments: store.listSegments(stream.id, { limit: 100 }),
    speakers: store.speakers(stream.id),
  });
});

api.patch('/streams/:id', (req, res) => {
  const { title, preset, alwaysOn, pinned } = req.body || {};
  const stream = store.updateStream(req.params.id, { title, preset, alwaysOn, pinned });
  if (!stream) return res.status(404).json({ error: 'not found' });
  res.json({ stream });
});

api.delete('/streams/:id', (req, res) => {
  capture.stop(req.params.id, { reason: 'deleted' });
  store.deleteStream(req.params.id);
  res.json({ ok: true });
});

// ---- capture control ------------------------------------------------------
api.post('/streams/:id/capture/start', async (req, res) => {
  const { url, preset } = req.body || {};
  const stream = store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'not found' });
  const target = url || stream.source;
  if (!target) return res.status(400).json({ error: 'this stream has no source URL; push audio from the browser' });
  store.updateStream(stream.id, { status: 'live', preset: preset || stream.preset, source: target });
  capture.startTuner(stream.id, target, preset || stream.preset);
  res.json({ ok: true, live: capture.describe(stream.id) });
});

api.post('/streams/:id/capture/stop', (req, res) => {
  capture.stop(req.params.id, { reason: 'user' });
  store.updateStream(req.params.id, { status: 'paused' });
  res.json({ ok: true });
});

// always-on: which stream should come back after a restart / when a page opens?
api.get('/capture/pending', (req, res) => {
  const live = capture.describeAll();
  const paused = store
    .listStreams()
    .filter((s) => s.alwaysOn && ['waiting', 'paused', 'live'].includes(s.status))
    .map((s) => ({ ...s, live: live.find((l) => l.streamId === s.id) || null }));
  res.json({ pending: paused, active: live });
});

// ---- transcripts ----------------------------------------------------------
api.get('/streams/:id/segments', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  res.json({ segments: store.listSegments(req.params.id, { limit, offset }), limit, offset });
});

api.get('/segments/recent', (req, res) => {
  res.json({ segments: store.recentSegments(Math.min(Number(req.query.limit) || 50, 500)) });
});

api.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ segments: [], query: q });
  res.json({ segments: store.search(q, Math.min(Number(req.query.limit) || 200, 1000)), query: q });
});

api.post('/segments/:id/reprocess', (req, res) => {
  const seg = store.getSegment(req.params.id);
  if (!seg) return res.status(404).json({ error: 'not found' });
  const text = postProcess(normalizeTenCodes(seg.text));
  res.json({ text, codes: codesIn(text) });
});

// ---- export ---------------------------------------------------------------
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour12: false });
}
function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildTranscript(streamId) {
  const stream = store.getStream(streamId);
  if (!stream) return null;
  const segments = store.allSegments(streamId);
  return { stream, segments };
}

api.get('/streams/:id/export', (req, res) => {
  const format = String(req.query.format || 'txt').toLowerCase();
  const data = buildTranscript(req.params.id);
  if (!data) return res.status(404).json({ error: 'not found' });
  const { stream, segments } = data;
  const safe = stream.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'transcript';

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
    return res.end(JSON.stringify({ stream, segments, exportedAt: new Date().toISOString() }, null, 2));
  }
  if (format === 'srt' || format === 'vtt') {
    const stamp = (ms, sep) => {
      const d = new Date(ms);
      const p = (n, l = 2) => String(n).padStart(l, '0');
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${sep}${p(d.getUTCMilliseconds(), 3)}`;
    };
    const lines = [];
    if (format === 'vtt') lines.push('WEBVTT', '');
    segments.forEach((s, i) => {
      lines.push(String(i + 1));
      lines.push(`${stamp(s.ts, ',')} --> ${stamp(s.endedAt || s.ts, ',')}`.replace(/,/g, format === 'vtt' ? '.' : ','));
      lines.push(speakerPrefix(s) + s.text, '');
    });
    res.setHeader('Content-Type', format === 'vtt' ? 'text/vtt' : 'application/x-subrip');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.${format}"`);
    return res.end(lines.join('\n'));
  }
  if (format === 'csv') {
    const rows = [['time', 'date', 'speaker', 'text', 'codes', 'confidence', 'preset']];
    for (const s of segments) {
      rows.push([fmtClock(s.ts), fmtDate(s.ts), s.speaker || '', s.text, s.codes.join(' '), s.confidence ?? '', s.preset || '']);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
    return res.end(csv);
  }
  const lines = [
    `TrillFun transcript — ${stream.title}`,
    `Stream id: ${stream.id}   Kind: ${stream.kind}   Preset: ${stream.preset}`,
    `Segments: ${segments.length}   Words: ${stream.words}`,
    `Exported: ${new Date().toISOString()}`,
    ''.padEnd(78, '-'),
    '',
  ];
  let lastDay = null;
  for (const s of segments) {
    const day = fmtDate(s.ts);
    if (day !== lastDay) {
      lines.push(`== ${day} ==`);
      lastDay = day;
    }
    lines.push(`[${fmtClock(s.ts)}] ${speakerPrefix(s)}${s.text}`);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`);
  res.end(lines.join('\n'));
});

function speakerPrefix(s) {
  return s.speaker ? `${s.speaker}: ` : '';
}

// ---- file upload + transcription -----------------------------------------
api.post('/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio file' });
  const preset = req.body.preset || 'auto';
  const title = req.body.title || req.file.originalname || 'Uploaded recording';
  const stream = store.createStream({
    title,
    kind: 'recording',
    preset,
    source: req.file.originalname,
    alwaysOn: false,
  });
  const wav = path.join(audioDir, `${stream.id}-upload.wav`);
  try {
    await runFfmpeg(['-i', req.file.path, '-ac', '1', '-ar', '16000', '-f', 'wav', wav]);
  } catch (err) {
    store.updateStream(stream.id, { status: 'error', error: err.message });
    return res.status(422).json({ error: `could not decode audio: ${err.message}` });
  }
  const probe = await probeMedia(wav).catch(() => ({ duration: null }));
  store.updateStream(stream.id, { status: 'live', detail: `${Math.round(probe.duration || 0)}s recording` });
  capture.startFile(stream.id, wav, preset);
  res.status(201).json({ stream: store.getStream(stream.id), duration: probe.duration });
});

// ---- demo / self test -----------------------------------------------------
api.post('/demo', (req, res) => {
  const stream = store.createStream({
    title: 'Demo traffic',
    kind: 'demo',
    preset: 'radio',
    alwaysOn: false,
  });
  const script = [
    ['Dispatch', 'Dispatch to unit seven, respond to a ten fifty four, vehicle accident, mile marker twelve.'],
    ['Unit 7', 'Unit seven copies, en route to mile marker twelve, ten four.'],
    ['Dispatch', 'Be advised, caller reports a ten fifty two, possible drunk driver eastbound on interstate forty.'],
    ['Unit 3', 'Three to dispatch, I have a ten twenty eight at the corner of Fifth and Main, requesting backup.'],
    ['Dispatch', 'Copy three, backup is en route, ETA four minutes.'],
    ['Unit 9', 'Nine to dispatch, suspect vehicle is ten ninety nine, blue pickup, northbound on route nine.'],
  ];
  let i = 0;
  const tick = () => {
    if (i >= script.length) {
      store.updateStream(stream.id, { status: 'finished' });
      broadcast('stream:status', { streamId: stream.id, state: 'finished' });
      return;
    }
    const [speaker, text] = script[i++];
    const out = postProcess(text);
    const seg = store.addSegment({
      streamId: stream.id,
      text: out,
      speaker,
      preset: 'radio',
      codes: codesIn(out),
      confidence: 0.9,
    });
    broadcast('segment', { ...seg, streamTitle: stream.title });
    setTimeout(tick, 2600);
  };
  store.updateStream(stream.id, { status: 'live' });
  broadcast('stream:status', { streamId: stream.id, state: 'live' });
  setTimeout(tick, 400);
  res.json({ stream: store.getStream(stream.id) });
});

api.delete('/streams/:id/segments', (req, res) => {
  const stream = store.getStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'not found' });
  store.db.prepare('DELETE FROM segments WHERE stream_id=?').run(req.params.id);
  store.db.prepare('DELETE FROM segments_fts WHERE stream_id=?').run(req.params.id);
  store.db.prepare('UPDATE streams SET words=0,segments=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- audio playback -------------------------------------------------------
api.get('/segments/:id/audio', (req, res) => {
  const seg = store.getSegment(req.params.id);
  if (!seg?.audio || !fs.existsSync(seg.audio)) return res.status(404).json({ error: 'no audio' });
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(seg.audio).pipe(res);
});

// ---------------------------------------------------------------------------
// always-on boot: bring back the last stream that should be transcribing
// ---------------------------------------------------------------------------
function resumeAlwaysOn() {
  const streams = store.listStreams().filter((s) => s.alwaysOn);
  const lastId = store.meta('lastStreamId');
  const ordered = [...streams].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : 0));
  for (const s of ordered) {
    if (s.source && /^(https?|rtsp|rtmp|udp|tcp|mms):\/\//i.test(s.source) && s.kind !== 'recording' && s.kind !== 'demo') {
      store.updateStream(s.id, { status: 'live' });
      capture.startTuner(s.id, s.source, s.preset);
      console.log(`[always-on] resuming "${s.title}" from ${s.source}`);
      break; // one tuner at boot; others can be started from the UI
    }
  }
  for (const s of streams) {
    if (s.status === 'live' && !capture.isActive(s.id)) {
      // browser-driven streams come back when a page opens
      store.updateStream(s.id, { status: 'waiting', detail: 'resumes when a browser reconnects' });
    }
  }
}

// ---------------------------------------------------------------------------
server.listen(config.port, config.host, () => {
  console.log(`\n  TrillFun listening on http://${config.host}:${config.port}`);
  console.log(`  data: ${dataDir}`);
  asr.start();
  asr.warm();
  resumeAlwaysOn();
  capture.pruneAudio();
});

function shutdown() {
  clearInterval(heartbeat);
  capture.shutdown();
  asr.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server, store, asr, capture };
