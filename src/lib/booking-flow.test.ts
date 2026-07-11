// Self-check for the booking-creation flow semantics (Phase 0 additions).
// Run: node --experimental-strip-types src/lib/booking-flow.test.ts
//
// The real concurrency guard is the Postgres row lock (SELECT ... FOR UPDATE
// on booking_slots) inside create_booking(): concurrent callers SERIALIZE, so
// their effects are equivalent to running one at a time. This file models
// exactly that serialized algorithm — same step order as the SQL in
// 0005_payment_foundation.sql §5 — and asserts the invariants that must hold
// for any interleaving:
//   * the last seat goes to exactly one of two racing requests
//   * an idempotency-key retry returns the SAME booking (no second seat)
//   * a lapsed hold frees its seat and queue numbers are never reused
//   * the per-(slot, phone) duplicate guard blocks a second active booking
// It also covers paymentHoldMinutes() env parsing and the admin
// Confirm-Payment transitions (no regression to the manual flow).
import assert from "node:assert";
import {
  occupies,
  countOccupied,
  nextQueueNumber,
  canConfirm,
  canTransition,
  paymentHoldMinutes,
  PAYMENT_HOLD_MINUTES,
  type BookingLike,
} from "./slots.ts";

// --- in-memory mirror of create_booking() ------------------------------------
type Row = BookingLike & {
  id: string;
  slot_id: string;
  phone: string;
  idempotency_key: string | null;
};

type CreateArgs = {
  slotId: string;
  phone: string;
  idempotencyKey: string;
  capacity: number;
  holdMinutes?: number;
  now?: number;
};

let seq = 0;

// Same step order as the SQL: idempotency short-circuit → expire lapsed holds
// for the slot → duplicate guard → capacity count → max+1 queue → insert.
function createBooking(
  rows: Row[],
  { slotId, phone, idempotencyKey, capacity, holdMinutes = PAYMENT_HOLD_MINUTES, now = Date.now() }: CreateArgs,
): { ok: true; booking: Row } | { ok: false; error: "duplicate_booking" | "slot_full" } {
  const existing = rows.find((r) => r.idempotency_key === idempotencyKey);
  if (existing) return { ok: true, booking: existing };

  const inSlot = rows.filter((r) => r.slot_id === slotId);
  for (const r of inSlot) {
    if (r.status === "pending_payment" && !occupies(r, now)) r.status = "expired";
  }

  if (inSlot.some((r) => r.phone === phone && occupies(r, now))) {
    return { ok: false, error: "duplicate_booking" };
  }
  if (countOccupied(inSlot, now) >= capacity) {
    return { ok: false, error: "slot_full" };
  }

  const booking: Row = {
    id: `b${++seq}`,
    slot_id: slotId,
    phone,
    idempotency_key: idempotencyKey,
    status: "pending_payment",
    hold_expires_at: new Date(now + holdMinutes * 60_000).toISOString(),
    queue_number: nextQueueNumber(inSlot),
  };
  rows.push(booking);
  return { ok: true, booking };
}

const NOW = Date.now();

// --- race for the last seat: exactly one winner ------------------------------
{
  const rows: Row[] = [];
  const a = createBooking(rows, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-a", capacity: 1, now: NOW });
  const b = createBooking(rows, { slotId: "s1", phone: "0810000002", idempotencyKey: "k-b", capacity: 1, now: NOW });
  assert.equal(a.ok, true, "first racer gets the seat");
  assert.deepEqual(b, { ok: false, error: "slot_full" }, "second racer is rejected");
  assert.equal(countOccupied(rows, NOW), 1, "capacity 1 slot never exceeds 1 occupant");
  // Order independence: swap arrival order, still exactly one winner.
  const rows2: Row[] = [];
  const b2 = createBooking(rows2, { slotId: "s1", phone: "0810000002", idempotencyKey: "k-b2", capacity: 1, now: NOW });
  const a2 = createBooking(rows2, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-a2", capacity: 1, now: NOW });
  assert.equal(b2.ok, true);
  assert.equal(a2.ok, false);
  assert.equal(countOccupied(rows2, NOW), 1);
}

// --- idempotent retry returns the same booking, occupies one seat ------------
{
  const rows: Row[] = [];
  const first = createBooking(rows, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-same", capacity: 2, now: NOW });
  const retry = createBooking(rows, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-same", capacity: 2, now: NOW });
  assert.equal(first.ok && retry.ok, true);
  if (first.ok && retry.ok) {
    assert.equal(retry.booking.id, first.booking.id, "retry with same key returns the original booking");
  }
  assert.equal(rows.length, 1, "no duplicate row created");
  assert.equal(countOccupied(rows, NOW), 1, "retry does not consume a second seat");
}

// --- lapsed hold frees the seat; queue numbers are never reused ---------------
{
  const rows: Row[] = [];
  // Booked 20 minutes ago with a 10-minute hold → lapsed 10 minutes ago.
  const past = NOW - 20 * 60_000;
  const stale = createBooking(rows, {
    slotId: "s1", phone: "0810000001", idempotencyKey: "k-old",
    capacity: 1, holdMinutes: 10, now: past,
  });
  assert.equal(stale.ok, true);

  // Now the hold has lapsed: a new customer gets the seat.
  const fresh = createBooking(rows, { slotId: "s1", phone: "0810000002", idempotencyKey: "k-new", capacity: 1, now: NOW });
  assert.equal(fresh.ok, true, "a lapsed hold must not block the seat");
  assert.equal(rows[0].status, "expired", "the stale hold is expired during creation");
  if (stale.ok && fresh.ok) {
    assert.equal(stale.booking.queue_number, 1);
    assert.equal(fresh.booking.queue_number, 2, "queue number is monotonic, never reused");
  }
  assert.equal(countOccupied(rows, NOW), 1);
}

// --- duplicate guard: one active booking per (slot, phone) --------------------
{
  const rows: Row[] = [];
  const first = createBooking(rows, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-1", capacity: 5, now: NOW });
  assert.equal(first.ok, true);
  const dup = createBooking(rows, { slotId: "s1", phone: "0810000001", idempotencyKey: "k-2", capacity: 5, now: NOW });
  assert.deepEqual(dup, { ok: false, error: "duplicate_booking" });
  // Same phone in ANOTHER slot is fine.
  const otherSlot = createBooking(rows, { slotId: "s2", phone: "0810000001", idempotencyKey: "k-3", capacity: 5, now: NOW });
  assert.equal(otherSlot.ok, true);
}

// --- manual admin Confirm Payment flow: no regression --------------------------
// confirmPayment (src/app/admin/actions.ts) hardcodes pending_payment → confirmed
// via transition_slot_booking. These mirror SLOT_TRANSITIONS / canConfirm.
{
  assert.equal(canTransition("pending_payment", "confirmed"), true, "manual confirm path stays valid");
  assert.equal(canTransition("booked", "confirmed"), true, "paid booking is admin-confirmable");
  assert.equal(canTransition("expired", "confirmed"), false, "expired booking cannot be confirmed");
  assert.equal(canTransition("cancelled", "confirmed"), false, "cancelled booking cannot be confirmed");

  const future = new Date(NOW + 30 * 60_000).toISOString();
  const full: BookingLike[] = [{ status: "confirmed" }, { status: "confirmed" }];
  // A live hold occupies its own seat → confirm succeeds even in a full slot.
  assert.equal(
    canConfirm({ status: "pending_payment", hold_expires_at: future }, full, 3, NOW).ok,
    true,
    "live hold in a full slot confirms without needing an extra seat",
  );
  // Payment Hold Safety (0008_reject_expired_hold_confirmation.sql): a lapsed
  // hold can NEVER be confirmed, even with room to spare — the previous
  // "late payment, manual review" allowance is intentionally removed so the
  // customer-facing hold deadline is a real guarantee.
  const past = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(
    canConfirm({ status: "pending_payment", hold_expires_at: past }, [...full, { status: "confirmed" }], 3, NOW),
    { ok: false, error: "hold_expired" },
    "lapsed hold cannot be confirmed even in a full slot",
  );
  assert.deepEqual(
    canConfirm({ status: "pending_payment", hold_expires_at: past }, [], 3, NOW),
    { ok: false, error: "hold_expired" },
    "lapsed hold cannot be confirmed even with plenty of room",
  );
}

// --- paymentHoldMinutes: env parsing + clamping --------------------------------
assert.equal(PAYMENT_HOLD_MINUTES, 30, "default hold is 30 minutes");
assert.equal(paymentHoldMinutes(undefined), 30, "absent env → default");
assert.equal(paymentHoldMinutes(""), 30, "empty env → default");
assert.equal(paymentHoldMinutes("abc"), 30, "garbage env → default");
assert.equal(paymentHoldMinutes("10"), 10, "explicit value honored");
assert.equal(paymentHoldMinutes("45"), 45);
assert.equal(paymentHoldMinutes("45.9"), 45, "fractions truncate");
assert.equal(paymentHoldMinutes("0"), 5, "clamped to minimum 5");
assert.equal(paymentHoldMinutes("-5"), 5, "negative clamped to minimum 5");
assert.equal(paymentHoldMinutes("3000"), 120, "clamped to maximum 120");

// --- rate-limit window model (mirrors record_rate_hit + route decision) --------
// record_rate_hit counts hits inside the window; the route rejects when the
// count EXCEEDS the limit — so exactly `limit` requests pass, the next is 429.
{
  const LIMIT = 30;
  const WINDOW_MS = 5 * 60_000;
  const hits: number[] = [];
  const recordHit = (t: number) => {
    while (hits.length && hits[0] <= t - WINDOW_MS) hits.shift();
    hits.push(t);
    return hits.length;
  };
  let rejected = 0;
  for (let i = 0; i < 31; i++) {
    if (recordHit(NOW + i * 1000) > LIMIT) rejected++;
  }
  assert.equal(rejected, 1, "31st request within the window is rate limited");
  // After the window slides past the burst, requests pass again.
  assert.ok(recordHit(NOW + WINDOW_MS + 60_000) <= LIMIT, "hits expire with the window");
}

console.log("booking-flow self-check passed");
