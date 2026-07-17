import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SLIP_MAX_BYTES } from "../../image-meta.ts";
import {
  fileFitsBeforeBuffering,
  SLIP_MAX_REQUEST_BYTES,
  validateUploadContentLength,
} from "./upload-guard.ts";

assert.deepEqual(validateUploadContentLength(null), { ok: false, reason: "missing" });
for (const deceptive of ["", "-1", "+1", "1.5", "1e6", "100, 100", "abc"]) {
  assert.deepEqual(validateUploadContentLength(deceptive), { ok: false, reason: deceptive === "" ? "missing" : "invalid" });
}
assert.deepEqual(validateUploadContentLength(String(SLIP_MAX_REQUEST_BYTES + 1)), {
  ok: false,
  reason: "too_large",
});
assert.deepEqual(validateUploadContentLength(String(SLIP_MAX_REQUEST_BYTES)), {
  ok: true,
  bytes: SLIP_MAX_REQUEST_BYTES,
});
assert.equal(fileFitsBeforeBuffering(SLIP_MAX_BYTES), true);
assert.equal(fileFitsBeforeBuffering(SLIP_MAX_BYTES + 1), false);
assert.equal(fileFitsBeforeBuffering(0), false);

// Source-order contract: every early rejection happens before the parser,
// buffer allocation, and provider call. This also proves invalid/rate-limited
// requests cannot reach EasySlip after a future refactor without failing here.
const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, "../../../app/api/pay/[token]/slip/route.ts"), "utf8");
const lengthGate = route.indexOf("validateUploadContentLength(");
const rateGate = route.indexOf("const hits = await recordRateHit");
const formParse = route.indexOf("form = await req.formData()");
const fileSizeGate = route.indexOf("fileFitsBeforeBuffering(file.size)");
const bufferAllocation = route.indexOf("await file.arrayBuffer()");
const byteValidation = route.indexOf("validateSlipImage(image)");
const providerCall = route.indexOf("await provider.verify");
for (const [name, index] of [
  ["Content-Length gate", lengthGate],
  ["rate gate", rateGate],
  ["form parser", formParse],
  ["file size gate", fileSizeGate],
  ["buffer allocation", bufferAllocation],
  ["byte validation", byteValidation],
  ["provider call", providerCall],
] as const) {
  assert.ok(index >= 0, `${name} must remain present`);
}
assert.ok(lengthGate < rateGate, "known oversized requests are rejected before rate-limit I/O");
assert.ok(rateGate < formParse, "rate-limited requests are rejected before multipart parsing");
assert.ok(formParse < fileSizeGate && fileSizeGate < bufferAllocation, "file.size is checked before allocating its buffer");
assert.ok(bufferAllocation < byteValidation && byteValidation < providerCall, "only byte-validated images reach EasySlip");

console.log("slip upload-guard self-check passed");
