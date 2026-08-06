import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeImage } from "../src/analyze.js";
import { decide } from "../src/route.js";
import { avifencEncoder } from "../src/encoders/avifenc.js";
import { BUILTIN_PROFILES } from "../src/profiles.js";
import type { Capabilities } from "../src/types.js";

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

const avifToolsAvailable =
  (await hasCmd("avifenc", "--version")) && (await hasCmd("avifdec", "--version"));

const caps: Capabilities = {
  sharp: { version: "0.34.5" },
  avifenc: { version: "1.4.1", codecs: ["aom", "svt", "rav1e"] },
};

/**
 * End-to-end proof for the alpha-routing fix: a transparent-background logo
 * (the shape that regressed into a solid black square downstream) must keep
 * its alpha through analyze -> decide -> avifenc encode. sharp cannot decode
 * 10-bit AVIF in every environment, so the round-trip decode goes through
 * avifdec, matching the repo's integration-test conventions.
 */
describe.skipIf(!avifToolsAvailable)("alpha routing (integration)", () => {
  it("transparent logo keeps alpha through the full pipeline", async () => {
    // Transparent-background logo: sharp RGBA canvas, half transparent.
    const input = new Uint8Array(
      await sharp({
        create: {
          width: 360,
          height: 360,
          channels: 4,
          background: { r: 10, g: 10, b: 10, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    );

    const char = await analyzeImage(input);
    expect(char.hasAlpha).toBe(true);

    // photo profile is the one whose fast path destroyed alpha downstream.
    const d = decide({
      caps,
      char,
      profile: BUILTIN_PROFILES.photo,
      format: "avif",
      width: 360,
      height: 360,
    });
    expect(d.encoder).toBe("avifenc");
    expect(d.config.codec).toBeUndefined(); // svt dropped -> aom default

    const out = await avifencEncoder({
      input,
      format: "avif",
      width: 360,
      height: 360,
      fit: "inside",
      config: d.config,
    });

    const dir = mkdtempSync(join(tmpdir(), "alpha-e2e-"));
    try {
      const avifPath = join(dir, "out.avif");
      const pngPath = join(dir, "out.png");
      writeFileSync(avifPath, out.data);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("avifdec", [avifPath, pngPath]);

      const { data, info } = await sharp(readFileSync(pngPath))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let min = 255;
      for (let i = 3; i < data.length; i += info.channels) {
        if (data[i]! < min) min = data[i]!;
      }
      expect(min).toBeLessThan(255); // transparency survived
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
