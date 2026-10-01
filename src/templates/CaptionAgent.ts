/**
 * CaptionAgent — Transcription and captioning agent
 *
 * Starts a caption job per video or recorded stream with `POST /v1/captions`
 * (contract: createCaptionJob), adds translations as further jobs, and fetches
 * captions with `GET /v1/captions/{jobId}/download` (contract: downloadCaptions).
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import { WaveToolError } from '../errors';

interface CaptionConfig extends Omit<WaveAgentConfig, 'agentType'> {
  /** Video (or recorded stream) ids to caption. */
  readonly streamIds: string[];
  /** First entry is the spoken language; the rest are translation targets. Default ['en']. */
  readonly languages?: string[];
  /** @deprecated The captions contract picks the provider; not sent. */
  readonly provider?: 'deepgram' | 'assemblyai' | 'cohere';
  readonly onTranscript?: (transcript: { text: string; language: string; timestamp: number }) => Promise<void>;
}

/** `POST /v1/captions` 201 response (contract: CaptionJob). */
export interface CaptionJob {
  readonly id: string;
  readonly videoId?: string;
  readonly status?: string;
}

/** `GET /v1/captions/{jobId}/download` response. */
export interface CaptionDownload {
  readonly url?: string;
  readonly content?: string;
}

export class CaptionAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly languages: string[];
  /** Source-language caption job per stream, created by start(). */
  private readonly jobs = new Map<string, string>();
  /** Translation jobs per stream, keyed by target language, created by translateTo(). */
  private readonly translationJobs = new Map<string, Map<string, string>>();

  constructor(config: CaptionConfig) {
    super({ ...config, agentType: 'captioner' });
    this.streamIds = config.streamIds;
    this.languages = config.languages && config.languages.length > 0 ? config.languages : ['en'];
  }

  override async start(): Promise<void> {
    await super.start();
    const [sourceLanguage, ...targetLanguages] = this.languages;
    for (const streamId of this.streamIds) {
      const job = await this.apiCall<CaptionJob>('createCaptionJob', {
        body: { videoId: streamId, sourceLanguage, ...(targetLanguages.length > 0 ? { targetLanguages } : {}) },
      });
      this.jobs.set(streamId, job.id);
    }
  }

  /**
   * Caption job id for a stream: the translation job for `language` when
   * translateTo() created one, otherwise the source job from start().
   */
  jobIdFor(streamId: string, language?: string): string | undefined {
    const translated = language ? this.translationJobs.get(streamId)?.get(language) : undefined;
    return translated ?? this.jobs.get(streamId);
  }

  /**
   * Start a caption job that translates the stream into `targetLanguage`.
   * Returns the job id. The source job from start() is kept, so
   * getTranscript(streamId) still returns the spoken-language captions.
   */
  async translateTo(streamId: string, targetLanguage: string): Promise<string> {
    const job = await this.apiCall<CaptionJob>('createCaptionJob', {
      body: { videoId: streamId, sourceLanguage: this.languages[0], targetLanguages: [targetLanguage] },
    });
    const byLanguage = this.translationJobs.get(streamId) ?? new Map<string, string>();
    byLanguage.set(targetLanguage, job.id);
    this.translationJobs.set(streamId, byLanguage);
    return job.id;
  }

  /**
   * Download captions for a stream (`format` defaults to vtt, `language` to
   * the spoken language). A language with its own translateTo() job is read
   * from that job; any other language is read from the source job.
   */
  async getTranscript(
    streamId: string,
    options: { language?: string; format?: 'srt' | 'vtt' | 'txt' | 'json' } = {},
  ): Promise<CaptionDownload> {
    const jobId = this.jobIdFor(streamId, options.language);
    if (!jobId) {
      throw new WaveToolError(
        `CaptionAgent.getTranscript: no caption job for stream ${streamId}.`,
        'WAVE_ERR_VALIDATION',
        { streamId },
        'Call start() (or translateTo()) for this stream first.',
      );
    }
    return this.apiCall<CaptionDownload>('downloadCaptions', {
      params: { jobId },
      query: { language: options.language ?? this.languages[0], format: options.format ?? 'vtt' },
    });
  }
}
