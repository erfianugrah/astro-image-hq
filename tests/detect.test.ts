import { describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/detect.js";
import type { Runner } from "../src/runner.js";

/** Build a runner that returns scripted responses. Matches when the table key
 *  is a prefix of `${cmd} ${args.join(" ")}` — lets tests key on `${cmd} ${args[0]}`. */
const stub = (
  table: Record<string, { stdout?: string; stderr?: string; ok?: boolean }>,
): Runner => {
  return async (cmd, args) => {
    const full = `${cmd} ${args.join(" ")}`.trim();
    const hit = Object.entries(table).find(([key]) => full.startsWith(key));
    if (!hit) return { stdout: "", stderr: "command not found", ok: false };
    const [, value] = hit;
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      ok: value.ok ?? true,
    };
  };
};

describe("detectCapabilities", () => {
  it("always reports sharp as present", async () => {
    const caps = await detectCapabilities({ runner: stub({}) });
    expect(caps.sharp.version).toBeTruthy();
  });

  it("detects avifenc when present", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "avifenc --version": { stdout: "avifenc Version: 1.0.4\nlibavif: 1.0.4" },
      }),
    });
    expect(caps.avifenc).toBeDefined();
    expect(caps.avifenc!.version).toBe("1.0.4");
  });

  it("omits avifenc when binary missing", async () => {
    const caps = await detectCapabilities({ runner: stub({}) });
    expect(caps.avifenc).toBeUndefined();
  });

  it("detects ffmpeg and parses encoder list", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "ffmpeg -version": { stdout: "ffmpeg version 7.1 Copyright" },
        "ffmpeg -hide_banner": {
          stdout: ` V....D libaom-av1\n V..... libsvtav1\n V....D av1_nvenc\n`,
        },
      }),
    });
    expect(caps.ffmpeg).toBeDefined();
    expect(caps.ffmpeg!.version).toBe("7.1");
    expect(caps.ffmpeg!.encoders).toContain("av1_nvenc");
    expect(caps.ffmpeg!.encoders).toContain("libsvtav1");
  });

  it("detects NVENC AV1 on Turing+ GPU", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "ffmpeg -version": { stdout: "ffmpeg version 7.1" },
        "ffmpeg -hide_banner": { stdout: " V....D av1_nvenc" },
        "nvidia-smi --query-gpu=name,compute_cap,memory.used,memory.total --format=csv,noheader,nounits": {
          stdout: "NVIDIA GeForce RTX 5090, 12.0, 1024, 32768",
        },
      }),
    });
    expect(caps.nvenc).toBeDefined();
    expect(caps.nvenc!.gpuName).toBe("NVIDIA GeForce RTX 5090");
    expect(caps.nvenc!.computeCap).toBe("12.0");
    expect(caps.nvenc!.supportsAvif).toBe(true);
    expect(caps.nvenc!.memoryUtilization).toBeCloseTo(1024 / 32768, 4);
  });

  it("disables NVENC AVIF on pre-Turing GPU (sm < 7.5)", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "ffmpeg -version": { stdout: "ffmpeg version 7.1" },
        "ffmpeg -hide_banner": { stdout: " V....D av1_nvenc" },
        "nvidia-smi --query-gpu=name,compute_cap,memory.used,memory.total --format=csv,noheader,nounits": {
          stdout: "NVIDIA GeForce GTX 1080, 6.1, 1024, 8192",
        },
      }),
    });
    expect(caps.nvenc).toBeDefined();
    expect(caps.nvenc!.supportsAvif).toBe(false);
  });

  it("omits NVENC when ffmpeg lacks av1_nvenc", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "ffmpeg -version": { stdout: "ffmpeg version 6.0" },
        "ffmpeg -hide_banner": { stdout: " V....D libaom-av1" },
        "nvidia-smi --query-gpu=name,compute_cap,memory.used,memory.total --format=csv,noheader,nounits": {
          stdout: "NVIDIA GeForce RTX 5090, 12.0, 0, 32768",
        },
      }),
    });
    expect(caps.nvenc).toBeUndefined();
  });

  it("omits NVENC when no GPU present", async () => {
    const caps = await detectCapabilities({
      runner: stub({
        "ffmpeg -version": { stdout: "ffmpeg version 7.1" },
        "ffmpeg -hide_banner": { stdout: " V....D av1_nvenc" },
      }),
    });
    expect(caps.nvenc).toBeUndefined();
  });

  it("returns minimal caps when nothing available (template default)", async () => {
    const caps = await detectCapabilities({ runner: stub({}) });
    expect(caps.sharp).toBeDefined();
    expect(caps.avifenc).toBeUndefined();
    expect(caps.ffmpeg).toBeUndefined();
    expect(caps.nvenc).toBeUndefined();
  });
});
