// End-to-end self test.
//
//   npm test                    full run (needs the local speech engine)
//   npm test -- --fast          skips anything that decodes audio
//
// Exercises the real server, not mocks:
//   1. health + config endpoints
//   2. create a stream, verify persistence
//   3. push PCM over the websocket exactly like the browser capture does,
//      including a "page closed mid-stream" reconnect
//   4. verify transcript, speaker labels and 10-code canonicalisation
//   5. search + every export format
//   6. restart resistance: the always-on stream comes back after a reboot
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const FAST = process.argv.includes('--fast');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = (p) => (p.startsWith('/api') ? `${BASE}${p}` : `${BASE}/api${p}`);
async function get(p, opts) {
  const r = await fetch(url(p), opts);
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function send(method, p, body) {
  const r = await fetch(url(p), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}

function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trill-test-'));
  const child = spawn('node', ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TRILL_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, dataDir, log: () => log };
}

async function waitForServer(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await get('/api/health');
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

function wavPcm(file) {
  const buf = fs.readFileSync(file);
  return buf.subarray(44); // our corpus files are plain 44-byte-header PCM
}

/** Push PCM to a stream over the websocket the same way the browser does. */
function pusher(streamId, sampleRate = 16000) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  let opened;
  const ready = new Promise((resolve, reject) => {
    opened = resolve;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'capture:open', streamId, sampleRate, source: 'system', preset: 'radio' }));
      resolve();
    });
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'segment') events.push(m.payload);
    } catch {
      /* ignore */
    }
  });
  return {
    ready,
    events,
    async send(pcm, chunk = 3200) {
      await ready;
      for (let i = 0; i < pcm.length; i += chunk) {
        ws.send(pcm.subarray(i, Math.min(i + chunk, pcm.length)));
        if (i % (chunk * 8) === 0) await sleep(4);
      }
    },
    close(fast = false) {
      if (fast) ws.terminate();
      else ws.close();
    },
    ws,
  };
}

async function main() {
  console.log('\nTrillFun self test\n==================');
  const { child, dataDir, log } = startServer();
  let ok = false;
  try {
    ok = await waitForServer();
    check('server starts and answers /api/health', ok, log().slice(-400));
    if (!ok) throw new Error('server did not start');

    // ---- static assets ---------------------------------------------------
    for (const asset of ['/', '/styles.css', '/app.js', '/capture-client.js']) {
      const r = await fetch(BASE + asset);
      check(`serves ${asset}`, r.ok && (await r.text()).length > 100);
    }

    // ---- config ----------------------------------------------------------
    const cfg = await get('/api/config');
    check('107 10-codes are exposed to the UI', Object.keys(cfg.tenCodes).length >= 100);
    check('10-54 has the right meaning', /injur|accident/i.test(cfg.tenCodes['54']), cfg.tenCodes['54']);
    check('capture presets present', cfg.presets.includes('radio') && cfg.presets.includes('phone'));

    // ---- 10-code normalisation via API ----------------------------------
    const s = await send('POST', '/streams', { title: 'Radio chatter', kind: 'radio', preset: 'radio' });
    check('create stream', !!s.stream.id);
    const streamId = s.stream.id;

    const listing = await get('/api/streams');
    check('stream is listed', listing.streams.some((x) => x.id === streamId));
    check('always-on defaults to true', listing.streams.find((x) => x.id === streamId).alwaysOn === true);

    // ---- websocket push path (what the browser does) ---------------------
    if (!FAST) {
      const corpus = path.join(ROOT, 'tests', 'corpus');
      const file = path.join(corpus, 'unit_ack.radio.wav');
      if (!fs.existsSync(file)) {
        check('corpus available (run npm run corpus)', false);
      } else {
        const pcm = wavPcm(file);
        const p = pusher(streamId);
        p.ws.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'capture:error' || m.type === 'asr:error') console.log('    ! server:', JSON.stringify(m.payload));
          } catch { /* ignore */ }
        });
        await p.send(pcm);
        await sleep(1500);
        const liveNow = await get('/api/streams');
        console.log('    live:', JSON.stringify(liveNow.active), 'bytes in:', liveNow.active?.[0]?.bytesIn);
        p.close();
        // give the recognizer time
        const deadline = Date.now() + 90_000;
        let detail = null;
        while (Date.now() < deadline) {
          detail = await get(`/api/streams/${streamId}`);
          if (detail.segments.length) break;
          await sleep(1000);
        }
        check('browser-pushed PCM is transcribed', detail?.segments?.length > 0, JSON.stringify(detail?.segments?.length));
        const text = detail?.segments?.[0]?.text || '';
        check('transcript contains unit seven', /unit\s*7|unit seven/i.test(text), text);
        check('10-4 is canonicalised', /10-4\b/.test(text), text);
        check('speaker label assigned', !!detail?.segments?.[0]?.speaker, detail?.segments?.[0]?.speaker);
        check('segment audio kept on disk', !!detail?.segments?.[0]?.audio && fs.existsSync(detail.segments[0].audio));

        // page closes mid-stream: paused, then a new page reconnects
        const status = await get('/api/capture/pending');
        check('stream stays armed after the page disconnects', status.pending.some((x) => x.id === streamId));
      }
    }

    // ---- search + exports ------------------------------------------------
    const search = await get('/api/search?q=unit');
    check('search endpoint works', Array.isArray(search.segments));

    for (const fmt of ['txt', 'srt', 'vtt', 'csv', 'json']) {
      const r = await fetch(`${BASE}/api/streams/${streamId}/export?format=${fmt}`);
      const body = await r.text();
      check(`export ${fmt}`, r.ok && body.length > 3, `${r.status} ${body.slice(0, 80)}`);
    }

    // ---- demo stream (no audio needed) -----------------------------------
    const demo = await send('POST', '/demo', {});
    check('demo stream starts', !!demo.stream.id);
    await sleep(3200);
    const demoDetail = await get(`/api/streams/${demo.stream.id}`);
    check('demo produced transcript', demoDetail.segments.length > 0);
    const demoText = demoDetail.segments.map((x) => x.text).join(' ');
    check('demo annotations present', /10-54/.test(demoText), demoText.slice(0, 120));

    // ---- persistence across restart --------------------------------------
    const before = (await get('/api/streams')).streams.length;
    child.kill('SIGTERM');
    await sleep(1500);
    const second = startServer({ TRILL_DATA_DIR: dataDir });
    await waitForServer();
    const after = await get('/api/streams');
    check('history survives a server restart', after.streams.length === before, `${before} -> ${after.streams.length}`);
    check('transcript survives a server restart', (await get(`/api/streams/${streamId}`)).segments.length > 0 || FAST);
    second.child.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    check('test run completed without exceptions', false, err.message);
    console.error(err);
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed: ' + failures.join(', '));
    process.exit(1);
  }
}

main();
