# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The `wave-adk` CLI is now actually usable: the published `bin` pointed at
  `./dist/cli/index.mjs`, a file the build never produced. The build now
  compiles `src/cli/index.ts` and `bin` points at the emitted
  `./dist/cli/index.js`.
