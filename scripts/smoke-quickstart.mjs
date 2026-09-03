#!/usr/bin/env node
/**
 * Live regression smoke for the README quickstart (StreamMonitorAgent.start()).
 *
 * Run against a freshly packed + installed tarball (see .github/workflows/smoke-install.yml),
 * not source, so it proves what a real `npm install @wave-av/adk` consumer gets.
 *
 * Pass conditions:
 *   - monitor.start() resolves (never happens without a scoped key, kept for completeness), OR
 *   - the request reaches api.wave.online and the gateway answers 402 (payment required) or
 *     403 SCOPE_INSUFFICIENT — both prove the SDK correctly formed and sent a live request.
 * Fail conditions:
 *   - any module-resolution / import error, or any other HTTP/network failure.
 *
 * No mocks: this hits the real gateway with a real (possibly under-scoped) key.
 */
import { StreamMonitorAgent } from '@wave-av/adk';

const apiKey = process.env.WAVE_AGENT_KEY ?? process.env.WAVE_GATEWAY_API_KEY;

const monitor = new StreamMonitorAgent({
  apiKey,
  agentName: 'ci-smoke-monitor',
  streamIds: ['stream_ci_smoke'],
  autoRemediate: false,
  onQualityDrop: async () => {},
});

try {
  await monitor.start();
  console.log(`smoke-quickstart: monitor.start() resolved (isRunning=${monitor.isRunning})`);
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const reachedGateway =
    message.includes('WAVE API error: 402') ||
    (message.includes('WAVE API error: 403') && message.includes('SCOPE_INSUFFICIENT'));
  if (reachedGateway) {
    console.log(`smoke-quickstart: reached the gateway, pass -- ${message.slice(0, 200)}`);
    process.exit(0);
  }
  console.error(`smoke-quickstart: FAIL -- ${message}`);
  process.exit(1);
}
