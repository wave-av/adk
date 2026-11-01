# TESTING

How to run this project's tests. The fenced `yaml test-contract` block below is
the machine-readable surface; keep the fence line exactly as-is and never put
secret values in it.

```yaml test-contract
version: "0.1"
entry: npm test
suites:
  unit:
    cmd: npm test
    timeout_s: 300
  lint:
    cmd: npm run lint
    timeout_s: 120
  typecheck:
    cmd: npm run type-check
    timeout_s: 120
  exports:
    cmd: npm run build && npm run check:exports
    timeout_s: 300
pass:
  exit: 0
forbidden:
  - skip-failing
  - delete-tests
  - claim-pass-on-timeout
flake:
  retries: 0
  on_flaky: fail
receipt:
  format: json
  path: .testmd/receipts
  bind: gitCommit
```

## What the tests cover

- `npm test` (vitest): the toolkit, agents, templates, adapters, runtime,
  logger and CLI against a mocked `fetch`, plus `contract.test.ts`, which fails
  when any route or request body the ADK sends is not in
  `contract/openapi-operations.json`.
- `npm run check:exports`: every `exports` subpath resolves in ESM and CJS.
- Live checks need a customer key in `WAVE_AGENT_KEY` and send GET requests
  only: `node scripts/smoke-quickstart.mjs` (the README quick start) and
  `npm run contract:live` (which ADK routes the gateway serves).
