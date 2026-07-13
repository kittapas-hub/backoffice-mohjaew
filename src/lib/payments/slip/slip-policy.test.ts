// Self-check for the trusted slip verification policy (pure logic).
// Run: node --experimental-strip-types src/lib/payments/slip/slip-policy.test.ts
import assert from "node:assert";
import {
  evaluateSlipPolicy,
  normalizeAccount,
  normalizeName,
  receiverMatches,
  TRANSFER_WINDOW_BEFORE_ORDER_MS,
  TRANSFER_CLOCK_SKEW_AFTER_NOW_MS,
} from "./policy.ts";
import type { NormalizedSlipVerification } from "./types.ts";

const NOW = new Date("2026-07-13T12:00:00Z");
const ORDER_CREATED = new Date("2026-07-13T11:40:00Z");

const RECEIVER_CONFIG = {
  accounts: ["xxx-x-x1234-x", "xxx-xxx-5678"],
  names: ["นาง มลฤดี ใจดี"],
};

function slip(over: Partial<NormalizedSlipVerification> = {}): NormalizedSlipVerification {
  return {
    provider: "easyslip",
    providerTransactionReference: "TX123456789",
    transferTimestamp: new Date("2026-07-13T11:50:00Z"),
    amountSatang: 50000,
    receiver: {
      bankShort: "KBANK",
      accountMasked: "xxx-x-x1234-x",
      proxyMasked: null,
      nameTh: "นาง มลฤดี ใจดี",
      nameEn: null,
      ...(over.receiver ?? {}),
    },
    senderDisplay: "นาย ลูกค้า จริงใจ / SCB",
    duplicateSignal: null,
    ...over,
  };
}

function evaluate(s: NormalizedSlipVerification, config = RECEIVER_CONFIG) {
  return evaluateSlipPolicy(s, {
    orderCreatedAt: ORDER_CREATED,
    now: NOW,
    receiverConfig: config,
  });
}

// --- normalization helpers ----------------------------------------------------
assert.equal(normalizeAccount("xxx-x-x1234-x"), "xxxxx1234x");
assert.equal(normalizeAccount("XXX X X1234 X"), "xxxxx1234x");
assert.equal(normalizeName("นาย อีซี่ สลิป"), "อีซี่สลิป");
assert.equal(normalizeName("MR. EASY SLIP"), "easyslip");
assert.equal(normalizeName("น.ส. มะลิ วงศ์ดี"), "มะลิวงศ์ดี");

// --- valid slip passes (requirement H-1 policy half) ---------------------------
assert.deepEqual(evaluate(slip()), { ok: true });

// --- transaction reference required (H-7) --------------------------------------
assert.deepEqual(evaluate(slip({ providerTransactionReference: null })), {
  ok: false,
  code: "tx_ref_missing",
});
assert.deepEqual(evaluate(slip({ providerTransactionReference: "  " })), {
  ok: false,
  code: "tx_ref_missing",
});

// --- receiver checks (H-3) ------------------------------------------------------
// Wrong receiving account.
assert.deepEqual(
  evaluate(slip({ receiver: { ...slip().receiver, accountMasked: "xxx-x-x9999-x" } })),
  { ok: false, code: "receiver_mismatch" },
);
// PromptPay proxy form of the shop account also matches.
assert.deepEqual(
  evaluate(
    slip({
      receiver: { ...slip().receiver, accountMasked: null, proxyMasked: "xxx-xxx-5678" },
    }),
  ),
  { ok: true },
);
// Unconfigured receiver = fail closed: nothing can auto-confirm.
assert.deepEqual(evaluate(slip(), { accounts: [], names: [] }), {
  ok: false,
  code: "receiver_mismatch",
});
// Account matches but the receiver NAME disagrees -> mismatch (second factor).
assert.deepEqual(
  evaluate(slip({ receiver: { ...slip().receiver, nameTh: "นาย คนอื่น ไม่ใช่ร้าน" } })),
  { ok: false, code: "receiver_mismatch" },
);
// Provider gave no name at all: account match alone is accepted.
assert.deepEqual(
  evaluate(slip({ receiver: { ...slip().receiver, nameTh: null, nameEn: null } })),
  { ok: true },
);
// Honorific differences must not cause false mismatches.
assert.ok(
  receiverMatches(
    { ...slip().receiver, nameTh: "มลฤดี ใจดี" },
    RECEIVER_CONFIG,
  ),
);

// --- payment window (H-4, H-5 timestamp half) -----------------------------------
// Before the window: transfer long before the order existed (a reused old slip).
assert.deepEqual(
  evaluate(
    slip({
      transferTimestamp: new Date(
        ORDER_CREATED.getTime() - TRANSFER_WINDOW_BEFORE_ORDER_MS - 1,
      ),
    }),
  ),
  { ok: false, code: "timestamp_out_of_window" },
);
// Exactly on the early boundary passes.
assert.deepEqual(
  evaluate(
    slip({
      transferTimestamp: new Date(
        ORDER_CREATED.getTime() - TRANSFER_WINDOW_BEFORE_ORDER_MS,
      ),
    }),
  ),
  { ok: true },
);
// From the future beyond clock skew.
assert.deepEqual(
  evaluate(
    slip({
      transferTimestamp: new Date(NOW.getTime() + TRANSFER_CLOCK_SKEW_AFTER_NOW_MS + 1),
    }),
  ),
  { ok: false, code: "timestamp_out_of_window" },
);
// Missing/unreadable timestamp is never auto-confirmed.
assert.deepEqual(evaluate(slip({ transferTimestamp: null })), {
  ok: false,
  code: "timestamp_out_of_window",
});
assert.deepEqual(evaluate(slip({ transferTimestamp: new Date("garbage") })), {
  ok: false,
  code: "timestamp_out_of_window",
});

// --- sender identity is deliberately NOT policy ---------------------------------
// (paying on someone's behalf is allowed) — a completely different sender passes.
assert.deepEqual(evaluate(slip({ senderDisplay: null })), { ok: true });

console.log("slip-policy self-check passed");
