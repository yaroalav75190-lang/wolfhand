// Привязка игровой сессии к устройству гостя (анти-махинации).
//
// Проблема: ссылка ?s=... из QR могла открываться на любом числе устройств — чужой человек
// (пересланная ссылка, найденная бумажка с QR) мог сыграть чужую раздачу или увидеть код приза.
//
// Решение: при регистрации сервер выдаёт случайный device-токен и хранит в сессии ТОЛЬКО его
// SHA-256. Все последующие игровые запросы (deal/session-status) обязаны предъявлять
// заголовок X-Device-Token. Нет или не тот токен → 403 SESSION_LOCKED, без утечки кода/призов.
// Сессия без привязки (до регистрации) проходит без проверки.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Выдать новый токен устройства: токен — клиенту, hash — в сессию. */
export function issueDeviceToken() {
  const token = randomBytes(24).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * Допущен ли запрос к привязанной сессии.
 * true — если сессия ещё не привязана (legacy/до регистрации) или предъявлен верный токен.
 */
export function deviceAllowed(req, session) {
  const bound = session?.device?.tokenHash;
  if (!bound) return true;
  const presented = req.headers['x-device-token'];
  if (!presented || typeof presented !== 'string' || presented.length > 128) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(String(bound), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
