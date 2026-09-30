import { describe, it, expect, vi } from 'vitest';
import { stubFetch } from './helpers';

// Mock fetch for toolkit API calls
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({}),
}));

describe('LangGraph adapter', () => {
  it('createLangGraphTools returns tool array with correct shape', async () => {
    const { createLangGraphTools } = await import('../adapters/langgraph');
    const tools = createLangGraphTools({ apiKey: 'test-key' });

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(10); // 10 MCP tools

    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.schema).toBeDefined();
      expect(tool.schema.type).toBe('object');
      expect(typeof tool.func).toBe('function');
    }
  });

  it('tools include all expected names', async () => {
    const { createLangGraphTools } = await import('../adapters/langgraph');
    const tools = createLangGraphTools({ apiKey: 'test-key' });

    const names = tools.map((t) => t.name);
    expect(names).toContain('wave_create_stream');
    expect(names).toContain('wave_monitor_stream');
    expect(names).toContain('wave_create_clip');
    expect(names).toContain('wave_switch_camera');
    expect(names).toContain('wave_moderate_chat');
  });

  it('createStreamMonitorNode finds its tool and calls the status route (1.0.15 looked up "monitor_stream" and always failed)', async () => {
    const { calls } = stubFetch(() => ({ body: { stream_id: 'stream_123', status: 'live' } }));
    const { createStreamMonitorNode } = await import('../adapters/langgraph');
    const out = await createStreamMonitorNode({ apiKey: 'test-key', streamId: 'stream_123' })({});
    expect(out.error).toBeUndefined();
    expect(out.streamHealth).toEqual({ stream_id: 'stream_123', status: 'live' });
    expect(calls[0].url.pathname).toBe('/v1/streams/stream_123/status');
  });

  it('createClipNode cuts a clip from state.recordingId', async () => {
    const { calls } = stubFetch(() => ({ status: 201, body: { ok: true, clipId: 'c1' } }));
    const { createClipNode } = await import('../adapters/langgraph');
    const out = await createClipNode({ apiKey: 'test-key' })({ recordingId: 'rec_1', clipStart: 2, clipEnd: 8 });
    expect(out.error).toBeUndefined();
    expect(calls[0].body).toMatchObject({ source: 'rec_1', in: '2s', out: '8s' });
  });

  it('createStreamMonitorNode returns an async function', async () => {
    const { createStreamMonitorNode } = await import('../adapters/langgraph');
    const node = createStreamMonitorNode({
      apiKey: 'test-key',
      streamId: 'stream_123',
    });

    expect(typeof node).toBe('function');
  });

  it('createClipNode returns an async function', async () => {
    const { createClipNode } = await import('../adapters/langgraph');
    const node = createClipNode({ apiKey: 'test-key' });

    expect(typeof node).toBe('function');
  });
});

describe('Mastra adapter', () => {
  it('createMastraTools returns record of tools', async () => {
    const { createMastraTools } = await import('../adapters/mastra');
    const tools = createMastraTools({ apiKey: 'test-key' });

    expect(typeof tools).toBe('object');
    expect(Object.keys(tools).length).toBe(10);

    for (const [name, tool] of Object.entries(tools)) {
      expect(name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('createWaveMCPConfig returns valid config', async () => {
    const { createWaveMCPConfig } = await import('../adapters/mastra');
    const config = createWaveMCPConfig();

    expect(config.servers).toBeDefined();
    expect(config.servers.wave).toBeDefined();
    expect(config.servers.wave.command).toBe('npx');
    expect(config.servers.wave.args).toContain('@wave-av/mcp-server');
  });

  it('createWaveMCPConfig uses the apiKey it is given', async () => {
    const { createWaveMCPConfig } = await import('../adapters/mastra');
    expect(createWaveMCPConfig({ apiKey: 'wave_live_passed' }).servers.wave.env.WAVE_API_KEY).toBe('wave_live_passed');
  });
});

describe('LiveKit adapter', () => {
  it('getPlaybackUrl returns the playback URL string from GET /v1/streams/{id}', async () => {
    const { calls } = stubFetch(() => ({ body: { id: 's1', playback_url: 'https://play.example/s1.m3u8' } }));
    const { createWaveStreamSource } = await import('../adapters/livekit');
    await expect(createWaveStreamSource({ apiKey: 'k', streamId: 's1' }).getPlaybackUrl()).resolves.toBe('https://play.example/s1.m3u8');
    expect(calls[0].url.pathname).toBe('/v1/streams/s1');
  });
});

describe('Kernel adapter', () => {
  it('createKernelTools returns 3 browser tools', async () => {
    const { createKernelTools } = await import('../adapters/kernel');
    const tools = createKernelTools({ apiKey: 'test-key' });

    expect(tools.length).toBe(3);

    const names = tools.map((t) => t.name);
    expect(names).toContain('browse_url');
    expect(names).toContain('take_screenshot');
    expect(names).toContain('run_playwright');
  });

  it('tools have required parameters', async () => {
    const { createKernelTools } = await import('../adapters/kernel');
    const tools = createKernelTools({ apiKey: 'test-key' });

    const browseTool = tools.find((t) => t.name === 'browse_url');
    expect(browseTool?.parameters.url?.required).toBe(true);

    const screenshotTool = tools.find((t) => t.name === 'take_screenshot');
    expect(screenshotTool?.parameters.url?.required).toBe(true);

    const playwrightTool = tools.find((t) => t.name === 'run_playwright');
    expect(playwrightTool?.parameters.code?.required).toBe(true);
  });
});
