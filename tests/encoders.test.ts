import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sharpEncoder } from "../src/encoders/sharp.js";
import { avifencEncoder } from "../src/encoders/avifenc.js";
import { nvencEncoder } from "../src/encoders/nvenc.js";
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
    // 853x480 — odd width that crashes svt+4:2:0 if we don't drop -c.
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
        codec: "svt", // would crash without the encoder-level fallback
        effort: 4,
      },
    };
    const result = await avifencEncoder(req);
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe("heif");
    expect(meta.width).toBe(853);
    expect(meta.height).toBe(480);
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
