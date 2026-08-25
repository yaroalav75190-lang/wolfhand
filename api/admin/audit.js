// GET /api/admin/audit?from=&to=&limit=&offset=
// Журнал всех выданных рук: что выпало, кому, кто выдал, погашено ли.
// По нему сверяется призовой фонд с партнёрами — поэтому записи живут дольше кодов.

import { applyCors, sendJson, sendError, requireRole, ROLES } from '../_lib/auth.js';
import { listAudit } from '../_lib/audit.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    requireRole(req, [ROLES.MANAGER, ROLES.MARKETING]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const entries = await listAudit({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      limit: Number(url.searchParams.get('limit')) || 500,
      offset: Number(url.searchParams.get('offset')) || 0,
    });

    return sendJson(res, 200, {
      total: entries.length,
      entries: entries.map((e) => ({
        ...e,
        createdAt: new Date(e.createdAt).toISOString(),
        redeemedAt: e.redeemedAt ? new Date(e.redeemedAt).toISOString() : null,
      })),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
