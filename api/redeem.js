// POST /api/redeem
// Погашение кода ВЛ-ХХХХ-ХХХ. Один код содержит две независимые позиции:
//   what: 'prize' — приз по комбинации, гасит сотрудник клуба;
//   what: 'cert'  — сертификат партнёра, гасит сам партнёр в своём кабинете.
//
// Раздельное погашение — не усложнение ради усложнения: партнёру нужно
// подтверждение, что его скидка реально дошла до кассы, а клубу — что приз выдан.
//
// GET /api/redeem?code=... — предпросмотр без погашения (что именно предстоит выдать).

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody, requireRole, readRole, ROLES } from './_lib/auth.js';
import { adminLimiter, clientIp } from './_lib/ratelimit.js';
import { normalizeCode, CODE_KIND } from './_lib/codes.js';
import { PRIZES, PARTNERS, publicPrize, isTaxable, taxAmount } from './_lib/prizes.js';
import { recordRedeem } from './_lib/audit.js';
import { publicHand } from './_lib/cards.js';

const TODAY = () => new Date().toISOString().slice(0, 10);
const STAFF_ROLES = [ROLES.STAFF, ROLES.MANAGER, ROLES.MARKETING];

/** Что показать по коду — общий вид для предпросмотра и для ответа после погашения. */
function describe(record) {
  const prize = record.prizeId ? PRIZES[record.prizeId] : null;
  return {
    code: record.code,
    combo: record.combo,
    comboName: record.comboName,
    cards: publicHand(record.cards || []),
    tier: record.tier,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    guest: record.guest,
    entryType: record.entryType,
    sourcePartner: record.sourcePartnerId
      ? { id: record.sourcePartnerId, name: PARTNERS[record.sourcePartnerId]?.name }
      : null,
    prize: record.prizeId ? {
      ...publicPrize(record.prizeId),
      redeemed: !!record.prizeRedeemed,
      redeemedAt: record.prizeRedeemedAt ? new Date(record.prizeRedeemedAt).toISOString() : null,
      redeemedBy: record.prizeRedeemedBy,
      requiresPassport: !!prize?.requiresPassport,
      tax: isTaxable(record.prizeId)
        ? { amount: taxAmount(record.prizeId), note: 'НДФЛ 35 % с суммы свыше 4 000 ₽. Нужны паспорт и ИНН.' }
        : null,
    } : null,
    cert: record.certPrizeId ? {
      ...publicPrize(record.certPrizeId),
      partnerId: PRIZES[record.certPrizeId]?.provider,
      redeemed: !!record.certRedeemed,
      redeemedAt: record.certRedeemedAt ? new Date(record.certRedeemedAt).toISOString() : null,
      redeemedBy: record.certRedeemedBy,
    } : null,
  };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    // ── Предпросмотр ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const session = readRole(req);
      if (!session) return sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'нужен вход на /admin/' });

      const url = new URL(req.url, `http://${req.headers.host}`);
      const code = normalizeCode(url.searchParams.get('code'), CODE_KIND.PRIZE);
      if (!code) return sendJson(res, 400, { error: 'BAD_CODE', message: 'код вида ВЛ-ХХХХ-ХХХ' });

      const record = await kv.get(KEY.code(code));
      if (!record) return sendJson(res, 404, { error: 'CODE_NOT_FOUND', message: 'код не найден или истёк' });

      const view = describe(record);
      // Партнёр видит только свою позицию — чужие призы его не касаются.
      if (session.role === ROLES.PARTNER) {
        const certProvider = PRIZES[record.certPrizeId]?.provider;
        if (certProvider !== session.partnerId) {
          return sendJson(res, 403, { error: 'NOT_YOUR_CERT', message: 'этот сертификат выдан не в ваш магазин' });
        }
        return sendJson(res, 200, { code: view.code, guest: view.guest, cert: view.cert, expiresAt: view.expiresAt });
      }
      return sendJson(res, 200, view);
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

    // ── Погашение ───────────────────────────────────────────────────────────
    const session = requireRole(req, [...STAFF_ROLES, ROLES.PARTNER]);

    const { success } = await adminLimiter().limit(`redeem:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);
    const code = normalizeCode(body.code, CODE_KIND.PRIZE);
    if (!code) return sendJson(res, 400, { error: 'BAD_CODE', message: 'код вида ВЛ-ХХХХ-ХХХ' });

    const what = body.what === 'cert' ? 'cert' : 'prize';
    const record = await kv.get(KEY.code(code));
    if (!record) return sendJson(res, 404, { error: 'CODE_NOT_FOUND', message: 'код не найден или истёк' });
    if (record.expiresAt < Date.now()) return sendJson(res, 410, { error: 'CODE_EXPIRED' });

    const who = String(session.name || session.partnerId || 'unknown').slice(0, 80);
    const now = Date.now();
    const date = TODAY();

    if (what === 'cert') {
      const certProvider = PRIZES[record.certPrizeId]?.provider;
      // Партнёр гасит только свои сертификаты; персонал клуба — любые (в т.ч. свой cert_optimist).
      if (session.role === ROLES.PARTNER && certProvider !== session.partnerId) {
        return sendJson(res, 403, { error: 'NOT_YOUR_CERT', message: 'этот сертификат выдан не в ваш магазин' });
      }
      if (record.certRedeemed) {
        return sendJson(res, 409, {
          error: 'ALREADY_REDEEMED',
          message: `сертификат уже погашен ${new Date(record.certRedeemedAt).toLocaleString('ru-RU')} (${record.certRedeemedBy})`,
        });
      }
      record.certRedeemed = true;
      record.certRedeemedAt = now;
      record.certRedeemedBy = who;
      await kv.set(KEY.code(code), record, { ex: Math.max(60, Math.floor((record.expiresAt - now) / 1000)) });

      try {
        await kv.hincrby(KEY.redeemedDay(date), record.certPrizeId, 1);
        if (certProvider && PARTNERS[certProvider]) {
          await kv.hincrby(KEY.partnerDay(date, certProvider), 'certsRedeemed', 1);
        }
      } catch (e) { console.warn('redeem cert stats failed', e.message); }

      return sendJson(res, 200, { ok: true, what, ...describe(record) });
    }

    // what === 'prize'
    if (session.role === ROLES.PARTNER) {
      return sendJson(res, 403, { error: 'FORBIDDEN', message: 'призы выдаёт клуб' });
    }
    if (!record.prizeId) {
      return sendJson(res, 422, { error: 'NO_PRIZE', message: 'по этой руке приза нет — только сертификат партнёра' });
    }
    if (record.prizeRedeemed) {
      return sendJson(res, 409, {
        error: 'ALREADY_REDEEMED',
        message: `приз уже выдан ${new Date(record.prizeRedeemedAt).toLocaleString('ru-RU')} (${record.prizeRedeemedBy})`,
      });
    }

    record.prizeRedeemed = true;
    record.prizeRedeemedAt = now;
    record.prizeRedeemedBy = who;
    await kv.set(KEY.code(code), record, { ex: Math.max(60, Math.floor((record.expiresAt - now) / 1000)) });

    try {
      await kv.hincrby(KEY.redeemedDay(date), record.prizeId, 1);
      await kv.hincrby(KEY.daily(date), 'prizesRedeemed', 1);
      await recordRedeem(record, who);
    } catch (e) { console.warn('redeem stats failed', e.message); }

    return sendJson(res, 200, { ok: true, what, ...describe(record) });
  } catch (err) {
    return sendError(res, err);
  }
}
