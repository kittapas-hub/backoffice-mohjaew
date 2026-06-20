// Conservative parsing of the labeled Thai booking form. The LINE OA Manager
// already sends the form template; customers reply with labeled lines, possibly
// split across several messages. We only set a field when a known label is
// matched with a non-empty value — never guess from unlabeled text.

export type CollectedFields = {
  nickname?: string;
  birthDateText?: string;
  consultationTopic?: string;
  phone?: string;
  preferredTime?: string;
};

export const REQUIRED_FIELDS: (keyof CollectedFields)[] = [
  "nickname",
  "birthDateText",
  "consultationTopic",
  "phone",
  "preferredTime",
];

// Label synonyms, longest/most-specific first within each group.
const LABELS: { key: keyof CollectedFields; patterns: string[] }[] = [
  { key: "nickname", patterns: ["ชื่อเล่น"] },
  {
    key: "birthDateText",
    patterns: ["วัน/เดือน/ปีเกิด", "วันเดือนปีเกิด", "วันเกิด", "ว/ด/ป", "เกิด"],
  },
  {
    key: "consultationTopic",
    patterns: ["หัวข้อที่ต้องการปรึกษา", "หัวข้อปรึกษา", "หัวข้อ", "เรื่องที่ปรึกษา", "ปรึกษา"],
  },
  {
    key: "phone",
    patterns: ["เบอร์โทรศัพท์", "เบอร์โทร", "เบอร์", "โทรศัพท์", "โทร"],
  },
  {
    key: "preferredTime",
    patterns: ["ช่วงเวลาที่สะดวก", "ช่วงเวลา", "เวลาที่สะดวก", "สะดวก", "เวลา"],
  },
];

function cleanValue(raw: string): string {
  return raw.replace(/^[\s:：\-]+/, "").trim();
}

// Parse one text message into whatever labeled fields it contains.
export function parseFields(text: string): CollectedFields {
  const out: CollectedFields = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const { key, patterns } of LABELS) {
      if (out[key]) continue;
      for (const p of patterns) {
        const idx = trimmed.indexOf(p);
        if (idx === -1) continue;
        const value = cleanValue(trimmed.slice(idx + p.length));
        if (value) {
          out[key] = key === "phone" ? normalizePhone(value) : value;
        }
        break;
      }
    }
  }
  return out;
}

// Keep digits and a leading +, drop spaces/dashes. Stored as text.
export function normalizePhone(value: string): string {
  const match = value.match(/[\d+\-\s()]+/);
  if (!match) return value.trim();
  return match[0].replace(/[\s\-()]/g, "").trim();
}

export function mergeFields(
  prev: CollectedFields,
  next: CollectedFields,
): CollectedFields {
  // First non-empty value wins, so an early answer isn't clobbered by a later
  // stray message that happens to contain a label.
  const merged: CollectedFields = { ...prev };
  for (const key of REQUIRED_FIELDS) {
    if (!merged[key] && next[key]) merged[key] = next[key];
  }
  return merged;
}

export function hasAllRequired(fields: CollectedFields): boolean {
  return REQUIRED_FIELDS.every((k) => !!fields[k]);
}
