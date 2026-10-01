/**
 * StreamMonitorAgent — Watches stream status, alerts and optionally restarts
 *
 * Polls `GET /v1/streams/{streamId}/status` for each stream. Every poll emits
 * `stream.status`; a stream that was `live` and is now `idle` or `ended`
 * raises a `stream_offline` alert, and with `autoRemediate` the agent calls
 * `POST /v1/streams/{streamId}/start` to bring it back.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import { WaveToolError } from '../errors';
import type { StreamQualityAlert } from '../types';

interface StreamMonitorConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly pollingIntervalMs?: number;
  /** @deprecated The WAVE status contract carries no QoE metrics to compare these against; unused. */
  readonly thresholds?: {
    readonly rebufferingWarning?: number;
    readonly rebufferingCritical?: number;
    readonly startupTimeWarning?: number;
    readonly startupTimeCritical?: number;
  };
  readonly onQualityDrop?: (alert: StreamQualityAlert) => Promise<void>;
  /** Restart a stream (`POST /v1/streams/{streamId}/start`) when it drops from live. */
  readonly autoRemediate?: boolean;
}

/** `GET /v1/streams/{streamId}/status` response (contract: getStreamStatus). */
interface StreamStatus {
  readonly stream_id?: string;
  readonly status?: 'idle' | 'live' | 'ended' | string;
  readonly current_viewers?: number;
}

export class StreamMonitorAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly pollingIntervalMs: number;
  private readonly onQualityDrop?: (alert: StreamQualityAlert) => Promise<void>;
  private readonly autoRemediate: boolean;
  private readonly lastStatus = new Map<string, string>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StreamMonitorConfig) {
    super({ ...config, agentType: 'stream_monitor' });
    if (!Array.isArray(config.streamIds) || config.streamIds.length === 0) {
      throw new WaveToolError(
        'StreamMonitorAgent: streamIds is empty, so there is nothing to monitor.',
        'WAVE_ERR_VALIDATION',
        { field: 'streamIds' },
        'Pass at least one stream id, e.g. streamIds: [process.env.WAVE_STREAM_ID].',
      );
    }
    this.streamIds = config.streamIds;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 30_000;
    this.onQualityDrop = config.onQualityDrop;
    this.autoRemediate = config.autoRemediate ?? false;
  }

  override async start(): Promise<void> {
    await super.start();

    const poll = async () => {
      for (const streamId of this.streamIds) {
        await this.checkStreamHealth(streamId);
      }
    };
    await poll();
    // A stream.status handler may have called stop() during the first poll;
    // a stopped agent must not start polling (or remediating) again.
    if (!this.isRunning) return;
    this.pollingTimer = setInterval(() => void poll(), this.pollingIntervalMs);
  }

  override async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    await super.stop();
  }

  private async checkStreamHealth(streamId: string): Promise<void> {
    try {
      const current = await this.apiCall<StreamStatus>('getStreamStatus', { params: { streamId } });
      const status = current?.status ?? 'unknown';
      const previous = this.lastStatus.get(streamId);
      this.lastStatus.set(streamId, status);

      await this.emit('stream.status', { streamId, ...current });

      if (previous === 'live' && (status === 'idle' || status === 'ended')) {
        const alert: StreamQualityAlert = {
          streamId,
          metric: 'stream_offline',
          severity: 'critical',
          currentValue: 0,
          threshold: 1,
          status,
          timestamp: new Date(),
        };

        await this.emit('quality.drop', alert as unknown as Record<string, unknown>);
        try {
          await this.onQualityDrop?.(alert);
        } catch (callbackError) {
          // An application callback failure is reported, but it must not skip
          // the restart: the offline status is already recorded, so a later
          // poll would never retry it.
          this.config.onError(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
        }

        if (this.autoRemediate && this.isRunning) {
          await this.apiCall('startStream', { params: { streamId } });
          await this.emit('stream.restarted', { streamId, reason: 'Auto-remediation by StreamMonitorAgent' });
        }
      }
    } catch (error) {
      this.config.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
