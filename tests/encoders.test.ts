import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sharpEncoder } from "../src/encoders/sharp.js";
import { avifencEncoder } from "../src/encoders/avifenc.js";
import { nvencEncoder } from "../src/encoders/nvenc.js";
import { clampEvenDims } from "../src/even-dims.js";
import type { EncodeRequest } from "../src/types.js";

const png = (color = { r: 32, g: 32, b: 32 }) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .png()
    .toBuffer();

const baseReq = async (overrides: Partial<EncodeRequest> = {}): Promise<EncodeRequest> => ({
  input: new Uint8Array(await png()),
  format: "avif",
  width: 64,
  height: 64,
  config: {
    encoderPreference: ["sharp"],
    quality: 80,
    depth: 8,
    chromaSubsampling: "4:4:4",
    effort: 4,
  },
  ...overrides,
});

describe("sharpEncoder", () => {
  it("encodes AVIF and returns the requested format", async () => {
    const req = await baseReq();
    const result = await sharpEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    // AVIF magic: ftyp box at offset 4
    const view = Buffer.from(result.data);
    expect(view.toString("ascii", 4, 8)).toBe("ftyp");
  });

  it("respects width/height resize options", async () => {
    const big = sharp({
      create: { width: 256, height: 256, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    const req = await baseReq({
      input: new Uint8Array(await big),
      format: "webp",
      width: 64,
      height: 64,
      config: { encoderPreference: ["sharp"], quality: 80 },
    });
    const result = await sharpEncoder(req);
    const meta = await sharp(result.data).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });

  it("encodes PNG losslessly", async () => {
    const req = await baseReq({
      format: "png",
      config: { encoderPreference: ["sharp"], quality: 100 },
    });
    const result = await sharpEncoder(req);
    expect(result.format).toBe("png");
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("png");
  });

  it("applies mozjpeg flag when set for JPEG", async () => {
    const req = await baseReq({
      format: "jpeg",
      config: { encoderPreference: ["sharp"], quality: 85, mozjpeg: true },
    });
    const result = await sharpEncoder(req);
    expect(result.format).toBe("jpeg");
  });

  it("clamps odd-dim 4:2:0 AVIF output to even via corrective resize", async () => {
    // Source 853x480 (odd width). Target 400x300 (even). fit:inside.
    // Pre-resize clamp to 400x300. Sharp fits within, producing odd height.
    // Post-resize evenOutputDims floors odd height to even (400x224).
    const odd = await sharp({
      create: { width: 853, height: 480, channels: 3, background: "#333" },
    }).png().toBuffer();
    const req = await baseReq({
      input: new Uint8Array(odd),
      width: 400,
      height: 300,
      fit: "inside",
      config: {
        encoderPreference: ["sharp"],
        quality: 80,
        depth: 8,
        chromaSubsampling: "4:2:0",
        effort: 4,
      },
    });
    const result = await sharpEncoder(req);
    const meta = await sharp(result.data).metadata();
    expect(meta.width).toBe(400);
    expect(meta.width! % 2).toBe(0);
    expect(meta.height! % 2).toBe(0);
    expect(meta.height).toBe(224);
  });

  it("leaves odd dims untouched for 4:4:4 AVIF", async () => {
    const odd = await sharp({
      create: { width: 129, height: 129, channels: 3, background: "#444" },
    }).png().toBuffer();
    const req = await baseReq({
      input: new Uint8Array(odd),
      width: 129,
      height: 129,
      config: {
        encoderPreference: ["sharp"],
        quality: 80,
        chromaSubsampling: "4:4:4" as const,
        effort: 4,
      },
    });
    const result = await sharpEncoder(req);
    const meta = await sharp(result.data).metadata();
    expect(meta.width).toBe(129);
    expect(meta.height).toBe(129);
  });
});

// avifenc and nvenc are integration tests — skip when binaries missing.
const hasCmd = async (cmd: string, ...args: string[]): Promise<boolean> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    await exec(cmd, args);
    return true;
  } catch {
    return false;
  }
};

const avifencAvailable = await hasCmd("avifenc", "--version");
const nvencAvailable =
  (await hasCmd("ffmpeg", "-hide_banner", "-version")) &&
  (await hasCmd("nvidia-smi", "-L"));

describe.skipIf(!avifencAvailable)("avifencEncoder (integration)", () => {
  it("produces a decodable AVIF", async () => {
    const req = await baseReq({
      config: {
        encoderPreference: ["avifenc"],
        quality: 90,
        depth: 10,
        chromaSubsampling: "4:4:4",
      },
    });
    const result = await avifencEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    const view = Buffer.from(result.data);
    expect(view.toString("ascii", 4, 8)).toBe("ftyp");
    // sharp can decode the result back
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("heif");
    expect(meta.width).toBe(64);
  });

  it("survives svt codec request on input with odd dimensions (4:2:0)", async () => {
    // 853x480 source with 4:2:0 AVIF. clampEvenDims floors width to 852
    // (height 480 already even). Sharp fit:inside resize scales to ~852x479.
    // Post-resize evenOutputDims floors height 479→478. Output: 852x478.
    const odd = await sharp({
      create: { width: 853, height: 480, channels: 3, background: "#222" },
    })
      .png()
      .toBuffer();
    const req: EncodeRequest = {
      input: new Uint8Array(odd),
      format: "avif",
      width: 853,
      height: 480,
      fit: "inside",
      config: {
        encoderPreference: ["avifenc"],
        quality: 88,
        depth: 10,
        chromaSubsampling: "4:2:0",
        codec: "svt",
        effort: 4,
      },
    };
    const result = await avifencEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("heif");
    // Even-dim clamp floors 853->852, 480->479 (aspect ratio), then
    // post-resize clamp floors 479->478 for 4:2:0 AVIF (Firefox compat).
    expect(meta.width).toBe(852);
    expect(meta.height).toBe(478);
  });
});

describe.skipIf(!nvencAvailable)("nvencEncoder (integration)", () => {
  it("produces a decodable 4:2:0 8-bit AVIF via av1_nvenc", async () => {
    // NVENC AV1 needs >= 128px input
    const big = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "#222" },
    })
      .png()
      .toBuffer();
    const req = await baseReq({
      input: new Uint8Array(big),
      width: 256,
      height: 256,
      config: {
        encoderPreference: ["nvenc"],
        quality: 85,
        depth: 8,
        chromaSubsampling: "4:2:0",
      },
    });
    const result = await nvencEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    const view = Buffer.from(result.data);
    expect(view.toString("ascii", 4, 8)).toBe("ftyp");
  });

  it("falls back to sharp for sub-128px images (NVENC AV1 minimum)", async () => {
    const tiny = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#222" },
    })
      .png()
      .toBuffer();
    const req = await baseReq({
      input: new Uint8Array(tiny),
      width: 64,
      height: 64,
      config: {
        encoderPreference: ["nvenc"],
        quality: 80,
        depth: 8,
        chromaSubsampling: "4:2:0",
      },
    });
    // Should not throw — NVENC encoder delegates to sharp internally
    const result = await nvencEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    const meta = await sharp(result.data).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });
});

describe("clampEvenDims", () => {
  const cfg420 = {
    encoderPreference: ["sharp"] as const,
    quality: 80,
    chromaSubsampling: "4:2:0" as const,
  };
  const cfg422 = {
    encoderPreference: ["sharp"] as const,
    quality: 80,
    chromaSubsampling: "4:2:2" as const,
  };
  const cfg444 = {
    encoderPreference: ["sharp"] as const,
    quality: 80,
    chromaSubsampling: "4:4:4" as const,
  };
  const cfgNone = {
    encoderPreference: ["sharp"] as const,
    quality: 80,
  };

  it("floors both dims to even for AVIF 4:2:0", () => {
    expect(clampEvenDims(853, 481, "avif", cfg420)).toEqual({ width: 852, height: 480 });
  });

  it("leaves already-even dims alone for AVIF 4:2:0", () => {
    expect(clampEvenDims(852, 480, "avif", cfg420)).toEqual({ width: 852, height: 480 });
  });

  it("floors width only for AVIF 4:2:2", () => {
    expect(clampEvenDims(853, 481, "avif", cfg422)).toEqual({ width: 852, height: 481 });
  });

  it("leaves odd dims untouched for AVIF 4:4:4", () => {
    expect(clampEvenDims(853, 481, "avif", cfg444)).toEqual({ width: 853, height: 481 });
  });

  it("leaves dims untouched for non-AVIF formats", () => {
    expect(clampEvenDims(853, 481, "webp", cfg420)).toEqual({ width: 853, height: 481 });
  });

  it("leaves dims untouched when no chroma set", () => {
    expect(clampEvenDims(853, 481, "avif", cfgNone)).toEqual({ width: 853, height: 481 });
  });

  it("handles undefined dims", () => {
    expect(clampEvenDims(undefined, 481, "avif", cfg420)).toEqual({ width: undefined, height: 480 });
    expect(clampEvenDims(853, undefined, "avif", cfg420)).toEqual({ width: 852, height: undefined });
  });
});
