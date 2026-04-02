/**
 * ClipFactoryAgent — Monitors streams, auto-creates highlight clips
 *
 * Detects highlights via audio spikes, chat engagement, and AI,
 * then auto-exports clips with branded stingers to social platforms.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import type { ClipHighlight } from '../types';

interface ClipFactoryConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly platforms?: ('tiktok' | 'youtube_shorts' | 'instagram_reels' | 'twitter')[];
  readonly stingerId?: string;
  readonly minConfidence?: number;
  readonly onHighlight?: (highlight: ClipHighlight) => Promise<void>;
}

export class ClipFactoryAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly platforms: string[];
  private readonly stingerId?: string;
  private readonly minConfidence: number;

  constructor(config: ClipFactoryConfig) {
    super({ ...config, agentType: 'clip_factory' });
    this.streamIds = config.streamIds;
    this.platforms = config.platforms ?? ['youtube_shorts', 'tiktok'];
    this.stingerId = config.stingerId;
    this.minConfidence = config.minConfidence ?? 0.8;
  }

  override async start(): Promise<void> {
    await super.start();
    // Subscribe to highlight detection events for each stream
    for (const streamId of this.streamIds) {
      this.on(`stream.${streamId}.highlight`, async (event) => {
        const highlight = event as unknown as ClipHighlight;
        if (highlight.confidence >= this.minConfidence) {
          await this.exportClip(highlight);
        }
      });
    }
  }

  async exportClip(highlight: ClipHighlight): Promise<string> {
    const clip = await this.apiCall<{ clipId: string }>('POST', '/v1/clips/export', {
      streamId: highlight.streamId,
      startTime: highlight.startTime,
      endTime: highlight.endTime,
      stingerId: this.stingerId,
      platforms: this.platforms,
    });
    return clip.clipId;
  }
}
