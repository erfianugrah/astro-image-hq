import { describe, expect, it } from "vitest";
import { decide, MissingEncoderError } from "../src/route.js";
import { BUILTIN_PROFILES } from "../src/profiles.js";
import type { Capabilities, Characteristics } from "../src/types.js";

const sharpOnly: Capabilities = { sharp: { version: "0.34.5" } };

const fullCaps: Capabilities = {
  sharp: { version: "0.34.5" },
  avifenc: { version: "1.0.4" },
  ffmpeg: { version: "7.1", encoders: ["av1_nvenc"] },
  nvenc: {
    gpuName: "RTX 5090",
    computeCap: "12.0",
    supportsAvif: true,
    memoryUtilization: 0.1,
  },
};

const flatBright: Characteristics = {
  meanLuma: 200,
  stdevLuma: 5,
  isDark: false,
  hasGradient: false,
};

const darkGradient: Characteristics = {
  meanLuma: 30,
  stdevLuma: 28,
  isDark: true,
  hasGradient: true,
};

describe("decide — preference walk", () => {
  it("picks first available encoder in preference list", () => {
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile: BUILTIN_PROFILES.balanced,
      format: "avif",
    });
    expect(d.encoder).toBe("avifenc");
  });

  it("skips missing encoders and falls through", () => {
    const d = decide({
      caps: sharpOnly,
      char: flatBright,
      profile: BUILTIN_PROFILES.balanced,
      format: "avif",
    });
    expect(d.encoder).toBe("sharp");
  });

  it("uses sharp directly for non-AVIF formats", () => {
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile: BUILTIN_PROFILES.balanced,
      format: "jpeg",
    });
    expect(d.encoder).toBe("sharp");
  });
});

describe("decide — missing encoder policies", () => {
  it("'fail' policy throws when preferred encoder missing", () => {
    expect(() =>
      decide({
        caps: sharpOnly,
        char: flatBright,
        profile: BUILTIN_PROFILES.hq,
        format: "avif",
      }),
    ).toThrow(MissingEncoderError);
  });

  it("'warn' policy falls through silently in the decision (warning emitted by service)", () => {
    const d = decide({
      caps: sharpOnly,
      char: flatBright,
      profile: BUILTIN_PROFILES.balanced,
      format: "avif",
    });
    expect(d.encoder).toBe("sharp");
    expect(d.reason).toMatch(/missing|fallback|sharp/i);
  });

  it("'silent' policy falls through quietly", () => {
    const d = decide({
      caps: sharpOnly,
      char: flatBright,
      profile: BUILTIN_PROFILES.fast,
      format: "avif",
    });
    expect(d.encoder).toBe("sharp");
  });
});

describe("decide — content-aware boost", () => {
  it("applies shadow boost on dark gradient images (photo profile)", () => {
    const d = decide({
      caps: fullCaps,
      char: darkGradient,
      profile: BUILTIN_PROFILES.photo,
      format: "avif",
    });
    expect(d.contentBoosted).toBe(true);
    expect(d.config.quality).toBeGreaterThanOrEqual(94);
  });

  it("does not apply shadow boost on bright images", () => {
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile: BUILTIN_PROFILES.photo,
      format: "avif",
    });
    expect(d.contentBoosted).toBe(false);
  });

  it("content-aware override can change encoder preference", () => {
    const d = decide({
      caps: fullCaps,
      char: darkGradient,
      profile: BUILTIN_PROFILES.photo,
      format: "avif",
    });
    expect(d.encoder).toBe("avifenc");
  });
});

describe("decide — NVENC gating", () => {
  it("skips NVENC when GPU memory utilization too high", () => {
    const profileWithNvenc = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          encoderPreference: ["nvenc", "avifenc", "sharp"] as const,
          quality: 80,
          depth: 8 as const,
          chromaSubsampling: "4:2:0" as const,
        },
      },
    };
    const busyCaps: Capabilities = {
      ...fullCaps,
      nvenc: { ...fullCaps.nvenc!, memoryUtilization: 0.9 },
    };
    const d = decide({
      caps: busyCaps,
      char: flatBright,
      profile: profileWithNvenc,
      format: "avif",
      gpuMaxMemoryUtilization: 0.5,
    });
    expect(d.encoder).toBe("avifenc");
    expect(d.reason).toMatch(/gpu|busy|memory/i);
  });

  it("skips NVENC when 10-bit requested (NVENC is 8-bit only)", () => {
    const profile = {
      ...BUILTIN_PROFILES.hq,
      onMissingEncoder: "warn" as const,
      formats: {
        ...BUILTIN_PROFILES.hq.formats,
        avif: {
          ...BUILTIN_PROFILES.hq.formats.avif,
          encoderPreference: ["nvenc", "avifenc", "sharp"] as const,
        },
      },
    };
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile,
      format: "avif",
    });
    expect(d.encoder).toBe("avifenc");
    expect(d.reason).toMatch(/8-bit|10-bit/i);
  });

  it("skips NVENC when 4:4:4 chroma requested", () => {
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["nvenc", "avifenc", "sharp"] as const,
          chromaSubsampling: "4:4:4" as const,
        },
      },
    };
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile,
      format: "avif",
    });
    expect(d.encoder).toBe("avifenc");
    expect(d.reason).toMatch(/4:2:0|chroma/i);
  });

  it("uses NVENC when 4:2:0 8-bit AVIF requested and GPU idle", () => {
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          encoderPreference: ["nvenc", "sharp"] as const,
          quality: 80,
          depth: 8 as const,
          chromaSubsampling: "4:2:0" as const,
        },
      },
    };
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile,
      format: "avif",
    });
    expect(d.encoder).toBe("nvenc");
  });
});

describe("decide — purity", () => {
  it("does not mutate inputs", () => {
    const beforeProfile = JSON.stringify(BUILTIN_PROFILES.photo);
    const beforeChar = JSON.stringify(darkGradient);
    decide({
      caps: fullCaps,
      char: darkGradient,
      profile: BUILTIN_PROFILES.photo,
      format: "avif",
    });
    expect(JSON.stringify(BUILTIN_PROFILES.photo)).toBe(beforeProfile);
    expect(JSON.stringify(darkGradient)).toBe(beforeChar);
  });
});
