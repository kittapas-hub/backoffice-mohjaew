// Guard face-image uploads before multipart parsing/buffering.
// Keep the whole request below Vercel Functions' documented 4.5 MB ceiling.
export const FACE_MAX_BYTES = 4 * 1024 * 1024;
export const FACE_MULTIPART_OVERHEAD_BYTES = 128 * 1024;
export const FACE_MAX_REQUEST_BYTES =
  FACE_MAX_BYTES + FACE_MULTIPART_OVERHEAD_BYTES;
// Face photos are compressed to 1800px on the customer path, but the server
// also needs a ceiling for direct callers and decompression-bomb headers.
export const FACE_MAX_DIMENSION = 4096;

export type FaceContentLengthDecision =
  | { ok: true; bytes: number }
  | { ok: false; reason: "missing" | "invalid" | "too_large" };

export function validateFaceUploadContentLength(
  raw: string | null,
): FaceContentLengthDecision {
  if (raw === null || raw.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: "invalid" };
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return { ok: false, reason: "invalid" };
  }
  if (bytes > FACE_MAX_REQUEST_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, bytes };
}

export function faceFileFitsBeforeBuffering(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= FACE_MAX_BYTES;
}

export function faceImageDimensionsFit(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= FACE_MAX_DIMENSION &&
    height <= FACE_MAX_DIMENSION
  );
}
