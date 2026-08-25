// Постоянный журнал выдач и погашений. Живёт дольше кодов (у тех TTL 14 дней),
// потому что именно по нему сверяется призовой фонд с партнёрами и считается ROI.
//
// Ключ audit:<createdAt-13-знаков>:<code> — zero-pad делает лексикографический
// порядок хронологическим, поэтому listValues отдаёт записи по времени.

import { kv, KEY, PREFIX } from './kv.js';
import { PRIZES, PARTNERS } from './prizes.js';

/** Записать факт выдачи кода (момент завершения раздачи). */
export async function recordIssue(codeRecord) {
  if (!codeRecord?.code) return;
  const entry = {
    v: 1,
    code: codeRecord.code,
    createdAt: codeRecord.createdAt,
    combo: codeRecord.combo,
    comboName: codeRecord.comboName,
    prizeId: codeRecord.prizeId || null,
    prizeName: codeRecord.prizeId ? PRIZES[codeRecord.prizeId]?.name : null,
    certPrizeId: codeRecord.certPrizeId || null,
    certName: codeRecord.certPrizeId ? PRIZES[codeRecord.certPrizeId]?.name : null,
    sourcePartnerId: codeRecord.sourcePartnerId || null,
    sourcePartnerName: codeRecord.sourcePartnerId ? PARTNERS[codeRecord.sourcePartnerId]?.name : null,
    entryType: codeRecord.entryType || null, // 'partner' | 'club'
    tier: codeRecord.tier || 'base',
    guestPhone: codeRecord.guest?.phone || null,
    guestName: codeRecord.guest?.name || null,
    staffId: codeRecord.staffId || null,
    redeemed: false,
    redeemedAt: null,
    redeemedBy: null,
  };
  await kv.set(KEY.audit(entry.createdAt, entry.code), entry); // без TTL
}

/** Отметить погашение в журнале. */
export async function recordRedeem(codeRecord, staffName) {
  if (!codeRecord?.code || !codeRecord.createdAt) return;
  const key = KEY.audit(codeRecord.createdAt, codeRecord.code);
  const entry = await kv.get(key);
  if (!entry) return;
  entry.redeemed = true;
  entry.redeemedAt = Date.now();
  entry.redeemedBy = String(staffName || '').slice(0, 80);
  await kv.set(key, entry);
}

/**
 * Прочитать журнал за период.
 * @param {object} opts
 * @param {string} opts.from дата YYYY-MM-DD включительно
 * @param {string} opts.to   дата YYYY-MM-DD включительно
 */
export async function listAudit({ from = null, to = null, limit = 500, offset = 0 } = {}) {
  const rows = await kv.listValues(PREFIX.audit, Math.min(Number(limit) || 500, 5000), Number(offset) || 0);
  const fromTs = from ? Date.parse(`${from}T00:00:00`) : null;
  const toTs = to ? Date.parse(`${to}T23:59:59.999`) : null;
  return rows
    .map((r) => r.value)
    .filter((e) => {
      if (!e?.createdAt) return false;
      if (fromTs && e.createdAt < fromTs) return false;
      if (toTs && e.createdAt > toTs) return false;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
