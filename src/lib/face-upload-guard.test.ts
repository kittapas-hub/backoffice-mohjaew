import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FACE_MAX_DIMENSION,
  FACE_MAX_BYTES,
  FACE_MAX_REQUEST_BYTES,
  faceFileFitsBeforeBuffering,
  faceImageDimensionsFit,
  validateFaceUploadContentLength,
} from "./face-upload-guard.ts";

assert.deepEqual(validateFaceUploadContentLength(null), {
  ok: false,
  reason: "missing",
});
for (const value of ["", "-1", "+1", "1.5", "1e6", "x"]) {
  assert.equal(validateFaceUploadContentLength(value).ok, false);
}
assert.deepEqual(
  validateFaceUploadContentLength(String(FACE_MAX_REQUEST_BYTES + 1)),
  { ok: false, reason: "too_large" },
);
assert.equal(validateFaceUploadContentLength(String(FACE_MAX_REQUEST_BYTES)).ok, true);
assert.equal(faceFileFitsBeforeBuffering(FACE_MAX_BYTES), true);
assert.equal(faceFileFitsBeforeBuffering(FACE_MAX_BYTES + 1), false);
assert.equal(faceImageDimensionsFit(FACE_MAX_DIMENSION, FACE_MAX_DIMENSION), true);
assert.equal(faceImageDimensionsFit(FACE_MAX_DIMENSION + 1, 100), false);
assert.equal(faceImageDimensionsFit(0, 100), false);

const here = fileURLToPath(new URL(".", import.meta.url));
const route = readFileSync(
  join(here, "..", "app", "api", "bookings", "face-upload", "route.ts"),
  "utf8",
);
const bookingForm = readFileSync(
  join(here, "..", "app", "booking", "BookingForm.tsx"),
  "utf8",
);
const lengthGuardAt = route.indexOf("validateFaceUploadContentLength");
const rateGateAt = route.indexOf("const hits = await recordRateHit");
const formDataAt = route.indexOf("await req.formData()");
assert.ok(lengthGuardAt >= 0, "face-upload must validate Content-Length");
assert.ok(rateGateAt >= 0, "face-upload must rate-limit new uploads");
assert.ok(formDataAt >= 0, "face-upload must parse multipart form data");
assert.ok(
  lengthGuardAt < formDataAt,
  "Content-Length guard must run before multipart parsing",
);
assert.ok(rateGateAt < formDataAt, "rate limit must run before multipart parsing");
assert.match(route, /sniffImage\(buffer\)/, "face-upload must sniff real image bytes");
assert.match(
  route,
  /faceImageDimensionsFit\(meta\.width, meta\.height\)/,
  "face-upload must cap image dimensions after byte sniffing",
);
assert.match(
  route,
  /\.from\("booking-faces"\)\s*\n\s*\.list\("faces"/,
  "idempotent retries must verify that the pending face object is ready",
);
assert.match(
  route,
  /if \(insertErr\.code === "23505"\)[\s\S]*?hasUploadedObject\(db, raceWinner\.storage_path\)/,
  "the concurrent insert-race path must verify Storage readiness before returning the token",
);
assert.match(
  bookingForm,
  /typeof uploadCandidate !== "string" \|\| !UUID_RE\.test\(uploadCandidate\)/,
  "booking form must validate the upload token before linking the face to a booking",
);
assert.match(
  route,
  /remove\(\[storagePath\]\)/,
  "failed face storage uploads must clean a possible partial object",
);
assert.match(
  route,
  /if \(cleanupSucceeded\) \{[\s\S]*?\.from\("booking_face_uploads"\)[\s\S]*?\.delete\(\)/,
  "face-upload must retain the intent when storage cleanup fails so cron can retry",
);

console.log("face-upload guard self-check passed");
