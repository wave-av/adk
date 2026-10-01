/**
 * Contract gate: the ADK may only call operations that exist in the WAVE API
 * contract (contract/openapi-operations.json, synced from the live
 * https://gateway.wave.online/openapi.json by `npm run contract:sync`).
 *
 * 1.0.15 called 21 routes, 18 of them absent from the contract
 * (/v1/streams/{id}/health, /v1/graphics/show, /v1/moderation/action, ...).
 * This test fails if any route in src/routes.ts, or any request actually sent
 * by a tool or template, is not a contract operation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WAVE_ROUTES } from '../routes';
import { AgentToolkit } from '../tools/AgentToolkit';
import { WaveAgent } from '../agents/WaveAgent';
import { AgentRuntime } from '../agents/AgentRuntime';
import { StreamMonitorAgent } from '../templates/StreamMonitorAgent';
import { AutoProducerAgent } from '../templates/AutoProducerAgent';
import { ClipFactoryAgent } from '../templates/ClipFactoryAgent';
import { ModerationAgent } from '../templates/ModerationAgent';
import { CaptionAgent } from '../templates/CaptionAgent';
import { createWaveStreamSource } from '../adapters/livekit';
import { stubFetch, type RecordedCall } from './helpers';

interface BodyShape { properties?: string[]; required?: string[]; additional?: boolean; open?: boolean }
interface Operation { method: string; path: string; operationId: string | null; body?: BodyShape }
const snapshot = JSON.parse(
  readFileSync(new URL('../../contract/openapi-operations.json', import.meta.url), 'utf8'),
) as { operations: Operation[] };

/** Segment-by-segment match of a concrete path against a `{param}` template (no dynamic RegExp). */
const pathMatches = (template: string, pathname: string) => {
  const t = template.split('/');
  const p = pathname.split('/');
  return t.length === p.length && t.every((seg, i) => (seg.startsWith('{') && seg.endsWith('}') ? p[i] !== '' : seg === p[i]));
};
const matchOperation = (method: string, pathname: string) =>
  snapshot.operations.find((op) => op.method === method && pathMatches(op.path, pathname));

/** Routes whose body the contract does not declare yet (src/routes.ts `io: 'undeclared'`). */
const undeclaredBody = new Set(
  Object.values(WAVE_ROUTES).filter((r) => r.io === 'undeclared').map((r) => `${r.method} ${r.path}`),
);

/** Body keys the operation does not declare, and required keys the body leaves out. */
const bodyViolations = (op: Operation, body: unknown): string[] => {
  if (undeclaredBody.has(`${op.method} ${op.path}`) || !op.body || op.body.open) return [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return ['body is not a JSON object'];
  const keys = Object.keys(body);
  const unknown = op.body.additional ? [] : keys.filter((k) => !op.body?.properties?.includes(k)).map((k) => `undeclared field "${k}"`);
  const missing = (op.body.required ?? []).filter((k) => !keys.includes(k)).map((k) => `missing required "${k}"`);
  return [...unknown, ...missing];
};

vi.spyOn(process.stdout, 'write').mockReturnValue(true);
vi.spyOn(process.stderr, 'write').mockReturnValue(true);

const KEY = 'wave_live_test_key';
const base = { apiKey: KEY, agentName: 'contract-test' };

describe('route table vs contract snapshot', () => {
  it.each(Object.entries(WAVE_ROUTES))('%s is a contract operation', (_name, route) => {
    const op = snapshot.operations.find((o) => o.method === route.method && o.path === route.path);
    expect(op, `${route.method} ${route.path} is not in the WAVE OpenAPI contract`).toBeDefined();
    // operationId when the contract names one; else the capability segment (an unnamed draft operation)
    expect(route.operation).toBe(op?.operationId ?? route.path.split('/')[2]);
  });

  it('the body check rejects undeclared fields and missing required fields', () => {
    const clips = snapshot.operations.find((o) => o.operationId === 'createClip');
    expect(clips?.body?.required).toEqual(['in', 'source']);
    expect(bodyViolations(clips as Operation, { source: 'rec_1', in: '1s', out: '9s' })).toEqual([]);
    expect(bodyViolations(clips as Operation, { videoId: 'v', in: '1s' })).toEqual([
      'undeclared field "videoId"',
      'missing required "source"',
    ]);
  });

  it('no source file outside routes.ts spells a /v1/ path', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__') walk(full);
        } else if (full.endsWith('.ts') && !full.endsWith('routes.ts') && !full.endsWith('kernel.ts')) {
          // kernel.ts calls Kernel's own API (api.onkernel.com), not WAVE.
          readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            const code = line.replace(/^\s*(\*|\/\/).*$/, ''); // ignore comment lines
            if (/['"`]\/v1\//.test(code)) offenders.push(`${full}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(new URL('..', import.meta.url).pathname);
    expect(offenders).toEqual([]);
  });
});

describe('every request the ADK sends is a contract operation', () => {
  let calls: RecordedCall[];

  beforeEach(() => {
    ({ calls } = stubFetch((call) => {
      if (call.url.pathname.endsWith('/status')) return { body: { stream_id: 's1', status: 'live' } };
      if (call.url.pathname === '/v1/captions') return { status: 201, body: { id: 'job_1' } };
      if (call.url.pathname === '/v1/clips') return { status: 201, body: { ok: true, clipId: 'clip_1' } };
      if (call.url.pathname === '/v1/moderate') return { body: { action: 'flag', violations: [{ category: 'spam' }] } };
      if (/^\/v1\/streams\/[^/]+$/.test(call.url.pathname)) return { body: { playback_url: 'https://play.example/s1.m3u8' } };
      return { body: {} };
    }));
  });

  const expectAllInContract = () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.origin).toBe('https://api.wave.online');
      const op = matchOperation(call.method, call.url.pathname);
      expect(op, `${call.method} ${call.url.pathname}`).toBeDefined();
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      // The request body must fit the operation's declared JSON body schema.
      if (op && call.body !== undefined) {
        expect(bodyViolations(op, call.body), `${call.method} ${call.url.pathname} body ${JSON.stringify(call.body)}`).toEqual([]);
      }
    }
  };

  it('all 10 AgentToolkit tools', async () => {
    const toolkit = new AgentToolkit({ apiKey: KEY });
    const args: Record<string, Record<string, unknown>> = {
      wave_create_stream: { title: 'Show' },
      wave_monitor_stream: { streamId: 'stream_abc123' },
      wave_create_clip: { recordingId: 'rec_1', startTime: 5, endTime: 20 },
      wave_switch_camera: { switcherId: 'sw1', sourceId: 'cam2' },
      wave_show_graphic: { switcherId: 'sw1', templateId: 'lower-third' },
      wave_moderate_chat: { content: 'hello', streamId: 's1' },
      wave_start_captions: { videoId: 'vid_1' },
      wave_analyze_quality: { streamId: 's1', timeRange: '24h' },
      wave_mark_highlight: { streamId: 's1', label: 'goal' },
      wave_control_camera: { cameraId: 'cam1', type: 'set_zoom', value: 0.5 },
    };
    const tools = toolkit.getTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(args).sort());
    for (const tool of tools) await tool.handler(args[tool.name]);
    expect(calls).toHaveLength(10);
    expectAllInContract();
  });

  it('agent registration, runtime heartbeat and every template method', async () => {
    const registered = new WaveAgent({ ...base, agentType: 'custom', register: true });
    const runtime = new AgentRuntime(registered, { healthPort: 0, heartbeatIntervalMs: 60_000 });
    await runtime.start();
    await runtime.stop();

    const monitor = new StreamMonitorAgent({ ...base, streamIds: ['s1'], autoRemediate: true, pollingIntervalMs: 60_000 });
    await monitor.start();
    await monitor.stop();

    const producer = new AutoProducerAgent({ ...base, switcherId: 'sw1' });
    await producer.start();
    await producer.switchToSource('cam2', 'speaker change');
    await producer.showGraphic('lower-third', { name: 'A' });
    await producer.markHighlight('applause');

    const clips = new ClipFactoryAgent({ ...base, streamIds: ['s1'] });
    await clips.exportClip({ streamId: 's1', recordingId: 'rec_1', startTime: 1, endTime: 9, confidence: 0.9, reason: 'x', detectedBy: 'ai_detection' });

    const mod = new ModerationAgent({ ...base, streamIds: ['s1'], rules: { customBlocklist: ['spam'] } });
    await mod.start();
    await mod.moderateMessage({ messageId: 'm1', streamId: 's1', content: 'buy spam now' });

    const captions = new CaptionAgent({ ...base, streamIds: ['vid_1'], languages: ['en', 'es'] });
    await captions.start();
    await captions.translateTo('vid_1', 'fr');
    await captions.getTranscript('vid_1');

    await createWaveStreamSource({ apiKey: KEY, streamId: 's1' }).getPlaybackUrl();

    expectAllInContract();
    const sent = new Set(calls.map((c) => `${c.method} ${c.url.pathname}`));
    expect(sent).toContain('POST /v1/agents');
    expect(sent).toContain('GET /v1/streams/s1/status');
  });
});
