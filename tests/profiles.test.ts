import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROFILES,
  getProfile,
  mergeProfile,
} from "../src/profiles.js";
import type { Profile } from "../src/types.js";

describe("BUILTIN_PROFILES", () => {
  it("ships fast, balanced, hq, photo", () => {
    expect(Object.keys(BUILTIN_PROFILES).sort()).toEqual([
      "balanced",
      "fast",
      "hq",
      "photo",
    ]);
  });

  it("fast profile uses sharp only and is silent on missing encoders", () => {
    const p = BUILTIN_PROFILES.fast;
    expect(p.formats.avif.encoderPreference).toEqual(["sharp"]);
    expect(p.formats.avif.depth).toBe(8);
    expect(p.onMissingEncoder).toBe("silent");
  });

  it("hq profile prefers avifenc with 10-bit and fails hard", () => {
    const p = BUILTIN_PROFILES.hq;
    expect(p.formats.avif.encoderPreference[0]).toBe("avifenc");
    expect(p.formats.avif.depth).toBe(10);
    expect(p.formats.avif.chromaSubsampling).toBe("4:4:4");
    expect(p.onMissingEncoder).toBe("fail");
  });

  it("balanced profile warns on missing encoders", () => {
    expect(BUILTIN_PROFILES.balanced.onMissingEncoder).toBe("warn");
  });

  it("photo profile includes a content-aware shadow rule", () => {
    const p = BUILTIN_PROFILES.photo;
    expect(p.contentAware).toBeDefined();
    expect(p.contentAware!.length).toBeGreaterThanOrEqual(1);
    const rule = p.contentAware![0]!;
    // Trigger on dark + gradient image
    expect(
      rule.when({
        meanLuma: 30,
        stdevLuma: 28,
        isDark: true,
        hasGradient: true,
      }),
    ).toBe(true);
    // Don't trigger on bright flat image
    expect(
      rule.when({
        meanLuma: 200,
        stdevLuma: 5,
        isDark: false,
        hasGradient: false,
      }),
    ).toBe(false);
  });

  it("photo profile shadow rule boosts AVIF quality", () => {
    const rule = BUILTIN_PROFILES.photo.contentAware![0]!;
    expect(rule.apply.quality).toBeGreaterThanOrEqual(94);
  });

  it("all profiles cover all four output formats", () => {
    const formats = ["avif", "webp", "jpeg", "png"] as const;
    for (const profile of Object.values(BUILTIN_PROFILES)) {
      for (const f of formats) {
        expect(profile.formats[f]).toBeDefined();
      }
    }
  });
});

describe("getProfile", () => {
  it("returns a built-in profile by name", () => {
    expect(getProfile("hq")).toBe(BUILTIN_PROFILES.hq);
  });

  it("returns the profile object as-is when given an inline profile", () => {
    const inline: Profile = {
      name: "custom",
      formats: BUILTIN_PROFILES.fast.formats,
      onMissingEncoder: "silent",
    };
    expect(getProfile(inline)).toBe(inline);
  });

  it("throws for unknown profile name", () => {
    expect(() => getProfile("nonexistent")).toThrow(/unknown profile/i);
  });
});

describe("mergeProfile", () => {
  it("returns the original profile when overrides empty", () => {
    const merged = mergeProfile(BUILTIN_PROFILES.balanced, {});
    expect(merged.formats.avif).toEqual(BUILTIN_PROFILES.balanced.formats.avif);
  });

  it("merges format overrides without dropping unspecified fields", () => {
    const merged = mergeProfile(BUILTIN_PROFILES.balanced, {
      avif: { quality: 95 },
    });
    expect(merged.formats.avif.quality).toBe(95);
    expect(merged.formats.avif.encoderPreference).toEqual(
      BUILTIN_PROFILES.balanced.formats.avif.encoderPreference,
    );
  });

  it("replaces encoderPreference when explicitly provided", () => {
    const merged = mergeProfile(BUILTIN_PROFILES.balanced, {
      avif: { encoderPreference: ["sharp"] },
    });
    expect(merged.formats.avif.encoderPreference).toEqual(["sharp"]);
  });

  it("does not mutate the source profile", () => {
    const before = JSON.stringify(BUILTIN_PROFILES.balanced);
    mergeProfile(BUILTIN_PROFILES.balanced, { avif: { quality: 50 } });
    expect(JSON.stringify(BUILTIN_PROFILES.balanced)).toBe(before);
  });
});
