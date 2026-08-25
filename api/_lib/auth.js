// Аутентификация и общие HTTP-хелперы.
//
// Два независимых контура:
//   1. Роли персонала и партнёров — HMAC-подписанная cookie `wolf_admin` (12 часов).
//      Логин на /admin/ → /api/admin/login.
//   2. Игровая сессия гостя — X-Session-Id + X-Device-Token (см. device.js).

import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── HTTP-хелперы ────────────────────────────────────────────────────────────

export function applyCors(req, res) {
  const allowed = process.env.PUBLIC_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id, X-Device-Token');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  const status = err?.status || 500;
  const code = err?.code || (status === 401 ? 'UNAUTHORIZED' : 'INTERNAL');
  const msg = status < 500 ? (err?.message || 'error') : 'internal error';
  if (status >= 500) console.error('[api]', err);
  sendJson(res, status, { error: code, message: msg });
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) {
      const err = new Error('payload too large');
      err.status = 413; err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const err = new Error('invalid JSON');
    err.status = 400; err.code = 'BAD_REQUEST';
    throw err;
  }
}

// ─── Роли ────────────────────────────────────────────────────────────────────

export const ROLES = {
  STAFF: 'staff',         // хостес / кассир / дилер: выдаёт QR, гасит коды
  MANAGER: 'manager',     // управляющий: статистика клуба
  MARKETING: 'marketing', // маркетолог: витрина, лиды, очередь выдач
  PARTNER: 'partner',     // партнёр цепочки: только своя статистика
};

const COOKIE_NAME = 'wolf_admin';
const COOKIE_TTL_SEC = 12 * 3600;

function _b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf-8');
}

function _secret() {
  const s = process.env.WOLF_SESSION_SECRET;
  if (!s || s.length < 16) {
    if (!globalThis.__wolf_runtime_secret) {
      globalThis.__wolf_runtime_secret = randomBytes(32).toString('hex');
      console.warn('[auth] WOLF_SESSION_SECRET не задан — использую runtime-секрет (cookie сбросятся при рестарте)');
    }
    return globalThis.__wolf_runtime_secret;
  }
  return s;
}

/** Подписать роль. partnerId заполняется только для роли partner. */
export function signRole(role, name, partnerId = null) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL_SEC;
  const payload = JSON.stringify({
    role,
    name: String(name || '').slice(0, 80),
    partnerId: partnerId || null,
    exp,
  });
  const body = _b64url(payload);
  const sig = createHmac('sha256', _secret()).update(body).digest();
  return `${body}.${_b64url(sig)}`;
}

/** Прочитать роль из cookie: {role, name, partnerId, exp} либо null. */
export function readRole(req) {
  const cookieHeader = req.headers?.cookie || '';
  if (typeof cookieHeader !== 'string') return null;
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k, v.join('=')]),
  );
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expectedSig = _b64url(createHmac('sha256', _secret()).update(body).digest());
  if (!safeEq(sig, expectedSig)) return null;
  let payload;
  try { payload = JSON.parse(_b64urlDecode(body)); } catch { return null; }
  if (!payload?.role || !payload.exp) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Требовать одну из ролей, иначе 401. */
export function requireRole(req, allowedRoles) {
  const session = readRole(req);
  if (!session || !allowedRoles.includes(session.role)) {
    const err = new Error('нужен вход на /admin/');
    err.status = 401; err.code = 'UNAUTHORIZED';
    throw err;
  }
  return session;
}

export function setRoleCookie(res, role, name, partnerId = null) {
  const value = signRole(role, name, partnerId);
  const isProd = process.env.NODE_ENV === 'production';
  const allowSecure = process.env.COOKIE_SECURE !== 'false';
  const secure = (isProd && allowSecure) ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_SEC};${secure}`);
}

export function clearRoleCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Пароль роли из ENV: MANAGER_PASSWORD / MARKETING_PASSWORD. */
export function checkRolePassword(role, password) {
  if (typeof password !== 'string') return false;
  let expected;
  if (role === ROLES.MANAGER)   expected = process.env.MANAGER_PASSWORD;
  if (role === ROLES.MARKETING) expected = process.env.MARKETING_PASSWORD;
  if (!expected) return false;
  return safeEq(password, expected);
}

/**
 * Пароль партнёра: PARTNER_PASSWORD_<ID в верхнем регистре>.
 * Например, PARTNER_PASSWORD_HELLOAPPLE=...
 */
export function checkPartnerPassword(partnerId, password) {
  if (typeof password !== 'string' || typeof partnerId !== 'string') return false;
  const envKey = `PARTNER_PASSWORD_${partnerId.toUpperCase()}`;
  const expected = process.env[envKey];
  if (!expected) return false;
  return safeEq(password, expected);
}
