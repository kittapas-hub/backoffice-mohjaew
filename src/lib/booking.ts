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

export type LineBookingSession = {
  id: string;
  line_user_id: string;
  line_display_name: string | null;
  status: string;
};

export type LegacyLineBookingRecord = {
  session_id: string;
  line_user_id: string;
  line_display_name: string | null;
  source: "line";
  nickname: string;
  birth_date_text: string;
  consultation_topic: string;
  phone: string;
  preferred_time: string;
  status: "pending";
};

// LINE conversational bookings do not have a concrete slot. They enter the
// existing legacy/manual queue as `pending`; only /api/bookings may create a
// slot booking (`pending_payment`). Requiring both the full labeled form and an
// image prevents partial LINE messages from creating malformed records.
export function buildLegacyLineBookingRecord(
  session: LineBookingSession,
  fields: CollectedFields,
  hasImage: boolean,
): LegacyLineBookingRecord | null {
  if (session.status !== "active" || !hasImage || !hasAllRequired(fields)) {
    return null;
  }

  return {
    session_id: session.id,
    line_user_id: session.line_user_id,
    line_display_name: session.line_display_name,
    source: "line",
    nickname: fields.nickname!,
    birth_date_text: fields.birthDateText!,
    consultation_topic: fields.consultationTopic!,
    phone: normalizePhone(fields.phone!),
    preferred_time: fields.preferredTime!,
    status: "pending",
  };
}

export function hasMatchingImageSignature(
  bytes: Uint8Array,
  mimeType: string,
): boolean {
  const startsWith = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);

  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && startsWith([0xff, 0xd8, 0xff]);
  }
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      startsWith([0x52, 0x49, 0x46, 0x46]) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
}

export async function createLineBookingIdempotently(
  insert: () => Promise<{ id: string | null; errorCode: string | null }>,
  findExisting: () => Promise<string | null>,
): Promise<string> {
  const created = await insert();
  if (created.id) return created.id;
  if (created.errorCode !== "23505") {
    throw new Error(
      `line_booking_create_failed:${created.errorCode ?? "unknown"}`,
    );
  }

  const existingId = await findExisting();
  if (!existingId) {
    throw new Error("line_booking_idempotency_read_failed:not_found");
  }
  return existingId;
}
