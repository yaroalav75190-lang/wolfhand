// GET  /api/admin/fulfillment            — очередь призов, которые нельзя отдать со стойки
// POST /api/admin/fulfillment {code, prizeId, done} — отметить выполненным
//
// Сюда попадают только призы с deferredFulfillment: техника и крупные сертификаты
// партнёров. Мелочь (фишки, комплимент бара, кепка) выдаётся сразу по коду и в очереди
// не участвует — иначе она превратится в свалку и её перестанут открывать.

import { kv, KEY, PREFIX } from '../_lib/kv.js';
import { applyCors, sendJson, sendError, readBody, requireRole, ROLES } from '../_lib/auth.js';
import { PRIZES, taxAmount } from '../_lib/prizes.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    const session = requireRole(req, [ROLES.MANAGER, ROLES.MARKETING]);

    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const showDone = url.searchParams.get('done') === '1';

      const rows = (await kv.listValues(PREFIX.fulfill, 2000, 0)).map((r) => r.value).filter(Boolean);
      const items = rows
        .filter((r) => (showDone ? r.done : !r.done))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((r) => ({
          ...r,
          prizeRetail: PRIZES[r.prizeId]?.retail || 0,
          requiresPassport: !!PRIZES[r.prizeId]?.requiresPassport,
          taxAmount: taxAmount(r.prizeId),
          createdAt: new Date(r.createdAt).toISOString(),
          doneAt: r.doneAt ? new Date(r.doneAt).toISOString() : null,
        }));

      return sendJson(res, 200, {
        pending: rows.filter((r) => !r.done).length,
        done: rows.filter((r) => r.done).length,
        items,
      });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    const prizeId = String(body.prizeId || '').trim();
    if (!code || !prizeId) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'нужны code и prizeId' });

    const key = KEY.fulfill(code, prizeId);
    const item = await kv.get(key);
    if (!item) return sendJson(res, 404, { error: 'NOT_FOUND' });

    item.done = body.done !== false;
    item.doneAt = item.done ? Date.now() : null;
    item.doneBy = item.done ? String(session.name || 'unknown').slice(0, 80) : null;
    item.note = String(body.note || '').slice(0, 500) || item.note || '';
    await kv.set(key, item);

    return sendJson(res, 200, { ok: true, item });
  } catch (err) {
    return sendError(res, err);
  }
}
