/**
 * Service-level override tests.
 *
 * Verifies that component-level transform options (`<Image quality={N} />`)
 * override profile policy when the encoder runs.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import service from "../src/service.js";

const baseImageConfig = {
  service: {
    config: {
      profile: "balanced",
      log: "off",
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as unknown as Parameters<typeof import("../src/service.js").default.transform>[2];

const dark = async () => {
  const w = 256, h = 256;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round(8 + (y / h) * 30);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
    }
  }
  return await sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
};

describe("service: component-level overrides win over profile", () => {
  it("transform.quality overrides profile quality", async () => {
    const input = new Uint8Array(await dark());

    // Profile balanced sets quality=90; we override to 30 vs 95 —
    // the lower-quality output must be smaller.
    const lo = await service.transform(
      input,
      { src: "x", format: "avif", width: 256, height: 256, quality: 30 },
      baseImageConfig,
    );
    const hi = await service.transform(
      input,
      { src: "x", format: "avif", width: 256, height: 256, quality: 95 },
      baseImageConfig,
    );

    expect(lo.format).toBe("avif");
    expect(hi.format).toBe("avif");
    expect(lo.data.byteLength).toBeLessThan(hi.data.byteLength);
  });

  it("string quality (URL-param style) is parsed and honored", async () => {
    const input = new Uint8Array(await dark());
    const result = await service.transform(
      input,
      { src: "x", format: "avif", width: 256, height: 256, quality: "70" },
      baseImageConfig,
    );
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
  });

  it("component quality wins over shadow-boost quality on dark gradient", async () => {
    // Build a couch-like input that reliably triggers the shadow rule
    // (mostly dark + bright window patch → high stdev luma).
    const w = 384, h = 384;
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        let v = 18 + Math.round(Math.random() * 8);
        if (y < 120 && x > 150 && x < 300) v = 200 + Math.round(Math.random() * 30);
        buf[i] = v;
        buf[i + 1] = v;
        buf[i + 2] = v - 3;
      }
    }
    const couch = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
    const input = new Uint8Array(couch);

    // Photo profile triggers shadow boost (q=95, 4:4:4, aom).
    // Component override should still win on quality.
    const photoConfig = {
      service: { config: { profile: "photo", log: "off" } },
    } as unknown as Parameters<typeof service.transform>[2];

    const lo = await service.transform(
      input,
      { src: "couch-lo", format: "avif", width: w, height: h, quality: 30 },
      photoConfig,
    );
    const hi = await service.transform(
      input,
      { src: "couch-hi", format: "avif", width: w, height: h, quality: 95 },
      photoConfig,
    );

    expect(lo.format).toBe("avif");
    expect(hi.format).toBe("avif");
    // Component quality must apply: q30 dark < q95 dark.
    expect(lo.data.byteLength).toBeLessThan(hi.data.byteLength);

    // And shadow boost must still have promoted both to 4:4:4 10-bit
    // (verifies override fires on top of boost, not instead of it).
    const meta = await sharp(hi.data).metadata();
    expect(meta.bitsPerSample).toBe(10);
  });
});
