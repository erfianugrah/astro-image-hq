/**
 * Image content analysis.
 *
 * Computes cheap statistical characteristics from an input buffer using
 * sharp's stats() API. Used by the routing layer to make content-aware
 * decisions (e.g. boost quality for dark gradient images).
 *
 * Performance: stats() is O(pixels). For huge inputs we downsample to a
 * 256px thumbnail first; analysis remains representative because we're
 * only computing aggregates.
 */

import sharp from "sharp";
import type { Characteristics } from "./types.js";

// Rec. 709 luma coefficients
const REC709 = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

const ANALYSIS_THUMB_SIZE = 256;
const DARK_THRESHOLD = 64; // mean luma below this → "dark"
const GRADIENT_STDEV_THRESHOLD = 12; // stdev above this → "has gradient"

export interface AnalyzeOptions {
  /** Override thumbnail size used for analysis (default 256). */
  readonly thumbnailSize?: number;
}

export async function analyzeImage(
  input: Uint8Array,
  options: AnalyzeOptions = {},
): Promise<Characteristics> {
  const size = options.thumbnailSize ?? ANALYSIS_THUMB_SIZE;

  // Downsample large inputs first so stats() stays fast.
  const pipeline = sharp(input).resize(size, size, {
    fit: "inside",
    withoutEnlargement: true,
  });

  const [stats, meta] = await Promise.all([
    pipeline.stats(),
    // metadata() on a separate instance: pipeline operations are irrelevant
    // to it, but this keeps the contract obvious.
    sharp(input).metadata(),
  ]);
  const channels = stats.channels;
  // Sharp's channels follow input order. For RGB images that's [R, G, B].
  // When an alpha channel exists it is included as the LAST stats channel
  // ([R,G,B,A] or [gray,A]).
  const r = channels[0];
  const g = channels[1] ?? r;
  const b = channels[2] ?? r;
  if (!r || !g || !b) {
    throw new Error("analyzeImage: stats() returned no channels");
  }

  // Meaningful transparency = alpha channel present AND not uniformly
  // opaque. A PNG exported with an all-255 alpha channel should stay on
  // the fast encoder paths.
  const alpha = meta.hasAlpha ? channels[channels.length - 1] : undefined;
  const hasAlpha = alpha !== undefined && alpha.min < 255;

  const meanLuma = REC709.r * r.mean + REC709.g * g.mean + REC709.b * b.mean;
  const stdevLuma =
    REC709.r * r.stdev + REC709.g * g.stdev + REC709.b * b.stdev;

  return {
    meanLuma,
    stdevLuma,
    isDark: meanLuma < DARK_THRESHOLD,
    hasGradient: stdevLuma > GRADIENT_STDEV_THRESHOLD,
    hasAlpha,
  };
}
