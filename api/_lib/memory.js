// In-memory KV-driver. Используется для локальной разработки и просмотра проекта
// без зависимости от better-sqlite3 (нативной сборки на Windows).
//
// Активация: KV_DRIVER=memory
// Данные хранятся в памяти процесса и теряются при рестарте.
// ВАЖНО: НЕ использовать в продакшене — там sqlite.

const _store = new Map();   // pk → { value, expiresAt }
const _hash  = new Map();   // pk → Map<field, number>
const _counter = new Map(); // pk → number

const now = () => Date.now();

function _isExpired(rec) {
  return rec && rec.expiresAt && rec.expiresAt < now();
}

function _cleanup(key) {
  const rec = _store.get(key);
  if (_isExpired(rec)) {
    _store.delete(key);
    _hash.delete(key);
    _counter.delete(key);
  }
}

export function get(key) {
  _cleanup(key);
  const rec = _store.get(key);
  return rec ? rec.value : null;
}

export function set(key, value, opts = {}) {
  const expiresAt = opts.ex ? now() + opts.ex * 1000 : null;
  _store.set(key, { value, expiresAt });
  return 'OK';
}

export function setNX(key, value, opts = {}) {
  _cleanup(key);
  if (_store.has(key)) return null;
  return set(key, value, opts);
}

export function del(key) {
  const existed = _store.has(key) || _hash.has(key) || _counter.has(key);
  _store.delete(key);
  _hash.delete(key);
  _counter.delete(key);
  return existed ? 1 : 0;
}

export function incr(key) {
  _cleanup(key);
  const cur = (_counter.get(key) || 0) + 1;
  _counter.set(key, cur);
  // Также пишем в store как value для совместимости с .get()
  _store.set(key, { value: cur, expiresAt: null });
  return cur;
}

export function hgetall(key) {
  _cleanup(key);
  const h = _hash.get(key);
  if (!h) return null;
  return Object.fromEntries(h.entries());
}

export function hincrby(key, field, n = 1) {
  _cleanup(key);
  let h = _hash.get(key);
  if (!h) { h = new Map(); _hash.set(key, h); }
  const cur = (h.get(field) || 0) + Number(n);
  h.set(field, cur);
  return cur;
}

// Vacuum для совместимости с интерфейсом sqlite.js (не используется server.js, но безопасно)
export function vacuum() {
  let removed = 0;
  for (const [key, rec] of _store.entries()) {
    if (_isExpired(rec)) {
      _store.delete(key);
      _hash.delete(key);
      _counter.delete(key);
      removed++;
    }
  }
  return removed;
}

// ─── Сканирование ключей по префиксу (зеркало sqlite.js) ──────────────────────
function _matchingKeys(prefix) {
  return [..._store.keys()]
    .filter(k => k.startsWith(prefix))
    .filter(k => !_isExpired(_store.get(k)))
    .sort();
}

export function listKeys(prefix, limit = 1000, offset = 0) {
  const lim = Math.min(Math.max(0, Number(limit) || 0), 10000);
  const off = Math.max(0, Number(offset) || 0);
  return _matchingKeys(prefix).slice(off, off + lim);
}

export function listValues(prefix, limit = 1000, offset = 0) {
  const keys = listKeys(prefix, limit, offset);
  const out = [];
  for (const k of keys) {
    const rec = _store.get(k);
    if (rec && rec.value !== undefined) out.push({ key: k, value: rec.value });
  }
  return out;
}

export function count(prefix) {
  return _matchingKeys(prefix).length;
}
