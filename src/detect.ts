/**
 * Environment capability detection.
 *
 * Probes are independent and run in parallel. Each probe is fault-tolerant:
 * any subprocess failure simply omits that capability from the result.
 *
 * Detection is memoized at module level — tests reset between cases via
 * the `runner` injection point, but production code calls `detect()` once
 * per build.
 */

import { createRequire } from "node:module";
import type {
  AvifencCapability,
  Capabilities,
  FfmpegCapability,
  NvencCapability,
  SharpCapability,
} from "./types.js";
import { defaultRunner, type Runner } from "./runner.js";

export interface DetectOptions {
  readonly runner?: Runner;
}

const NVIDIA_QUERY = [
  "--query-gpu=name,compute_cap,memory.used,memory.total",
  "--format=csv,noheader,nounits",
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectCapabilities(
  options: DetectOptions = {},
): Promise<Capabilities> {
  const runner = options.runner ?? defaultRunner;

  const [sharp, avifenc, ffmpeg, gpuLine] = await Promise.all([
    detectSharp(),
    detectAvifenc(runner),
    detectFfmpeg(runner),
    probeGpu(runner),
  ]);

  const nvenc = composeNvenc(ffmpeg, gpuLine);

  return { sharp, ...(avifenc && { avifenc }), ...(ffmpeg && { ffmpeg }), ...(nvenc && { nvenc }) };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function detectSharp(): SharpCapability {
  // Read sharp's package.json for a version string. Fall back to "unknown"
  // to keep detect.ts pure-ish (no top-level sharp import → faster startup,
  // no ESM/CJS weirdness in tests).
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("sharp/package.json") as { version?: string };
    return { version: pkg.version ?? "unknown" };
  } catch {
    return { version: "unknown" };
  }
}

async function detectAvifenc(runner: Runner): Promise<AvifencCapability | undefined> {
  const r = await runner("avifenc", ["--version"]);
  if (!r.ok) return undefined;
  // "avifenc Version: 1.0.4\nlibavif: 1.0.4..." — first version match wins
  const match = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return { version: match?.[1] ?? "unknown" };
}

async function detectFfmpeg(runner: Runner): Promise<FfmpegCapability | undefined> {
  const v = await runner("ffmpeg", ["-version"]);
  if (!v.ok) return undefined;
  const versionMatch = v.stdout.match(/ffmpeg version (\S+)/);

  const e = await runner("ffmpeg", ["-hide_banner", "-encoders"]);
  const encoders = e.ok ? parseFfmpegEncoders(e.stdout) : [];

  return {
    version: versionMatch?.[1] ?? "unknown",
    encoders,
  };
}

function parseFfmpegEncoders(stdout: string): string[] {
  // Encoder rows: " V....D av1_nvenc            NVIDIA NVENC av1 encoder"
  // Banner legend rows look like " V..... = Video" — skip those (name "=").
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*[VAS][\sA-Z.]{5}\s+(\S+)/);
    if (m?.[1] && m[1] !== "=") out.push(m[1]);
  }
  return out;
}

interface GpuInfo {
  readonly name: string;
  readonly computeCap: string;
  readonly memoryUtilization: number;
}

async function probeGpu(runner: Runner): Promise<GpuInfo | undefined> {
  const r = await runner("nvidia-smi", [...NVIDIA_QUERY]);
  if (!r.ok || !r.stdout.trim()) return undefined;
  const first = r.stdout.split("\n")[0]?.trim();
  if (!first) return undefined;
  const parts = first.split(",").map((s) => s.trim());
  if (parts.length < 4) return undefined;
  const [name, computeCap, used, total] = parts;
  if (!name || !computeCap || !used || !total) return undefined;
  const usedN = Number(used);
  const totalN = Number(total);
  const utilization = totalN > 0 ? usedN / totalN : 0;
  return { name, computeCap, memoryUtilization: utilization };
}

function composeNvenc(
  ffmpeg: FfmpegCapability | undefined,
  gpu: GpuInfo | undefined,
): NvencCapability | undefined {
  if (!ffmpeg || !gpu) return undefined;
  if (!ffmpeg.encoders.includes("av1_nvenc")) return undefined;

  // GPU silicon supports 4:4:4/10-bit on Ada+ (sm_89), but ffmpeg's
  // av1_nvenc wrapper only exposes 4:2:0 8-bit AVIF in practice. We
  // gate NVENC on Turing+ (sm_75) which is the minimum for AV1 NVENC
  // hardware, and accept that all output will be 4:2:0 8-bit.
  const [major, minor] = gpu.computeCap.split(".").map(Number);
  const supportsAvif =
    typeof major === "number" &&
    typeof minor === "number" &&
    (major > 7 || (major === 7 && minor >= 5));

  return {
    gpuName: gpu.name,
    computeCap: gpu.computeCap,
    supportsAvif,
    memoryUtilization: gpu.memoryUtilization,
  };
}
