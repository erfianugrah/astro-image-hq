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

/** Minimum image dimension (smallest of width/height) each AV1 codec accepts. */
const CODEC_MIN_SIZE: Record<NonNullable<FormatConfig["codec"]>, number> = {
  aom: 1, // no practical minimum
  svt: 64, // SVT-AV1 hard minimum: "Source Width/Height must be at least 64"
  rav1e: 1, // no practical minimum
};

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
  const minDim = minDimension(args.width, args.height);
  for (const candidate of config.encoderPreference) {
    const reason = encoderReason(candidate, caps, config, gpuMax);
    if (reason.ok) {
      const finalized = finalizeConfig(candidate, config, caps, minDim);
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
 * Strip config fields the chosen encoder cannot honor. Two cases drop
 * the codec field for the avifenc encoder:
 *   1. The requested codec isn't built into the avifenc binary.
 *   2. The image is below the codec's minimum dimension (e.g. SVT-AV1
 *      requires 64x64 minimum; favicons and small srcset variants fall
 *      below this).
 *
 * In either case, the codec field is removed so avifenc falls back to
 * its built-in default (typically aom), which has no practical minimum.
 */
function finalizeConfig(
  encoder: EncoderId,
  config: FormatConfig,
  caps: Capabilities,
  minDim: number | undefined,
): FinalizedConfig {
  if (encoder !== "avifenc" || !config.codec) {
    return { config, codecDropped: false };
  }
  // Capability check
  if (!caps.avifenc?.codecs.includes(config.codec)) {
    return dropCodec(config, "unavailable");
  }
  // Minimum-size check
  const minSize = CODEC_MIN_SIZE[config.codec];
  if (minDim !== undefined && minDim < minSize) {
    return dropCodec(config, `image ${minDim}px < codec min ${minSize}px`);
  }
  return { config, codecDropped: false };
}

function dropCodec(config: FormatConfig, reason: string): FinalizedConfig {
  const { codec: _drop, ...rest } = config;
  void _drop;
  return { config: rest, codecDropped: true, dropReason: reason };
}

function minDimension(w: number | undefined, h: number | undefined): number | undefined {
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
