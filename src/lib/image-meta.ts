// Real image validation from bytes — never trusts extension or client MIME.
// Pure, stdlib-only. Supports the three formats the slip upload accepts.

export type ImageMeta = {
  type: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

function pngMeta(buf: Buffer): ImageMeta | null {
  // 8-byte signature, then IHDR chunk: width @16, height @20 (big-endian).
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  return {
    type: "image/png",
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function jpegMeta(buf: Buffer): ImageMeta | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return null;
  }
  // Walk segments until a SOF marker (C0–CF except C4/C8/CC) carrying dimensions.
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers without a length field
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      return {
        type: "image/jpeg",
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    }
    i += 2 + len;
  }
  return null;
}

function webpMeta(buf: Buffer): ImageMeta | null {
  // RIFF....WEBP then VP8 / VP8L / VP8X chunk.
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: 14-bit width/height at offsets 26/28 (little-endian).
    return {
      type: "image/webp",
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return {
      type: "image/webp",
      width: (b & 0x3fff) + 1,
      height: ((b >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    // 24-bit (width-1)/(height-1) at offsets 24/27.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { type: "image/webp", width: w + 1, height: h + 1 };
  }
  return null;
}

/** Sniff format + dimensions from bytes. Null = not a supported image. */
export function sniffImage(buf: Buffer): ImageMeta | null {
  return pngMeta(buf) ?? jpegMeta(buf) ?? webpMeta(buf) ?? null;
}

export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
export const SLIP_MIN_DIMENSION = 100;
export const SLIP_MAX_DIMENSION = 8000;

export type SlipImageError = "empty" | "too_large" | "not_an_image" | "bad_dimensions";

/** Full slip-image validation: size, real signature, safe dimensions. */
export function validateSlipImage(
  buf: Buffer,
): { ok: true; meta: ImageMeta } | { ok: false; error: SlipImageError } {
  if (buf.length === 0) return { ok: false, error: "empty" };
  if (buf.length > SLIP_MAX_BYTES) return { ok: false, error: "too_large" };
  const meta = sniffImage(buf);
  if (!meta) return { ok: false, error: "not_an_image" };
  if (
    meta.width < SLIP_MIN_DIMENSION ||
    meta.height < SLIP_MIN_DIMENSION ||
    meta.width > SLIP_MAX_DIMENSION ||
    meta.height > SLIP_MAX_DIMENSION
  ) {
    return { ok: false, error: "bad_dimensions" };
  }
  return { ok: true, meta };
}
