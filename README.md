# astro-image-hq

High-quality image service for Astro. Routes AVIF encoding across `avifenc`,
NVENC, and sharp with content-aware shadow detection — fixes banding in dark
photographs that 8-bit sharp output cannot.

## Why

`astro:assets` uses sharp (libvips). Sharp's prebuilt binaries lack 10-bit
HEIF/AVIF support, so dark gradients exhibit visible banding even at high
quality settings. This package routes AVIF encoding to `avifenc` (libavif CLI)
or NVENC when available, falling back to sharp when not.

## Install

```sh
bun add astro-image-hq
# or
npm install astro-image-hq
```

Optional encoders (one of):

```sh
# libavif CLI — recommended; produces 10-bit 4:4:4 AVIF
sudo pacman -S libavif         # Arch
sudo apt install libavif-bin   # Debian/Ubuntu

# ffmpeg with av1_nvenc — fastest, but 8-bit 4:2:0 only
# (most distros' ffmpeg already ships with NVENC)
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import hqService from "astro-image-hq";

export default defineConfig({
  image: {
    service: hqService({ profile: "photo" }),
  },
});
```

That's it. The service auto-detects available encoders and routes
intelligently. Build output reports the active routing:

```
[astro-image-hq] profile=photo; AVIF route: avifenc
[astro-image-hq] available: sharp 0.34.5, avifenc 1.0.4
```

## Profiles

Pick the profile that matches your use case:

| Profile     | AVIF                         | Missing-encoder | Use case                    |
| ----------- | ---------------------------- | --------------- | --------------------------- |
| `fast`      | sharp 8-bit q80 4:4:4        | silent fallback | Dev iteration, CI smoke     |
| `balanced`  | avifenc 8-bit q88 4:4:4      | warn + fallback | Default                     |
| `hq`        | avifenc 10-bit q92 4:4:4     | **fail build**  | Production                  |
| `photo`     | hq + content-aware shadows   | warn + fallback | Photography blogs           |

## Content-aware shadow boost

The `photo` profile detects dark gradient images and applies maximum-quality
encoding. The original image that motivated this package — a dark room with
sofa shadows — went from visible banding to clean gradients with the boost.

Detection is cheap (sharp `stats()` on a 256px thumbnail) and runs once per
image. Triggered when:
- mean luma < 64
- stdev luma > 12

## Custom profiles

```js
import hqService, { BUILTIN_PROFILES, mergeProfile } from "astro-image-hq";

const myProfile = mergeProfile(BUILTIN_PROFILES.hq, {
  avif: { quality: 95, encoderPreference: ["avifenc"] },
});

export default defineConfig({
  image: {
    service: hqService({ profile: myProfile }),
  },
});
```

Or pass an entirely custom profile object. See `src/types.ts` for the shape.

## Encoder reality

| Encoder          | Bit depth | Chroma     | Speed     | When chosen                     |
| ---------------- | --------- | ---------- | --------- | ------------------------------- |
| `avifenc` (CPU)  | 8 / 10    | 4:4:4 etc. | Slow      | Default for AVIF when installed |
| `av1_nvenc` (GPU)| 8 only    | 4:2:0 only | Very fast | Explicit opt-in; 4:2:0 8-bit only |
| `sharp` (libvips)| 8 only    | 4:4:4 etc. | Fast      | Fallback / non-AVIF formats     |

NVENC AV1 silicon supports 4:4:4 10-bit on Ada+ GPUs, but ffmpeg's wrapper
currently only exposes 4:2:0 8-bit AVIF output. Routing automatically skips
NVENC when 4:4:4 or 10-bit is requested.

## Configuration

```ts
hqService({
  profile: "photo" | "hq" | "balanced" | "fast" | Profile,

  // Override profile defaults per format
  formats: {
    avif: { encoderPreference: ["avifenc", "sharp"] },
  },

  // Skip NVENC when GPU memory is busy (default 0.5)
  gpu: { maxMemoryUtilization: 0.5 },

  // "off" | "summary" | "verbose"
  log: "summary",
})
```

## License

MIT
