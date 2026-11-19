import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DRIVES } from './drives.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS drives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  potential REAL NOT NULL,
  threshold REAL NOT NULL,
  fill_per_min REAL NOT NULL,
  release REAL NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  drive TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  llm INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT
);
CREATE INDEX IF NOT EXISTS thoughts_at ON thoughts(at);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  drive TEXT NOT NULL,
  text TEXT NOT NULL,
  priority REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

/**
 * The agency keeps its own file so a cortex upgrade or restore never has to
 * migrate somebody else's tables. Writes are short and single-process.
 */
export function openAgencyStore({ file }) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  function setMeta(key, value) {
    db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  function loadDrives() {
    const rows = db.prepare('SELECT * FROM drives ORDER BY rowid').all();
    if (!rows.length) return DEFAULT_DRIVES.map((drive) => ({ ...drive }));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      potential: Number(row.potential),
      threshold: Number(row.threshold),
      fillPerMin: Number(row.fill_per_min),
      release: Number(row.release),
    }));
  }

  function saveDrives(drives, at) {
    const stmt = db.prepare(`
      INSERT INTO drives(id, name, potential, threshold, fill_per_min, release, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, potential = excluded.potential, threshold = excluded.threshold,
        fill_per_min = excluded.fill_per_min, release = excluded.release, updated_at = excluded.updated_at
    `);
    for (const drive of drives) {
      stmt.run(drive.id, drive.name, Number(drive.potential) || 0, Number(drive.threshold) || 0.6, Number(drive.fillPerMin) || 0, Number(drive.release) || 0.3, at);
    }
  }

  function addThought({ id, at, drive, text, source, llm, traceId = null }) {
    db.prepare(`
      INSERT INTO thoughts(id, at, drive, text, source, llm, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, at, drive, text, source, llm ? 1 : 0, traceId);
    return id;
  }

  function countThoughtsSince(iso) {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE at >= ?').get(iso).c ?? 0);
  }

  function lastThoughtAt() {
    return db.prepare('SELECT at FROM thoughts ORDER BY at DESC LIMIT 1').get()?.at ?? null;
  }

  function listThoughts({ limit = 20 } = {}) {
    return db.prepare('SELECT * FROM thoughts ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit)));
  }

  function activeGoalFor(driveId, at) {
    return db.prepare("SELECT * FROM goals WHERE drive = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(driveId, at) ?? null;
  }

  function countThoughtsForDrive(drive) {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE drive = ?').get(drive)?.c ?? 0);
  }

  function lastThoughtForDrive(drive) {
    return db.prepare('SELECT at FROM thoughts WHERE drive = ? ORDER BY at DESC LIMIT 1').get(drive)?.at ?? null;
  }

  function listGoals({ status = 'active', limit = 20 } = {}) {
    return db.prepare('SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, Math.max(1, Math.min(200, limit)))
      .map((row) => ({
        id: row.id,
        drive: row.drive,
        text: row.text,
        priority: Number(row.priority),
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
  }

  function addGoal({ id, drive, text, priority, at, expiresAt }) {
    db.prepare(`
      INSERT INTO goals(id, drive, text, priority, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, drive, text, priority, at, expiresAt);
  }

  function expireGoals(at) {
    return db.prepare("UPDATE goals SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(at).changes;
  }

  function stats() {
    return {
      thoughts: Number(db.prepare('SELECT COUNT(*) AS c FROM thoughts').get().c ?? 0),
      goals: Number(db.prepare("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'").get().c ?? 0),
      lastThoughtAt: lastThoughtAt(),
    };
  }

  return {
    file: resolved,
    getMeta,
    setMeta,
    loadDrives,
    saveDrives,
    addThought,
    countThoughtsSince,
    lastThoughtAt,
    listThoughts,
    activeGoalFor,
    listGoals,
    countThoughtsForDrive,
    lastThoughtForDrive,
    addGoal,
    expireGoals,
    stats,
    close: () => db.close(),
  };
}
