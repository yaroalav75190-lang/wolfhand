// POST /api/admin/logout
// Сбрасывает cookie сессии. Возвращает {ok: true} даже если cookie не было.

import { applyCors, sendJson, sendError, clearRoleCookie } from '../_lib/auth.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    clearRoleCookie(res);
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
