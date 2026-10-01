import { describe, it, expect, vi, afterEach } from 'vitest';
import { WaveAgent } from '../agents/WaveAgent';
import { AgentLogger } from '../agents/AgentLogger';
import { StreamMonitorAgent } from '../templates/StreamMonitorAgent';
import { ModerationAgent } from '../templates/ModerationAgent';
import { CaptionAgent } from '../templates/CaptionAgent';
import { ClipFactoryAgent } from '../templates/ClipFactoryAgent';
import { WaveToolError } from '../errors';
import { stubFetch } from './helpers';

vi.spyOn(process.stdout, 'write').mockReturnValue(true);
vi.spyOn(process.stderr, 'write').mockReturnValue(true);

const base = { apiKey: 'wave_live_test_key', agentName: 'unit' };

class RawAgent extends WaveAgent {
  raw() {
    return this.apiCall<{ ok: boolean }>('GET', '/v1/billing/usage');
  }
}

afterEach(() => vi.useRealTimers());

describe('WaveAgent', () => {
  it('start() makes no network call unless register: true', async () => {
    const { fn } = stubFetch();
    const agent = new WaveAgent({ ...base, agentType: 'custom' });
    await agent.start();
    expect(agent.isRunning).toBe(true);
    expect(agent.isRegistered).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('register: true registers via POST /v1/agents and surfaces a scope error without retrying', async () => {
    const { calls } = stubFetch(() => ({ status: 403, body: { error: { code: 'SCOPE_INSUFFICIENT', request_id: 'rid-1' } } }));
    const agent = new WaveAgent({ ...base, agentType: 'custom', register: true });
    const err = (await agent.start().catch((e: unknown) => e)) as WaveToolError;
    expect(err).toBeInstanceOf(WaveToolError);
    expect(err.gatewayCode).toBe('SCOPE_INSUFFICIENT');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ action: 'register', name: 'unit', type: 'custom' });
    expect(agent.isRunning).toBe(false);
  });

  it('retries a GET on 5xx with backoff, then succeeds', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { calls } = stubFetch(() => (++n < 3 ? { status: 503, body: { error: { code: 'UPSTREAM' } } } : { body: { ok: true } }));
    const pending = new RawAgent({ ...base, agentType: 'custom' }).raw();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('does not resend a POST after a 5xx: the write may already have been applied', async () => {
    const { calls } = stubFetch(() => ({ status: 502, body: { error: { code: 'UPSTREAM', request_id: 'rid-502' } } }));
    const agent = new WaveAgent({ ...base, agentType: 'custom', register: true });
    const err = (await agent.start().catch((e: unknown) => e)) as WaveToolError;
    expect(err).toBeInstanceOf(WaveToolError);
    expect(err.status).toBe(502);
    expect(err.requestId).toBe('rid-502');
    expect(calls).toHaveLength(1);
    expect(agent.isRegistered).toBe(false);
  });

  it('does not resend a POST after a network error', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fn);
    const agent = new WaveAgent({ ...base, agentType: 'custom', register: true });
    await expect(agent.start()).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a POST on 429 (the gateway refused it before running it)', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { calls } = stubFetch(() =>
      ++n < 2 ? { status: 429, body: { error: { code: 'RATE_LIMITED' } }, headers: { 'retry-after': '1' } } : { body: {} },
    );
    const agent = new WaveAgent({ ...base, agentType: 'custom', register: true });
    const started = agent.start();
    await vi.runAllTimersAsync();
    await started;
    expect(calls).toHaveLength(2);
    expect(agent.isRegistered).toBe(true);
  });

  it('a missing path parameter is a WAVE_ERR_VALIDATION with no request and no retry', async () => {
    const { fn } = stubFetch();
    const errors: Error[] = [];
    const monitor = new StreamMonitorAgent({
      ...base,
      streamIds: [process.env.WAVE_ADK_TEST_UNSET_STREAM_ID as string],
      onError: (e) => errors.push(e),
    });
    const t0 = Date.now();
    await monitor.start();
    await monitor.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(fn).not.toHaveBeenCalled();
    expect(errors[0]).toBeInstanceOf(WaveToolError);
    expect((errors[0] as WaveToolError).code).toBe('WAVE_ERR_VALIDATION');
  });

  it('keeps the 1.0.15 raw-path apiCall form working for subclasses', async () => {
    const { calls } = stubFetch(() => ({ body: { ok: true } }));
    await expect(new RawAgent({ ...base, agentType: 'custom' }).raw()).resolves.toEqual({ ok: true });
    expect(calls[0].url.pathname).toBe('/v1/billing/usage');
  });
});

describe('StreamMonitorAgent', () => {
  it('refuses an empty streamIds list', () => {
    expect(() => new StreamMonitorAgent({ ...base, streamIds: [] })).toThrow(/nothing to monitor/);
  });

  it('alerts and restarts when a live stream drops', async () => {
    const statuses = ['live', 'ended'];
    const { calls } = stubFetch((c) => (c.url.pathname.endsWith('/status') ? { body: { status: statuses.shift() } } : { body: {} }));
    const onQualityDrop = vi.fn(async () => {});
    const monitor = new StreamMonitorAgent({ ...base, streamIds: ['s1'], autoRemediate: true, onQualityDrop, pollingIntervalMs: 60_000 });
    await monitor.start();
    await monitor['checkStreamHealth']('s1');
    await monitor.stop();
    expect(onQualityDrop).toHaveBeenCalledWith(expect.objectContaining({ streamId: 's1', metric: 'stream_offline', status: 'ended' }));
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toContain('POST /v1/streams/s1/start');
  });

  it('reports gateway errors through onError with the request id', async () => {
    stubFetch(() => ({ status: 404, body: { error: { code: 'ROUTE_NOT_FOUND', request_id: 'rid-2' } } }));
    const onError = vi.fn();
    const monitor = new StreamMonitorAgent({ ...base, streamIds: ['s1'], onError, pollingIntervalMs: 60_000 });
    await monitor.start();
    await monitor.stop();
    expect(onError.mock.calls[0][0]).toMatchObject({ gatewayCode: 'ROUTE_NOT_FOUND', requestId: 'rid-2' });
  });

  it('does not start polling when stop() ran during the first poll', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch(() => ({ body: { status: 'live' } }));
    const monitor = new StreamMonitorAgent({ ...base, streamIds: ['s1'], pollingIntervalMs: 1_000 });
    monitor.on('stream.status', async () => {
      await monitor.stop();
    });
    await monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    expect(monitor.isRunning).toBe(false);
  });

  it('still restarts the stream when onQualityDrop rejects', async () => {
    const statuses = ['live', 'idle'];
    const { calls } = stubFetch((c) => (c.url.pathname.endsWith('/status') ? { body: { status: statuses.shift() } } : { body: {} }));
    const onError = vi.fn();
    const monitor = new StreamMonitorAgent({
      ...base,
      streamIds: ['s1'],
      autoRemediate: true,
      onError,
      pollingIntervalMs: 60_000,
      onQualityDrop: async () => {
        throw new Error('pager down');
      },
    });
    await monitor.start();
    await monitor['checkStreamHealth']('s1');
    await monitor.stop();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toContain('POST /v1/streams/s1/start');
    expect(onError.mock.calls[0][0]).toMatchObject({ message: 'pager down' });
  });
});

describe('ClipFactoryAgent', () => {
  const highlight = { streamId: 's1', startTime: 1, endTime: 9, confidence: 0.95, reason: 'goal', detectedBy: 'ai_detection' as const };

  it('refuses a highlight without recordingId instead of sending a stream id as a recording id', async () => {
    const { fn } = stubFetch();
    const clips = new ClipFactoryAgent({ ...base, streamIds: ['s1'] });
    await expect(clips.exportClip(highlight)).rejects.toMatchObject({ code: 'WAVE_ERR_VALIDATION' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('still cuts the clip when onHighlight rejects', async () => {
    const { calls } = stubFetch(() => ({ status: 201, body: { clipId: 'clip_1' } }));
    const onError = vi.fn();
    const clips = new ClipFactoryAgent({
      ...base,
      streamIds: ['s1'],
      onError,
      onHighlight: async () => {
        throw new Error('webhook down');
      },
    });
    await clips.start();
    await clips['emit']('stream.s1.highlight', { ...highlight, recordingId: 'rec_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ source: 'rec_1', sourceType: 'recording_id', in: '1s', out: '9s' });
    expect(onError.mock.calls[0][0]).toMatchObject({ message: 'webhook down' });
  });
});

describe('ModerationAgent / CaptionAgent', () => {
  it('moderateMessage reports flag verdicts; blockUser refuses to invent a route', async () => {
    stubFetch(() => ({ body: { action: 'block', violations: [{ category: 'spam', confidence: 0.97 }] } }));
    const onFlag = vi.fn(async () => {});
    const mod = new ModerationAgent({ ...base, streamIds: ['s1'], onFlag });
    await mod.moderateMessage({ messageId: 'm1', streamId: 's1', content: 'buy now' });
    expect(onFlag).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', reason: 'spam', action: 'block' }));
    await expect(mod.blockUser('s1', 'u1', 'spam')).rejects.toMatchObject({ code: 'WAVE_ERR_NOT_IN_CONTRACT' });
  });

  it('CaptionAgent downloads captions for the job it created', async () => {
    const { calls } = stubFetch((c) => (c.method === 'POST' ? { status: 201, body: { id: 'job_9' } } : { body: { content: 'WEBVTT' } }));
    const agent = new CaptionAgent({ ...base, streamIds: ['vid_1'], languages: ['en', 'es'] });
    await agent.start();
    expect(calls[0].body).toEqual({ videoId: 'vid_1', sourceLanguage: 'en', targetLanguages: ['es'] });
    await expect(agent.getTranscript('vid_1')).resolves.toEqual({ content: 'WEBVTT' });
    expect(calls[1].url.pathname).toBe('/v1/captions/job_9/download');
    expect(calls[1].url.searchParams.get('language')).toBe('en');
    await expect(agent.getTranscript('other')).rejects.toMatchObject({ code: 'WAVE_ERR_VALIDATION' });
  });

  it('CaptionAgent.translateTo keeps the source job; each language reads its own job', async () => {
    let next = 0;
    const { calls } = stubFetch((c) => (c.method === 'POST' ? { status: 201, body: { id: `job_${++next}` } } : { body: { content: 'x' } }));
    const agent = new CaptionAgent({ ...base, streamIds: ['vid_1'], languages: ['en'] });
    await agent.start();
    await agent.translateTo('vid_1', 'fr');
    expect(agent.jobIdFor('vid_1')).toBe('job_1');
    expect(agent.jobIdFor('vid_1', 'fr')).toBe('job_2');
    await agent.getTranscript('vid_1');
    await agent.getTranscript('vid_1', { language: 'fr' });
    expect(calls[2].url.pathname).toBe('/v1/captions/job_1/download');
    expect(calls[2].url.searchParams.get('language')).toBe('en');
    expect(calls[3].url.pathname).toBe('/v1/captions/job_2/download');
    expect(calls[3].url.searchParams.get('language')).toBe('fr');
  });
});

describe('AgentLogger forwarding', () => {
  const make = (forwardUrl: string) =>
    new AgentLogger({ agentName: 'a', level: 'info', forwardUrl, apiKey: 'wave_live_secret', waveBaseUrl: 'https://api.wave.online' });

  it('never sends the WAVE key to a third-party collector', async () => {
    const { calls } = stubFetch();
    const logger = make('https://logs.example.com/ingest');
    logger.info('x');
    await logger.flush();
    logger.destroy();
    expect(calls[0].url.href).toBe('https://logs.example.com/ingest');
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('re-buffers logs when the collector answers non-2xx', async () => {
    const { calls } = stubFetch(() => ({ status: 500, body: {} }));
    const logger = make('https://logs.example.com/ingest');
    logger.info('keep me');
    await logger.flush();
    await logger.flush();
    logger.destroy();
    expect(calls).toHaveLength(2);
    expect((calls[1].body as { logs: unknown[] }).logs).toHaveLength(1);
  });
});
