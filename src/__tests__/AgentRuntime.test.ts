import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../agents/AgentRuntime';
import { WaveAgent } from '../agents/WaveAgent';

// Suppress stdout/stderr from logger
vi.spyOn(process.stdout, 'write').mockReturnValue(true);
vi.spyOn(process.stderr, 'write').mockReturnValue(true);

// Mock fetch globally (fresh Response per call: a body can only be read once)
const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
vi.stubGlobal('fetch', fetchMock);

describe('AgentRuntime', () => {
  let agent: WaveAgent;
  let runtime: AgentRuntime;

  beforeEach(() => {
    fetchMock.mockClear();
    agent = new WaveAgent({
      apiKey: 'test-key',
      agentName: 'test-agent',
      agentType: 'stream_monitor',
    });
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
    }
  });

  it('creates runtime with default config', () => {
    runtime = new AgentRuntime(agent);
    const health = runtime.getHealth();

    expect(health.status).toBe('unhealthy'); // not started yet
    expect(health.agentName).toBe('test-agent');
    expect(health.totalCalls).toBe(0);
    expect(health.version).toBe('2.0.0');
  });

  it('getHealth returns healthy after start', async () => {
    runtime = new AgentRuntime(agent, { healthPort: 0 });

    // start() makes no API call for an unregistered agent (the default)
    await runtime.start();
    const health = runtime.getHealth();

    expect(health.status).toBe('healthy');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.lastHeartbeat).toBeDefined();
  });

  it('retries the final log flush once and warns on stderr when the collector still refuses', async () => {
    const stderr = vi.mocked(process.stderr.write);
    stderr.mockClear();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    const r = new AgentRuntime(agent, { healthPort: 0, logForwardUrl: 'https://logs.example.com/ingest' });
    await r.start();
    fetchMock.mockClear();
    await r.stop();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const collectorCalls = fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).startsWith('https://logs.example.com'));
    expect(collectorCalls).toHaveLength(2);
    const warned = stderr.mock.calls.map((c) => String(c[0])).find((line) => line.includes('Log forwarding failed at shutdown'));
    expect(warned).toBeDefined();
    expect(JSON.parse(warned as string).data.undelivered).toBeGreaterThan(0);
  });

  it('warns at shutdown about records dropped while the collector was behind, even after it recovered', async () => {
    const stderr = vi.mocked(process.stderr.write);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    const r = new AgentRuntime(agent, { healthPort: 0, logForwardUrl: 'https://logs.example.com/ingest' });
    await r.start();
    const logger = r.getLogger();
    for (let i = 0; i < 100; i++) logger.info(`line ${i}`); // full buffer: one forward, which fails
    await logger.flush();
    for (let i = 0; i < 1_200; i++) logger.info(`more ${i}`); // the collector is behind: the oldest are dropped
    expect(logger.droppedCount).toBeGreaterThan(0);
    stderr.mockClear();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 })); // the collector recovers
    await r.stop();
    const warned = stderr.mock.calls.map((c) => String(c[0])).find((line) => line.includes('dropped records while the collector was behind'));
    expect(warned).toBeDefined();
    expect(JSON.parse(warned as string).data).toMatchObject({ undelivered: 0, dropped: logger.droppedCount });
  });

  it('getLogger returns an AgentLogger instance', () => {
    runtime = new AgentRuntime(agent);
    const logger = runtime.getLogger();

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('stop sets agent to not running', async () => {
    runtime = new AgentRuntime(agent, { healthPort: 0 });

    await runtime.start();
    expect(agent.isRunning).toBe(true);

    await runtime.stop();
    expect(agent.isRunning).toBe(false);
  });

  it('calls onShutdown during stop', async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    runtime = new AgentRuntime(agent, { healthPort: 0, onShutdown });
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();
    await runtime.stop();

    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it('handles onShutdown timeout gracefully', async () => {
    const slowShutdown = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 60_000))
    );
    runtime = new AgentRuntime(agent, {
      healthPort: 0,
      onShutdown: slowShutdown,
      shutdownTimeoutMs: 100,
    });
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();
    // Should not hang — shutdown timeout kicks in
    await runtime.stop();

    expect(slowShutdown).toHaveBeenCalledOnce();
  });

  it('unregistered agent: local heartbeat only, no network call', async () => {
    runtime = new AgentRuntime(agent, {
      healthPort: 0,
      heartbeatIntervalMs: 60_000,
    });

    await runtime.start();
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.getHealth().lastHeartbeat).not.toBeNull();
  });

  it('registered agent: heartbeat goes to POST /v1/agents with action heartbeat', async () => {
    const registered = new WaveAgent({
      apiKey: 'test-key',
      agentName: 'test-agent',
      agentType: 'stream_monitor',
      register: true,
    });
    runtime = new AgentRuntime(registered, { healthPort: 0, heartbeatIntervalMs: 60_000 });

    await runtime.start();
    await new Promise((r) => setImmediate(r));

    const bodies = fetchMock.mock.calls
      .filter((call: unknown[]) => String(call[0]) === 'https://api.wave.online/v1/agents')
      .map((call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies.map((b: { action: string }) => b.action)).toEqual(['register', 'heartbeat']);
  });

  it('stop is idempotent', async () => {
    runtime = new AgentRuntime(agent, { healthPort: 0 });
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();
    await runtime.stop();
    await runtime.stop(); // second call should be no-op

    expect(agent.isRunning).toBe(false);
  });

  it('stop removes the SIGTERM/SIGINT handlers start installed', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    runtime = new AgentRuntime(agent, { healthPort: 0 });

    await runtime.start();
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);

    await runtime.stop();
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
  });
});
