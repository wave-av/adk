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
});
