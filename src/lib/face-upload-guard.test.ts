import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FACE_MAX_BYTES,
  FACE_MAX_REQUEST_BYTES,
  faceFileFitsBeforeBuffering,
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

const here = fileURLToPath(new URL(".", import.meta.url));
const route = readFileSync(
  join(here, "..", "app", "api", "bookings", "face-upload", "route.ts"),
  "utf8",
);
const lengthGuardAt = route.indexOf("validateFaceUploadContentLength");
const formDataAt = route.indexOf("await req.formData()");
assert.ok(lengthGuardAt >= 0, "face-upload must validate Content-Length");
assert.ok(formDataAt >= 0, "face-upload must parse multipart form data");
assert.ok(
  lengthGuardAt < formDataAt,
  "Content-Length guard must run before multipart parsing",
);
assert.match(route, /sniffImage\(buffer\)/, "face-upload must sniff real image bytes");

console.log("face-upload guard self-check passed");
