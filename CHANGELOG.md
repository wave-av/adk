# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No user-facing changes since 1.0.15.

## [1.0.15] - 2026-08-04

### Added

- Apache-2.0 license, with a NOTICE file reserving the WAVE marks (#16).

### Changed

- `package.json` bumped to `1.0.15`. The repository and the registry had drifted:
  `package.json` on `main` still read `1.0.2` while the published `latest` was
  `1.0.14`, so the release gate's tag/manifest equality check refused every
  `v*` tag. `1.0.14`'s published tarball contains `dist/{adapters,agents,
  templates,tools}/…`, output this repository's build (`tsup src/index.ts`)
  never produces, meaning those versions were published from somewhere other
  than this repository. `1.0.15` declares this repository the build source
  going forward without moving any published version number backwards (#72).

### Fixed

- The `wave-adk` CLI now works. The published `bin` pointed at
  `./dist/cli/index.mjs`, a file the build never produced. The build now
  compiles `src/cli/index.ts`, and `bin` points at the emitted
  `./dist/cli/index.js` (#67).
- TypeScript declarations now ship with the package. `package.json` advertised
  `./dist/index.d.ts`, but the build never emitted declarations. The build now
  passes `--dts` to tsup (#67).
- `z.record(z.unknown())` fixed to the two-argument zod v4 signature
  `z.record(z.string(), z.unknown())`. The error was masked because no root
  `tsconfig.json` existed, so `tsc --noEmit` never ran and tsup/esbuild
  transpiled without type-checking. A root `tsconfig.json` now runs
  type-check in CI (#20).

## [1.0.6] - 2026-04-02

### Added

- Initial public release: 10 tools, 5 templates, 4 adapters, and
  `AgentRuntime` v2.
- npm publish workflow triggered on tag push.

### Fixed

- Removed unverified marketing claims from brand copy and fixed the community
  URL.

[Unreleased]: https://github.com/wave-av/adk/compare/v1.0.15...HEAD
[1.0.15]: https://github.com/wave-av/adk/compare/v1.0.6...v1.0.15
[1.0.6]: https://github.com/wave-av/adk/releases/tag/v1.0.6
