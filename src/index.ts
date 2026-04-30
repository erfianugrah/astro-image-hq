/**
 * Public entrypoint for astro-image-hq.
 *
 * Usage:
 *   import hqService from "astro-image-hq";
 *
 *   image: {
 *     service: hqService({ profile: "photo" }),
 *   }
 */

import type { HqOptions } from "./types.js";

export interface ImageServiceEntry {
  readonly entrypoint: string;
  readonly config: HqOptions;
}

/**
 * Factory for the Astro `image.service` config object.
 * The `entrypoint` resolves to this package's `service` subpath.
 */
export default function hqService(options: HqOptions): ImageServiceEntry {
  return {
    entrypoint: "astro-image-hq/service",
    config: options,
  };
}

export { BUILTIN_PROFILES, getProfile, mergeProfile } from "./profiles.js";
export type {
  BuiltinProfileName,
} from "./profiles.js";
export type {
  Capabilities,
  Characteristics,
  ChromaSubsampling,
  ContentAwareRule,
  EncoderId,
  FormatConfig,
  GpuOptions,
  HqOptions,
  LogLevel,
  MissingEncoderPolicy,
  OutputFormat,
  Profile,
  RoutingDecision,
} from "./types.js";
