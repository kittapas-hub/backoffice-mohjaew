// Self-check for the real Thai booking parser + completion gating.
// Run: node --experimental-strip-types src/lib/booking.test.ts
import assert from "node:assert";
import {
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

console.log("booking self-check passed");
