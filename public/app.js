// TrillFun web app.
// Talks to the server over REST + a single websocket. Audio capture happens
// here (browser-privileged sources) and recognition happens on the server.
import { CaptureSession, captureSupport } from './capture-client.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  streams: [],
  activeId: null,
  segments: new Map(), // streamId -> array
  view: 'live',
  follow: true,
  annotate: true,
  ws: null,
  wsReady: false,
  capture: null, // CaptureSession
  captureStreamId: null,
  heartbeat: null,
  asr: null,
  searchMode: false,
  presets: {},
  tenCodes: {},
  pendingSeek: null,
};

const api = {
  async get(path) {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

// ── formatting ──────────────────────────────────────────────────────────
const pad = (n, l = 2) => String(n).padStart(l, '0');
function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Render transcript text with 10-codes highlighted and meanings as tooltips. */
function renderText(text, { annotate = true, highlight = null } = {}) {
  let html = escapeHtml(text);
  if (highlight) {
    const q = escapeHtml(highlight).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>');
  }
  // split out already-annotated "10-54 (meaning)" and bare codes
  html = html.replace(
    /\b10-(\d{1,3})\b(\s*\(([^)]*)\))?/g,
    (m, n, _withMeaning, meaning) => {
      const code = `10-${Number(n)}`;
      const known = state.tenCodes[Number(n)] || meaning;
      const title = known ? ` title="${escapeHtml(known)}"` : '';
      const label = annotate && meaning ? '' : '';
      const meaningHtml = annotate && known && !meaning ? `<span class="meaning"> — ${escapeHtml(known.toLowerCase())}</span>` : '';
      return `<code10${title}>${code}</code10>${meaningHtml}`;
    },
  );
  return html;
}

function speakerClass(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (/speaker b|unit|car|truck|engine|medic|ladder/.test(n)) return 'alt';
  return '';
}

// ── toast ───────────────────────────────────────────────────────────────
function toast(message, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'ok' ? '' : kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ── rendering ───────────────────────────────────────────────────────────
function activeStream() {
  return state.streams.find((s) => s.id === state.activeId) || null;
}

function renderStreams() {
  const list = $('#streamList');
  list.innerHTML = '';
  if (!state.streams.length) {
    list.innerHTML = '<div class="engine-meta" style="padding:8px 4px">No streams yet. Create one below.</div>';
    return;
  }
  for (const s of state.streams) {
    const live = s.live;
    const dotClass = live?.state === 'live' ? 'live' : s.status === 'error' ? 'error' : s.status === 'live' || s.status === 'waiting' ? 'waiting' : '';
    const btn = document.createElement('button');
    btn.className = `stream-item ${s.id === state.activeId ? 'active' : ''}`;
    btn.setAttribute('role', 'listitem');
    btn.innerHTML = `
      <span class="dot ${dotClass}"></span>
      <span style="min-width:0">
        <span class="name">${escapeHtml(s.title)}</span>
        <span class="sub">${escapeHtml(s.detail || s.source || s.kind)}</span>
      </span>
      <span class="count">${s.segments || 0}</span>`;
    btn.onclick = () => selectStream(s.id);
    list.append(btn);
  }
}

function renderHeader() {
  const s = activeStream();
  const badge = $('#streamBadge');
  if (!s) {
    $('#streamTitle').textContent = 'No stream selected';
    badge.textContent = 'idle';
    badge.className = 'badge';
    $('#streamPreset').textContent = '—';
    $('#streamMeta').textContent = 'choose a stream or start a capture';
    ['#pauseBtn', '#exportBtn', '#settingsBtn'].forEach((id) => ($(id).disabled = true));
    return;
  }
  $('#streamTitle').textContent = s.title;
  const liveState = s.live?.state;
  const status = liveState || s.status;
  badge.textContent = status === 'live' ? 'live' : status;
  badge.className = `badge ${['live', 'waiting', 'paused', 'error'].includes(status) ? status : ''}`;
  $('#streamPreset').textContent = `${s.preset} processing`;
  const parts = [];
  if (s.kind) parts.push(s.kind);
  if (s.source) parts.push(s.source.length > 48 ? s.source.slice(0, 46) + '…' : s.source);
  parts.push(`${s.segments || 0} segments · ${s.words || 0} words`);
  $('#streamMeta').textContent = parts.join(' · ');
  $('#pauseBtn').disabled = false;
  $('#exportBtn').disabled = false;
  $('#settingsBtn').disabled = false;
  $('#alwaysOnBtn').textContent = `always-on: ${s.alwaysOn ? 'on' : 'off'}`;
  $('#alwaysOnBtn').classList.toggle('on', !!s.alwaysOn);
}

function segmentEl(seg, { fresh = false, highlight = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `seg${fresh ? ' new' : ''}`;
  wrap.dataset.id = seg.id;
  const when = clock(seg.ts);
  const conf = seg.confidence != null ? Math.round(seg.confidence * 100) : null;
  wrap.innerHTML = `
    <div class="time">${when}</div>
    <div class="body">
      <div class="text">${seg.speaker ? `<span class="who ${speakerClass(seg.speaker)}">${escapeHtml(seg.speaker)}</span>` : ''}${renderText(seg.text, { annotate: state.annotate, highlight })}</div>
      <div class="meta">
        ${conf != null ? `<span class="conf">${conf}% conf</span>` : ''}
        ${seg.duration ? `<span>${seg.duration.toFixed(1)}s</span>` : ''}
        ${seg.preset ? `<span>${escapeHtml(seg.preset)}</span>` : ''}
        ${seg.audio ? `<button class="mini-play" data-audio="${seg.id}">▶ audio</button>` : ''}
        ${seg.streamTitle ? `<span class="muted">${escapeHtml(seg.streamTitle)}</span>` : ''}
      </div>
    </div>`;
  wrap.querySelector('[data-audio]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playSegment(seg.id);
  });
  return wrap;
}

function renderTranscript() {
  const holder = $('#transcript');
  const segs = state.segments.get(state.activeId) || [];
  holder.innerHTML = '';
  if (!segs.length) {
    holder.innerHTML = `<div class="empty" id="emptyState">
      <div class="empty-art">📻</div>
      <h2>Nothing transcribed yet</h2>
      <p>Start a capture, tune in a stream, or press <strong>Run demo traffic</strong>.</p></div>`;
    return;
  }
  let lastDay = null;
  for (const seg of segs) {
    const day = dayLabel(seg.ts);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      holder.append(sep);
      lastDay = day;
    }
    holder.append(segmentEl(seg));
  }
  if (state.follow) holder.scrollTop = holder.scrollHeight;
}

function appendSegment(seg) {
  if (seg.streamId !== state.activeId || state.searchMode) return;
  const arr = state.segments.get(seg.streamId) || [];
  arr.push(seg);
  state.segments.set(seg.streamId, arr);
  const holder = $('#transcript');
  $('#emptyState')?.remove();
  const nearBottom = holder.scrollHeight - holder.scrollTop - holder.clientHeight < 120;
  holder.append(segmentEl(seg, { fresh: true }));
  if (state.follow && nearBottom) holder.scrollTop = holder.scrollHeight;
  const s = activeStream();
  if (s) {
    s.segments = (s.segments || 0) + 1;
    s.words = (s.words || 0) + (seg.words || 0);
    renderHeader();
    renderStreams();
  }
  updateFoot();
}

function updateFoot() {
  const segs = state.segments.get(state.activeId) || [];
  const words = segs.reduce((n, s) => n + (s.words || s.text.split(/\s+/).length), 0);
  $('#footStats').textContent = `${segs.length} segments · ${words} words`;
}

// ── selection ───────────────────────────────────────────────────────────
async function loadStreams({ keepActive = true } = {}) {
  const { streams } = await api.get('/streams');
  state.streams = streams;
  if (!keepActive || !state.streams.some((s) => s.id === state.activeId)) {
    const first = state.streams.find((s) => s.live?.state === 'live') || state.streams[0];
    state.activeId = first?.id ?? null;
  }
  renderStreams();
  renderHeader();
  if (state.activeId) await loadSegments(state.activeId);
  await refreshCaptureTarget();
}

async function refreshCaptureTarget() {
  // after a reload/closed tab, resume the last stream that should be live
  try {
    const { pending } = await api.get('/capture/pending');
    const target = pending.find((s) => s.alwaysOn && s.kind !== 'recording' && s.kind !== 'demo');
    if (target && !state.capture && !target.live) {
      $('#captureStatus').textContent = `“${target.title}” is armed — reconnect audio to keep transcribing`;
      state.pendingSeek = target.id;
      selectStream(target.id, { silent: true });
    }
  } catch {
    /* server not ready yet */
  }
}

async function selectStream(id, { silent = false } = {}) {
  state.activeId = id;
  state.searchMode = false;
  $('#searchResults').hidden = true;
  renderStreams();
  renderHeader();
  await loadSegments(id);
  if (!silent) closeRail();
}

async function loadSegments(id) {
  const { segments } = await api.get(`/streams/${id}/segments?limit=400`);
  state.segments.set(id, segments.reverse());
  renderTranscript();
  updateFoot();
}

// ── websocket ───────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.wsReady = true;
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 25000);
    // if a capture was running, re-attach audio to it
    if (state.captureStreamId) {
      ws.send(JSON.stringify({
        type: 'capture:open',
        streamId: state.captureStreamId,
        sampleRate: state.capture?.rate || 16000,
        source: state.capture?.mode || 'system',
        preset: activeStream()?.preset,
      }));
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg.type, msg.payload);
  };

  ws.onclose = () => {
    state.wsReady = false;
    setTimeout(connect, 1200);
  };
}

function handleMessage(type, p) {
  switch (type) {
    case 'hello':
      setAsr(p.asr);
      break;
    case 'asr':
      setAsr(p);
      break;
    case 'segment': {
      if (p.streamId && p.streamId !== 'undefined' && !state.segments.has(p.streamId)) {
        state.segments.set(p.streamId, []);
      }
      appendSegment(p);
      break;
    }
    case 'stream:status':
      syncStatus(p);
      break;
    case 'level':
      if (p.streamId === state.activeId) updateLevel(p);
      break;
    case 'capture:error':
      if (p.streamId === state.activeId) toast(p.message, 'err');
      break;
    case 'asr:error':
      toast(p.message, 'err');
      break;
    default:
      break;
  }
}

function syncStatus(live) {
  const s = state.streams.find((x) => x.id === live.streamId);
  if (s) {
    s.live = live.state ? live : null;
    s.status = live.state === 'live' ? 'live' : live.state === 'paused' ? 'waiting' : s.status;
  }
  renderStreams();
  if (live.streamId === state.activeId) {
    renderHeader();
    updateStatusStrip();
  }
}

function setAsr(status) {
  if (!status) return;
  state.asr = status;
  $('#asrModel').textContent = status.ready ? `${status.model} · ${status.modelMB} MB` : 'engine offline';
  $('#asrDot').className = `dot ${status.ready ? 'live' : 'error'}`;
  const rtf = status.rtf ? `${(1 / status.rtf).toFixed(1)}× realtime` : '—';
  $('#asrMeta').textContent = [
    `${status.compute} · ${status.threads} threads`,
    `${status.transcriptions || 0} segments decoded`,
    rtf,
    status.error ? `⚠ ${status.error}` : null,
    status.restarts ? `${status.restarts} restarts` : null,
  ].filter(Boolean).join('\n');
  $('#asrMeter').style.width = status.rtf ? `${Math.min(100, status.rtf * 100)}%` : '0%';
  $('#asrLag').textContent = status.queue ? `${status.queue} queued` : '';
}

function updateLevel({ level, threshold, active }) {
  const pct = Math.max(2, Math.min(100, ((level + 70) / 70) * 100));
  $('#levelBar').style.width = `${pct}%`;
  $('#levelThresh').style.left = `${Math.max(2, Math.min(100, ((threshold + 70) / 70) * 100))}%`;
  $('#levelBar').style.background = active ? 'linear-gradient(90deg,#34d399,#fbbf24)' : 'linear-gradient(90deg,#34d399,#3b4a5a)';
}

function updateStatusStrip() {
  const s = activeStream();
  const el = $('#captureStatus');
  if (!s) {
    el.textContent = 'Waiting for a stream…';
    return;
  }
  const live = s.live;
  if (live?.state === 'live') {
    el.textContent = live.type === 'tuner'
      ? `Tuned in — server-side capture running${live.speaking ? ' · speech detected' : ''}`
      : `Capturing ${live.type} audio${live.speaking ? ' · speech detected' : ''}`;
  } else if (live?.state === 'paused') {
    el.textContent = 'Paused — audio source disconnected';
  } else if (s.status === 'live') {
    el.textContent = 'Waiting for audio from a browser…';
  } else if (s.status === 'finished') {
    el.textContent = 'Finished — transcript complete';
  } else if (s.kind === 'recording') {
    el.textContent = 'Recording transcribed';
  } else {
    el.textContent = 'Not capturing — start a capture below';
  }
}

// ── capture control ─────────────────────────────────────────────────────
function ensureActiveStream(presetFallback = 'auto') {
  if (state.activeId) return state.activeId;
  return null;
}

async function startBrowserCapture(mode, preset) {
  const support = captureSupport();
  if (mode !== 'mic' && !support.hasDisplay) {
    toast('This browser cannot capture tab/system audio. Use Chrome or Edge, or use a stream URL.', 'err', 7000);
    return;
  }
  let streamId = state.activeId;
  if (!streamId) {
    const title = { system: 'System audio', tab: 'Shared tab', mic: 'Microphone' }[mode];
    const { stream } = await api.send('POST', '/streams', {
      title,
      kind: mode,
      preset,
      alwaysOn: true,
    });
    streamId = stream.id;
    await loadStreams({ keepActive: false });
    state.activeId = streamId;
    renderStreams();
  } else {
    await api.send('PATCH', `/streams/${streamId}`, { preset });
  }

  try {
    const session = new CaptureSession({
      mode,
      onAudio: (pcm) => {
        if (state.ws?.readyState === 1) state.ws.send(pcm);
      },
      onLevel: ({ db }) => {
        if (state.capture) updateLevel({ level: db, threshold: -45, active: db > -40 });
      },
      onStatus: (msg) => toast(msg, 'ok', 2500),
    });
    await session.start();
    state.capture = session;
    state.captureStreamId = streamId;
    attachCaptureSocket(streamId, session, mode, preset);
    startHeartbeat();
    $('#captureStatus').textContent = `Capturing ${mode} audio`;
    toast(`Transcribing ${session.label}`, 'ok', 2600);
    $('#capturePanel').hidden = true;
    await loadStreams();
  } catch (err) {
    toast(err.message || String(err), 'err', 7000);
  }
}

function attachCaptureSocket(streamId, session, mode, preset) {
  const sendOpen = () => {
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({
        type: 'capture:open',
        streamId,
        sampleRate: session.rate,
        source: mode,
        preset,
      }));
    }
  };
  if (state.ws?.readyState === 1) sendOpen();
  else setTimeout(sendOpen, 900);
  state._sendOpen = sendOpen;
}

function startHeartbeat() {
  clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => {
    if (state.capture && state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'capture:heartbeat' }));
    }
  }, 3000);
}

async function stopCapture() {
  if (state.capture) {
    state.capture.stop();
    state.capture = null;
  }
  clearInterval(state.heartbeat);
  if (state.captureStreamId) {
    await api.send('POST', `/streams/${state.captureStreamId}/capture/stop`).catch(() => {});
  }
  toast('Capture stopped', 'warn', 2400);
  await loadStreams();
}

// ── actions ─────────────────────────────────────────────────────────────
async function createStreamFromModal() {
  const title = $('#nsTitle').value.trim() || 'New stream';
  const kind = $('#nsKind').value;
  const preset = $('#nsPreset').value;
  const url = $('#nsUrl').value.trim();
  const alwaysOn = $('#nsAlwaysOn').checked;
  try {
    const { stream } = await api.send('POST', '/streams', { title, kind, preset, url: url || null, alwaysOn });
    $('#newStreamModal').hidden = true;
    await loadStreams({ keepActive: false });
    selectStream(stream.id);
    if (url) toast('Tuning in — transcribing on the server', 'ok');
    else toast('Stream created — start a capture to feed it audio', 'ok');
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

async function startUrlCapture() {
  const url = $('#urlInput').value.trim();
  const preset = $('#urlPreset').value;
  if (!url) return toast('Paste a stream URL first', 'warn');
  try {
    let streamId = state.activeId;
    if (!streamId) {
      const { stream } = await api.send('POST', '/streams', {
        title: new URL(url).hostname, kind: 'stream', preset, url, alwaysOn: true,
      });
      streamId = stream.id;
      await loadStreams({ keepActive: false });
      state.activeId = streamId;
    } else {
      await api.send('POST', `/streams/${streamId}/capture/start`, { url, preset });
    }
    await loadStreams();
    toast('Tuned in — this keeps transcribing with the page closed', 'ok', 5200);
    $('#capturePanel').hidden = true;
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

async function uploadFile() {
  const file = $('#fileInput').files?.[0];
  if (!file) return toast('Choose a file first', 'warn');
  const preset = $('#filePreset').value;
  const prog = $('#uploadProgress');
  prog.hidden = false;
  const bar = prog.querySelector('i');
  const fd = new FormData();
  fd.append('audio', file);
  fd.append('preset', preset);
  fd.append('title', file.name);
  await new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`;
    };
    xhr.onload = async () => {
      prog.hidden = true;
      bar.style.width = '0%';
      if (xhr.status >= 400) {
        let msg = 'upload failed';
        try { msg = JSON.parse(xhr.response).error || msg; } catch { /* ignore */ }
        toast(msg, 'err', 6000);
      } else {
        const { stream } = JSON.parse(xhr.response);
        await loadStreams({ keepActive: false });
        selectStream(stream.id);
        toast('Transcribing file…', 'ok');
      }
      resolve();
    };
    xhr.onerror = () => {
      prog.hidden = true;
      toast('upload failed', 'err');
      resolve();
    };
    xhr.send(fd);
  });
}

async function runDemo() {
  const { stream } = await api.send('POST', '/demo');
  await loadStreams({ keepActive: false });
  selectStream(stream.id);
  toast('Demo dispatch traffic running', 'ok');
}

async function playSegment(id) {
  const audio = new Audio(`/api/segments/${id}/audio`);
  try {
    await audio.play();
  } catch {
    toast('Audio for this segment is no longer stored', 'warn');
  }
}

async function search(q) {
  if (!q.trim()) return closeSearch();
  const { segments } = await api.get(`/search?q=${encodeURIComponent(q)}&limit=200`);
  state.searchMode = true;
  $('#searchResults').hidden = false;
  $('#srTitle').textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'} matching “${q}”`;
  const list = $('#srList');
  list.innerHTML = '';
  if (!segments.length) {
    list.innerHTML = '<div class="empty" style="margin:20px auto"><p>Nothing found.</p></div>';
    return;
  }
  for (const seg of segments) list.append(segmentEl(seg, { highlight: q }));
}

function closeSearch() {
  state.searchMode = false;
  $('#searchResults').hidden = true;
  $('#searchInput').value = '';
}

async function exportStream(format = 'txt') {
  if (!state.activeId) return;
  const s = activeStream();
  const a = document.createElement('a');
  a.href = `/api/streams/${state.activeId}/export?format=${format}`;
  a.download = `${(s?.title || 'transcript').replace(/[^\w.-]+/g, '_')}.${format}`;
  a.click();
  toast(`Exporting ${format.toUpperCase()}`, 'ok', 2000);
}

function openSettings() {
  const s = activeStream();
  if (!s) return;
  $('#stTitle').value = s.title;
  $('#stPreset').value = s.preset;
  $('#stUrl').value = s.source && /^https?:/.test(s.source) ? s.source : '';
  $('#stAlwaysOn').checked = !!s.alwaysOn;
  $('#settingsModal').hidden = false;
}

async function saveSettings() {
  const s = activeStream();
  if (!s) return;
  const body = {
    title: $('#stTitle').value.trim() || s.title,
    preset: $('#stPreset').value,
    alwaysOn: $('#stAlwaysOn').checked,
  };
  const url = $('#stUrl').value.trim();
  try {
    await api.send('PATCH', `/streams/${s.id}`, body);
    if (url && url !== s.source) {
      await api.send('POST', `/streams/${s.id}/capture/start`, { url, preset: body.preset });
    }
    $('#settingsModal').hidden = true;
    await loadStreams();
    toast('Saved', 'ok', 1800);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteStream() {
  const s = activeStream();
  if (!s) return;
  if (!confirm(`Delete “${s.title}” and its transcript? This cannot be undone.`)) return;
  await api.send('DELETE', `/streams/${s.id}`);
  state.segments.delete(s.id);
  state.activeId = null;
  $('#settingsModal').hidden = true;
  await loadStreams({ keepActive: false });
  toast('Stream deleted', 'warn');
}

async function clearTranscript() {
  if (!state.activeId) return;
  if (!confirm('Clear every segment in this stream? Export first if you want to keep it.')) return;
  await api.send('DELETE', `/streams/${state.activeId}/segments`);
  state.segments.set(state.activeId, []);
  renderTranscript();
  await loadStreams();
  toast('Transcript cleared', 'warn');
}

function closeRail() {
  document.body.classList.remove('rail-open');
}

// ── wiring ──────────────────────────────────────────────────────────────
function bind() {
  $('#newStreamBtn').onclick = () => {
    $('#nsTitle').value = '';
    $('#nsUrl').value = '';
    $('#newStreamModal').hidden = false;
    setTimeout(() => $('#nsTitle').focus(), 50);
  };
  $('#nsCreate').onclick = createStreamFromModal;
  $('#demoBtn').onclick = runDemo;
  $('#helpBtn').onclick = () => ($('#helpModal').hidden = false);
  $('#refreshStreams').onclick = () => loadStreams();
  $('#railOpen').onclick = () => document.body.classList.toggle('rail-open');
  $('#railClose').onclick = closeRail;

  $$('[data-close]').forEach((b) => (b.onclick = () => (b.closest('.modal').hidden = true)));
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m) m.hidden = true;
  }));

  $$('[data-capture]').forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.capture;
      const preset = $({ system: '#systemPreset', tab: '#tabPreset', mic: '#micPreset' }[mode]).value;
      startBrowserCapture(mode, preset);
    };
  });

  $('#startUrlBtn').onclick = startUrlCapture;
  $('#uploadBtn').onclick = uploadFile;
  $('#uploadBtn').addEventListener('keydown', (e) => e.key === 'Enter' && uploadFile());

  $('#pauseBtn').onclick = async () => {
    const s = activeStream();
    if (!s) return;
    if (s.live?.state === 'live') {
      if (state.capture) await stopCapture();
      else {
        await api.send('POST', `/streams/${s.id}/capture/stop`);
        await loadStreams();
        toast('Capture stopped', 'warn');
      }
    } else if (s.source) {
      await api.send('POST', `/streams/${s.id}/capture/start`, { url: s.source, preset: s.preset });
      await loadStreams();
      toast('Capture started', 'ok');
    } else {
      $('#capturePanel').hidden = false;
      toast('Choose an audio source below', 'warn');
    }
  };

  $('#alwaysOnBtn').onclick = async () => {
    const s = activeStream();
    if (!s) return;
    await api.send('PATCH', `/streams/${s.id}`, { alwaysOn: !s.alwaysOn });
    await loadStreams();
    toast(`Always-on ${!s.alwaysOn ? 'enabled' : 'disabled'}`, 'ok', 2000);
  };

  $('#exportBtn').onclick = () => {
    const choice = prompt('Export format: txt, srt, vtt, csv, json', 'txt');
    if (choice) exportStream(choice.trim().toLowerCase());
  };
  $('#settingsBtn').onclick = openSettings;
  $('#stSave').onclick = saveSettings;
  $('#stDelete').onclick = deleteStream;
  $('#stExport').onclick = () => exportStream('json');
  $('#clearBtn').onclick = clearTranscript;

  $$('.tab').forEach((tab) => {
    tab.onclick = async () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      state.view = tab.dataset.view;
      if (state.view === 'history') {
        // history = everything, newest first, across streams
        const { segments } = await api.get('/segments/recent?limit=400');
        const holder = $('#transcript');
        holder.innerHTML = '';
        if (!segments.length) {
          holder.innerHTML = '<div class="empty"><h2>No history yet</h2><p>Transcribed segments are stored here permanently.</p></div>';
        }
        for (const seg of segments) holder.append(segmentEl(seg));
      } else {
        renderTranscript();
      }
    };
  });

  $('#followToggle').onchange = (e) => {
    state.follow = e.target.checked;
    if (state.follow) $('#transcript').scrollTop = $('#transcript').scrollHeight;
  };
  $('#annotateToggle').onchange = (e) => {
    state.annotate = e.target.checked;
    if (state.view === 'live') renderTranscript();
  };

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => search(q), 260);
  });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });
  $('#closeSearch').onclick = closeSearch;

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      $('#searchInput').focus();
    }
    if (e.key === 'Escape') $$('.modal').forEach((m) => (m.hidden = true));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'capture:pause', reason: 'tab hidden' }));
    } else if (document.visibilityState === 'visible' && state.ws?.readyState === 1 && state.captureStreamId) {
      state.ws.send(JSON.stringify({ type: 'capture:heartbeat' }));
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.capture) state.capture.stop();
  });
}

async function init() {
  bind();
  connect();
  try {
    const cfg = await api.get('/config');
    state.tenCodes = cfg.tenCodes;
    state.presets = cfg.presets;
  } catch {
    /* server offline */
  }
  await loadStreams({ keepActive: false });
  setInterval(async () => {
    try {
      const h = await api.get('/health');
      setAsr(h.asr);
    } catch {
      /* ignore */
    }
  }, 15000);
  if (window.innerWidth > 880) $('#capturePanel').hidden = false;
}

init();
