import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentToolkit, WaveToolError } from '../tools';
import { buildPath } from '../routes';
import { stubFetch, ROUTE_NOT_FOUND_BODY } from './helpers';

const KEY = 'wave_live_test_key';

describe('AgentToolkit gateway errors (wave-av/adk#62)', () => {
  it('throws WaveToolError with the gateway code and request id instead of resolving the error body', async () => {
    stubFetch(() => ({ status: 404, body: ROUTE_NOT_FOUND_BODY, headers: { 'x-request-id': 'hdr-id' } }));
    const tool = new AgentToolkit({ apiKey: KEY }).findTool('wave_monitor_stream');

    const err = await tool.handler({ streamId: 's1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WaveToolError);
    const e = err as WaveToolError;
    expect(e.status).toBe(404);
    expect(e.code).toBe('WAVE_ERR_NOT_FOUND');
    expect(e.gatewayCode).toBe('ROUTE_NOT_FOUND');
    expect(e.requestId).toBe('fb990d81-2114-4602-8b30-5ad12ff00a5b'); // body wins over header
    expect(e.message).toContain('WAVE API error: 404');
    expect(e.message).toContain('GET /v1/streams/{streamId}/status');
    expect(e.message).not.toContain(KEY);
  });

  it('falls back to the x-request-id header and keeps 403 scope errors actionable', async () => {
    stubFetch(() => ({ status: 403, body: { error: { code: 'SCOPE_INSUFFICIENT', message: 'needs switcher:write' } }, headers: { 'x-request-id': 'hdr-id' } }));
    const err = (await new AgentToolkit({ apiKey: KEY })
      .findTool('wave_switch_camera')
      .handler({ switcherId: 'sw1', sourceId: 'cam2' })
      .catch((e: unknown) => e)) as WaveToolError;
    expect(err.code).toBe('WAVE_ERR_FORBIDDEN');
    expect(err.gatewayCode).toBe('SCOPE_INSUFFICIENT');
    expect(err.requestId).toBe('hdr-id');
    expect(err.fix).toContain('wave-scopes.json');
  });

  it('resolves the parsed body on 2xx', async () => {
    stubFetch(() => ({ body: { stream_id: 's1', status: 'live' } }));
    const out = await new AgentToolkit({ apiKey: KEY }).findTool('wave_monitor_stream').handler({ streamId: 's1' });
    expect(out).toEqual({ stream_id: 's1', status: 'live' });
  });
});

describe('AgentToolkit request shapes follow the contract', () => {
  let calls: ReturnType<typeof stubFetch>['calls'];
  beforeEach(() => {
    ({ calls } = stubFetch(() => ({ body: {} })));
  });

  it('wave_create_clip sends ClipCreate {source, sourceType, in, out}', async () => {
    await new AgentToolkit({ apiKey: KEY }).findTool('wave_create_clip').handler({ recordingId: 'rec_1', startTime: 5, endTime: 20.5 });
    expect(calls[0].body).toEqual({ source: 'rec_1', sourceType: 'recording_id', in: '5s', out: '20.5s' });
  });

  it('wave_moderate_chat sends ModerateRequest with contentType chat', async () => {
    await new AgentToolkit({ apiKey: KEY }).findTool('wave_moderate_chat').handler({ content: 'hi', streamId: 's1' });
    expect(calls[0].body).toEqual({ content: 'hi', contentType: 'chat', context: { streamId: 's1' } });
  });

  it('wave_analyze_quality sends a from/to window', async () => {
    await new AgentToolkit({ apiKey: KEY }).findTool('wave_analyze_quality').handler({ streamId: 's1', timeRange: '1h' });
    const from = Date.parse(calls[0].url.searchParams.get('from') ?? '');
    const to = Date.parse(calls[0].url.searchParams.get('to') ?? '');
    expect(to - from).toBe(3_600_000);
  });

  it('wave_control_camera sends a ControlCameraRequest variant and enforces its fields', async () => {
    const tool = new AgentToolkit({ apiKey: KEY }).findTool('wave_control_camera');
    await tool.handler({ cameraId: 'cam1', type: 'recall_preset', presetId: 'p1' });
    expect(calls[0].body).toEqual({ type: 'recall_preset', presetId: 'p1' });
    await expect(tool.handler({ cameraId: 'cam1', type: 'set_zoom' })).rejects.toMatchObject({ code: 'WAVE_ERR_VALIDATION' });
  });

  it('accepts non-UUID stream ids (the contract types streamId as a plain string)', async () => {
    await new AgentToolkit({ apiKey: KEY }).findTool('wave_monitor_stream').handler({ streamId: 'stream_abc123' });
    expect(calls[0].url.pathname).toBe('/v1/streams/stream_abc123/status');
  });
});

describe('validation and keys', () => {
  it.each([undefined, '', '   ', 'undefined'])('refuses apiKey %j before any request (no "Bearer undefined")', (apiKey) => {
    const { fn } = stubFetch();
    expect(() => new AgentToolkit({ apiKey: apiKey as string })).toThrow(WaveToolError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects bad params with WAVE_ERR_VALIDATION and makes no request', async () => {
    const { fn } = stubFetch();
    const tool = new AgentToolkit({ apiKey: KEY }).findTool('wave_create_clip');
    await expect(tool.handler({ recordingId: 'r', startTime: 10, endTime: 5 })).rejects.toMatchObject({ code: 'WAVE_ERR_VALIDATION' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('findTool suggests the closest name', () => {
    const toolkit = new AgentToolkit({ apiKey: KEY });
    expect(() => toolkit.findTool('wave_create_streem')).toThrow(/Did you mean "wave_create_stream"/);
  });

  it('buildPath encodes ids so they cannot add segments or a query', () => {
    expect(buildPath('/v1/streams/{streamId}/status', { streamId: '../agents?x=1' })).toBe('/v1/streams/..%2Fagents%3Fx%3D1/status');
    expect(() => buildPath('/v1/streams/{streamId}', {})).toThrow(/streamId/);
  });

  it('toMCPTools exposes enums and array items', () => {
    const tools = new AgentToolkit({ apiKey: KEY }).toMCPTools();
    const cam = tools.find((t) => t.name === 'wave_control_camera');
    expect((cam?.inputSchema.properties as Record<string, { enum?: string[] }>).type.enum).toContain('set_zoom');
    expect(tools).toHaveLength(10);
  });
});

vi.unstubAllGlobals();
