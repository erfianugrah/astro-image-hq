/**
 * Astro LocalImageService implementation.
 *
 * Wraps `astro/assets/services/sharp` and overrides `transform()` to route
 * encoding through the strategy layer. Non-image work (URL parsing, HTML
 * attribute generation) is delegated to the underlying sharp service.
 *
 * State (capabilities, profile, tally) is module-scoped because Astro
 * instantiates services per build via dynamic import; that import is
 * cached, so a single build sees one instance.
 */

import baseSharpService from "astro/assets/services/sharp";
import type { LocalImageService } from "astro";
import { detectCapabilities } from "./detect.js";
import { analyzeImage } from "./analyze.js";
import { decide, MissingEncoderError } from "./route.js";
import { getProfile, mergeProfile } from "./profiles.js";
import { sharpEncoder } from "./encoders/sharp.js";
import { avifencEncoder } from "./encoders/avifenc.js";
import { nvencEncoder } from "./encoders/nvenc.js";
import { createLogger, type Logger } from "./log.js";
import type {
  Capabilities,
  EncodeRequest,
  EncoderId,
  FormatConfig,
  HqOptions,
  OutputFormat,
  Profile,
} from "./types.js";

const sharpService = baseSharpService;

interface ResolvedState {
  caps: Capabilities;
  profile: Profile;
  options: HqOptions;
  logger: Logger;
  tally: Record<EncoderId | "boosted", number>;
}

let statePromise: Promise<ResolvedState> | undefined;

function loadState(opts: HqOptions): Promise<ResolvedState> {
  if (!statePromise) {
    statePromise = (async () => {
      const caps = await detectCapabilities();
      const base = getProfile(opts.profile);
      const profile = opts.formats ? mergeProfile(base, opts.formats) : base;
      const logger = createLogger(opts.log ?? "summary");
      logger.summary(caps, profile);
      return {
        caps,
        profile,
        options: opts,
        logger,
        tally: { sharp: 0, avifenc: 0, nvenc: 0, boosted: 0 },
      };
    })();
  }
  return statePromise;
}

const ENCODERS: Record<EncoderId, (req: EncodeRequest) => Promise<{ data: Uint8Array; format: OutputFormat }>> = {
  sharp: sharpEncoder,
  avifenc: avifencEncoder,
  nvenc: nvencEncoder,
};

const SUPPORTED_FORMATS = new Set<OutputFormat>(["avif", "webp", "jpeg", "png"]);

const service: LocalImageService = {
  ...sharpService,

  propertiesToHash: [
    ...(sharpService.propertiesToHash ?? ["src", "width", "height", "format", "quality"]),
    "_profile",
    "_encoder",
    "_depth",
    "_chroma",
  ],

  async transform(inputBuffer, transform, imageConfig) {
    const opts = (imageConfig.service.config ?? {}) as HqOptions;
    if (!opts.profile) {
      // Misconfigured — defer entirely to sharp service.
      return sharpService.transform(inputBuffer, transform, imageConfig);
    }

    const state = await loadState(opts);
    const format = transform.format as OutputFormat | undefined;

    if (!format || !SUPPORTED_FORMATS.has(format)) {
      return sharpService.transform(inputBuffer, transform, imageConfig);
    }

    const input = inputBuffer instanceof Uint8Array
      ? inputBuffer
      : new Uint8Array(inputBuffer);

    const char = await analyzeImage(input);

    let decision;
    try {
      decision = decide({
        caps: state.caps,
        char,
        profile: state.profile,
        format,
        gpuMaxMemoryUtilization: opts.gpu?.maxMemoryUtilization,
      });
    } catch (e) {
      if (e instanceof MissingEncoderError) {
        state.logger.warn(e.message);
        throw e;
      }
      throw e;
    }

    state.logger.trace(decision, format);
    state.tally[decision.encoder]++;
    if (decision.contentBoosted) state.tally.boosted++;

    // Component-level overrides (e.g. <Image quality={90} />) win over
    // profile policy. Only fields present in FormatConfig are merged;
    // width/height/fit live separately on EncodeRequest.
    const overridden = applyTransformOverrides(decision.config, transform);

    const encoder = ENCODERS[decision.encoder];
    const req: EncodeRequest = {
      input,
      format,
      ...(typeof transform.width === "number" && { width: transform.width }),
      ...(typeof transform.height === "number" && { height: transform.height }),
      ...(typeof transform.fit === "string" && { fit: transform.fit as EncodeRequest["fit"] }),
      config: overridden,
    };

    return encoder(req);
  },
};

export default service;

// Helper for callers wanting to flush the tally (mostly for tests).
export async function flushTally(): Promise<Record<EncoderId | "boosted", number> | undefined> {
  if (!statePromise) return undefined;
  const state = await statePromise;
  state.logger.tally(state.tally);
  return state.tally;
}

/**
 * Merge transform-level overrides on top of the profile-derived config.
 * Component-level values (e.g. `<Image quality={90} />`) win over profile
 * policy and content-aware boosts. Only FormatConfig-shaped fields are
 * merged; sizing fields stay on EncodeRequest.
 */
function applyTransformOverrides(
  config: FormatConfig,
  transform: Record<string, unknown>,
): FormatConfig {
  const q = transform.quality;
  if (typeof q === "number") return { ...config, quality: q };
  if (typeof q === "string" && /^\d+$/.test(q)) return { ...config, quality: Number(q) };
  return config;
}
