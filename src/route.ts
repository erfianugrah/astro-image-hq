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
}

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
    const reason = encoderReason(candidate, caps, config, gpuMax);
    if (reason.ok) {
      const finalized = finalizeConfig(candidate, config, caps);
      const note = finalized.codecDropped
        ? `${reason.note} (codec=${config.codec} unavailable, using default)`
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
}

/**
 * Strip config fields the chosen encoder cannot honor. Currently only
 * relevant for avifenc when the requested codec isn't built in.
 */
function finalizeConfig(
  encoder: EncoderId,
  config: FormatConfig,
  caps: Capabilities,
): FinalizedConfig {
  if (encoder !== "avifenc" || !config.codec) {
    return { config, codecDropped: false };
  }
  if (caps.avifenc?.codecs.includes(config.codec)) {
    return { config, codecDropped: false };
  }
  // Codec requested but unavailable — drop it so avifenc uses its default.
  const { codec: _drop, ...rest } = config;
  void _drop;
  return { config: rest, codecDropped: true };
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
