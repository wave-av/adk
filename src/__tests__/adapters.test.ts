import { describe, it, expect, vi } from 'vitest';

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
    expect(names).toContain('create_stream');
    expect(names).toContain('monitor_stream');
    expect(names).toContain('create_clip');
    expect(names).toContain('switch_camera');
    expect(names).toContain('moderate_chat');
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
