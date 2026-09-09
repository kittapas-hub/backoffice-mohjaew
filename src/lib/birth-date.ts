const THAI_DIGITS: Record<string, string> = {
  "๐": "0", "๑": "1", "๒": "2", "๓": "3", "๔": "4",
  "๕": "5", "๖": "6", "๗": "7", "๘": "8", "๙": "9",
};

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
] as const;

const THAI_WEEKDAYS = [
  "อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์",
] as const;

const MONTH_ALIASES: Record<string, number> = {
  "มค": 1, "ม.ค": 1, "มกราคม": 1,
  "กพ": 2, "ก.พ": 2, "กุมภาพันธ์": 2,
  "มีค": 3, "มี.ค": 3, "มีนาคม": 3,
  "เมย": 4, "เม.ย": 4, "เมษายน": 4,
  "พค": 5, "พ.ค": 5, "พฤษภาคม": 5,
  "มิย": 6, "มิ.ย": 6, "มิถุนายน": 6,
  "กค": 7, "ก.ค": 7, "กรกฎาคม": 7,
  "สค": 8, "ส.ค": 8, "สิงหาคม": 8,
  "กย": 9, "ก.ย": 9, "กันยายน": 9,
  "ตค": 10, "ต.ค": 10, "ตุลาคม": 10,
  "พย": 11, "พ.ย": 11, "พฤศจิกายน": 11,
  "ธค": 12, "ธ.ค": 12, "ธันวาคม": 12,
};

export type ParsedBirthDate = {
  day: number;
  month: number;
  buddhistYear: number;
  gregorianYear: number;
  iso: string;
  input: string;
  display: string;
};

function normalizeDigits(value: string): string {
  return value.replace(/[๐-๙]/g, (digit) => THAI_DIGITS[digit] ?? digit);
}

function resolveYear(rawYear: number): { buddhistYear: number; gregorianYear: number } | null {
  if (!Number.isInteger(rawYear) || rawYear < 0) return null;
  const buddhistYear = rawYear < 100 ? 2500 + rawYear : rawYear >= 2400 ? rawYear : rawYear + 543;
  const gregorianYear = buddhistYear - 543;
  if (gregorianYear < 1900 || gregorianYear > 2200) return null;
  return { buddhistYear, gregorianYear };
}

function buildParsed(day: number, month: number, rawYear: number): ParsedBirthDate | null {
  const resolved = resolveYear(rawYear);
  if (!resolved || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(resolved.gregorianYear, month - 1, day));
  if (date.getUTCFullYear() !== resolved.gregorianYear || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getTime() > Date.now()) return null;

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const iso = `${resolved.gregorianYear}-${mm}-${dd}`;
  const input = `${dd}/${mm}/${resolved.buddhistYear}`;
  const display = `วัน${THAI_WEEKDAYS[date.getUTCDay()]}ที่ ${day} ${THAI_MONTHS[month - 1]} ${resolved.buddhistYear}`;
  return { day, month, ...resolved, iso, input, display };
}

export function parseBirthDateInput(raw: string): ParsedBirthDate | null {
  const value = normalizeDigits(raw).trim().replace(/\s+/g, " ");
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildParsed(Number(iso[3]), Number(iso[2]), Number(iso[1]));

  const numeric = value.match(/^(\d{1,2})\s*[\/-]\s*(\d{1,2})\s*[\/-]\s*(\d{2,4})$/);
  if (numeric) return buildParsed(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));

  const thaiText = value.match(/^(\d{1,2})\s+([^\d\s]+)\s+(\d{2,4})$/);
  if (thaiText) {
    const rawMonth = thaiText[2];
    const key = rawMonth.replace(/\.$/, "");
    const month = MONTH_ALIASES[key] ?? MONTH_ALIASES[rawMonth];
    if (month) return buildParsed(Number(thaiText[1]), month, Number(thaiText[3]));
  }

  return null;
}

export function normalizeBirthDateText(raw: string): string {
  return parseBirthDateInput(raw)?.display ?? raw.trim();
}

export function calendarIsoToBirthDateInput(iso: string): string {
  return parseBirthDateInput(iso)?.input ?? "";
}
