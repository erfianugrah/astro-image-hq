import { describe, expect, it } from "vitest";
import { decide, MissingEncoderError } from "../src/route.js";
import { BUILTIN_PROFILES } from "../src/profiles.js";
import type { Capabilities, Characteristics } from "../src/types.js";

const sharpOnly: Capabilities = { sharp: { version: "0.34.5" } };

const fullCaps: Capabilities = {
  sharp: { version: "0.34.5" },
  avifenc: { version: "1.4.1", codecs: ["aom", "svt", "rav1e"] },
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
    // balanced profile: [nvenc, avifenc, sharp] @ 4:2:0 10-bit → NVENC wins
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile: BUILTIN_PROFILES.balanced,
      format: "avif",
    });
    expect(d.encoder).toBe("nvenc");
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

  it("uses NVENC for 4:2:0 10-bit AVIF (luma banding fix without chroma cost)", () => {
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          encoderPreference: ["nvenc", "avifenc", "sharp"] as const,
          quality: 90,
          depth: 10 as const,
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
    expect(d.reason).toMatch(/10-bit/i);
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

  it("skips NVENC when image dimensions below 128px (NVENC AV1 minimum)", () => {
    const profile = {
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
    const d = decide({
      caps: fullCaps,
      char: flatBright,
      profile,
      format: "avif",
      width: 64,
      height: 64,
    });
    // NVENC skipped → falls through to avifenc
    expect(d.encoder).toBe("avifenc");
    expect(d.reason).toMatch(/NVENC|128/);
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

describe("decide — codec capability fallback", () => {
  it("drops codec field when avifenc lacks the requested codec", () => {
    const capsWithoutSvt: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
        },
      },
    };
    const d = decide({
      caps: capsWithoutSvt,
      char: flatBright,
      profile,
      format: "avif",
    });
    expect(d.encoder).toBe("avifenc");
    // codec should be dropped (or undefined) so avifenc uses default (aom)
    expect(d.config.codec).toBeUndefined();
  });

  it("preserves codec when avifenc supports it", () => {
    const capsWithSvt: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.4.1", codecs: ["aom", "svt", "rav1e"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
        },
      },
    };
    const d = decide({
      caps: capsWithSvt,
      char: flatBright,
      profile,
      format: "avif",
      width: 1280,
      height: 720,
    });
    expect(d.encoder).toBe("avifenc");
    expect(d.config.codec).toBe("svt");
  });

  it("drops svt codec when image dimensions below 64px (SVT-AV1 hard minimum)", () => {
    const capsWithSvt: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt", "rav1e"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
        },
      },
    };
    const d = decide({
      caps: capsWithSvt,
      char: flatBright,
      profile,
      format: "avif",
      width: 32,
      height: 32,
    });
    expect(d.encoder).toBe("avifenc");
    // Codec dropped → avifenc uses its default (aom)
    expect(d.config.codec).toBeUndefined();
    expect(d.reason).toMatch(/min|64/i);
  });

  it("preserves svt codec at exactly 64px (boundary)", () => {
    const capsWithSvt: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt", "rav1e"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
        },
      },
    };
    const d = decide({
      caps: capsWithSvt,
      char: flatBright,
      profile,
      format: "avif",
      width: 64,
      height: 64,
    });
    expect(d.config.codec).toBe("svt");
  });

  it("drops svt codec when 4:2:0 width is odd (chroma parity)", () => {
    const caps: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
          chromaSubsampling: "4:2:0" as const,
        },
      },
    };
    const d = decide({
      caps,
      char: flatBright,
      profile,
      format: "avif",
      width: 853, // odd
      height: 480,
    });
    expect(d.config.codec).toBeUndefined();
    expect(d.reason).toMatch(/odd|parity|even/i);
  });

  it("drops svt codec when 4:2:0 height is odd (chroma parity)", () => {
    const caps: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
          chromaSubsampling: "4:2:0" as const,
        },
      },
    };
    const d = decide({
      caps,
      char: flatBright,
      profile,
      format: "avif",
      width: 1280,
      height: 721, // odd
    });
    expect(d.config.codec).toBeUndefined();
  });

  it("preserves svt codec at 4:4:4 with odd dimensions (no parity req)", () => {
    const caps: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.balanced,
      formats: {
        ...BUILTIN_PROFILES.balanced.formats,
        avif: {
          ...BUILTIN_PROFILES.balanced.formats.avif,
          encoderPreference: ["avifenc", "sharp"] as const,
          codec: "svt" as const,
          chromaSubsampling: "4:4:4" as const,
        },
      },
    };
    const d = decide({
      caps,
      char: flatBright,
      profile,
      format: "avif",
      width: 853,
      height: 481,
    });
    // 4:4:4 has no parity constraint — codec preserved
    expect(d.config.codec).toBe("svt");
  });

  it("preserves aom codec at any size (no minimum)", () => {
    const caps: Capabilities = {
      sharp: { version: "0.34.5" },
      avifenc: { version: "1.0.4", codecs: ["aom", "svt", "rav1e"] },
    };
    const profile = {
      ...BUILTIN_PROFILES.hq,
      onMissingEncoder: "warn" as const,
    };
    const d = decide({
      caps,
      char: flatBright,
      profile,
      format: "avif",
      width: 16,
      height: 16,
    });
    expect(d.config.codec).toBe("aom");
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
