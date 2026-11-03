// Pure CSV parsing, dedupe and export logic. No DOM; runs in the browser and in Node.

const UNIT = '(?:RM|MYR)';
const AMOUNT_RE = new RegExp(`^${UNIT}?(\\d{1,3}(?:,\\d{3})+|\\d*)(?:\\.(\\d{0,2}))?${UNIT}?$`, 'i');
// Used to re-join an unquoted amount that the comma split broke apart ("RM 1" + "234.50").
const AMOUNT_HEAD_RE = new RegExp(`^\\s*${UNIT}?\\s*\\d{1,3}(?:,\\s*\\d{3})*\\s*$`, 'i');
const AMOUNT_TAIL_RE = new RegExp(`^\\s*\\d{3}(?:\\.\\d*)?\\s*${UNIT}?\\s*$`, 'i');

/** Parses an amount string to integer sen. Returns null unless it is a valid amount > 0. */
export function parseAmount(text) {
  const match = AMOUNT_RE.exec(String(text).replace(/\s/g, ''));
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (!whole && !fraction) return null;
  const cents = Number(whole.replaceAll(',', '') || 0) * 100 + Number(fraction.padEnd(2, '0'));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

/** Validates "yyyy-MM-dd HH:mm" and returns it normalised, or null. Never goes through a timezone. */
export function parseDate(text) {
  const normalised = text.trim().replace(/\s+/g, ' ');
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(normalised);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const realDay = date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return realDay && h < 24 && mi < 60 ? normalised : null;
}

// Reads a quoted field whose content starts at `start`. Returns null if it is not well formed,
// in which case the caller treats the quote as a literal character, so a stray quote in a
// merchant name only affects its own line.
function readQuoted(line, start) {
  let text = '';
  for (let i = start; i < line.length; i++) {
    if (line[i] !== '"') { text += line[i]; continue; }
    if (line[i + 1] === '"') { text += '"'; i++; continue; }
    const rest = /^\s*(,|$)/.exec(line.slice(i + 1));
    return rest ? { text, end: i + 1 + rest[0].length - rest[1].length } : null;
  }
  return null;
}

/** Splits one physical line into fields: [{ text, quoted }]. */
export function splitLine(line) {
  const fields = [];
  let i = 0;
  for (;;) {
    const opening = /^\s*"/.exec(line.slice(i));
    const quoted = opening && readQuoted(line, i + opening[0].length);
    if (quoted) {
      fields.push({ text: quoted.text, quoted: true });
      i = quoted.end;
    } else {
      const comma = line.indexOf(',', i);
      const end = comma === -1 ? line.length : comma;
      fields.push({ text: line.slice(i, end), quoted: false });
      i = end;
    }
    if (i >= line.length) return fields;
    i++; // skip the comma
  }
}

/**
 * Parses "yyyy-MM-dd HH:mm,amount,merchant,card".
 * Returns { date, cents, merchant, card } or { error } with a user-facing message.
 */
export function parseLine(raw) {
  const fields = splitLine(raw);
  if (fields.length < 4) return { error: '字段不足' };

  const date = parseDate(fields[0].text);
  if (!date) return { error: '日期格式无效' };

  // A thousands comma in an unquoted amount looks like a field separator. Merge while the next
  // field is a 3-digit group and a merchant and a card would still remain.
  let amount = fields[1].text;
  let next = 2;
  while (
    !fields[1].quoted && fields.length - next >= 3 && !fields[next].quoted
    && AMOUNT_HEAD_RE.test(amount) && AMOUNT_TAIL_RE.test(fields[next].text)
  ) {
    amount += `,${fields[next++].text}`;
  }
  const cents = parseAmount(amount);
  if (cents === null) return { error: '金额无效' };

  const merchant = fields.slice(next, -1).map((f) => f.text).join(',').trim();
  return { date, cents, merchant, card: fields.at(-1).text.trim() };
}

/** Dedupe key: SHA-256 of the raw line plus how many times it has occurred so far in the file. */
export async function dedupeKey(raw, occurrence) {
  const bytes = new TextEncoder().encode(`${raw}\u0000${occurrence}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Works out what importing `text` would do given the Set of already imported keys.
 * Returns { rows: [{ key, entry }], skipped, failed: [{ line, raw, error }] }; does not mutate `seen`.
 * Physical lines are records: the Shortcut only ever appends single lines.
 */
export async function planImport(text, seen) {
  const plan = { rows: [], skipped: 0, failed: [] };
  const counts = new Map();
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let isFirst = true;

  for (const [index, line] of lines.entries()) {
    const raw = line.trim();
    if (!raw) continue;
    const parsed = parseLine(raw);
    const isHeader = isFirst && parsed.error && /日期|date/i.test(splitLine(raw)[0].text);
    isFirst = false;
    if (isHeader) continue;

    const occurrence = (counts.get(raw) ?? 0) + 1;
    counts.set(raw, occurrence);
    if (parsed.error) {
      plan.failed.push({ line: index + 1, raw, error: parsed.error });
      continue;
    }
    const key = await dedupeKey(raw, occurrence);
    if (seen.has(key)) plan.skipped++;
    else plan.rows.push({ key, entry: parsed });
  }
  return plan;
}

function csvCell(value, isText = true) {
  let text = String(value);
  // Merchant names come from outside the app: stop spreadsheets running them as formulas.
  if (isText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialises entries, oldest first, as CSV with a UTF-8 BOM. */
export function toCSV(entries) {
  const rows = [...entries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => [
      e.date,
      (e.cents / 100).toFixed(2),
      csvCell(e.merchant),
      csvCell(e.card),
    ].join(','));
  return `﻿${['日期时间,金额(RM),商户,卡', ...rows].join('\r\n')}\r\n`;
}
