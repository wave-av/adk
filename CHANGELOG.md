# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No user-facing changes since 1.1.0.

## [1.1.0] - 2026-09-30

Minor, not patch: it adds public exports and options, and it reshapes four
tool inputs to match the WAVE API contract. The old inputs never produced a
working call, so no working integration breaks.

### Fixed

- Subpath imports work again. 1.0.15 built only `src/index.ts`, so
  `import { AgentToolkit } from '@wave-av/adk/tools'` (the README quick start)
  threw `ERR_PACKAGE_PATH_NOT_EXPORTED`. The build now has one tsup entry per
  subpath, and `exports` restores `./tools`, `./agents`, `./adapters`,
  `./templates` and `./types` from 1.0.14, plus `./adapters/mastra`,
  `./adapters/langgraph`, `./adapters/livekit` and `./adapters/kernel`, each in
  ESM and CJS with types. `npm run check:exports` imports every subpath in
  both module systems and runs in CI against the packed tarball.
- Tool handlers throw on gateway errors (#62). `AgentToolkit` returned the
  gateway's `{ error: ... }` body as a successful result, so an agent never
  saw a failure. Every non-2xx answer now throws `WaveToolError` with the HTTP
  status, the gateway code (`ROUTE_NOT_FOUND`, `SCOPE_INSUFFICIENT`, ...), the
  gateway `request_id`, and a fix.
- Every tool and template calls an operation in the WAVE API contract
  (https://gateway.wave.online/openapi.json). 1.0.15 called 21 routes and 18
  were not in the contract (`/v1/streams/{id}/health`, `/v1/graphics/show`,
  `/v1/moderation/action`, `/v1/replay/poi`, `/v1/captions/start`, ...). All
  routes now live in one table, `WAVE_ROUTES` (src/routes.ts), and a contract
  test fails if any route, or any request a tool or template sends, is missing
  from the vendored contract snapshot. Path parameters are URL-encoded.
- The LangGraph nodes found their tools again (`monitor_stream` and
  `create_clip` were looked up by the wrong names, #59), shipped in a release
  for the first time.
- `wave-adk deploy` no longer prints a made-up agent id. `deploy`, `test`,
  `logs` and `status` exit 1 with "not implemented" until an API operation
  backs them. `wave-adk init <template> [dir]` scaffolds a real project through
  `@wave-av/create-app`.
- A missing key fails fast. `WaveAgent`, `AgentToolkit` and
  `createWaveStreamSource` throw `WAVE_ERR_MISSING_API_KEY` instead of sending
  `Authorization: Bearer undefined`.
- `createWaveMCPConfig({ apiKey })` uses the key it is given.
- `createWaveStreamSource().getPlaybackUrl()` returns the stream's
  `playback_url` string from `GET /v1/streams/{streamId}`, not a health object.
- `AgentLogger` sends the WAVE key only to the WAVE API origin, never to a
  third-party log collector, and re-buffers logs when the collector answers
  non-2xx.
- `package.json` `repository.directory` pointed at `packages/adk`, a path this
  repo does not have. `homepage` pointed at a 404 page; it now points at
  https://docs.wave.online/docs/adk.

### Changed

- `start()` registers the agent (`POST /v1/agents`, scope `agents:write`) only
  with `register: true`. 1.0.15 always called `POST /v1/agents/register`, a
  route outside the contract, so the README quick start failed on its first
  call. `AgentRuntime` sends platform heartbeats only for a registered agent.
- Tool inputs follow the contract: `wave_create_clip` takes `recordingId`
  (`POST /v1/clips` cuts from a recording), `wave_moderate_chat` takes the
  message `content`, `wave_start_captions` takes `videoId`, and
  `wave_control_camera` takes a command `type` (`set_zoom`, `recall_preset`,
  ...). Stream ids are no longer forced to be UUIDs.
- `StreamMonitorAgent` polls `GET /v1/streams/{streamId}/status`, alerts when
  a live stream goes idle or ended, and with `autoRemediate` restarts it with
  `POST /v1/streams/{streamId}/start`. It refuses an empty `streamIds`.
- `ModerationAgent.moderateMessage()` moderates one message with
  `POST /v1/moderate`. `blockUser()` and `approveMessage()` throw
  `WAVE_ERR_NOT_IN_CONTRACT`: the contract has no such operations.
- `CaptionAgent` creates caption jobs with `POST /v1/captions` and downloads
  them with `GET /v1/captions/{jobId}/download`.
- `AgentRuntime` `logForwardUrl` is now the full collector URL. The ADK no
  longer appends `/v1/agents/logs`, a route the WAVE API does not have.
- README is regenerated from `.wave/repo.json`. The subpath and CLI
  capabilities no longer say "planned", the quick start no longer uses a
  stream id the toolkit rejected, and new sections cover errors, keys and
  scopes, and what the live gateway serves.

### Added

- `WaveToolError`, `WAVE_ROUTES` and the template result types are exported.
- `npm test` (vitest, 80+ tests with mocked fetch), `npm run check:exports`,
  `npm run contract:sync` and `npm run contract:live`. The last one runs the
  ADK against the live gateway with a GET-only guard and reports, route by
  route, what the gateway serves.

### Known server-side gaps

Measured on 2026-09-30 with `npm run contract:live`: the client sends correct,
authenticated requests (the authenticated control `GET /v1/billing/usage`
answers 200), but none of the 16 contract routes the ADK uses is proven served.
The `/v1/streams` family answers `404 ROUTE_NOT_FOUND` (open contract change
wave-av/api-spec#111 marks it unrouted); `/v1/clips` and `/v1/captions` answer a prefix-level 402
that a made-up path under the same prefix also gets; the capability routes answer
a prefix-level 403 `SCOPE_INSUFFICIENT`. Tools surface each of these as a
`WaveToolError` with the gateway request id.

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
  Published to npm as `@wave-av/adk@1.0.15`.

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

[Unreleased]: https://github.com/wave-av/adk/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/wave-av/adk/compare/v1.0.15...v1.1.0
[1.0.15]: https://github.com/wave-av/adk/compare/v1.0.6...v1.0.15
[1.0.6]: https://github.com/wave-av/adk/releases/tag/v1.0.6
