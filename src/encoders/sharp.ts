/**
 * Sharp encoder strategy.
 *
 * Wraps libvips/sharp directly. Default for non-AVIF formats and the
 * universal fallback when other encoders are unavailable.
 */

import sharp, { type AvifOptions, type WebpOptions, type JpegOptions } from "sharp";
import type { EncodeRequest, EncodeResult } from "../types.js";

export async function sharpEncoder(req: EncodeRequest): Promise<EncodeResult> {
  const pipeline = sharp(req.input);

  if (req.width || req.height) {
    pipeline.resize(req.width, req.height, {
      fit: req.fit ?? "cover",
      withoutEnlargement: true,
    });
  }

  const data = await applyFormat(pipeline, req).toBuffer();
  return { data: new Uint8Array(data), format: req.format };
}

function applyFormat(
  pipeline: sharp.Sharp,
  req: EncodeRequest,
): sharp.Sharp {
  const { format, config } = req;
  if (format === "avif") {
    const opts: AvifOptions = {
      quality: config.quality,
      effort: config.effort ?? 4,
      ...(config.chromaSubsampling && { chromaSubsampling: config.chromaSubsampling }),
    };
    return pipeline.avif(opts);
  }
  if (format === "webp") {
    const opts: WebpOptions = {
      quality: config.quality,
      effort: config.effort ?? 4,
    };
    return pipeline.webp(opts);
  }
  if (format === "jpeg") {
    const opts: JpegOptions = {
      quality: config.quality,
      ...(config.mozjpeg !== undefined && { mozjpeg: config.mozjpeg }),
      ...(config.chromaSubsampling && { chromaSubsampling: config.chromaSubsampling }),
    };
    return pipeline.jpeg(opts);
  }
  // png — quality is unused; libvips picks zlib level
  return pipeline.png();
}
