/**
 * Service-level override precedence tests.
 *
 * Verifies the boost-floor semantics:
 *   - Bright/typical content: component-level transform.quality drives output
 *     (no shadow boost; profile and component cooperate).
 *   - Dark gradient content: shadow boost overrides component quality
 *     (boost is a floor for content known to band).
 *
 * NOTE: vitest module-scope state is shared across tests in this file.
 * All tests must use the same profile for the cached state to remain valid.
 * We use "photo" so the boost path is reachable.
 */

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import service from "../src/service.js";

const photoConfig = {
  service: { config: { profile: "photo", log: "off" } },
} as unknown as Parameters<typeof service.transform>[2];

// Astro 7.4+ passes a runtime logger as transform()'s 4th argument.
const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const logger = makeLogger() as unknown as Parameters<typeof service.transform>[3];

const brightFlat = async (size = 256) => {
  const data = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const v = 180 + ((x + y) % 30);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return await sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
};

const darkGradient = async (size = 384) => {
  // Couch-like: dark room + bright window patch — reliably triggers shadow rule.
  const buf = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      let v = 18 + Math.round(Math.random() * 8);
      if (y < size / 3 && x > size / 3 && x < (size * 2) / 3) {
        v = 200 + Math.round(Math.random() * 30);
      }
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v - 3;
    }
  }
  return await sharp(buf, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
};

describe("service: override precedence (boost as quality floor)", () => {
  it("component quality drives output for bright (non-boosted) images", async () => {
    const input = new Uint8Array(await brightFlat(256));

    const lo = await service.transform(
      input,
      { src: "b-lo", format: "avif", width: 256, height: 256, quality: 30 },
      photoConfig,
      logger,
    );
    const hi = await service.transform(
      input,
      { src: "b-hi", format: "avif", width: 256, height: 256, quality: 95 },
      photoConfig,
      logger,
    );

    expect(lo.format).toBe("avif");
    expect(hi.format).toBe("avif");
    // No boost on bright content — component q wins, q30 file is smaller.
    expect(lo.data.byteLength).toBeLessThan(hi.data.byteLength);
  });

  it("string quality (URL-param style) is parsed and honored", async () => {
    const input = new Uint8Array(await brightFlat(256));
    const result = await service.transform(
      input,
      { src: "p-str", format: "avif", width: 256, height: 256, quality: "70" },
      photoConfig,
      logger,
    );
    expect(result.format).toBe("avif");
    expect(result.data.byteLength).toBeGreaterThan(0);
  });

  it("shadow boost overrides component quality on dark gradient", async () => {
    const input = new Uint8Array(await darkGradient(384));

    // Boost forces q95 + 4:4:4 + aom regardless of component value.
    // Both outputs should land at q95 → sizes within encoder noise.
    const lo = await service.transform(
      input,
      { src: "d-lo", format: "avif", width: 384, height: 384, quality: 30 },
      photoConfig,
      logger,
    );
    const hi = await service.transform(
      input,
      { src: "d-hi", format: "avif", width: 384, height: 384, quality: 95 },
      photoConfig,
      logger,
    );

    expect(lo.format).toBe("avif");
    expect(hi.format).toBe("avif");

    // Both should be encoded at q95 (boost wins). Sizes within ±15% slack
    // for inherent encoder non-determinism with random input content.
    const ratio = lo.data.byteLength / hi.data.byteLength;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);

    // Both must be 10-bit (boost's depth=10).
    const meta = await sharp(hi.data).metadata();
    expect(meta.bitsPerSample).toBe(10);
  });
});

describe("propertiesToHash", () => {
  it("includes the package version so consumer caches invalidate on upgrade", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgVersion = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
    ).version;
    expect(pkgVersion).toBe("0.1.6");
    expect(service.propertiesToHash).toBeDefined();
    expect(service.propertiesToHash).toContain(pkgVersion);
  });
});

describe("sharp fallback forwards the Astro logger (0.1.6)", () => {
  it("an svg request on a PNG source warns through the logger instead of throwing", async () => {
    const input = new Uint8Array(await brightFlat(64));
    const log = makeLogger();
    const result = await service.transform(
      input,
      { src: "not-really.svg", format: "svg", width: 64, height: 64 },
      photoConfig,
      log as unknown as Parameters<typeof service.transform>[3],
    );
    expect(result.data.byteLength).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toMatch(/expected an SVG/);
  });
});
