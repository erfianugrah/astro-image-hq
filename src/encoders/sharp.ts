/**
 * Sharp encoder strategy.
 *
 * Wraps libvips/sharp directly. Default for non-AVIF formats and the
 * universal fallback when other encoders are unavailable.
 */

import sharp, { type AvifOptions, type WebpOptions, type JpegOptions } from "sharp";
import type { EncodeRequest, EncodeResult } from "../types.js";
import { clampEvenDims, evenOutputDims } from "../even-dims.js";

export async function sharpEncoder(req: EncodeRequest): Promise<EncodeResult> {
  const pipeline = sharp(req.input);

  // Clamp target dims to even for 4:2:0 AVIF - Firefox rejects odd-dim
  // AVIFs without a clap box (Chrome handles aom's in-bitstream crop).
  const even = clampEvenDims(req.width, req.height, req.format, req.config);
  if (even.width || even.height) {
    pipeline.resize(even.width, even.height, {
      fit: req.fit ?? "cover",
      withoutEnlargement: true,
    });
  }

  // Post-resize: raw round-trip to verify actual dimensions are even.
  // Pre-resize clamping is best-effort; aspect-ratio scaling under
  // fit:inside can still produce odd outputs.
  if (req.format === "avif" && req.config.chromaSubsampling === "4:2:0") {
    const { data: raw, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const dims = evenOutputDims(info.width, info.height, req.format, req.config);
    const clamped = sharp(raw, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
    if (dims.width !== info.width || dims.height !== info.height) {
      clamped.resize(dims.width, dims.height, { fit: "fill" });
    }
    const data = await applyFormat(clamped, req).toBuffer();
    return { data: new Uint8Array(data), format: req.format };
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
