/**
 * avifenc (libavif CLI) encoder strategy.
 *
 * Resizes input via sharp first (sharp is best at resize), writes PNG to
 * a temp file, then runs avifenc to produce AVIF. Reads result back.
 *
 * libavif 1.x flags used:
 *   -q,--qcolor Q   Quality 0..100 (100 = lossless)
 *   -d,--depth D    Output bit depth: 8, 10, or 12
 *   -y,--yuv F      Chroma format: 444 / 422 / 420
 *   -s,--speed S    Encoder speed 0..10 (0 = slowest/best)
 *   -j,--jobs J     Worker threads
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

  const dir = await mkdtemp(join(tmpdir(), "image-hq-"));
  const id = randomUUID();
  const inPath = join(dir, `${id}.png`);
  const outPath = join(dir, `${id}.avif`);

  try {
    await writeFile(inPath, png);
    const args = buildArgs(req.config, inPath, outPath);
    await runAvifenc(args);
    const data = await readFile(outPath);
    return { data: new Uint8Array(data), format: "avif" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildArgs(config: FormatConfig, inPath: string, outPath: string): string[] {
  const depth = config.depth ?? 8;
  const yuv = mapChroma(config.chromaSubsampling);
  const quality = Math.max(0, Math.min(100, config.quality));
  // effort 0..10 in our world maps inversely to speed (speed 0 = slowest = best).
  const speed = config.effort !== undefined
    ? Math.max(0, Math.min(10, 10 - config.effort))
    : 6;

  const args = [
    "-q", String(quality),
    "-d", String(depth),
    "-y", yuv,
    "-s", String(speed),
    "-j", "all",
  ];
  if (config.codec) args.push("-c", config.codec);
  args.push(inPath, outPath);
  return args;
}

function mapChroma(c: FormatConfig["chromaSubsampling"]): string {
  if (c === "4:2:0") return "420";
  if (c === "4:2:2") return "422";
  return "444";
}

function runAvifenc(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("avifenc", args);
    const errChunks: Buffer[] = [];

    proc.stderr.on("data", (c: Buffer) => errChunks.push(c));
    proc.stdout.on("data", () => {}); // drain

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`avifenc exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}
