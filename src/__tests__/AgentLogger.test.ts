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

  it('logging past a full buffer while a forward hangs queues one flush, not one per line', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      for (let i = 0; i < 400; i++) logger.info(`line ${i}`); // 100 trigger the first forward, 300 more pile up
      const shutdown = logger.flush(); // shares the flush already waiting
      releaseFirst(new Response(null, { status: 503 })); // the collector is down
      expect(await shutdown).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(2); // the hung forward and one retry, not one per queued line
      const retry = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(retry.logs).toHaveLength(400); // the failed 100 plus the 300 logged meanwhile, in order
      expect(retry.logs[0].message).toBe('line 0');
      expect(logger.pendingCount).toBe(400);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('a queued flush sends everything logged while the earlier forward was on the wire', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      for (let i = 0; i < 400; i++) logger.info(`line ${i}`);
      const shutdown = logger.flush();
      releaseFirst(new Response(null, { status: 202 }));
      expect(await shutdown).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(second.logs).toHaveLength(300);
      expect(logger.pendingCount).toBe(0);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('a failing collector is not retried per log line, and the buffer stays bounded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      for (let i = 0; i < 100; i++) logger.info(`line ${i}`); // buffer full: one forward, which fails
      expect(await logger.flush()).toBe(false);
      const callsAfterFailure = fetchMock.mock.calls.length;
      for (let i = 100; i < 2_000; i++) logger.info(`line ${i}`);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFailure); // waits for the periodic flush
      expect(logger.pendingCount).toBe(1_000);
      expect(logger.droppedCount).toBe(1_000);
      const dropWarnings = () => stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Log collector is behind'));
      expect(dropWarnings()).toHaveLength(1); // reported at once, not per dropped record

      fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
      expect(await logger.flush()).toBe(true); // the periodic flush recovers
      const sent = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
      expect(sent.logs[0].message).toBe('line 1000'); // the newest 1,000 survived
      expect(sent.logs.at(-1).message).toBe('line 1999');

      fetchMock.mockResolvedValue(new Response(null, { status: 503 })); // falls behind again: warned again
      logger.info('again');
      expect(await logger.flush()).toBe(false);
      for (let i = 0; i < 1_001; i++) logger.info(`more ${i}`);
      expect(dropWarnings()).toHaveLength(2);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('gives every forward a deadline so shutdown cannot hang on the collector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = new AgentLogger({ agentName: 'a', level: 'info', forwardUrl: 'https://logs.example.com/ingest', apiKey: 'k' });
    try {
      logger.info('one');
      expect(await logger.flush()).toBe(true);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
    }
  });
});
