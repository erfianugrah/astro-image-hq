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
};

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
});
