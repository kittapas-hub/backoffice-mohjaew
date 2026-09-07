import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const compressionSource = readFileSync(
  fileURLToPath(new URL("./client-image-compression.ts", import.meta.url)),
  "utf8",
);
assert.match(
  compressionSource,
  /createImageBitmap\(file,\s*\{\s*imageOrientation:\s*"from-image"/,
  "phone EXIF orientation must be applied before canvas drawing",
);
assert.match(
  compressionSource,
  /createImageBitmap[\s\S]*?catch \{[\s\S]*?object-URL decoder[\s\S]*?URL\.createObjectURL/,
  "createImageBitmap option failures must fall back to the browser image decoder",
);
assert.match(
  compressionSource,
  /loaded\.width <= FACE_MAX_DIMENSION[\s\S]*loaded\.height <= FACE_MAX_DIMENSION/,
  "small source files must not bypass the image dimension policy",
);

console.log("client image compression self-check passed");
