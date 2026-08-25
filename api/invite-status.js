// GET /api/invite-status?code=ПР-ХХХХ-ХХХ
// Страница приглашения опрашивает этот эндпоинт, пока сотрудник клуба не подтвердит визит.
// После подтверждения возвращает sessionId — и гость сразу переходит к раздаче,
// без повторного сканирования QR.
//
// Доступ: код приглашения + X-Device-Token того устройства, где шла регистрация.

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError } from './_lib/auth.js';
import { normalizeCode, CODE_KIND } from './_lib/codes.js';
import { hashToken } from './_lib/device.js';
import { getGuest, publicRoute } from './_lib/guests.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = normalizeCode(url.searchParams.get('code'), CODE_KIND.INVITE);
    if (!code) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'нужен код приглашения' });

    const invite = await kv.get(KEY.invite(code));
    if (!invite) return sendJson(res, 404, { error: 'INVITE_NOT_FOUND' });

    // Статус видит только устройство, на котором гость регистрировался.
    if (invite.deviceHash) {
      const presented = req.headers['x-device-token'];
      if (!presented || hashToken(String(presented)) !== invite.deviceHash) {
        return sendJson(res, 403, { error: 'DEVICE_MISMATCH', message: 'приглашение открыто на другом устройстве' });
      }
    }

    const guest = await getGuest(invite.phone);

    return sendJson(res, 200, {
      status: invite.usedAt ? 'activated' : 'pending',
      sessionId: invite.sessionId || null,
      partnerId: invite.partnerId,
      expiresAt: new Date(invite.expiresAt).toISOString(),
      route: guest ? publicRoute(guest) : null,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
