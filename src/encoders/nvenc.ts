/**
 * NVENC encoder strategy via ffmpeg.
 *
 * Pipes resized PNG through ffmpeg, encoded as AV1 still-image with the
 * av1_nvenc encoder, written to a temp file (the AVIF muxer requires
 * seekable output).
 *
 * Constraints:
 *   - Requires ffmpeg with av1_nvenc + libavif/avif muxer support
 *   - Requires NVIDIA GPU with AV1 NVENC (sm_75+, Turing or newer)
 *   - 4:2:0 chroma only (8-bit or 10-bit) — wrapper limitation
 *   - Minimum frame dimension: 128x128
 *
 * The route layer gates on transform dimensions before this encoder is
 * picked, but post-resize actual dimensions can still drop below the
 * minimum (e.g. fit:inside on small sources). When that happens we
 * delegate to the sharp encoder as a fallback rather than crashing.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { EncodeRequest, EncodeResult, FormatConfig } from "../types.js";
import { sharpEncoder } from "./sharp.js";
import { clampEvenDims, evenOutputDims } from "../even-dims.js";

const NVENC_MIN_DIM = 128;

export async function nvencEncoder(req: EncodeRequest): Promise<EncodeResult> {
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
  // Materialize PNG and check actual post-resize dimensions. NVENC AV1
  // rejects inputs smaller than 128x128 - fall back to sharp for tiny
  // outputs (favicons, sub-thumbnail variants) rather than crashing.
  let { data: png, info } = await pipeline
    .png({ compressionLevel: 0 })
    .toBuffer({ resolveWithObject: true });

  // Post-resize even-dim clamp for 4:2:0 AVIF - Firefox rejects odd-dim
  // AVIFs without a clap box.
  const dims = evenOutputDims(info.width, info.height, req.format, req.config);
  if (dims.width !== info.width || dims.height !== info.height) {
    png = await sharp(png)
      .resize(dims.width, dims.height, { fit: "fill" })
      .png({ compressionLevel: 0 })
      .toBuffer();
    info = { ...info, width: dims.width, height: dims.height };
  }

  if (Math.min(info.width, info.height) < NVENC_MIN_DIM) {
    return sharpEncoder(req);
  }

  const dir = await mkdtemp(join(tmpdir(), "image-hq-"));
  const outPath = join(dir, `${randomUUID()}.avif`);
  try {
    const args = buildArgs(req.config, outPath);
    try {
      await pipeFfmpeg(png, args);
    } catch (err) {
      // Defense-in-depth: if NVENC still errors despite our checks,
      // fall back to sharp rather than failing the whole build.
      return sharpEncoder(req);
    }
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
