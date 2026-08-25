// GET /api/admin/leads?partnerId=&limit=&offset=&format=json|csv
// База участников акции.
//
// Разграничение доступа здесь — не про удобство, а про 152-ФЗ:
//   • маркетолог/управляющий видят всех участников (клуб — оператор ПДн);
//   • партнёр видит ТОЛЬКО тех, кто пришёл через его точку или получил его сертификат,
//     и ТОЛЬКО тех, кто отдельно согласился на передачу контакта партнёрам.
// Гость без consentPartners участвует в акции наравне со всеми, но в партнёрскую
// выгрузку не попадает никогда.

import { kv, PREFIX } from '../_lib/kv.js';
import { applyCors, sendJson, sendError, requireRole, ROLES } from '../_lib/auth.js';
import { PARTNERS } from '../_lib/prizes.js';
import { routeState } from '../_lib/guests.js';

function toCsv(rows) {
  const head = ['Имя', 'Телефон', 'Источник', 'Карт маршрута', 'Визитов', 'Раздач', 'Согласие на рассылку', 'Дата регистрации'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const r of rows) {
    lines.push([
      r.name, r.phone, r.sourcePartnerName || 'Клуб', r.routeCount, r.visits, r.deals,
      r.consentMarketing ? 'да' : 'нет', r.createdAt,
    ].map(esc).join(';'));
  }
  // BOM — иначе Excel открывает кириллицу кракозябрами.
  return '﻿' + lines.join('\r\n');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const session = requireRole(req, [ROLES.MANAGER, ROLES.MARKETING, ROLES.PARTNER]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 2000);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';

    const isPartner = session.role === ROLES.PARTNER;
    const partnerFilter = isPartner ? session.partnerId : (url.searchParams.get('partnerId') || null);

    const raw = await kv.listValues(PREFIX.guest, limit + offset + 500, 0);
    let guests = raw.map((r) => r.value).filter(Boolean);

    if (partnerFilter) {
      guests = guests.filter((g) => {
        const collected = (g.route || []).map((c) => c.partnerId);
        return g.sourcePartnerId === partnerFilter || collected.includes(partnerFilter);
      });
    }
    if (isPartner) {
      // Без явного согласия контакт партнёру не передаём — даже если он «его» лид.
      guests = guests.filter((g) => g.consent?.consentPartners === true);
    }

    guests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const total = guests.length;
    const page = guests.slice(offset, offset + limit);

    const rows = page.map((g) => {
      const state = routeState(g);
      return {
        name: g.name || '',
        phone: g.phone,
        sourcePartnerId: g.sourcePartnerId || null,
        sourcePartnerName: g.sourcePartnerId ? PARTNERS[g.sourcePartnerId]?.name : null,
        routeCount: state.collected.length,
        routeComplete: state.complete,
        visits: g.visits || 0,
        deals: g.deals || 0,
        consentMarketing: g.consent?.consentMarketing === true,
        consentPartners: g.consent?.consentPartners === true,
        createdAt: g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '',
        lastDealAt: g.lastDealAt ? new Date(g.lastDealAt).toISOString().slice(0, 10) : null,
      };
    });

    if (format === 'csv') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${partnerFilter || 'all'}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.end(toCsv(rows));
    }

    return sendJson(res, 200, {
      total,
      limit,
      offset,
      scope: isPartner ? 'partner' : 'all',
      partnerId: partnerFilter,
      // Маркетологу полезно видеть, сколько контактов «заперто» отсутствием согласия
      withoutPartnerConsent: isPartner ? null : guests.filter((g) => g.consent?.consentPartners !== true).length,
      leads: rows,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
