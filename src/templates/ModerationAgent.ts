/**
 * ModerationAgent — AI content moderation for live streams
 *
 * Sends each chat message to `POST /v1/moderate` (contract: moderateContent)
 * and reports flag/block verdicts through `onFlag`. The contract moderates
 * content per call; it has no stream-level configure, block-user or approve
 * operation, so those methods throw WAVE_ERR_NOT_IN_CONTRACT instead of
 * calling invented routes.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import { notInContract } from '../errors';
import type { ModerationFlag } from '../types';

interface ModerationConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly rules?: {
    /** @deprecated The moderation contract has no profanity category; the server applies its own policy. */
    readonly blockProfanity?: boolean;
    /** @deprecated The server checks spam by default. */
    readonly blockSpam?: boolean;
    /** @deprecated The server checks harassment by default. */
    readonly blockHarassment?: boolean;
    /** Words or phrases to block; sent as `options.customRules`. */
    readonly customBlocklist?: string[];
  };
  readonly onFlag?: (flag: ModerationFlag) => Promise<void>;
}

/** `POST /v1/moderate` response (contract: ModerateResponse). */
export interface ModerationVerdict {
  readonly allowed?: boolean;
  readonly action?: 'allow' | 'flag' | 'block' | 'review';
  readonly confidence?: number;
  readonly violations?: { category?: string; confidence?: number }[];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ModerationAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly rules: NonNullable<ModerationConfig['rules']>;
  private readonly onFlag?: (flag: ModerationFlag) => Promise<void>;

  constructor(config: ModerationConfig) {
    super({ ...config, agentType: 'moderator' });
    this.streamIds = config.streamIds;
    this.onFlag = config.onFlag;
    this.rules = config.rules ?? {
      blockProfanity: true,
      blockSpam: true,
      blockHarassment: true,
    };
  }

  get monitoredStreams(): readonly string[] {
    return this.streamIds;
  }

  /** Moderate one chat message; calls `onFlag` when the verdict is flag or block. */
  async moderateMessage(
    message: { messageId: string; streamId: string; content: string; userId?: string },
  ): Promise<ModerationVerdict> {
    const customRules = (this.rules.customBlocklist ?? []).map((word, i) => ({
      name: `blocklist-${i}`,
      pattern: `\\b${escapeRegex(word)}\\b`,
      action: 'block' as const,
    }));

    const verdict = await this.apiCall<ModerationVerdict>('moderateContent', {
      body: {
        content: message.content,
        contentType: 'chat',
        context: { streamId: message.streamId, ...(message.userId ? { userId: message.userId } : {}) },
        ...(customRules.length > 0 ? { options: { customRules } } : {}),
      },
    });

    if (verdict?.action === 'flag' || verdict?.action === 'block') {
      const top = verdict.violations?.[0];
      await this.onFlag?.({
        messageId: message.messageId,
        streamId: message.streamId,
        content: message.content,
        reason: top?.category ?? 'policy',
        confidence: top?.confidence ?? verdict.confidence ?? 0,
        action: verdict.action,
      });
    }
    return verdict;
  }

  async blockUser(_streamId: string, _userId: string, _reason: string): Promise<void> {
    throw notInContract('ModerationAgent.blockUser', 'Enforce the block in your chat system using the verdict from moderateMessage().');
  }

  async approveMessage(_messageId: string): Promise<void> {
    throw notInContract('ModerationAgent.approveMessage', 'Publish the message in your chat system when moderateMessage() returns allow.');
  }
}
