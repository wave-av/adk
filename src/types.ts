/**
 * WAVE ADK Type Definitions
 */

export type AgentType =
  | 'stream_monitor'
  | 'auto_producer'
  | 'clip_factory'
  | 'moderator'
  | 'captioner'
  | 'custom';

export type AgentTier = 'free' | 'pro' | 'enterprise';

export interface AgentInvocation {
  readonly id: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly eventType: string;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly durationMs: number;
  readonly costCents: number;
  readonly status: 'success' | 'error' | 'timeout';
  readonly createdAt: Date;
}

export interface AgentWebhookEvent {
  readonly id: string;
  readonly pattern: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: Date;
  readonly signature: string;
}

export interface StreamQualityAlert {
  readonly streamId: string;
  readonly metric: 'rebuffering' | 'startup_time' | 'error_rate' | 'bitrate_drop' | 'stream_offline';
  readonly severity: 'warning' | 'critical';
  readonly currentValue: number;
  readonly threshold: number;
  /** Stream status from `GET /v1/streams/{streamId}/status` when the alert fired. */
  readonly status?: string;
  readonly timestamp: Date;
}

export interface ClipHighlight {
  readonly streamId: string;
  /** Recording to cut the clip from (`POST /v1/clips` needs a recording id). Falls back to streamId. */
  readonly recordingId?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly confidence: number;
  readonly reason: string;
  readonly detectedBy: 'audio_spike' | 'chat_spike' | 'scene_change' | 'ai_detection';
}

export interface ModerationFlag {
  readonly messageId: string;
  readonly streamId: string;
  readonly content: string;
  /** Violation category from `POST /v1/moderate` (e.g. harassment, spam, violence). */
  readonly reason: 'profanity' | 'spam' | 'harassment' | 'self_harm' | 'violence' | (string & {});
  readonly confidence: number;
  readonly action: 'block' | 'flag' | 'allow';
}
