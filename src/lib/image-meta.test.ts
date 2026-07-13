// Self-check for image-meta (slip upload image validation).
// Run: node --experimental-strip-types src/lib/image-meta.test.ts
import assert from "node:assert";
import {
  sniffImage,
  validateSlipImage,
  SLIP_MAX_BYTES,
} from "./image-meta.ts";

// --- fixture builders (minimal-but-real headers) ----------------------------
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number): Buffer {
  // SOI, APP0(len 4), SOF0(len 0x11) carrying dimensions.
  const b = Buffer.alloc(20);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  b.writeUInt16BE(h, 13);
  b.writeUInt16BE(w, 15);
  b[17] = 0x03;
  return b;
}

function webpLossless(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0);
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8);
  b.write("VP8L", 12);
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
}

// --- format sniffing ---------------------------------------------------------
assert.deepEqual(sniffImage(png(800, 600)), {
  type: "image/png",
  width: 800,
  height: 600,
});
assert.deepEqual(sniffImage(jpeg(1024, 768)), {
  type: "image/jpeg",
  width: 1024,
  height: 768,
});
assert.deepEqual(sniffImage(webpLossless(500, 400)), {
  type: "image/webp",
  width: 500,
  height: 400,
});

// Forged MIME/extension: bytes decide, not the client's claim. A text file
// "renamed" to .jpg is still not an image.
assert.equal(sniffImage(Buffer.from("GIF89a not allowed")), null);
assert.equal(sniffImage(Buffer.from("%PDF-1.7 definitely not an image")), null);
assert.equal(sniffImage(Buffer.from("<html>hi</html>")), null);
// Truncated/corrupt headers.
assert.equal(sniffImage(png(800, 600).subarray(0, 10)), null);
assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff])), null);

// --- validateSlipImage: size + dimension policy ------------------------------
assert.equal(validateSlipImage(png(800, 600)).ok, true);

{
  const r = validateSlipImage(Buffer.alloc(0));
  assert.deepEqual(r, { ok: false, error: "empty" });
}
{
  // Oversized image (requirement H-14).
  const r = validateSlipImage(Buffer.alloc(SLIP_MAX_BYTES + 1));
  assert.deepEqual(r, { ok: false, error: "too_large" });
}
{
  // Unsupported format (requirement H-15) / forged MIME (H-16).
  const r = validateSlipImage(Buffer.from("plain text pretending to be jpg"));
  assert.deepEqual(r, { ok: false, error: "not_an_image" });
}
{
  const tiny = validateSlipImage(png(50, 50));
  assert.deepEqual(tiny, { ok: false, error: "bad_dimensions" });
  const huge = validateSlipImage(png(9000, 100));
  assert.deepEqual(huge, { ok: false, error: "bad_dimensions" });
  const zero = validateSlipImage(png(0, 600));
  assert.deepEqual(zero, { ok: false, error: "bad_dimensions" });
}

// PNG bytes with a lying .jpeg claim: validate returns the REAL type; callers
// must use meta.type, never the client MIME, when talking to the provider.
{
  const r = validateSlipImage(png(300, 300));
  assert.ok(r.ok && r.meta.type === "image/png");
}

console.log("image-meta self-check passed");
