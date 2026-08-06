# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-08-06

### Fixed

- Alpha-bearing images (transparent PNGs/logos) route to aom-only. SVT-AV1
  and av1_nvenc drop the alpha plane entirely, rendering transparent regions
  as solid black. Routing now skips NVENC and drops non-aom codecs when the
  image has meaningful transparency (commit 528ced4).
- AVIF 4:2:0 outputs now clamp resize target dimensions to even values in all
  three encoders (sharp, avifenc, nvenc). Firefox rejects AVIFs with odd
  dimensions encoded 4:2:0 ("Image corrupt or truncated") - aom pads odd
  dimensions and crops in-bitstream, which Chrome honors but Firefox requires
  a container clap box for. Floor-to-even via a shared helper; 4:4:4 and
  4:2:2 outputs are not clamped.
- `propertiesToHash` now includes the package version so that consumer image
  caches (e.g. Astro's `node_modules/.astro/assets` cache) invalidate on
  upgrade, ensuring the above fixes reach consumers.

## [0.1.4] - 2026-05-01

### Fixed

- NVENC AV1 minimum frame dimension (128x128) gating. Routing skips
  NVENC for inputs below the minimum so favicons and tiny srcset
  variants fall through to avifenc. Source: ffmpeg error
  `InitializeEncoder failed: invalid param (8): Frame dimensions are
  less than the minimum supported value`.
- NVENC encoder reads actual post-resize PNG dimensions and delegates
  to the sharp encoder when below 128px (route's pre-flight uses
  transform.width/height which can differ from post-resize dims under
  fit:inside). Defense-in-depth: also falls back to sharp on any
  unexpected NVENC failure rather than crashing the build.

## [0.1.3] — 2026-05-01

### Fixed

- Encoder-level codec fallback for cases the route can't predict.
  `transform.width`/`transform.height` are *max* dimensions; sharp's
  `fit: inside` resize can produce odd actual dimensions even when the
  caller passed even ones. The avifenc encoder now reads the resized
  PNG's actual dimensions and drops the `-c` flag when the codec
  constraints (SVT-AV1 64x64 minimum, 4:2:0 even-parity, rav1e 32x32
  minimum) are violated post-resize.
- Defense-in-depth retry: if avifenc still errors despite the
  pre-flight check (covers unknown future codec constraints), the
  encoder retries once without `-c` and lets avifenc use its default.

## [0.1.2] — 2026-05-01

### Fixed

- Drop SVT-AV1 codec when image width or height is odd at 4:2:0 chroma.
  SVT-AV1 errors with `Source Width must be even for YUV_420 colorspace`
  on inputs that aom handles internally. Astro generates srcset variants
  with odd dimensions on some sources, breaking the build.
- Generalized the codec-constraint table: each codec now has a
  `CodecConstraints` record with `minDim` and `even420` flags. rav1e
  picks up its own 32px minimum for free.

## [0.1.1] — 2026-05-01

### Fixed

- Drop SVT-AV1 codec when image dimensions are below 64×64. SVT-AV1
  rejects smaller inputs with `Source Width/Height must be at least 64`,
  causing build failures on favicons and small srcset variants. The
  router now falls back to avifenc's default codec (typically aom) for
  those cases. Manifests as a per-codec `CODEC_MIN_SIZE` table that
  also covers future codec additions.

### Added

- `width`/`height` fields on `DecideArgs` so the router can apply
  dimension-aware policies (currently only the SVT-AV1 minimum check).

## [0.1.0] — 2026-05-01

Initial release.

### Added

- Custom Astro `LocalImageService` with strategy-pattern encoder routing.
- Three encoder strategies:
  - `sharp` — universal fallback via libvips.
  - `avifenc` — libavif 1.x CLI with codec selection (aom/svt/rav1e).
  - `nvenc` — ffmpeg `av1_nvenc` for GPU-accelerated 4:2:0 AV1.
- Capability detection probing sharp version, avifenc version + built-in
  codecs, ffmpeg encoder list, NVIDIA GPU compute capability and memory.
- Four built-in profiles:
  - `fast` — sharp 8-bit 4:2:0, dev-iteration speed.
  - `balanced` — 4:2:0 10-bit via NVENC or avifenc-svt with sharp fallback.
  - `hq` — strict 4:4:4 10-bit aom for max-quality production.
  - `photo` — hybrid: 4:2:0 10-bit default + content-aware shadow boost
    promoting dark gradients to 4:4:4 10-bit aom.
- Content-aware analysis using `sharp.stats()` on a 256px thumbnail to
  compute mean/stdev luma and classify dark gradient images.
- Shadow boost rule: dark gradient images get promoted encoder, codec,
  chroma, and quality settings on the fly.
- Component-level quality override with **boost-as-floor** precedence:
  bright images take the per-call value, dark gradients are clamped up
  to the boost's quality.
- Codec capability fallback: when avifenc lacks the requested codec
  (e.g. older libavif without svt-av1), the codec field is dropped so
  avifenc uses its default.
- Build-time encoder summary log (`profile=…; AVIF route: …; available: …`).
- Configurable GPU memory utilization threshold for NVENC routing.

### Limitations

- NVENC AVIF output is restricted to 4:2:0 chroma (consumer GPU silicon
  does not yet expose 4:4:4 AV1 encode).
- ffmpeg's AVIF muxer requires seekable output; NVENC encoder uses a
  temporary file rather than stdin/stdout pipes.
- avifenc (libavif) must be installed separately; the package gracefully
  falls back to sharp when missing, but the 10-bit / 4:4:4 features
  require avifenc.
