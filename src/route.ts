/**
 * Encoder routing — pure decision function.
 *
 * Given environment capabilities, image characteristics, a profile, and an
 * output format, returns which encoder to use and the final FormatConfig
 * to apply. No side effects, fully testable.
 */

import type {
  Capabilities,
  Characteristics,
  EncoderId,
  FormatConfig,
  OutputFormat,
  Profile,
  RoutingDecision,
} from "./types.js";

export class MissingEncoderError extends Error {
  constructor(
    public readonly profile: string,
    public readonly format: OutputFormat,
    public readonly preference: readonly EncoderId[],
  ) {
    super(
      `Profile "${profile}" requires one of [${preference.join(", ")}] for ${format}, but none are available. ` +
        `Install \`avifenc\` (libavif) or \`ffmpeg\` with av1_nvenc, or pick a different profile.`,
    );
    this.name = "MissingEncoderError";
  }
}

export interface DecideArgs {
  readonly caps: Capabilities;
  readonly char: Characteristics;
  readonly profile: Profile;
  readonly format: OutputFormat;
  /** Skip NVENC when GPU memory util exceeds this (0..1). Default 0.5. */
  readonly gpuMaxMemoryUtilization?: number;
  /** Output dimensions — used to gate encoders/codecs with size constraints. */
  readonly width?: number;
  readonly height?: number;
}

interface CodecConstraints {
  /** Smaller side must be at least this many pixels. */
  readonly minDim: number;
  /**
   * For 4:2:0 chroma, both dimensions must be even (chroma planes are
   * half-resolution and need exact integer mapping). aom handles this
   * internally; SVT-AV1 errors out.
   */
  readonly even420: boolean;
}

/** Per-codec dimension/parity constraints when avifenc -c <codec> is used. */
const CODEC_CONSTRAINTS: Record<NonNullable<FormatConfig["codec"]>, CodecConstraints> = {
  aom: { minDim: 1, even420: false },
  svt: { minDim: 64, even420: true },
  rav1e: { minDim: 32, even420: false },
};

/**
 * NVENC AV1 minimum frame dimension. Inputs smaller than this fail with
 * "Frame dimensions are less than the minimum supported value" — most
 * commonly hit by favicons and small thumbnails. Route skips NVENC for
 * smaller inputs and falls through to the next encoder (typically
 * avifenc, then sharp).
 */
const NVENC_MIN_DIM = 128;

const DEFAULT_GPU_MAX_UTIL = 0.5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decide(args: DecideArgs): RoutingDecision {
  const { caps, char, profile, format } = args;
  const gpuMax = args.gpuMaxMemoryUtilization ?? DEFAULT_GPU_MAX_UTIL;

  const baseConfig = profile.formats[format];
  const { config, contentBoosted, boostReason } = applyContentRules(
    baseConfig,
    char,
    profile,
  );

  // Walk encoder preference, picking first available + capable.
  // Track skipped encoders so the reason string explains the choice.
  const skipped: string[] = [];
  for (const candidate of config.encoderPreference) {
    // av1_nvenc cannot carry an alpha plane - transparent images would
    // render as solid black. Route them past NVENC entirely.
    if (char.hasAlpha && candidate === "nvenc") {
      skipped.push("nvenc: alpha transparency unsupported");
      continue;
    }
    const reason = encoderReason(candidate, caps, config, gpuMax, args.width, args.height);
    if (reason.ok) {
      const finalized = finalizeConfig(candidate, config, caps, args.width, args.height, char.hasAlpha);
      const note = finalized.codecDropped
        ? `${reason.note} (codec=${config.codec} ${finalized.dropReason}, using default)`
        : reason.note;
      return {
        encoder: candidate,
        config: finalized.config,
        reason: composeReason(
          profile,
          candidate,
          contentBoosted,
          boostReason,
          note,
          skipped,
        ),
        contentBoosted,
      };
    }
    skipped.push(`${candidate}: ${reason.note}`);
  }

  // No preferred encoder available. Apply policy.
  if (profile.onMissingEncoder === "fail") {
    throw new MissingEncoderError(profile.name, format, config.encoderPreference);
  }

  // warn or silent → fall back to sharp (always present).
  return {
    encoder: "sharp",
    config: { ...config, encoderPreference: ["sharp"] },
    reason:
      profile.onMissingEncoder === "warn"
        ? `preferred encoders missing — fallback to sharp (warn)`
        : `fallback to sharp`,
    contentBoosted,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ContentRuleResult {
  config: FormatConfig;
  contentBoosted: boolean;
  boostReason?: string;
}

function applyContentRules(
  base: FormatConfig,
  char: Characteristics,
  profile: Profile,
): ContentRuleResult {
  const rules = profile.contentAware ?? [];
  for (const rule of rules) {
    if (rule.when(char)) {
      return {
        config: { ...base, ...rule.apply },
        contentBoosted: true,
        boostReason: rule.reason,
      };
    }
  }
  return { config: base, contentBoosted: false };
}

interface FinalizedConfig {
  config: FormatConfig;
  codecDropped: boolean;
  dropReason?: string;
}

/**
 * Strip config fields the chosen encoder cannot honor. The codec field
 * is dropped for the avifenc encoder when:
 *   1. The requested codec isn't built into the avifenc binary.
 *   2. The image is below the codec's minimum dimension (e.g. SVT-AV1
 *      requires 64x64; rav1e requires 32x32).
 *   3. The codec rejects odd dimensions for 4:2:0 chroma (SVT-AV1 errors
 *      with "Source Width must be even for YUV_420 colorspace"); aom
 *      handles odd dimensions internally.
 *
 * Additionally, when the image has meaningful transparency, any codec
 * other than aom is dropped: the SVT-AV1 and rav1e 4:2:0 paths lose the
 * alpha plane (transparent logos render as solid black), while aom
 * encodes the alpha auxiliary plane correctly.
 *
 * In any of those cases, the codec field is removed so avifenc falls
 * back to its built-in default (typically aom), which is permissive.
 */
function finalizeConfig(
  encoder: EncoderId,
  config: FormatConfig,
  caps: Capabilities,
  width: number | undefined,
  height: number | undefined,
  hasAlpha = false,
): FinalizedConfig {
  if (encoder !== "avifenc" || !config.codec) {
    return { config, codecDropped: false };
  }
  // Alpha check: only aom carries the alpha plane reliably.
  if (hasAlpha && config.codec !== "aom") {
    return dropCodec(config, "alpha transparency needs aom");
  }
  // Capability check
  if (!caps.avifenc?.codecs.includes(config.codec)) {
    return dropCodec(config, "unavailable");
  }
  const constraints = CODEC_CONSTRAINTS[config.codec];
  // Minimum-size check
  const minDim = smallestSide(width, height);
  if (minDim !== undefined && minDim < constraints.minDim) {
    return dropCodec(config, `image ${minDim}px < codec min ${constraints.minDim}px`);
  }
  // Parity check (4:2:0 only)
  if (constraints.even420 && config.chromaSubsampling === "4:2:0") {
    if (typeof width === "number" && width % 2 !== 0) {
      return dropCodec(config, `width ${width} odd; codec needs even for 4:2:0`);
    }
    if (typeof height === "number" && height % 2 !== 0) {
      return dropCodec(config, `height ${height} odd; codec needs even for 4:2:0`);
    }
  }
  return { config, codecDropped: false };
}

function dropCodec(config: FormatConfig, reason: string): FinalizedConfig {
  const { codec: _drop, ...rest } = config;
  void _drop;
  return { config: rest, codecDropped: true, dropReason: reason };
}

function smallestSide(w: number | undefined, h: number | undefined): number | undefined {
  if (typeof w === "number" && typeof h === "number") return Math.min(w, h);
  if (typeof w === "number") return w;
  if (typeof h === "number") return h;
  return undefined;
}

interface EncoderAvailability {
  readonly ok: boolean;
  readonly note: string;
}

function encoderReason(
  id: EncoderId,
  caps: Capabilities,
  config: FormatConfig,
  gpuMax: number,
  width: number | undefined,
  height: number | undefined,
): EncoderAvailability {
  if (id === "sharp") return { ok: true, note: "sharp ok" };

  if (id === "avifenc") {
    return caps.avifenc
      ? { ok: true, note: `avifenc ${caps.avifenc.version}` }
      : { ok: false, note: "avifenc not installed" };
  }

  if (id === "nvenc") {
    if (!caps.nvenc) return { ok: false, note: "no NVIDIA GPU / NVENC" };
    if (!caps.nvenc.supportsAvif) {
      return { ok: false, note: "GPU lacks AV1 NVENC (sm < 7.5)" };
    }
    // ffmpeg's av1_nvenc wrapper supports 4:2:0 8-bit and 4:2:0 10-bit.
    // 4:4:4 / 4:2:2 are not exposed despite GPU silicon — route those to avifenc.
    if (config.chromaSubsampling === "4:4:4" || config.chromaSubsampling === "4:2:2") {
      return {
        ok: false,
        note: `NVENC AVIF is 4:2:0 only (use avifenc for ${config.chromaSubsampling})`,
      };
    }
    // NVENC AV1 minimum frame dimension (favicons / tiny thumbnails fail).
    const minDim = smallestSide(width, height);
    if (minDim !== undefined && minDim < NVENC_MIN_DIM) {
      return {
        ok: false,
        note: `image ${minDim}px < NVENC AV1 min ${NVENC_MIN_DIM}px`,
      };
    }
    if (caps.nvenc.memoryUtilization > gpuMax) {
      return {
        ok: false,
        note: `GPU memory ${(caps.nvenc.memoryUtilization * 100).toFixed(0)}% > ${(gpuMax * 100).toFixed(0)}% threshold`,
      };
    }
    return { ok: true, note: `nvenc on ${caps.nvenc.gpuName} (4:2:0 ${config.depth ?? 8}-bit)` };
  }

  return { ok: false, note: `unknown encoder ${id satisfies never}` };
}

function composeReason(
  profile: Profile,
  encoder: EncoderId,
  boosted: boolean,
  boostReason: string | undefined,
  encoderNote: string,
  skipped: readonly string[],
): string {
  const parts = [`profile=${profile.name}`, `encoder=${encoder}`, encoderNote];
  if (boosted && boostReason) parts.push(`boosted: ${boostReason}`);
  if (skipped.length > 0) parts.push(`skipped [${skipped.join(", ")}]`);
  return parts.join("; ");
}
