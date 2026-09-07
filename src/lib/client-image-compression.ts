const SUPPORTED_FACE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const FACE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const FACE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const FACE_TARGET_BYTES = 1024 * 1024;
export const FACE_MAX_DIMENSION = 1800;

export function fitWithinMaxDimension(
  width: number,
  height: number,
  maxDimension = FACE_MAX_DIMENSION,
) {
  if (width <= 0 || height <= 0 || maxDimension <= 0) {
    throw new Error("invalid_dimensions");
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type LoadedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

async function loadBrowserImage(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => URL.revokeObjectURL(url),
  };
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("image_encode_failed"))),
      "image/jpeg",
      quality,
    );
  });
}

export async function compressFaceImage(file: File): Promise<File> {
  if (!SUPPORTED_FACE_TYPES.has(file.type)) throw new Error("unsupported_type");
  if (file.size <= 0 || file.size > FACE_SOURCE_MAX_BYTES) throw new Error("source_too_large");

  const loaded = await loadBrowserImage(file);
  try {
    const fitted = fitWithinMaxDimension(loaded.width, loaded.height);
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas_unavailable");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);

    let blob = await canvasToJpeg(canvas, 0.82);
    for (const quality of [0.74, 0.68]) {
      if (blob.size <= FACE_TARGET_BYTES) break;
      blob = await canvasToJpeg(canvas, quality);
    }

    const originalIsSafe = file.size <= FACE_UPLOAD_MAX_BYTES;
    if (originalIsSafe && file.size <= blob.size) return file;
    if (blob.size > FACE_UPLOAD_MAX_BYTES) throw new Error("compressed_too_large");

    const baseName = file.name.replace(/\.[^.]+$/, "") || "face";
    return new File([blob], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    loaded.cleanup();
  }
}
