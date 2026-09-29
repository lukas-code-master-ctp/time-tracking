/**
 * Screenshot processing inside the service worker, on the device and before
 * uploading (spec 3.3): resize to at most SCREENSHOT_MAX_WIDTH, optional blur,
 * JPEG strictly below SCREENSHOT_MAX_BYTES (Storage rules: `size < 1 MB`).
 *
 * Uses `createImageBitmap` + `OffscreenCanvas` (available in MV3 service
 * workers; no offscreen document needed). Blur: `ctx.filter = 'blur(Npx)'`;
 * where the 2D context of OffscreenCanvas does not support `filter`, a strong
 * downscale + upscale (pixelating then smoothing) gives an equivalent result.
 *
 * The canvas code only runs in a browser (covered by `npm run e2e:extension`);
 * the pure helpers are unit-tested.
 */
import { SCREENSHOT_JPEG_QUALITY, SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_WIDTH } from '@timetracking/shared';

export interface ProcessedImage {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  blurred: boolean;
}

export interface ImageProcessor {
  process(dataUrl: string, opts: { blur: boolean }): Promise<ProcessedImage>;
}

/** Output size: width ≤ maxWidth, aspect ratio kept, integers ≥ 1. */
export function fitWidth(width: number, height: number, maxWidth: number = SCREENSHOT_MAX_WIDTH): { width: number; height: number } {
  if (width <= maxWidth) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = maxWidth / width;
  return { width: maxWidth, height: Math.max(1, Math.round(height * scale)) };
}

/** Blur radius that makes text unreadable at this width (~13 px at 1280). */
export function blurRadiusFor(width: number): number {
  return Math.max(6, Math.round(width / 100));
}

/** Qualities tried in order, then the image is shrunk and the list starts again. */
export const JPEG_QUALITIES = [SCREENSHOT_JPEG_QUALITY, 0.55, 0.4, 0.25] as const;
const SHRINK = 0.75;
const MAX_SHRINKS = 4;

/**
 * Encodes with decreasing quality (and then smaller sizes) until the JPEG is
 * strictly below `maxBytes`. `encode(scale, quality)` renders at `scale` of
 * the base size.
 */
export async function encodeUnderLimit(
  encode: (scale: number, quality: number) => Promise<Blob>,
  maxBytes: number = SCREENSHOT_MAX_BYTES,
): Promise<{ blob: Blob; scale: number; quality: number }> {
  let scale = 1;
  for (let s = 0; s <= MAX_SHRINKS; s++) {
    for (const quality of JPEG_QUALITIES) {
      const blob = await encode(scale, quality);
      if (blob.size < maxBytes) return { blob, scale, quality };
    }
    scale *= SHRINK;
  }
  throw new Error('No se pudo reducir la captura bajo el límite de tamaño');
}

type Ctx2D = OffscreenCanvasRenderingContext2D;

function context(canvas: OffscreenCanvas): Ctx2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D no disponible');
  return ctx;
}

/** True when the 2D context applies CSS filters (Chrome does; checked at runtime anyway). */
export function supportsFilter(ctx: { filter?: string }): boolean {
  if (!('filter' in ctx)) return false;
  const before = ctx.filter;
  ctx.filter = 'blur(2px)';
  const ok = ctx.filter === 'blur(2px)';
  ctx.filter = before ?? 'none';
  return ok;
}

/** Draws `src` blurred on `ctx` (w×h). */
function drawBlurred(ctx: Ctx2D, src: CanvasImageSource, w: number, h: number, useFilter: boolean): void {
  const r = blurRadiusFor(w);
  if (useFilter) {
    ctx.filter = `blur(${r}px)`;
    // Drawn slightly larger so the blur does not fade the borders to black.
    ctx.drawImage(src, -2 * r, -2 * r, w + 4 * r, h + 4 * r);
    ctx.filter = 'none';
    return;
  }
  // Fallback: shrink a lot, then scale back up with smoothing (twice, smoother).
  const factor = Math.max(8, r * 2);
  const sw = Math.max(1, Math.round(w / factor));
  const sh = Math.max(1, Math.round(h / factor));
  const small = new OffscreenCanvas(sw, sh);
  const sctx = context(small);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, 0, 0, sw, sh);
  const mid = new OffscreenCanvas(sw * 4, sh * 4);
  const mctx = context(mid);
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(small, 0, 0, sw * 4, sh * 4);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, 0, 0, w, h);
}

/** Browser implementation (service worker). */
export function createCanvasImageProcessor(): ImageProcessor {
  return {
    async process(dataUrl, opts) {
      const source = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(source);
      try {
        const base = fitWidth(bitmap.width, bitmap.height);
        let blurred = false;
        let out = { width: base.width, height: base.height };
        const { blob } = await encodeUnderLimit(async (scale, quality) => {
          const w = Math.max(1, Math.round(base.width * scale));
          const h = Math.max(1, Math.round(base.height * scale));
          const canvas = new OffscreenCanvas(w, h);
          const ctx = context(canvas);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          if (opts.blur) {
            drawBlurred(ctx, bitmap, w, h, supportsFilter(ctx));
            blurred = true;
          } else {
            ctx.drawImage(bitmap, 0, 0, w, h);
          }
          out = { width: w, height: h };
          return canvas.convertToBlob({ type: 'image/jpeg', quality });
        });
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height, blurred };
      } finally {
        bitmap.close();
      }
    },
  };
}
