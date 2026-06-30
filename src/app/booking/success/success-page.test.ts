// Self-check for success page helpers.
// Run: node --experimental-strip-types src/app/booking/success/success-page.test.ts
import assert from "node:assert";
import { formatMmSs, buildLineHref, buildLinePrefill } from "./helpers.ts";

// --- formatMmSs -----------------------------------------------------------

assert.equal(formatMmSs(0), "00:00");
assert.equal(formatMmSs(-1), "00:00");
assert.equal(formatMmSs(59_999), "00:59");
assert.equal(formatMmSs(60_000), "01:00");
assert.equal(formatMmSs(125_000), "02:05"); // 2 min 5 sec
assert.equal(formatMmSs(600_000), "10:00"); // 10 min

// --- buildLineHref --------------------------------------------------------

// Standard LINE OA URL format → oaMessage deep link with encoded prefill
const oaUrl = "https://line.me/R/ti/p/@mohjaew";
const href = buildLineHref(oaUrl, "hello\nworld");
assert.ok(
  href.startsWith("https://line.me/R/oaMessage/@mohjaew?text="),
  `Expected oaMessage URL, got: ${href}`,
);
assert.ok(href.includes("hello"), "Prefill text should be URL-encoded in href");

// Unknown URL format: falls back to original URL unchanged
const unknownUrl = "https://lin.ee/abc123";
assert.equal(buildLineHref(unknownUrl, "text"), unknownUrl);

// --- buildLinePrefill -----------------------------------------------------

const prefill = buildLinePrefill({
  reference: "REF-001",
  thaiDate: "จ. 1 มกราคม 2568",
  slotLabel: "09:00–10:00 น.",
});

// Must contain booking metadata
assert.ok(prefill.includes("REF-001"), "Must contain reference");
assert.ok(prefill.includes("2568"), "Must contain Thai date");
assert.ok(prefill.includes("09:00"), "Must contain time range");

// Must NOT contain PII field labels (name, phone, birthdate)
const piiPatterns = ["ชื่อ", "เบอร์", "โทร", "วันเกิด", "เลขบัตร"];
for (const pattern of piiPatterns) {
  assert.ok(
    !prefill.includes(pattern),
    `Prefill must not contain PII field: ${pattern}`,
  );
}

// LINE href built from prefill should also not expose PII
const lineHref = buildLineHref(oaUrl, prefill);
for (const pattern of piiPatterns) {
  assert.ok(
    !lineHref.includes(encodeURIComponent(pattern)),
    `LINE href must not expose PII field: ${pattern}`,
  );
}

console.log("success-page helpers: all checks passed ✓");
