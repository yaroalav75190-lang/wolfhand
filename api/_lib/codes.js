// Одноразовые коды: приз (ВЛ-ХХХХ-ХХХ) и пригласительный от партнёра (ПР-ХХХХ-ХХХ).
//
// Только кириллица и цифры — код диктуют голосом и вводят вручную на стойке.
// Исключены визуально неоднозначные символы: О(0), З(3), Й(≈И), Ё(=Е), Ъ, Ь, Ы, цифра 0.
// Алфавит 33 символа → 33^7 ≈ 42 млрд комбинаций на префикс.

import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';

const ALPHABET = 'АБВГДЕЖИКЛМНПРСТУФХЦШЭЮЯ123456789';
const ALPHABET_SET = new Set(ALPHABET.split(''));

export const CODE_KIND = {
  PRIZE:  'ВЛ', // «Волк» — код выигрыша, гость показывает сотруднику клуба
  INVITE: 'ПР', // «Приглашение» — выдаётся на точке партнёра, погашается на входе в клуб
};

const CHAR_CLASS = `[${ALPHABET}]`;

function part(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

/** Сгенерировать код указанного типа. */
export function generateCode(prefix = CODE_KIND.PRIZE) {
  return `${prefix}-${part(4)}-${part(3)}`;
}

/**
 * Канонизировать введённый код. Возвращает код в верхнем регистре либо null,
 * если формат неверен (в т.ч. если ввели латиницей или цифру 0).
 * @param {string} code
 * @param {string|null} prefix ожидаемый тип; null — любой известный
 */
export function normalizeCode(code, prefix = null) {
  if (typeof code !== 'string') return null;
  const s = code.trim().toUpperCase();
  const prefixes = prefix ? [prefix] : Object.values(CODE_KIND);
  const matched = prefixes.find((p) => new RegExp(`^${p}-${CHAR_CLASS}{4}-${CHAR_CLASS}{3}$`).test(s));
  if (!matched) return null;
  for (const ch of s.slice(matched.length + 1).replace(/-/g, '')) {
    if (!ALPHABET_SET.has(ch)) return null;
  }
  return s;
}

/** Тип кода по префиксу: 'PRIZE' | 'INVITE' | null. */
export function codeKind(code) {
  const s = String(code || '').trim().toUpperCase();
  const entry = Object.entries(CODE_KIND).find(([, p]) => s.startsWith(`${p}-`));
  return entry ? entry[0] : null;
}

export const CODE_ALPHABET = ALPHABET;

/** QR-картинка (data:image/png) для показа сотруднику. Best-effort: при ошибке — null. */
export async function codeQrDataUrl(text, { width = 240 } = {}) {
  if (!text || typeof text !== 'string') return null;
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width,
      color: { dark: '#0c0909', light: '#ffffff' },
    });
  } catch {
    return null;
  }
}
