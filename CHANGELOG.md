# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `package.json` is now `1.0.15`, reconciling the repo with the registry
  (#70). It read `1.0.2` while npm's `latest` was `1.0.14`, so the release
  gate's tag/manifest equality check refused **every** `v*` tag: `v1.0.15`
  failed because the manifest said 1.0.2, and `v1.0.2` failed because 1.0.2 is
  already published.

  The drift is itself the finding, and it is worth recording rather than
  quietly fixing: `1.0.14`'s tarball contains `dist/{adapters,agents,templates,
  tools}/…`, which `tsup src/index.ts` never emitted. Those versions were
  published from somewhere other than this repository. Jumping to 1.0.15 rather
  than continuing from 1.0.2 declares this repo the build source from here on,
  and leaves the published history intact so no consumer sees a version number
  move backwards. See wave-av/claude-workstation#1099 for the open question of
  which repo owns which `@wave-av` package.

### Fixed

- `pr-agent` lane: fork-triggered `/` commands are now refused, and the AI
  call's budget fits inside its step. Three defects, one of them only visible
  once the first was fixed.

  The job-level `if:` refused forks on the `pull_request` arm and could not on
  `issue_comment` — fork status is absent from that payload, so there was never
  an expression to write. A `fork gate` step now asks the pulls endpoint and
  fails closed: only a literal `false` proceeds, so a 404, a rate limit or a
  deleted fork all skip. The lane runs no `actions/checkout`, so fork code was
  never executed and no exfiltration path existed; what this closes is the
  comment claiming forks were already skipped, which was true of one arm only.

  `CONFIG__AI_TIMEOUT` was 600s inside a 360s step, so the runner killed the
  step before pr-agent could reach its own timeout or fall back to a secondary
  model. Now 300s.

  Fixing the first exposed a third: `stamp attempt 2 end` runs under
  `if: always()`, so when attempt 2 never ran the verdict subtracted from zero
  and reported a 1787580408-second attempt as a confident TIMED OUT.

  Contributors on forks are affected: a maintainer's `/review` on a fork PR is
  now declined with a warning rather than silently running.
  (wave-av/wave-foundation-public#73)

- The `wave-adk` CLI is now actually usable: the published `bin` pointed at
  `./dist/cli/index.mjs`, a file the build never produced. The build now
  compiles `src/cli/index.ts` and `bin` points at the emitted
  `./dist/cli/index.js`.
- TypeScript declarations now ship with the package: `package.json` advertised
  `./dist/index.d.ts` but the build never emitted declarations. The build now
  passes `--dts` to tsup.
