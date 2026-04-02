import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../agents/AgentRuntime';
import { WaveAgent } from '../agents/WaveAgent';

// Suppress stdout/stderr from logger
vi.spyOn(process.stdout, 'write').mockReturnValue(true);
vi.spyOn(process.stderr, 'write').mockReturnValue(true);

// Mock fetch globally
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({}),
});
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

    // Mock agent start to avoid real API call
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();
    const health = runtime.getHealth();

    expect(health.status).toBe('healthy');
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.lastHeartbeat).toBeDefined();
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
    vi.spyOn(agent, 'start').mockResolvedValue();

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

  it('sends heartbeat on start', async () => {
    runtime = new AgentRuntime(agent, {
      healthPort: 0,
      heartbeatIntervalMs: 60_000,
    });
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();

    // First call is agent register, second is heartbeat
    const heartbeatCall = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/heartbeat')
    );
    expect(heartbeatCall).toBeDefined();
  });

  it('stop is idempotent', async () => {
    runtime = new AgentRuntime(agent, { healthPort: 0 });
    vi.spyOn(agent, 'start').mockResolvedValue();

    await runtime.start();
    await runtime.stop();
    await runtime.stop(); // second call should be no-op

    expect(agent.isRunning).toBe(false);
  });
});
