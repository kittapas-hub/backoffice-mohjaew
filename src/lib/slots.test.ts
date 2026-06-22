// Self-check for slot capacity rules + input validation.
// Run: node --experimental-strip-types src/lib/slots.test.ts
//
// These mirror the SQL in 0002_booking_slots.sql. Real concurrency safety is
// enforced by the Postgres row lock (SELECT ... FOR UPDATE) in create_booking;
// see the staging checklist in README for the concurrent-load verification.
import assert from "node:assert";
import {
  DEFAULT_CONSULTATION_TOPIC,
  isAllowedSource,
  occupies,
  countOccupied,
  remainingSeats,
  isSlotFull,
  nextQueueNumber,
  canConfirm,
  canTransition,
  validateBookingInput,
  type BookingLike,
} from "./slots.ts";
import { mapTransitionError } from "./confirm-error.ts";

const future = new Date(Date.now() + 30 * 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

// --- capacity 4: the 5th booking can't get a seat ---------------------------
const four: BookingLike[] = [
  { status: "confirmed" },
  { status: "confirmed" },
  { status: "pending_payment", hold_expires_at: future },
  { status: "pending_payment", hold_expires_at: future },
];
assert.equal(countOccupied(four), 4);
assert.equal(remainingSeats(4, four), 0);
assert.equal(isSlotFull(4, four), true, "slot of capacity 4 with 4 occupants is full");

// --- expired pending_payment frees the seat ---------------------------------
const withExpired: BookingLike[] = [
  { status: "confirmed" },
  { status: "pending_payment", hold_expires_at: past }, // lapsed -> frees seat
  { status: "expired" },
  { status: "cancelled" },
];
assert.equal(countOccupied(withExpired), 1, "only the confirmed seat counts");
assert.equal(remainingSeats(4, withExpired), 3);
assert.equal(isSlotFull(4, withExpired), false);

// --- confirmed keeps occupying capacity -------------------------------------
assert.equal(occupies({ status: "confirmed" }), true);
assert.equal(occupies({ status: "completed" }), true);
assert.equal(occupies({ status: "pending_payment", hold_expires_at: future }), true);
assert.equal(occupies({ status: "pending_payment", hold_expires_at: past }), false);
assert.equal(occupies({ status: "expired" }), false);
assert.equal(occupies({ status: "cancelled" }), false);

// --- queue number is monotonic, never reused --------------------------------
assert.equal(nextQueueNumber([]), 1);
assert.equal(
  nextQueueNumber([{ status: "expired", queue_number: 1 }, { status: "confirmed", queue_number: 2 }]),
  3,
  "queue number does not reuse an expired booking's number",
);

// --- confirm: slot full of pending_payment, confirm one of them -------------
// capacity 4, four live pending_payment holds. Confirming one must succeed
// (it already occupies a seat) and occupancy must stay 4, not become 5.
{
  const others3: BookingLike[] = [
    { status: "pending_payment", hold_expires_at: future },
    { status: "pending_payment", hold_expires_at: future },
    { status: "pending_payment", hold_expires_at: future },
  ];
  const self: BookingLike = { status: "pending_payment", hold_expires_at: future };
  const r = canConfirm(self, others3, 4);
  assert.equal(r.ok, true, "confirming a live hold in a full slot must succeed");

  // After confirm: self becomes confirmed, others unchanged → still 4 occupied.
  const afterConfirm: BookingLike[] = [{ status: "confirmed" }, ...others3];
  assert.equal(countOccupied(afterConfirm), 4, "occupancy stays 4 after confirm, not 5");
}

// --- confirm: idempotent for already-confirmed ------------------------------
assert.equal(canConfirm({ status: "confirmed" }, [], 0).ok, true);

// --- confirm: expired / cancelled cannot be confirmed -----------------------
assert.deepEqual(
  canConfirm({ status: "expired" }, [], 4),
  { ok: false, error: "not_confirmable" },
);
assert.deepEqual(
  canConfirm({ status: "cancelled" }, [], 4),
  { ok: false, error: "not_confirmable" },
);

// --- confirm: lapsed hold needs a free seat ---------------------------------
{
  const fullOthers: BookingLike[] = [
    { status: "confirmed" },
    { status: "confirmed" },
    { status: "confirmed" },
    { status: "confirmed" },
  ];
  const lapsed: BookingLike = { status: "pending_payment", hold_expires_at: past };
  // Its hold lapsed and the slot is otherwise full → cannot confirm.
  assert.deepEqual(canConfirm(lapsed, fullOthers, 4), { ok: false, error: "slot_full" });
  // But if there's room, a lapsed hold can still be confirmed.
  assert.equal(canConfirm(lapsed, fullOthers.slice(0, 3), 4).ok, true);
}

// --- state transition matrix (mirrors transition_slot_booking) --------------
assert.equal(canTransition("pending_payment", "confirmed"), true);
assert.equal(canTransition("pending_payment", "cancelled"), true);
assert.equal(canTransition("pending_payment", "expired"), true);
assert.equal(canTransition("confirmed", "completed"), true);
assert.equal(canTransition("confirmed", "cancelled"), true);
// Forbidden / terminal transitions:
assert.equal(canTransition("expired", "completed"), false, "expired is terminal");
assert.equal(canTransition("cancelled", "confirmed"), false, "cancelled is terminal");
assert.equal(canTransition("completed", "cancelled"), false, "completed is terminal");
assert.equal(canTransition("pending_payment", "completed"), false, "must confirm first");

// confirmed -> completed keeps occupancy (already occupied; no extra seat).
{
  const others: BookingLike[] = [{ status: "confirmed" }, { status: "confirmed" }];
  const before = countOccupied([{ status: "confirmed" }, ...others]); // 3
  const after = countOccupied([{ status: "completed" }, ...others]); // 3
  assert.equal(before, after, "confirmed→completed does not change occupancy");
}

// confirmed -> cancelled frees a seat.
{
  const others: BookingLike[] = [{ status: "confirmed" }, { status: "confirmed" }];
  const before = countOccupied([{ status: "confirmed" }, ...others]); // 3
  const after = countOccupied([{ status: "cancelled" }, ...others]); // 2
  assert.equal(before - after, 1, "confirmed→cancelled returns one seat");
}

// --- mapTransitionError -----------------------------------------------------
assert.equal(mapTransitionError("...slot_full..."), "slot_full");
assert.equal(mapTransitionError("invalid_transition"), "invalid_transition");
assert.equal(mapTransitionError("not_slot_booking"), "invalid_transition");
assert.equal(mapTransitionError("booking_not_found"), "not_found");
assert.equal(mapTransitionError("some other db error"), "server_error");
assert.equal(mapTransitionError(null), "server_error");

// --- source allowlist -------------------------------------------------------
for (const s of ["line", "website", "facebook", "instagram"]) {
  assert.equal(isAllowedSource(s), true);
}
for (const s of ["tiktok", "", undefined, "LINE", "x"]) {
  assert.equal(isAllowedSource(s), false);
}

// --- input validation -------------------------------------------------------
const goodUuid = "11111111-2222-3333-4444-555555555555";
const ok = validateBookingInput({
  slotId: goodUuid,
  source: "website",
  nickname: "มะลิ",
  phone: "081-234-5678",
  consultationTopic: "ความรัก",
  birthDateText: "1 ม.ค. 2540",
});
assert.equal(ok.ok, true);
if (ok.ok) assert.equal(ok.value.phone, "0812345678");

const okWithoutSpecialTopic = validateBookingInput({
  slotId: goodUuid,
  source: "website",
  nickname: "มะลิ",
  phone: "081-234-5678",
  consultationTopic: "",
  birthDateText: "1 ม.ค. 2540",
});
assert.equal(okWithoutSpecialTopic.ok, true);
if (okWithoutSpecialTopic.ok) {
  assert.equal(okWithoutSpecialTopic.value.consultationTopic, DEFAULT_CONSULTATION_TOPIC);
}

// bad source
assert.deepEqual(
  validateBookingInput({ slotId: goodUuid, source: "tiktok", nickname: "a", phone: "0812345678", consultationTopic: "x", birthDateText: "y" }),
  { ok: false, error: "invalid_source" },
);
// bad slot id
assert.equal(
  validateBookingInput({ slotId: "not-a-uuid", source: "website", nickname: "a", phone: "0812345678", consultationTopic: "x", birthDateText: "y" }).ok,
  false,
);
// missing field
assert.equal(
  validateBookingInput({ slotId: goodUuid, source: "website", nickname: "", phone: "0812345678", consultationTopic: "x", birthDateText: "y" }).ok,
  false,
);
// bad phone
assert.equal(
  validateBookingInput({ slotId: goodUuid, source: "website", nickname: "a", phone: "123", consultationTopic: "x", birthDateText: "y" }).ok,
  false,
);

console.log("slots self-check passed");
