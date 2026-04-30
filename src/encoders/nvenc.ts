/**
 * NVENC encoder strategy via ffmpeg.
 *
 * Pipes resized PNG through ffmpeg, encoded as AV1 still-image with the
 * av1_nvenc encoder, written to stdout as an AVIF container.
 *
 * Requires:
 *   - ffmpeg with av1_nvenc and libavif/avif muxer support
 *   - NVIDIA GPU with compute capability sm_89+ for 4:4:4 10-bit
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { EncodeRequest, EncodeResult, FormatConfig } from "../types.js";

export async function nvencEncoder(req: EncodeRequest): Promise<EncodeResult> {
  const pipeline = sharp(req.input);
  if (req.width || req.height) {
    pipeline.resize(req.width, req.height, {
      fit: req.fit ?? "cover",
      withoutEnlargement: true,
    });
  }
  const png = await pipeline.png({ compressionLevel: 0 }).toBuffer();

  // ffmpeg's AVIF muxer requires a seekable output, so we route through
  // a temp file rather than stdout pipe.
  const dir = await mkdtemp(join(tmpdir(), "image-hq-"));
  const outPath = join(dir, `${randomUUID()}.avif`);
  try {
    const args = buildArgs(req.config, outPath);
    await pipeFfmpeg(png, args);
    const data = await readFile(outPath);
    return { data: new Uint8Array(data), format: "avif" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildArgs(config: FormatConfig, outPath: string): string[] {
  const cq = mapQualityToCq(config.quality);
  const pixFmt = pixelFormat(config);
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "image2pipe",
    "-i", "-",
    "-c:v", "av1_nvenc",
    "-cq", String(cq),
    "-pix_fmt", pixFmt,
    "-preset", "p5",
    "-frames:v", "1",
    outPath,
  ];
}

function mapQualityToCq(quality: number): number {
  // NVENC AV1 cq range 0..63 (lower=better). Map quality 100→18, 50→36.
  const q = Math.max(0, Math.min(100, quality));
  return Math.round(63 - (q / 100) * 45);
}

function pixelFormat(config: FormatConfig): string {
  // ffmpeg's av1_nvenc wrapper supports 4:2:0 at 8-bit and 10-bit.
  // 4:4:4 / 4:2:2 not exposed; routing rejects those before we get here.
  return config.depth === 10 ? "yuv420p10le" : "yuv420p";
}

function pipeFfmpeg(input: Buffer, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    const errChunks: Buffer[] = [];

    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`ffmpeg av1_nvenc exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });

    proc.stdin.on("error", reject);
    proc.stdin.end(input);
  });
}
