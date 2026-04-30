/**
 * avifenc (libavif CLI) encoder strategy.
 *
 * Resizes input via sharp first (sharp is best at resize), then pipes the
 * resized PNG through avifenc on stdin and reads AVIF from stdout.
 *
 * libavif CLI flags (v1.0+):
 *   --depth 8|10|12          Bit depth
 *   --yuv 444|422|420         Chroma subsampling
 *   --min N                   Min quantizer (lower = higher quality)
 *   --max N                   Max quantizer (lower = higher quality)
 *   --speed N                 Encoder speed (0=slow/best ... 10=fast)
 *   -                         Read stdin / write stdout
 */

import { spawn } from "node:child_process";
import sharp from "sharp";
import type { EncodeRequest, EncodeResult, FormatConfig } from "../types.js";

export async function avifencEncoder(req: EncodeRequest): Promise<EncodeResult> {
  // Pre-resize via sharp; emit PNG so avifenc decodes losslessly.
  const pipeline = sharp(req.input);
  if (req.width || req.height) {
    pipeline.resize(req.width, req.height, {
      fit: req.fit ?? "cover",
      withoutEnlargement: true,
    });
  }
  const png = await pipeline.png({ compressionLevel: 0 }).toBuffer();

  const args = buildArgs(req.config);
  const data = await pipeAvifenc(png, args);
  return { data, format: "avif" };
}

function buildArgs(config: FormatConfig): string[] {
  const depth = config.depth ?? 8;
  const yuv = mapChroma(config.chromaSubsampling);
  // Map quality (0..100) to quantizer range. avifenc defaults: min 0, max 63.
  // Higher quality → lower quantizer ceiling.
  const q = Math.max(0, Math.min(100, config.quality));
  const max = Math.round(63 - (q / 100) * 53); // q=100→10, q=50→36
  const min = Math.max(0, max - 12);
  const speed = config.effort !== undefined ? Math.max(0, 10 - config.effort) : 6;

  return [
    "--depth", String(depth),
    "--yuv", yuv,
    "--min", String(min),
    "--max", String(max),
    "--speed", String(speed),
    "-", "-", // stdin → stdout
  ];
}

function mapChroma(c: FormatConfig["chromaSubsampling"]): string {
  if (c === "4:2:0") return "420";
  if (c === "4:2:2") return "422";
  return "444";
}

function pipeAvifenc(input: Buffer, args: string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn("avifenc", args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`avifenc exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });

    proc.stdin.on("error", reject);
    proc.stdin.end(input);
  });
}
