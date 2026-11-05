// Persistent transcript store.
//
// History is the product, so this is deliberately durable:
//   * every recognized segment is written to SQLite before it is broadcast
//   * streams/captures are rows, so a restart can resume the last one
//   * full text search over every word ever transcribed
//   * speakers are tracked per stream (radio call signs / phone speakers)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const now = () => Date.now();
const id = () => crypto.randomUUID().slice(0, 8) + Date.now().toString(36).slice(-5);

export class Store {
  constructor(dbPath, { retentionDays = 30 } = {}) {
    this.retentionDays = retentionDays;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS streams (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'stream',
        preset        TEXT NOT NULL DEFAULT 'auto',
        status        TEXT NOT NULL DEFAULT 'idle',
        source        TEXT,
        detail        TEXT,
        pinned        INTEGER NOT NULL DEFAULT 1,
        always_on     INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        started_at    INTEGER,
        stopped_at    INTEGER,
        error         TEXT,
        words         INTEGER NOT NULL DEFAULT 0,
        segments      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS segments (
        id         TEXT PRIMARY KEY,
        stream_id  TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        ts         INTEGER NOT NULL,
        ended_at   INTEGER NOT NULL,
        text       TEXT NOT NULL,
        raw_text   TEXT,
        speaker    TEXT,
        preset     TEXT,
        codes      TEXT,
        confidence REAL,
        duration   REAL,
        audio      TEXT,
        words      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS segments_stream_ts ON segments(stream_id, ts DESC);
      CREATE INDEX IF NOT EXISTS segments_ts ON segments(ts DESC);

      CREATE TABLE IF NOT EXISTS speakers (
        stream_id  TEXT NOT NULL,
        name       TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL,
        segments   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (stream_id, name)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
        text, stream_id UNINDEXED, segment_id UNINDEXED, tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT
      );
    `);
    this.q = {
      insertStream: this.db.prepare(`INSERT INTO streams
        (id,title,kind,preset,status,source,detail,pinned,always_on,created_at,updated_at,started_at,words,segments)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0)`),
      updateStream: this.db.prepare(`UPDATE streams SET title=COALESCE(?,title), kind=COALESCE(?,kind),
        preset=COALESCE(?,preset), status=COALESCE(?,status), source=COALESCE(?,source),
        detail=COALESCE(?,detail), always_on=COALESCE(?,always_on), pinned=COALESCE(?,pinned),
        updated_at=?, started_at=COALESCE(?,started_at), stopped_at=COALESCE(?,stopped_at),
        error=? WHERE id=?`),
      bumpStream: this.db.prepare(
        `UPDATE streams SET words=words+?, segments=segments+1, updated_at=? WHERE id=?`,
      ),
      getStream: this.db.prepare(`SELECT * FROM streams WHERE id=?`),
      listStreams: this.db.prepare(`SELECT * FROM streams ORDER BY pinned DESC, updated_at DESC`),
      deleteStream: this.db.prepare(`DELETE FROM streams WHERE id=?`),
      insertSegment: this.db.prepare(`INSERT INTO segments
        (id,stream_id,ts,ended_at,text,raw_text,speaker,preset,codes,confidence,duration,audio,words)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertFts: this.db.prepare(
        `INSERT INTO segments_fts (text, stream_id, segment_id) VALUES (?,?,?)`,
      ),
      listSegments: this.db.prepare(
        `SELECT * FROM segments WHERE stream_id=? ORDER BY ts DESC LIMIT ? OFFSET ?`,
      ),
      allSegments: this.db.prepare(
        `SELECT * FROM segments WHERE stream_id=? ORDER BY ts ASC`,
      ),
      recent: this.db.prepare(
        `SELECT s.*, st.title AS stream_title FROM segments s
         JOIN streams st ON st.id=s.stream_id ORDER BY s.ts DESC LIMIT ?`,
      ),
      search: this.db.prepare(
        `SELECT s.*, st.title AS stream_title FROM segments_fts f
         JOIN segments s ON s.id=f.segment_id JOIN streams st ON st.id=s.stream_id
         WHERE segments_fts MATCH ? ORDER BY s.ts DESC LIMIT ?`,
      ),
      deleteSegmentsOlder: this.db.prepare(`DELETE FROM segments WHERE ts < ?`),
      upsertSpeaker: this.db.prepare(`INSERT INTO speakers (stream_id,name,first_seen,last_seen,segments)
        VALUES (?,?,?,?,1) ON CONFLICT(stream_id,name) DO UPDATE SET
        last_seen=excluded.last_seen, segments=segments+1`),
      listSpeakers: this.db.prepare(
        `SELECT * FROM speakers WHERE stream_id=? ORDER BY segments DESC`,
      ),
      allSpeakers: this.db.prepare(`SELECT * FROM speakers ORDER BY last_seen DESC`),
      getMeta: this.db.prepare(`SELECT value FROM meta WHERE key=?`),
      setMeta: this.db.prepare(
        `INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ),
      countSegments: this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(words),0) AS w FROM segments`),
    };
    this.prune();
  }

  // ---- streams -------------------------------------------------------------
  createStream({ title, kind = 'stream', preset = 'auto', source = null, detail = null, alwaysOn = 1 }) {
    const streamId = id();
    const t = now();
    this.q.insertStream.run(
      streamId, title, kind, preset, 'idle', source, detail, 1, alwaysOn ? 1 : 0, t, t, null,
    );
    return this.getStream(streamId);
  }

  updateStream(streamId, fields = {}) {
    const s = this.getStream(streamId);
    if (!s) return null;
    const status = fields.status ?? null;
    this.q.updateStream.run(
      fields.title ?? null,
      fields.kind ?? null,
      fields.preset ?? null,
      status,
      fields.source ?? null,
      fields.detail ?? null,
      fields.alwaysOn === undefined ? null : fields.alwaysOn ? 1 : 0,
      fields.pinned === undefined ? null : fields.pinned ? 1 : 0,
      now(),
      status === 'live' ? now() : null,
      status === 'stopped' || status === 'error' ? now() : null,
      fields.error ?? null,
      streamId,
    );
    return this.getStream(streamId);
  }

  getStream(streamId) {
    const s = this.q.getStream.get(streamId);
    return s ? this.decorateStream(s) : null;
  }

  listStreams() {
    return this.q.listStreams.all().map((s) => this.decorateStream(s));
  }

  deleteStream(streamId) {
    const segs = this.db.prepare(`SELECT id FROM segments WHERE stream_id=?`).all(streamId);
    const delFts = this.db.prepare(`DELETE FROM segments_fts WHERE segment_id=?`);
    for (const seg of segs) delFts.run(seg.id);
    this.db.prepare(`DELETE FROM speakers WHERE stream_id=?`).run(streamId);
    this.q.deleteStream.run(streamId);
  }

  decorateStream(s) {
    const speakers = this.q.listSpeakers.all(s.id);
    return {
      id: s.id,
      title: s.title,
      kind: s.kind,
      preset: s.preset,
      status: s.status,
      source: s.source,
      detail: s.detail,
      pinned: !!s.pinned,
      alwaysOn: !!s.always_on,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      startedAt: s.started_at,
      stoppedAt: s.stopped_at,
      error: s.error,
      words: s.words,
      segments: s.segments,
      speakers: speakers.map((sp) => sp.name),
    };
  }

  // ---- segments ------------------------------------------------------------
  addSegment({
    streamId,
    text,
    rawText = null,
    speaker = null,
    preset = null,
    codes = [],
    confidence = null,
    duration = null,
    audio = null,
    ts = now(),
    endedAt = null,
  }) {
    if (!text || !text.trim()) return null;
    const segId = id();
    const words = text.trim().split(/\s+/).length;
    this.q.insertSegment.run(
      segId, streamId, ts, endedAt ?? ts, text.trim(), rawText, speaker, preset,
      codes.length ? codes.join(',') : null, confidence, duration, audio, words,
    );
    this.q.insertFts.run(text.trim(), streamId, segId);
    this.q.bumpStream.run(words, now(), streamId);
    if (speaker) this.q.upsertSpeaker.run(streamId, speaker, ts, ts);
    return this.getSegment(segId);
  }

  getSegment(segId) {
    const row = this.db.prepare(`SELECT * FROM segments WHERE id=?`).get(segId);
    return row ? mapSegment(row) : null;
  }

  listSegments(streamId, { limit = 100, offset = 0 } = {}) {
    return this.q.listSegments.all(streamId, limit, offset).map(mapSegment);
  }

  allSegments(streamId) {
    return this.q.allSegments.all(streamId).map(mapSegment);
  }

  recentSegments(limit = 50) {
    return this.q.recent.all(limit).map((r) => ({
      ...mapSegment(r),
      streamTitle: r.stream_title,
    }));
  }

  search(query, limit = 100) {
    const cleaned = String(query || '')
      .replace(/["'*^:()-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"*`)
      .join(' ');
    if (!cleaned) return [];
    try {
      return this.q.search.all(cleaned, limit).map((r) => ({
        ...mapSegment(r),
        streamTitle: r.stream_title,
      }));
    } catch {
      return [];
    }
  }

  speakers(streamId = null) {
    if (streamId) return this.q.listSpeakers.all(streamId);
    return this.q.allSpeakers.all();
  }

  stats() {
    const c = this.q.countSegments.get();
    return { segments: c.n, words: c.w, streams: this.listStreams().length };
  }

  // ---- retention -----------------------------------------------------------
  prune() {
    if (!this.retentionDays) return;
    const cutoff = now() - this.retentionDays * 86400_000;
    const old = this.db.prepare(`SELECT id FROM segments WHERE ts < ?`).all(cutoff);
    if (old.length) {
      const delFts = this.db.prepare(`DELETE FROM segments_fts WHERE segment_id=?`);
      for (const seg of old) delFts.run(seg.id);
      this.q.deleteSegmentsOlder.run(cutoff);
    }
  }

  meta(key, value) {
    if (value === undefined) return this.q.getMeta.get(key)?.value ?? null;
    this.q.setMeta.run(key, String(value));
    return value;
  }
}

function mapSegment(r) {
  return {
    id: r.id,
    streamId: r.stream_id,
    ts: r.ts,
    endedAt: r.ended_at,
    text: r.text,
    rawText: r.raw_text,
    speaker: r.speaker,
    preset: r.preset,
    codes: r.codes ? r.codes.split(',') : [],
    confidence: r.confidence,
    duration: r.duration,
    audio: r.audio,
    words: r.words,
  };
}

export default Store;
