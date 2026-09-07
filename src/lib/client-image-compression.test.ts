import assert from "node:assert/strict";
import {
  FACE_MAX_DIMENSION,
  FACE_SOURCE_MAX_BYTES,
  FACE_TARGET_BYTES,
  FACE_UPLOAD_MAX_BYTES,
  fitWithinMaxDimension,
} from "./client-image-compression.ts";

assert.deepEqual(fitWithinMaxDimension(4000, 3000), { width: 1800, height: 1350 });
assert.deepEqual(fitWithinMaxDimension(3000, 4000), { width: 1350, height: 1800 });
assert.deepEqual(fitWithinMaxDimension(1200, 800), { width: 1200, height: 800 });
assert.deepEqual(fitWithinMaxDimension(100, 200, 100), { width: 50, height: 100 });
assert.throws(() => fitWithinMaxDimension(0, 100), /invalid_dimensions/);
assert.equal(FACE_MAX_DIMENSION, 1800);
assert.ok(FACE_SOURCE_MAX_BYTES > FACE_UPLOAD_MAX_BYTES);
assert.ok(FACE_UPLOAD_MAX_BYTES > FACE_TARGET_BYTES);

console.log("client image compression self-check passed");