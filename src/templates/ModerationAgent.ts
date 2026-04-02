/**
 * ModerationAgent — AI content moderation for live streams
 *
 * Monitors chat messages and video content for policy violations.
 * Can auto-block, flag for review, or escalate to humans.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import type { ModerationFlag } from '../types';

interface ModerationConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly rules?: {
    readonly blockProfanity?: boolean;
    readonly blockSpam?: boolean;
    readonly blockHarassment?: boolean;
    readonly customBlocklist?: string[];
  };
  readonly onFlag?: (flag: ModerationFlag) => Promise<void>;
}

export class ModerationAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly rules: NonNullable<ModerationConfig['rules']>;

  constructor(config: ModerationConfig) {
    super({ ...config, agentType: 'moderator' });
    this.streamIds = config.streamIds;
    this.rules = config.rules ?? {
      blockProfanity: true,
      blockSpam: true,
      blockHarassment: true,
    };
  }

  override async start(): Promise<void> {
    await super.start();
    await this.apiCall('POST', '/v1/moderation/configure', {
      streamIds: this.streamIds,
      rules: this.rules,
      agentControlled: true,
    });
  }

  async blockUser(streamId: string, userId: string, reason: string): Promise<void> {
    await this.apiCall('POST', `/v1/moderation/block`, {
      streamId,
      userId,
      reason,
      duration: 3600,
    });
  }

  async approveMessage(messageId: string): Promise<void> {
    await this.apiCall('POST', `/v1/moderation/approve`, { messageId });
  }
}
