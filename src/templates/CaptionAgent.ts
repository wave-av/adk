/**
 * CaptionAgent — Real-time transcription and captioning agent
 *
 * Provides live captions, multi-language translation,
 * and searchable transcripts for streams and VOD.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';

interface CaptionConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly languages?: string[];
  readonly provider?: 'deepgram' | 'assemblyai' | 'cohere';
  readonly onTranscript?: (transcript: { text: string; language: string; timestamp: number }) => Promise<void>;
}

export class CaptionAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly languages: string[];
  private readonly provider: string;

  constructor(config: CaptionConfig) {
    super({ ...config, agentType: 'captioner' });
    this.streamIds = config.streamIds;
    this.languages = config.languages ?? ['en'];
    this.provider = config.provider ?? 'deepgram';
  }

  override async start(): Promise<void> {
    await super.start();
    for (const streamId of this.streamIds) {
      await this.apiCall('POST', '/v1/captions/start', {
        streamId,
        languages: this.languages,
        provider: this.provider,
        agentControlled: true,
      });
    }
  }

  async translateTo(streamId: string, targetLanguage: string): Promise<void> {
    await this.apiCall('POST', `/v1/captions/${streamId}/translate`, {
      targetLanguage,
    });
  }

  async getTranscript(streamId: string): Promise<{ segments: { text: string; start: number; end: number }[] }> {
    return this.apiCall('GET', `/v1/captions/${streamId}/transcript`);
  }
}
