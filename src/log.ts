/**
 * Build-time logging.
 *
 * Designed to be terse: one line at first transform announcing the active
 * encoder routing, plus a per-image trace at verbose level. The aggregate
 * tally must be emitted by the consumer (the build process) since the
 * service has no "build complete" signal — we expose a snapshot helper.
 */

import type { Capabilities, EncoderId, LogLevel, Profile, RoutingDecision } from "./types.js";

const PREFIX = "[astro-image-hq]";

export interface Logger {
  readonly level: LogLevel;
  readonly summary: (caps: Capabilities, profile: Profile) => void;
  readonly trace: (decision: RoutingDecision, format: string) => void;
  readonly tally: (counts: Record<EncoderId | "boosted", number>) => void;
  readonly warn: (message: string) => void;
}

export function createLogger(level: LogLevel): Logger {
  let summarized = false;
  return {
    level,
    summary(caps, profile) {
      if (level === "off" || summarized) return;
      summarized = true;
      const lines = formatSummary(caps, profile);
      for (const line of lines) console.log(`${PREFIX} ${line}`);
    },
    trace(decision, format) {
      if (level !== "verbose") return;
      console.log(
        `${PREFIX} ${format} → ${decision.encoder}` +
          (decision.contentBoosted ? " (boosted)" : "") +
          ` — ${decision.reason}`,
      );
    },
    tally(counts) {
      if (level === "off") return;
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`);
      if (parts.length === 0) return;
      console.log(`${PREFIX} encoded: ${parts.join(", ")}`);
    },
    warn(message) {
      if (level === "off") return;
      console.warn(`${PREFIX} warning: ${message}`);
    },
  };
}

function formatSummary(caps: Capabilities, profile: Profile): string[] {
  const encoders: string[] = [`sharp ${caps.sharp.version}`];
  if (caps.avifenc) encoders.push(`avifenc ${caps.avifenc.version}`);
  if (caps.nvenc) {
    encoders.push(`av1_nvenc on ${caps.nvenc.gpuName} (sm_${caps.nvenc.computeCap.replace(".", "")})`);
  }
  return [
    `profile=${profile.name}; AVIF route: ${profile.formats.avif.encoderPreference.join(" > ")}`,
    `available: ${encoders.join(", ")}`,
  ];
}
