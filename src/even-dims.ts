/**
 * Shared even-dimension clamp for AVIF 4:2:0 output.
 *
 * Firefox rejects AVIFs with odd dimensions encoded 4:2:0 ("Image corrupt
 * or truncated"). aom pads odd dims and crops in-bitstream - Chrome honors
 * this, Firefox does not without a container clap box.
 *
 * Two helpers:
 *   clampEvenDims - pre-resize target-dim clamp (best-effort)
 *   evenOutputDims - post-resize actual-dim clamp (corrective)
 *
 * Floors to even: never exceeds the caller's max dims under fit:inside.
 * 4:2:2 needs even width only. 4:4:4 is left untouched.
 */

import type { FormatConfig, OutputFormat } from "./types.js";

export interface EvenDims {
  width?: number;
  height?: number;
}

/** Pre-resize: clamp target max dimensions to even before handing to sharp. */
export function clampEvenDims(
  width: number | undefined,
  height: number | undefined,
  format: OutputFormat,
  config: FormatConfig,
): EvenDims {
  if (format !== "avif" || !config.chromaSubsampling) return { width, height };
  const chroma = config.chromaSubsampling;
  if (chroma === "4:2:0") {
    return {
      width: typeof width === "number" ? width - (width % 2) : undefined,
      height: typeof height === "number" ? height - (height % 2) : undefined,
    };
  }
  if (chroma === "4:2:2") {
    return {
      width: typeof width === "number" ? width - (width % 2) : undefined,
      height,
    };
  }
  return { width, height };
}

/** Floor a number to its even neighbour. */
export function floorEven(n: number): number {
  return n - (n % 2);
}

/** Post-resize: clamp ACTUAL output dimensions to even for 4:2:0 AVIF. */
export function evenOutputDims(
  width: number,
  height: number,
  format: OutputFormat,
  config: FormatConfig,
): { width: number; height: number } {
  if (format !== "avif" || !config.chromaSubsampling) return { width, height };
  const chroma = config.chromaSubsampling;
  if (chroma === "4:2:0") {
    return { width: floorEven(width), height: floorEven(height) };
  }
  if (chroma === "4:2:2") {
    return { width: floorEven(width), height };
  }
  return { width, height };
}