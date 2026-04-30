/**
 * Built-in encoding profiles and merge helpers.
 *
 * Profiles are the high-level "what quality level do I want" knob users turn.
 * A profile bundles per-format encoder preferences, quality settings, and an
 * optional set of content-aware rules that adjust those settings based on
 * image characteristics.
 *
 * This module is pure — no side effects, no I/O.
 */

import type {
  ContentAwareRule,
  FormatConfig,
  OutputFormat,
  Profile,
} from "./types.js";

// ---------------------------------------------------------------------------
// Content-aware rules
// ---------------------------------------------------------------------------

/**
 * The shadow-boost rule. Dark gradient images get the full chroma + bit-depth
 * treatment via avifenc-aom; everything else stays on the fast 4:2:0 path
 * defined by the profile's default FormatConfig.
 *
 * Why: 4:4:4 only matters for chroma smearing in dark-to-light transitions
 * and high-saturation hard edges. Bright photographic content is visually
 * indistinguishable at 4:2:0 and encodes much faster.
 */
const SHADOW_BOOST: ContentAwareRule = {
  when: (c) => c.isDark && c.hasGradient,
  apply: {
    quality: 95,
    chromaSubsampling: "4:4:4",
    depth: 10,
    codec: "aom",
    effort: 6, // avifenc speed=4
    encoderPreference: ["avifenc", "sharp"],
  },
  reason: "dark gradient — promote to 4:4:4 10-bit aom",
};

// ---------------------------------------------------------------------------
// Format configs (reused across profiles)
// ---------------------------------------------------------------------------

const FAST_AVIF: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 80,
  depth: 8,
  chromaSubsampling: "4:2:0",
  effort: 4,
};

// Balanced: GPU NVENC if available, else avifenc-svt (fast CPU AV1).
// 4:2:0 10-bit fixes luma banding without the chroma cost of 4:4:4.
const BALANCED_AVIF: FormatConfig = {
  encoderPreference: ["nvenc", "avifenc", "sharp"],
  quality: 88,
  depth: 10,
  chromaSubsampling: "4:2:0",
  codec: "svt",
  effort: 4,
};

// HQ profile: strict 4:4:4 10-bit aom for every AVIF. Slower but max quality.
const HQ_AVIF: FormatConfig = {
  encoderPreference: ["avifenc"],
  quality: 92,
  depth: 10,
  chromaSubsampling: "4:4:4",
  codec: "aom",
  effort: 6,
};

// Photo profile default: fast 4:2:0 10-bit (NVENC > avifenc-svt > sharp).
// Shadow boost upgrades dark gradient images to 4:4:4 aom on the fly.
const PHOTO_AVIF: FormatConfig = {
  encoderPreference: ["nvenc", "avifenc", "sharp"],
  quality: 90,
  depth: 10,
  chromaSubsampling: "4:2:0",
  codec: "svt",
  effort: 4,
};

const FAST_JPEG: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 82,
  mozjpeg: false,
};

const BALANCED_JPEG: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 88,
  mozjpeg: true,
};

const HQ_JPEG: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 92,
  mozjpeg: true,
};

const WEBP_82: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 82,
  effort: 4,
};

const WEBP_88: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 88,
  effort: 6,
};

const WEBP_92: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 92,
  effort: 6,
};

const PNG: FormatConfig = {
  encoderPreference: ["sharp"],
  quality: 100, // unused for png but required by interface
};

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

const fast: Profile = {
  name: "fast",
  formats: { avif: FAST_AVIF, webp: WEBP_82, jpeg: FAST_JPEG, png: PNG },
  onMissingEncoder: "silent",
};

const balanced: Profile = {
  name: "balanced",
  formats: { avif: BALANCED_AVIF, webp: WEBP_88, jpeg: BALANCED_JPEG, png: PNG },
  onMissingEncoder: "warn",
};

const hq: Profile = {
  name: "hq",
  formats: { avif: HQ_AVIF, webp: WEBP_92, jpeg: HQ_JPEG, png: PNG },
  onMissingEncoder: "fail",
};

const photo: Profile = {
  name: "photo",
  formats: { avif: PHOTO_AVIF, webp: WEBP_92, jpeg: HQ_JPEG, png: PNG },
  contentAware: [SHADOW_BOOST],
  onMissingEncoder: "warn",
};

export const BUILTIN_PROFILES = { fast, balanced, hq, photo } as const;

export type BuiltinProfileName = keyof typeof BUILTIN_PROFILES;

// ---------------------------------------------------------------------------
// Profile resolution & merging
// ---------------------------------------------------------------------------

const isBuiltinName = (name: string): name is BuiltinProfileName =>
  name in BUILTIN_PROFILES;

/**
 * Resolve a string name or inline profile object to a concrete Profile.
 * Throws when given a string that's not a built-in profile name.
 */
export function getProfile(input: string | Profile): Profile {
  if (typeof input !== "string") return input;
  if (isBuiltinName(input)) return BUILTIN_PROFILES[input];
  throw new Error(
    `Unknown profile "${input}". Built-ins: ${Object.keys(BUILTIN_PROFILES).join(", ")}`,
  );
}

/**
 * Merge per-format overrides into a profile, returning a new Profile.
 * Does not mutate the source. Overrides shallow-merge into FormatConfig;
 * arrays (encoderPreference) replace wholesale when present.
 */
export function mergeProfile(
  base: Profile,
  overrides: Partial<Record<OutputFormat, Partial<FormatConfig>>>,
): Profile {
  const formats = { ...base.formats };
  for (const key of Object.keys(overrides) as OutputFormat[]) {
    const override = overrides[key];
    if (!override) continue;
    formats[key] = { ...formats[key], ...override };
  }
  return { ...base, formats };
}
