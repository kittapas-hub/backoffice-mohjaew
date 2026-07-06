// Self-check for Payment Hold Safety: server-side rejection of confirming a
// booking whose pending_payment hold has already lapsed, independent of the
// 5-minute expire-bookings cron.
// Run: node --experimental-strip-types src/lib/payments/hold-expiry.test.ts
//
// DB-level behaviour (row locks, the actual RPC transition) cannot be
// verified without a live Supabase instance — those are marked [SQL] and
// verified by inspecting the migration SQL directly, same convention as
// payments.test.ts.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canConfirm } from "../slots.ts";
import { mapTransitionError, TRANSITION_ERROR_TH } from "../confirm-error.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readMigration(name: string) {
  return readFileSync(join(repoRoot, "supabase/migrations", name), "utf8");
}
function readSrc(rel: string) {
  return readFileSync(join(repoRoot, "src", rel), "utf8");
}

const migration = readMigration("0008_reject_expired_hold_confirmation.sql");

// ===========================================================================
// [SQL] Migration replaces transition_slot_booking with the same signature.
// ===========================================================================
assert.match(
  migration,
  /create or replace function public\.transition_slot_booking\(\s*p_booking_id uuid,\s*p_to\s+text\s*\)/,
  "0008 must replace transition_slot_booking(uuid, text)",
);

// [SQL] The hold_expired guard must run for pending_payment -> confirmed,
// checking hold_expires_at against now(), BEFORE the capacity/slot_full logic.
const fnBody = migration.slice(
  migration.indexOf("create or replace function public.transition_slot_booking"),
);
const guardIdx = fnBody.search(/raise exception 'hold_expired'/);
const capacityIdx = fnBody.search(/raise exception 'slot_full'/);
assert.ok(guardIdx > -1, "must raise 'hold_expired'");
assert.ok(capacityIdx > -1, "must still raise 'slot_full' for the (now unreachable-for-pending_payment) booked path");
assert.ok(guardIdx < capacityIdx, "hold_expired check must run before the slot_full capacity check");

assert.match(
  fnBody.slice(0, guardIdx),
  /v_from = 'pending_payment'\s*\n\s*and \(v_booking\.hold_expires_at is null or v_booking\.hold_expires_at <= now\(\)\)/,
  "hold_expired must trigger when hold_expires_at is null or in the past",
);

// [SQL] Every other transition must be unchanged from 0005.
assert.match(
  migration,
  /\(v_from = 'pending_payment' and p_to in \('confirmed', 'cancelled', 'expired'\)\)/,
  "pending_payment transition set unchanged",
);
assert.match(
  migration,
  /\(v_from = 'booked'\s+and p_to in \('confirmed', 'cancelled'\)\)/,
  "booked transition set unchanged",
);
assert.match(
  migration,
  /\(v_from = 'confirmed'\s+and p_to in \('completed', 'cancelled'\)\)/,
  "confirmed transition set unchanged",
);

// [SQL] Grants unchanged: invoker rights, service_role only.
assert.doesNotMatch(migration, /security definer/i, "no SECURITY DEFINER expected (invoker rights, same as 0005)");
assert.match(
  migration,
  /revoke all on function public\.transition_slot_booking\(uuid, text\) from public, anon, authenticated/,
  "must revoke execute from public/anon/authenticated",
);
assert.match(
  migration,
  /grant execute on function public\.transition_slot_booking\(uuid, text\) to service_role/,
  "must grant execute to service_role only",
);

// ===========================================================================
// Pure TypeScript: canConfirm() mirrors the new SQL invariant exactly.
// ===========================================================================
const NOW = Date.now();
const past = new Date(NOW - 60_000).toISOString();
const future = new Date(NOW + 60_000).toISOString();

assert.deepEqual(
  canConfirm({ status: "pending_payment", hold_expires_at: past }, [], 10, NOW),
  { ok: false, error: "hold_expired" },
  "lapsed hold rejected even with abundant room",
);
assert.deepEqual(
  canConfirm({ status: "pending_payment", hold_expires_at: null }, [], 10, NOW),
  { ok: false, error: "hold_expired" },
  "missing hold_expires_at treated as expired, never confirmable",
);
assert.equal(
  canConfirm({ status: "pending_payment", hold_expires_at: future }, [], 10, NOW).ok,
  true,
  "live hold still confirms normally (no regression to the valid path)",
);
assert.equal(
  canConfirm({ status: "booked" }, [{ status: "confirmed" }], 1, NOW).ok,
  true,
  "booked -> confirmed unaffected by the hold_expired guard",
);

// ===========================================================================
// confirm-error.ts: 'hold_expired' maps from the RPC exception message to a
// distinct, understandable Thai admin error — same convention as slot_full.
// ===========================================================================
assert.equal(mapTransitionError("hold_expired"), "hold_expired");
assert.equal(mapTransitionError("some wrapper: hold_expired"), "hold_expired");
assert.ok(
  TRANSITION_ERROR_TH.hold_expired.length > 0,
  "must have a Thai message for hold_expired",
);
assert.doesNotMatch(
  TRANSITION_ERROR_TH.hold_expired,
  /token|secret|service_role/i,
  "admin error message must not leak internals",
);

// ===========================================================================
// admin/actions.ts: confirmPayment fast-fails on an expired hold using the
// booking's own persisted hold_expires_at (never a client-supplied value),
// before ever reaching the RPC.
// ===========================================================================
const actionsSrc = readSrc("app/admin/actions.ts");
assert.match(
  actionsSrc,
  /select\("status, slot_id, hold_expires_at"\)/,
  "confirmPayment must read the booking's own hold_expires_at column",
);
assert.match(
  actionsSrc,
  /new Date\(booking\.hold_expires_at\)\.getTime\(\)\s*<=\s*Date\.now\(\)/,
  "confirmPayment must compare the persisted hold_expires_at against the server clock, not a client-supplied value",
);
assert.doesNotMatch(
  actionsSrc,
  /formData\.get\(["']holdExpiresAt["']\)|formData\.get\(["']now["']\)/,
  "confirmPayment must never accept a client-supplied expiry or time value",
);
assert.match(
  actionsSrc,
  /error=hold_expired/,
  "confirmPayment must redirect with the hold_expired error code on rejection",
);

// ===========================================================================
// PaymentInstructions.tsx: client-side hold-expiry safety.
//
// This branch is intentionally NOT src/app/booking/success/BookingStatusPanel.tsx
// — that file (and the polling redesign it was part of) never existed in any
// committed history; it only ever existed as uncommitted work in a different,
// dirty worktree. This branch's committed success page is the older,
// server-rendered-only architecture (page.tsx re-fetches booking status fresh
// on every load; no client polling exists here), so the hold-expiry guard is
// implemented as a small new client component, PaymentInstructions.tsx,
// wired into the existing page.tsx.
// ===========================================================================
const panelSrc = readSrc("app/booking/success/PaymentInstructions.tsx");

assert.match(panelSrc, /^"use client";/, "must be a client component");

// A local holdExpired flag, driven only by the holdExpiresAt prop vs Date.now().
assert.match(
  panelSrc,
  /new Date\(holdExpiresAt\)\.getTime\(\)\s*<=\s*Date\.now\(\)/,
  "must compute hold expiry from the holdExpiresAt prop vs the client clock",
);
assert.match(
  panelSrc,
  /setInterval\(check,\s*1000\)/,
  "must re-check expiry on an interval (matches HoldCountdown's 1s cadence)",
);

// The holdExpired early-return must come first, before the hasPaymentConfig
// branch, so QR/bank/reference/copy/LINE CTA are all replaced by the same
// expiry message once the hold has lapsed.
const holdExpiredIdx = panelSrc.indexOf("if (holdExpired)");
const hasPaymentConfigIdx = panelSrc.indexOf("if (!hasPaymentConfig)");
assert.ok(holdExpiredIdx > -1, "must have an if (holdExpired) branch");
assert.ok(hasPaymentConfigIdx > -1, "must have an if (!hasPaymentConfig) branch");
assert.ok(
  holdExpiredIdx < hasPaymentConfigIdx,
  "holdExpired check must be evaluated before the hasPaymentConfig check",
);

const expiredBlock = panelSrc.slice(holdExpiredIdx, hasPaymentConfigIdx);
assert.match(expiredBlock, /หมดเวลาถือคิวแล้ว/, "must show the Thai hold-expired heading");
assert.match(
  expiredBlock,
  /กรุณาอย่าโอนเงิน/,
  "must explicitly tell the customer not to transfer money",
);
assert.match(
  expiredBlock,
  /ติดต่อทีมงาน/,
  "must direct the customer to contact the team",
);
assert.match(
  expiredBlock,
  /จองคิวใหม่/,
  "must offer a path to make a new booking",
);
assert.doesNotMatch(
  expiredBlock,
  /qrSrc|accountNumber|CopyButton|LineCta/,
  "expired block must not render any payment instruction",
);

// The remainder (non-expired, hasPaymentConfig true) must be unchanged: QR,
// bank details, reference, copy buttons, and the LINE CTA still render
// normally when the hold has not expired.
const notExpiredBlock = panelSrc.slice(hasPaymentConfigIdx);
assert.match(notExpiredBlock, /qrSrc/, "QR image must still render before expiry");
assert.match(notExpiredBlock, /accountNumber/, "account number must still render before expiry");
assert.match(notExpiredBlock, /reference/, "reference must still render before expiry");
assert.match(notExpiredBlock, /CopyButton/, "copy buttons must still render before expiry");
assert.match(notExpiredBlock, /LineCta/, "LINE CTA must still render before expiry");

// page.tsx must actually wire this component in (not just define it unused),
// passing the booking's real, server-fetched holdExpiresAt — never a
// client-supplied value — and must no longer inline the payment-instructions
// JSX itself (that logic now lives solely in PaymentInstructions.tsx).
const successPageSrc = readSrc("app/booking/success/page.tsx");
assert.match(
  successPageSrc,
  /import \{ PaymentInstructions \} from ["']\.\/PaymentInstructions["']/,
  "page.tsx must import PaymentInstructions",
);
assert.match(
  successPageSrc,
  /<PaymentInstructions[\s\S]*?holdExpiresAt=\{booking\.holdExpiresAt\}/,
  "page.tsx must pass the booking's own server-fetched holdExpiresAt",
);
assert.doesNotMatch(
  successPageSrc,
  /CopyButton|LineCta/,
  "page.tsx must no longer directly render CopyButton/LineCta — that now lives inside PaymentInstructions",
);

// The server-rendered terminal-status branch (confirmed/booked/cancelled/
// expired/completed) is untouched: it returns before PaymentInstructions is
// ever reached, so a locally-computed client expiry can never contradict a
// real server-confirmed status — there's no shared state to overwrite.
assert.match(
  successPageSrc,
  /if \(booking\.status !== "pending_payment"\)/,
  "terminal-status branch must still gate on the server-fetched status before rendering payment instructions",
);

// ===========================================================================
// Booking-detail admin route (/admin/bookings/[id]): the expired-hold
// confirmation bypass. pending_payment -> confirmed must route through the
// same hardened ConfirmPaymentButton -> confirmPayment() path as /admin/day
// and the /admin list, NEVER through the generic transitionSlotBooking form
// — that form has no expiry fast-fail and, until migration 0008 is applied,
// relies on nothing at all to reject a lapsed hold.
// ===========================================================================
const detailPageSrc = readSrc("app/admin/bookings/[id]/page.tsx");

assert.match(
  detailPageSrc,
  /import \{ ConfirmPaymentButton \} from ["']\.\.\/\.\.\/_components\/ConfirmPaymentButton["']/,
  "detail page must import the same hardened ConfirmPaymentButton used by /admin/day",
);

// Locate the SLOT_TRANSITIONS map/render block for the slot-booking branch.
const detailTransitionsStart = detailPageSrc.indexOf("SLOT_TRANSITIONS[booking.status]");
assert.ok(detailTransitionsStart > -1, "detail page must render SLOT_TRANSITIONS for slot bookings");
const detailTransitionsBlock = detailPageSrc.slice(
  detailTransitionsStart,
  detailPageSrc.indexOf("Legacy/manual booking", detailTransitionsStart),
);

assert.match(
  detailTransitionsBlock,
  /booking\.status === ["']pending_payment["'] && to === ["']confirmed["']/,
  "detail page must special-case pending_payment -> confirmed",
);
assert.match(
  detailTransitionsBlock,
  /<ConfirmPaymentButton/,
  "detail page must render ConfirmPaymentButton for pending_payment -> confirmed",
);

// The special-case must come BEFORE the generic transitionSlotBooking form
// in the conditional (ternary), i.e. it must gate that path off rather than
// rendering both / rendering the generic form unconditionally.
const specialCaseIdx = detailTransitionsBlock.indexOf(
  'booking.status === "pending_payment" && to === "confirmed"',
);
const genericFormIdx = detailTransitionsBlock.indexOf("<form key={to} action={transitionSlotBooking}>");
assert.ok(specialCaseIdx > -1 && genericFormIdx > -1 && specialCaseIdx < genericFormIdx,
  "the pending_payment -> confirmed special case must precede (gate off) the generic transitionSlotBooking form",
);

// The generic form must still exist for every other transition (booked ->
// confirmed/cancelled, confirmed -> completed/cancelled, pending_payment ->
// cancelled/expired) — this fix must not remove the state machine UI for
// anything except the one confirm path.
assert.match(
  detailTransitionsBlock,
  /transitionSlotBooking/,
  "generic transitionSlotBooking form must remain for all other transitions",
);

// The ConfirmPaymentButton call must supply bookingId/nickname/phone/refCode
// from the already-loaded booking row and redirect back to the same detail
// page — no new data fetching, no new auth logic introduced.
const confirmButtonCall = detailTransitionsBlock.slice(
  detailTransitionsBlock.indexOf("<ConfirmPaymentButton"),
  detailTransitionsBlock.indexOf("/>", detailTransitionsBlock.indexOf("<ConfirmPaymentButton")) + 2,
);
assert.match(confirmButtonCall, /bookingId=\{booking\.id\}/, "must pass the real booking id");
assert.match(confirmButtonCall, /redirectTo=\{`\/admin\/bookings\/\$\{booking\.id\}`\}/, "must redirect back to the same detail page");

// Cross-surface consistency: every admin page that can confirm a
// pending_payment booking must use ConfirmPaymentButton, never a bare
// transitionSlotBooking form, for that specific transition.
for (const page of ["app/admin/day/page.tsx", "app/admin/page.tsx", "app/admin/bookings/[id]/page.tsx"]) {
  const src = readSrc(page);
  assert.match(
    src,
    /ConfirmPaymentButton/,
    `${page} must use ConfirmPaymentButton for manual payment confirmation`,
  );
}

console.log("hold-expiry self-check passed");
