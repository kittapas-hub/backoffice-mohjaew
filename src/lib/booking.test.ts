// Self-check for the real Thai booking parser + completion gating.
// Run: node --experimental-strip-types src/lib/booking.test.ts
import assert from "node:assert";
import {
  buildLegacyLineBookingRecord,
  createLineBookingIdempotently,
  hasMatchingImageSignature,
  parseFields,
  mergeFields,
  hasAllRequired,
  normalizePhone,
} from "./booking.ts";

// --- parseFields: all fields in one multiline message ------------------------
const a = parseFields(
  "ชื่อเล่น: มะลิ\nวันเกิด: 1/1/2540\nหัวข้อ: ความรัก\nเบอร์: 081-234-5678\nสะดวก: เย็น",
);
assert.equal(a.nickname, "มะลิ");
assert.equal(a.birthDateText, "1/1/2540");
assert.equal(a.consultationTopic, "ความรัก");
assert.equal(a.phone, "0812345678");
assert.equal(a.preferredTime, "เย็น");

// Conservative: unlabeled chatter yields nothing.
assert.deepEqual(parseFields("สวัสดีค่ะ"), {});

// Label without colon still parses (space separator).
assert.equal(parseFields("ชื่อเล่น มะลิ").nickname, "มะลิ");

// --- normalizePhone ----------------------------------------------------------
assert.equal(normalizePhone("081-234 5678"), "0812345678");
assert.equal(normalizePhone("โทร 02 123 4567"), "021234567");

// --- mergeFields: first non-empty value wins (split replies, no clobber) -----
const m = mergeFields({ nickname: "มะลิ" }, { nickname: "อื่น", phone: "0812345678" });
assert.equal(m.nickname, "มะลิ"); // early answer preserved
assert.equal(m.phone, "0812345678"); // later answer added

// --- hasAllRequired: completion gating --------------------------------------
assert.equal(hasAllRequired(a), true);
assert.equal(hasAllRequired({ nickname: "มะลิ" }), false); // missing fields -> no booking
assert.equal(
  hasAllRequired({
    nickname: "ม",
    birthDateText: "x",
    consultationTopic: "y",
    phone: "0",
    preferredTime: "z",
  }),
  true,
);

// --- LINE completion: full form + image creates one safe legacy record -------
const lineSession = {
  id: "11111111-2222-3333-4444-555555555555",
  line_user_id: "line-user-fixture",
  line_display_name: "Fixture",
  status: "active",
};
const completeFields = {
  nickname: "Fixture",
  birthDateText: "1/1/2540",
  consultationTopic: "General",
  phone: "081-234-5678",
  preferredTime: "Evening",
};
const lineRecord = buildLegacyLineBookingRecord(
  lineSession,
  completeFields,
  true,
);
assert.deepEqual(lineRecord, {
  session_id: lineSession.id,
  line_user_id: lineSession.line_user_id,
  line_display_name: lineSession.line_display_name,
  source: "line",
  nickname: "Fixture",
  birth_date_text: "1/1/2540",
  consultation_topic: "General",
  phone: "0812345678",
  preferred_time: "Evening",
  status: "pending",
});

// Repeated events for one logical session always target the same session_id.
// The database unique(session_id) constraint returns the original booking.
assert.equal(
  buildLegacyLineBookingRecord(lineSession, completeFields, true)?.session_id,
  lineRecord?.session_id,
);

// Partial form, missing image, or a completed session creates no booking.
assert.equal(
  buildLegacyLineBookingRecord(lineSession, { nickname: "Fixture" }, true),
  null,
);
assert.equal(
  buildLegacyLineBookingRecord(lineSession, completeFields, false),
  null,
);
assert.equal(
  buildLegacyLineBookingRecord(
    { ...lineSession, status: "completed" },
    completeFields,
    true,
  ),
  null,
);

// --- LINE image content validation ------------------------------------------
assert.equal(
  hasMatchingImageSignature(
    Uint8Array.from([0xff, 0xd8, 0xff, 0x00]),
    "image/jpeg",
  ),
  true,
);
assert.equal(
  hasMatchingImageSignature(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/png",
  ),
  true,
);
assert.equal(
  hasMatchingImageSignature(
    Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]),
    "image/webp",
  ),
  true,
);
assert.equal(
  hasMatchingImageSignature(
    Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e]),
    "image/png",
  ),
  false,
  "declared MIME without matching magic bytes must be rejected",
);

// --- Concurrent duplicate completion: two calls resolve to one booking ------
let storedBookingId: string | null = null;
let physicalInsertCount = 0;
const insertOnce = async () => {
  await Promise.resolve();
  if (storedBookingId) return { id: null, errorCode: "23505" };
  storedBookingId = "synthetic-booking-id";
  physicalInsertCount += 1;
  return { id: storedBookingId, errorCode: null };
};
const findStored = async () => storedBookingId;
const concurrentResults = await Promise.all([
  createLineBookingIdempotently(insertOnce, findStored),
  createLineBookingIdempotently(insertOnce, findStored),
]);
assert.deepEqual(concurrentResults, [
  "synthetic-booking-id",
  "synthetic-booking-id",
]);
assert.equal(physicalInsertCount, 1, "two concurrent calls must persist one booking");

console.log("booking self-check passed");
