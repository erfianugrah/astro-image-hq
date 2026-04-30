/**
 * Domain types for astro-image-hq.
 *
 * These types form the ubiquitous language of the package. Each module
 * (detection, analysis, routing, encoding) operates on these shapes and
 * returns these shapes. Pure-function modules (route, profiles) take and
 * return these without side effects.
 */

/** Output formats this service can produce. */
export type OutputFormat = "avif" | "webp" | "jpeg" | "png";

/** Encoder strategy identifiers. */
export type EncoderId = "sharp" | "avifenc" | "nvenc";

/** Behaviour when a preferred encoder is missing at build time. */
export type MissingEncoderPolicy = "fail" | "warn" | "silent";

/** Diagnostic verbosity. */
export type LogLevel = "off" | "summary" | "verbose";

/** Chroma subsampling for AVIF/JPEG. */
export type ChromaSubsampling = "4:4:4" | "4:2:2" | "4:2:0";

// ---------------------------------------------------------------------------
// Capabilities — what's available in the build environment
// ---------------------------------------------------------------------------

export interface SharpCapability {
  readonly version: string;
}

export interface AvifencCapability {
  readonly version: string;
}

export interface FfmpegCapability {
  readonly version: string;
  readonly encoders: readonly string[];
}

export interface NvencCapability {
  readonly gpuName: string;
  readonly computeCap: string; // e.g. "8.9", "12.0"
  /** Reality: ffmpeg's av1_nvenc currently only supports 4:2:0 8-bit AVIF
   *  regardless of GPU silicon. This flag signals NVENC presence; consumers
   *  should treat its output as 4:2:0 8-bit. */
  readonly supportsAvif: boolean;
  readonly memoryUtilization: number; // 0..1
}

export interface Capabilities {
  readonly sharp: SharpCapability; // always present
  readonly avifenc?: AvifencCapability;
  readonly ffmpeg?: FfmpegCapability;
  readonly nvenc?: NvencCapability;
}

// ---------------------------------------------------------------------------
// Characteristics — content analysis result
// ---------------------------------------------------------------------------

export interface Characteristics {
  /** Weighted luma 0..255 (Rec. 709 coefficients). */
  readonly meanLuma: number;
  /** Stddev of luma; rough proxy for contrast. */
  readonly stdevLuma: number;
  /** True when the image is predominantly dark. */
  readonly isDark: boolean;
  /** True when there is significant gradient (not flat). */
  readonly hasGradient: boolean;
}

// ---------------------------------------------------------------------------
// Profile — encoding strategy preset
// ---------------------------------------------------------------------------

/** AV1 codec selection — only honored by the `avifenc` encoder. */
export type AvifCodec = "aom" | "svt" | "rav1e";

export interface FormatConfig {
  readonly encoderPreference: readonly EncoderId[];
  readonly quality: number;
  readonly depth?: 8 | 10;
  readonly chromaSubsampling?: ChromaSubsampling;
  readonly effort?: number;
  /** AV1 codec for avifenc (`aom` slow/best, `svt` fast/4:2:0-only, `rav1e` mid). */
  readonly codec?: AvifCodec;
  /** mozjpeg flag for JPEG only. */
  readonly mozjpeg?: boolean;
}

export interface ContentAwareRule {
  /** Pure predicate over image characteristics. */
  readonly when: (c: Characteristics) => boolean;
  /** Partial config to merge into the format config when the rule matches. */
  readonly apply: Partial<FormatConfig>;
  /** Human-readable reason for logs. */
  readonly reason: string;
}

export interface Profile {
  readonly name: string;
  readonly formats: Readonly<Record<OutputFormat, FormatConfig>>;
  readonly contentAware?: readonly ContentAwareRule[];
  readonly onMissingEncoder: MissingEncoderPolicy;
}

// ---------------------------------------------------------------------------
// User options & service config
// ---------------------------------------------------------------------------

export interface GpuOptions {
  /** Skip NVENC when GPU memory utilization exceeds this fraction (0..1). */
  readonly maxMemoryUtilization?: number;
}

export interface HqOptions {
  readonly profile: string | Profile;
  readonly formats?: Partial<Record<OutputFormat, Partial<FormatConfig>>>;
  readonly gpu?: GpuOptions;
  readonly log?: LogLevel;
}

// ---------------------------------------------------------------------------
// Routing — pure decision output
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  readonly encoder: EncoderId;
  readonly config: FormatConfig;
  readonly reason: string;
  readonly contentBoosted: boolean;
}

// ---------------------------------------------------------------------------
// Encoding — strategy contract
// ---------------------------------------------------------------------------

export interface EncodeRequest {
  readonly input: Uint8Array;
  readonly format: OutputFormat;
  readonly width?: number;
  readonly height?: number;
  readonly fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  readonly config: FormatConfig;
}

export interface EncodeResult {
  readonly data: Uint8Array;
  readonly format: OutputFormat;
}
