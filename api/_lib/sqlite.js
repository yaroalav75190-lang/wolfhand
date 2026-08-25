// SQLite-драйвер для kv-store. Используется когда KV_DRIVER=sqlite (по умолчанию для VPS).
// Совместим с интерфейсом ydb.js / redis-driver.js.
//
// Установка: npm i better-sqlite3
// Файл БД: data/wolfhand.sqlite (создаётся автоматически)
//
// Атомарность для setNX через INSERT ... ON CONFLICT DO NOTHING.
// TTL через колонку expires_at + периодическая очистка (опционально через cron).

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.SQLITE_PATH || path.resolve(process.cwd(), 'data/wolfhand.sqlite');

let _db = null;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      pk TEXT PRIMARY KEY,
      value TEXT,
      counter INTEGER,
      hash TEXT,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS kv_exp ON kv(expires_at);
  `);
  return _db;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function notExpired(row) {
  if (!row) return false;
  if (row.expires_at == null) return true;
  return row.expires_at > nowSec();
}

function ttlSec(opts) {
  if (!opts?.ex) return null;
  return nowSec() + Number(opts.ex);
}

export async function get(key) {
  const row = db().prepare('SELECT value, counter, expires_at FROM kv WHERE pk = ?').get(key);
  if (!notExpired(row)) return null;
  if (row.value == null) {
    // Ключи-счётчики (создаются через incr) хранят число в колонке counter, а не value.
    // Возвращаем counter — иначе статистика призов (stats:prize:*) читается как null
    // и распределение призов на дашборде всегда пустое (memory-драйвер маскировал баг).
    return (row.counter != null) ? row.counter : null;
  }
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export async function set(key, value, opts) {
  db().prepare(`
    INSERT INTO kv(pk, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(pk) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, counter = NULL, hash = NULL
  `).run(key, JSON.stringify(value), ttlSec(opts));
  return 'OK';
}

export async function setNX(key, value, opts) {
  // Сначала чистим протухшую запись, если есть. Затем INSERT с проверкой.
  const tx = db().transaction((k, v, exp) => {
    const row = db().prepare('SELECT pk, expires_at FROM kv WHERE pk = ?').get(k);
    if (row && row.expires_at != null && row.expires_at <= nowSec()) {
      db().prepare('DELETE FROM kv WHERE pk = ?').run(k);
    }
    try {
      db().prepare('INSERT INTO kv(pk, value, expires_at) VALUES (?, ?, ?)').run(k, v, exp);
      return true;
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw e;
    }
  });
  const ok = tx(key, JSON.stringify(value), ttlSec(opts));
  return ok ? 'OK' : null;
}

export async function del(key) {
  const info = db().prepare('DELETE FROM kv WHERE pk = ?').run(key);
  return info.changes;
}

export async function incr(key) {
  const tx = db().transaction((k) => {
    const row = db().prepare('SELECT counter, expires_at FROM kv WHERE pk = ?').get(k);
    if (row && row.expires_at != null && row.expires_at <= nowSec()) {
      db().prepare('DELETE FROM kv WHERE pk = ?').run(k);
    }
    const next = ((notExpired(row) && row.counter) || 0) + 1;
    db().prepare(`
      INSERT INTO kv(pk, counter) VALUES (?, ?)
      ON CONFLICT(pk) DO UPDATE SET counter = excluded.counter
    `).run(k, next);
    return next;
  });
  return tx(key);
}

export async function hgetall(key) {
  const row = db().prepare('SELECT hash, expires_at FROM kv WHERE pk = ?').get(key);
  if (!notExpired(row)) return null;
  if (!row.hash) return null;
  try { return JSON.parse(row.hash); } catch { return null; }
}

export async function hincrby(key, field, n) {
  const tx = db().transaction((k, f, delta) => {
    const row = db().prepare('SELECT hash, expires_at FROM kv WHERE pk = ?').get(k);
    if (row && row.expires_at != null && row.expires_at <= nowSec()) {
      db().prepare('DELETE FROM kv WHERE pk = ?').run(k);
    }
    let h = {};
    if (notExpired(row) && row.hash) {
      try { h = JSON.parse(row.hash); } catch {}
    }
    h[f] = (Number(h[f]) || 0) + Number(delta);
    db().prepare(`
      INSERT INTO kv(pk, hash) VALUES (?, ?)
      ON CONFLICT(pk) DO UPDATE SET hash = excluded.hash
    `).run(k, JSON.stringify(h));
    return h[f];
  });
  return tx(key, field, n);
}

// Очистка протухших записей (вызывается периодически из server.js)
export function vacuum() {
  const info = db().prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(nowSec());
  return info.changes;
}

// ─── Сканирование ключей по префиксу (для пагинации аккаунтов и аналитики) ────
// Сортировка по pk ASC даёт стабильный порядок для пагинации.
function _escapeLike(s) {
  // SQLite LIKE спецсимволы: %, _. Экранируем через ESCAPE '\\'.
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function listKeys(prefix, limit = 1000, offset = 0) {
  const like = _escapeLike(prefix) + '%';
  const rows = db().prepare(`
    SELECT pk FROM kv
    WHERE pk LIKE ? ESCAPE '\\'
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY pk
    LIMIT ? OFFSET ?
  `).all(like, nowSec(), Math.min(Math.max(0, Number(limit) || 0), 10000), Math.max(0, Number(offset) || 0));
  return rows.map(r => r.pk);
}

export async function listValues(prefix, limit = 1000, offset = 0) {
  const like = _escapeLike(prefix) + '%';
  const rows = db().prepare(`
    SELECT pk, value FROM kv
    WHERE pk LIKE ? ESCAPE '\\'
      AND (expires_at IS NULL OR expires_at > ?)
      AND value IS NOT NULL
    ORDER BY pk
    LIMIT ? OFFSET ?
  `).all(like, nowSec(), Math.min(Math.max(0, Number(limit) || 0), 10000), Math.max(0, Number(offset) || 0));
  const out = [];
  for (const r of rows) {
    try { out.push({ key: r.pk, value: JSON.parse(r.value) }); }
    catch { /* пропускаем битые JSON */ }
  }
  return out;
}

export async function count(prefix) {
  const like = _escapeLike(prefix) + '%';
  const row = db().prepare(`
    SELECT COUNT(*) AS c FROM kv
    WHERE pk LIKE ? ESCAPE '\\'
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(like, nowSec());
  return Number(row?.c) || 0;
}
