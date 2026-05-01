# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
