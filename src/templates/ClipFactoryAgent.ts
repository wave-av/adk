/**
 * ClipFactoryAgent — Monitors streams, auto-creates highlight clips
 *
 * Listens for highlight events and cuts a clip for each one above the
 * confidence bar with `POST /v1/clips` (contract: createClip).
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import type { ClipHighlight } from '../types';

interface ClipFactoryConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  /** @deprecated Social export is not part of the WAVE clips contract; not sent. */
  readonly platforms?: ('tiktok' | 'youtube_shorts' | 'instagram_reels' | 'twitter')[];
  /** @deprecated Stingers are not part of the WAVE clips contract; not sent. */
  readonly stingerId?: string;
  readonly minConfidence?: number;
  readonly onHighlight?: (highlight: ClipHighlight) => Promise<void>;
}

/** `POST /v1/clips` 201 response (contract: ClipCreateResponse). */
interface ClipCreateResponse {
  readonly clipId: string;
}

export class ClipFactoryAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly minConfidence: number;
  private readonly onHighlight?: (highlight: ClipHighlight) => Promise<void>;

  constructor(config: ClipFactoryConfig) {
    super({ ...config, agentType: 'clip_factory' });
    this.streamIds = config.streamIds;
    this.minConfidence = config.minConfidence ?? 0.8;
    this.onHighlight = config.onHighlight;
  }

  override async start(): Promise<void> {
    await super.start();
    // Subscribe to highlight detection events for each stream
    for (const streamId of this.streamIds) {
      this.on(`stream.${streamId}.highlight`, async (event) => {
        const highlight = event as unknown as ClipHighlight;
        await this.onHighlight?.(highlight);
        if (highlight.confidence >= this.minConfidence) {
          await this.exportClip(highlight);
        }
      });
    }
  }

  async exportClip(highlight: ClipHighlight): Promise<string> {
    const clip = await this.apiCall<ClipCreateResponse>('createClip', {
      body: {
        source: highlight.recordingId ?? highlight.streamId,
        sourceType: 'recording_id',
        in: `${highlight.startTime}s`,
        out: `${highlight.endTime}s`,
      },
    });
    return clip.clipId;
  }
}
