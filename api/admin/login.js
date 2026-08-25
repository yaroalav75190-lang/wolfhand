// POST /api/admin/login
// Вход в служебный контур. Четыре сценария:
//   staff     — по имени и фамилии, без пароля (стойка клуба, смена меняется часто);
//   manager   — пароль MANAGER_PASSWORD;
//   marketing — пароль MARKETING_PASSWORD;
//   partner   — партнёр цепочки, пароль PARTNER_PASSWORD_<ID>.
//
// Отсутствие пароля у роли staff — сознательное решение: на стойке пароль всё равно
// становится общим и записывается на бумажке. Реальные ограничения роли staff —
// она не видит ни сводной статистики, ни лидов, ни чужих сертификатов.

import {
  applyCors, sendJson, sendError, readBody,
  setRoleCookie, checkRolePassword, checkPartnerPassword, ROLES,
} from '../_lib/auth.js';
import { adminLimiter, clientIp } from '../_lib/ratelimit.js';
import { PARTNERS } from '../_lib/prizes.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const { success } = await adminLimiter().limit(`login:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);
    const role = String(body.role || '').trim();

    if (role === ROLES.STAFF) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (name.length < 3) {
        return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'укажите имя и фамилию' });
      }
      setRoleCookie(res, ROLES.STAFF, name);
      return sendJson(res, 200, { ok: true, role: ROLES.STAFF, name });
    }

    if (role === ROLES.MANAGER || role === ROLES.MARKETING) {
      if (!checkRolePassword(role, body.password)) {
        return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'неверный пароль' });
      }
      const name = String(body.name || (role === ROLES.MANAGER ? 'Управляющий' : 'Маркетолог')).slice(0, 80);
      setRoleCookie(res, role, name);
      return sendJson(res, 200, { ok: true, role, name });
    }

    if (role === ROLES.PARTNER) {
      const partnerId = String(body.partnerId || '').trim();
      if (!PARTNERS[partnerId]) {
        return sendJson(res, 400, { error: 'UNKNOWN_PARTNER', message: 'выберите партнёра' });
      }
      if (!checkPartnerPassword(partnerId, body.password)) {
        return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'неверный пароль' });
      }
      const name = PARTNERS[partnerId].name;
      setRoleCookie(res, ROLES.PARTNER, name, partnerId);
      return sendJson(res, 200, { ok: true, role: ROLES.PARTNER, name, partnerId });
    }

    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'неизвестная роль' });
  } catch (err) {
    return sendError(res, err);
  }
}
