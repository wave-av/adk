import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLogger } from '../agents/AgentLogger';

describe('AgentLogger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes structured JSON to stdout for info level', () => {
    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'info',
      forwardUrl: '',
      apiKey: 'test-key',
    });

    logger.info('Hello world', { key: 'value' });

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('info');
    expect(output.agent).toBe('test-agent');
    expect(output.message).toBe('Hello world');
    expect(output.data).toEqual({ key: 'value' });
    expect(output.timestamp).toBeDefined();
  });

  it('writes errors to stderr', () => {
    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'info',
      forwardUrl: '',
      apiKey: 'test-key',
    });

    logger.error('Something failed', { code: 500 });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(output.level).toBe('error');
    expect(output.message).toBe('Something failed');
  });

  it('respects log level filtering', () => {
    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'warn',
      forwardUrl: '',
      apiKey: 'test-key',
    });

    logger.debug('Debug message');
    logger.info('Info message');
    logger.warn('Warn message');
    logger.error('Error message');

    // debug and info should be filtered out
    expect(stdoutSpy).toHaveBeenCalledOnce(); // only warn
    expect(stderrSpy).toHaveBeenCalledOnce(); // only error
  });

  it('omits data field when empty', () => {
    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'info',
      forwardUrl: '',
      apiKey: 'test-key',
    });

    logger.info('No data');

    const output = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(output.data).toBeUndefined();
  });

  it('buffers logs when forwardUrl is set', () => {
    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'info',
      forwardUrl: 'https://api.wave.online',
      apiKey: 'test-key',
    });

    logger.info('Buffered message');

    // Still writes to stdout
    expect(stdoutSpy).toHaveBeenCalledOnce();

    // Cleanup timer
    logger.destroy();
  });

  it('destroy stops flush timer', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');

    const logger = new AgentLogger({
      agentName: 'test-agent',
      level: 'info',
      forwardUrl: 'https://api.wave.online',
      apiKey: 'test-key',
    });

    logger.destroy();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('a flush waits for an in-flight forward and resends its records if that forward failed', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      logger.info('one');
      logger.info('two');
      const periodic = logger.flush(); // the auto-flush: buffer is now empty, request on the wire
      const shutdown = logger.flush(); // must not report success on the empty buffer
      expect(logger.pendingCount).toBe(0);
      releaseFirst(new Response(null, { status: 503 }));
      expect(await periodic).toBe(false);
      expect(await shutdown).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const resent = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(resent.logs.map((l: { message: string }) => l.message)).toEqual(['one', 'two']);
      expect(logger.pendingCount).toBe(0);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('a flush that follows a failing in-flight forward reports the failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      logger.info('one');
      const first = logger.flush();
      const second = logger.flush();
      expect(await first).toBe(false);
      expect(await second).toBe(false);
      expect(logger.pendingCount).toBe(1);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });
});
