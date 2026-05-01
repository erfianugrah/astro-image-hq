# @erfianugrah/astro-image-hq

[![npm version](https://img.shields.io/npm/v/@erfianugrah/astro-image-hq.svg)](https://www.npmjs.com/package/@erfianugrah/astro-image-hq)
[![CI](https://github.com/erfianugrah/astro-image-hq/actions/workflows/ci.yml/badge.svg)](https://github.com/erfianugrah/astro-image-hq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

High-quality image service for Astro. Routes AVIF encoding across `avifenc`,
NVENC, and sharp with content-aware shadow detection — fixes banding in dark
photographs that 8-bit sharp output cannot.

## Why

`astro:assets` uses sharp (libvips). Sharp's prebuilt binaries lack 10-bit
HEIF/AVIF support, so dark gradients exhibit visible banding even at high
quality settings. This package routes AVIF encoding to `avifenc` (libavif CLI)
or NVENC when available, falling back to sharp when not.

## Quick start

```sh
bun add @erfianugrah/astro-image-hq
# or
npm install @erfianugrah/astro-image-hq
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import hqService from "@erfianugrah/astro-image-hq";

export default defineConfig({
  image: {
    service: hqService({ profile: "photo" }),
  },
});
```

That's it. The service auto-detects available encoders and routes
intelligently. Build output reports the active routing:

```
[astro-image-hq] profile=photo; AVIF route: nvenc > avifenc > sharp
[astro-image-hq] available: sharp 0.34.5, avifenc 1.4.1, av1_nvenc on NVIDIA GeForce RTX 5090
```

## Optional system dependencies

For best quality, install one or both of these on the build machine:

```sh
# libavif CLI — recommended; produces 10-bit 4:4:4 AVIF for shadow content
sudo pacman -S libavif         # Arch
sudo apt install libavif-bin   # Debian/Ubuntu

# ffmpeg with av1_nvenc — fastest path; 8-bit/10-bit 4:2:0 only
# (most distros' ffmpeg ships with NVENC; requires NVIDIA GPU)
```

Without either, the service falls back to sharp's built-in AVIF encoder
(8-bit 4:4:4) and prints a warning if the active profile expected
something better.

## Profiles

| Profile     | AVIF settings                                  | Missing-encoder | Use case                        |
| ----------- | ---------------------------------------------- | --------------- | ------------------------------- |
| `fast`      | sharp 8-bit 4:2:0 q80                          | silent fallback | Dev iteration, CI smoke         |
| `balanced`  | NVENC > avifenc-svt > sharp; 10-bit 4:2:0 q88  | warn + fallback | General purpose                 |
| `hq`        | avifenc-aom 10-bit 4:4:4 q92 (no fallback)     | **fail build**  | Production, max quality         |
| `photo`     | balanced default + content-aware shadow boost  | warn + fallback | Photography blogs (default)     |

The `photo` profile is the most common choice. It uses the fast
4:2:0 path for typical content and automatically promotes dark gradient
images to 4:4:4 10-bit aom — fixing banding on the photos that need it
without slowing down the rest of the build.

## Override precedence

Component-level overrides like `<Image quality={85} />` apply on top of
the profile defaults. Then content-aware boosts merge last, acting as a
**quality floor** for content known to band:

1. Profile defaults (e.g. `photo`: q90, 4:2:0 10-bit, NVENC)
2. Component override (e.g. `quality={85}` → q85)
3. Shadow boost on dark gradients (q95, 4:4:4, aom)

For bright/typical content, the component value drives the output. For
dark gradients, the boost overrides the component value to ensure the
banding fix is applied regardless of the project-wide quality cap.

## Content-aware shadow boost

Detection runs once per image via `sharp.stats()` on a 256px thumbnail
(~5-20 ms). Triggered when:

- Mean luma < 64 (predominantly dark)
- Stdev luma > 12 (significant gradient or detail)

When triggered, the encoding upgrades to:

- Quality 95
- 10-bit depth
- 4:4:4 chroma subsampling
- aom codec (highest quality AV1 encoder)
- avifenc encoder (CPU; ~3-5 s per image at speed=4)

For revista-3 (a personal photography blog), this caught ~7% of source
images and added negligible total build time while eliminating visible
banding in shadow regions.

## Custom profiles

```js
import hqService, { BUILTIN_PROFILES, mergeProfile } from "@erfianugrah/astro-image-hq";

// Tweak a built-in profile
const myProfile = mergeProfile(BUILTIN_PROFILES.hq, {
  avif: { quality: 95, encoderPreference: ["avifenc"] },
});

export default defineConfig({
  image: {
    service: hqService({ profile: myProfile }),
  },
});
```

Or pass a fully custom `Profile` object — see `src/types.ts` for the
shape including `ContentAwareRule`.

## Known limitations

- **NVENC chroma**: `av1_nvenc` outputs 4:2:0 only. Routing automatically
  skips NVENC when 4:4:4 or 4:2:2 is requested and routes to avifenc.
  4:4:4 hardware encoding is not yet exposed by ffmpeg or NVIDIA's
  consumer-tier driver SDK.
- **libavif version sensitivity**: the `-c svt`/`-c rav1e` codec flags
  require libavif compiled with those backends. If the installed
  `avifenc` lacks the requested codec, this package automatically drops
  the codec flag and lets avifenc use its default (aom).
- **sharp 10-bit**: prebuilt sharp binaries fail with
  `bitdepth: 10` (`Expected 8 for bitdepth when using prebuilt
  binaries`). Use avifenc for 10-bit output; sharp is 8-bit only.
- **Astro Image API surface**: only `quality` is currently overridable
  via the component. Other format settings (depth, chroma, codec) come
  from the profile or content-aware rules.

## Configuration

```ts
hqService({
  // Built-in name, or an inline Profile object.
  profile: "photo" | "hq" | "balanced" | "fast" | Profile,

  // Per-format overrides on top of the profile.
  formats: {
    avif: { encoderPreference: ["avifenc", "sharp"] },
  },

  // Skip NVENC when GPU memory utilization exceeds this fraction.
  // Default: 0.5. Useful when ComfyUI/llama.cpp share the GPU.
  gpu: { maxMemoryUtilization: 0.5 },

  // Diagnostic verbosity.
  log: "off" | "summary" | "verbose",  // default "summary"
});
```

## Compatibility

- Astro `>=5.0.0`
- sharp `>=0.33.0`
- Node `>=20`, Bun `>=1.0`
- Linux + macOS (Windows untested but should work)

## Development

```sh
git clone https://github.com/erfianugrah/astro-image-hq
cd astro-image-hq
bun install
bun run test       # 55 tests
bun run typecheck
bun run build
```

## License

MIT — see [LICENSE](./LICENSE).
