// POST /api/session
// Клубный контур: гость сделал заказ на кухню от MIN_CHECK_KITCHEN ₽ и получает право
// на раздачу. Сотрудник вводит сумму чека — система отдаёт QR-коды (по одному на каждые
// полные MIN_CHECK_KITCHEN ₽) для показа гостю.
//
// Доступ: роли staff / manager / marketing.

import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody, requireRole, ROLES } from './_lib/auth.js';
import { staffLimiter, clientIp } from './_lib/ratelimit.js';
import { CONFIG, computeQRCount } from './_lib/prizes.js';

const MAX_CHECK_VALUE = 1_000_000;
const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const staff = requireRole(req, [ROLES.STAFF, ROLES.MANAGER, ROLES.MARKETING]);

    const { success } = await staffLimiter().limit(`session:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);
    const check = Number(body.check);
    if (!Number.isFinite(check) || check < 0 || check > MAX_CHECK_VALUE) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'сумма чека — число от 0 до 1 000 000' });
    }
    const tableNo = String(body.tableNo || '').slice(0, 20);

    const qrCount = computeQRCount(check);
    if (qrCount === 0) {
      return sendJson(res, 422, {
        error: 'CHECK_TOO_LOW',
        message: `нужен чек на кухню от ${CONFIG.MIN_CHECK_KITCHEN} ₽ (сейчас ${Math.round(check)} ₽)`,
        min: CONFIG.MIN_CHECK_KITCHEN,
      });
    }

    const now = Date.now();
    const ttlSec = CONFIG.SESSION_TTL_HOURS * 3600;
    const batchId = randomBytes(12).toString('base64url');
    const staffId = String(staff.name || 'unknown').slice(0, 80);
    const publicOrigin = process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;

    await kv.set(KEY.batch(batchId), {
      v: 1, batchId, createdAt: now, staffId, check, tableNo, qrCount,
    }, { ex: ttlSec });

    const qrs = [];
    for (let i = 1; i <= qrCount; i++) {
      const sessionId = randomBytes(18).toString('base64url');
      const session = {
        v: 1,
        id: sessionId,
        createdAt: now,
        staffId,
        entryType: 'club',
        sourcePartnerId: null,
        batchId,
        tableNo,
        check,
        qrIndex: i,
        qrTotal: qrCount,
        phone: null,        // появится после регистрации гостя
        guestName: '',
        registered: false,  // клубный гость регистрируется сам, на своём телефоне
        device: null,
        tier: 'base',       // уточнится по маршруту гостя в момент регистрации
        wolfHand: false,
        dealsUsed: 0,
        maxDeals: CONFIG.DEALS_PER_QR,
        finalized: false,
        code: null,
      };
      await kv.set(KEY.session(sessionId), session, { ex: ttlSec });

      const url = `${publicOrigin}/?s=${sessionId}`;
      qrs.push({
        sessionId,
        url,
        qrDataUrl: await QRCode.toDataURL(url, {
          errorCorrectionLevel: 'M', margin: 1, width: 360,
          color: { dark: '#0c0909', light: '#ffffff' },
        }),
        qrIndex: i,
        qrTotal: qrCount,
      });
    }

    try {
      const date = TODAY();
      await kv.hincrby(KEY.daily(date), 'checks', 1);
      await kv.hincrby(KEY.daily(date), 'qrIssued', qrCount);
      await kv.hincrby(KEY.daily(date), 'checkSum', Math.round(check));
    } catch (e) {
      console.warn('session stats failed', e.message);
    }

    return sendJson(res, 201, {
      batchId, check, tableNo, qrCount, qrs,
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
