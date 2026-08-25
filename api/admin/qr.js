// GET /api/admin/qr?partnerId=helloapple[&size=600]
// QR-код точки партнёра для печати: тейбл-тенты, роллапы, наклейки на кассу.
//
// Ссылка ведёт на лендинг с меткой партнёра — именно по ней считается вся его
// атрибуция, поэтому генерировать её вручную нельзя: опечатка в slug превратит
// трафик партнёра в анонимный.

import QRCode from 'qrcode';
import { applyCors, sendJson, sendError, requireRole, ROLES } from '../_lib/auth.js';
import { PARTNERS, ROUTE_PARTNER_IDS } from '../_lib/prizes.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const session = requireRole(req, [ROLES.MANAGER, ROLES.MARKETING, ROLES.PARTNER]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const requested = url.searchParams.get('partnerId');
    // Партнёр может получить только свой код — чужой QR ему ни к чему.
    const partnerId = session.role === ROLES.PARTNER ? session.partnerId : requested;

    if (!partnerId || !ROUTE_PARTNER_IDS.includes(partnerId)) {
      return sendJson(res, 400, { error: 'UNKNOWN_PARTNER', message: 'неизвестный партнёр' });
    }

    const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 600, 200), 1200);
    const origin = process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;
    const link = `${origin}/?p=${partnerId}`;

    const dataUrl = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'H', // печать может быть с заломами и бликами — берём максимальную коррекцию
      margin: 2,
      width: size,
      color: { dark: '#0c0909', light: '#ffffff' },
    });

    return sendJson(res, 200, {
      partnerId,
      name: PARTNERS[partnerId].name,
      card: PARTNERS[partnerId].card,
      color: PARTNERS[partnerId].color,
      link,
      qrDataUrl: dataUrl,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
