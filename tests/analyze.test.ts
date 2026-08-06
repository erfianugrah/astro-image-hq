import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeImage } from "../src/analyze.js";

const png = (color: { r: number; g: number; b: number }) =>
  sharp({
    create: { width: 64, height: 64, channels: 3, background: color },
  })
    .png()
    .toBuffer();

const gradient = async (start: number, end: number) => {
  const w = 64;
  const h = 64;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round(start + ((end - start) * y) / (h - 1));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
};

describe("analyzeImage", () => {
  it("classifies a near-black flat image as dark with no gradient", async () => {
    const buf = await png({ r: 16, g: 16, b: 16 });
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.isDark).toBe(true);
    expect(c.hasGradient).toBe(false);
    expect(c.meanLuma).toBeLessThan(32);
  });

  it("classifies a bright flat image as light with no gradient", async () => {
    const buf = await png({ r: 230, g: 230, b: 230 });
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.isDark).toBe(false);
    expect(c.hasGradient).toBe(false);
    expect(c.meanLuma).toBeGreaterThan(200);
  });

  it("classifies a dark gradient as dark with gradient (the banding case)", async () => {
    const buf = await gradient(8, 80);
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.isDark).toBe(true);
    expect(c.hasGradient).toBe(true);
  });

  it("classifies a bright gradient as light with gradient", async () => {
    const buf = await gradient(150, 230);
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.isDark).toBe(false);
    expect(c.hasGradient).toBe(true);
  });

  it("computes weighted luma using rec.709 coefficients", async () => {
    // Pure red — luma should be ~54 (0.2126 * 255)
    const buf = await png({ r: 255, g: 0, b: 0 });
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.meanLuma).toBeCloseTo(54, 0);
  });

  it("returns reasonable values for a 1x1 input", async () => {
    const buf = await png({ r: 50, g: 50, b: 50 });
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.meanLuma).toBeGreaterThan(40);
    expect(c.meanLuma).toBeLessThan(60);
  });
});

describe("analyzeImage - alpha detection", () => {
  it("detects meaningful transparency (alpha min < 255)", async () => {
    const buf = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 10, g: 10, b: 10, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.hasAlpha).toBe(true);
  });

  it("reports no alpha for opaque RGB images", async () => {
    const buf = await png({ r: 200, g: 200, b: 200 });
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.hasAlpha).toBe(false);
  });

  it("treats a uniformly-opaque alpha channel as opaque (no rerouting)", async () => {
    // Many editors export PNGs with an all-255 alpha channel; these must
    // stay on the fast encoder paths.
    const buf = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 200, g: 200, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const c = await analyzeImage(new Uint8Array(buf));
    expect(c.hasAlpha).toBe(false);
  });
});
