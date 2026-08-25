// GET /api/admin/me
// Возвращает текущую роль и имя по cookie. 401 — если не залогинен.

import { applyCors, sendJson, sendError, readRole } from '../_lib/auth.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const session = readRole(req);
    if (!session) {
      return sendJson(res, 401, { error: 'UNAUTHORIZED' });
    }
    return sendJson(res, 200, {
      role: session.role,
      name: session.name,
      partnerId: session.partnerId || null,
      expiresAt: new Date(session.exp * 1000).toISOString(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
