#!/usr/bin/env node
/**
 * Live regression smoke for the README quickstart (StreamMonitorAgent.start()).
 *
 * Run against a freshly packed + installed tarball (see .github/workflows/smoke-install.yml),
 * not source, so it proves what a real `npm install @wave-av/adk` consumer gets.
 *
 * The quickstart makes exactly one kind of call: GET /v1/streams/{streamId}/status
 * (start() registers nothing unless `register: true`). The script blocks every
 * other method, so it cannot create or change anything.
 *
 * Pass conditions:
 *   - start() resolves, and the first poll either returns a status or reports a
 *     WaveToolError carrying the gateway's HTTP status and request id through
 *     onError (the gateway answered; the SDK surfaced the answer).
 * Fail conditions:
 *   - any module-resolution / import error
 *   - 401 (the SDK's auth header is wrong or the key is bad)
 *   - an error that is not a WaveToolError, or one without a request id
 *
 * Needs a customer key in WAVE_AGENT_KEY (never an internal gateway key).
 */
import { StreamMonitorAgent, WaveToolError } from '@wave-av/adk';

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const method = String(init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return Promise.reject(new Error(`smoke GET-only guard blocked ${method} ${String(input)}`));
  return realFetch(input, init);
};

const apiKey = process.env.WAVE_AGENT_KEY || process.env.WAVE_API_KEY;
if (!apiKey) {
  console.error('smoke-quickstart: set WAVE_AGENT_KEY (a customer wave_live_* key). Nothing was sent.');
  process.exit(2);
}

const errors = [];
const statuses = [];
const monitor = new StreamMonitorAgent({
  apiKey,
  agentName: 'ci-smoke-monitor',
  streamIds: [process.env.WAVE_STREAM_ID ?? '00000000-0000-4000-8000-000000000000'],
  pollingIntervalMs: 60_000,
  onError: (err) => errors.push(err),
});
monitor.on('stream.status', async (event) => { statuses.push(event); });

await monitor.start();
await monitor.stop();

if (statuses.length > 0) {
  console.log(`smoke-quickstart: pass -- status ${JSON.stringify(statuses[0]).slice(0, 200)}`);
  process.exit(0);
}
const err = errors[0];
if (err instanceof WaveToolError && err.status && err.status !== 401 && err.requestId) {
  console.log(`smoke-quickstart: pass -- gateway answered ${err.status} ${err.gatewayCode ?? ''} request_id=${err.requestId}; SDK surfaced it as WaveToolError ${err.code}`);
  process.exit(0);
}
console.error(`smoke-quickstart: FAIL -- ${err ? `${err.name} ${err.code ?? ''} ${err.message}` : 'no status and no error reported'}`);
process.exit(1);
