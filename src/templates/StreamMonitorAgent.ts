/**
 * StreamMonitorAgent — Watches stream quality, auto-remediates
 *
 * Monitors QoE metrics (rebuffering, startup time, error rate),
 * triggers alerts, and can auto-switch to backup streams.
 */

import { WaveAgent, type WaveAgentConfig } from '../agents/WaveAgent';
import type { StreamQualityAlert } from '../types';

interface StreamMonitorConfig extends Omit<WaveAgentConfig, 'agentType'> {
  readonly streamIds: string[];
  readonly pollingIntervalMs?: number;
  readonly thresholds?: {
    readonly rebufferingWarning?: number;
    readonly rebufferingCritical?: number;
    readonly startupTimeWarning?: number;
    readonly startupTimeCritical?: number;
  };
  readonly onQualityDrop?: (alert: StreamQualityAlert) => Promise<void>;
  readonly autoRemediate?: boolean;
}

export class StreamMonitorAgent extends WaveAgent {
  private readonly streamIds: string[];
  private readonly pollingIntervalMs: number;
  private readonly onQualityDrop?: (alert: StreamQualityAlert) => Promise<void>;
  private readonly autoRemediate: boolean;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: StreamMonitorConfig) {
    super({ ...config, agentType: 'stream_monitor' });
    this.streamIds = config.streamIds;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 30_000;
    this.onQualityDrop = config.onQualityDrop;
    this.autoRemediate = config.autoRemediate ?? false;
  }

  override async start(): Promise<void> {
    await super.start();

    this.pollingTimer = setInterval(async () => {
      for (const streamId of this.streamIds) {
        await this.checkStreamHealth(streamId);
      }
    }, this.pollingIntervalMs);
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
      const health = await this.apiCall<{
        status: string;
        metrics: { rebufferingRatio: number; startupTime: number; errorRate: number };
      }>('GET', `/v1/streams/${streamId}/health`);

      if (health.status === 'degraded' || health.status === 'critical') {
        const alert: StreamQualityAlert = {
          streamId,
          metric: 'rebuffering',
          severity: health.status === 'critical' ? 'critical' : 'warning',
          currentValue: health.metrics.rebufferingRatio,
          threshold: 0.02,
          timestamp: new Date(),
        };

        await this.emit('quality.drop', alert as unknown as Record<string, unknown>);
        await this.onQualityDrop?.(alert);

        if (this.autoRemediate && health.status === 'critical') {
          await this.apiCall('POST', `/v1/streams/${streamId}/remediate`, {
            action: 'reduce_bitrate',
            reason: 'Auto-remediation by StreamMonitorAgent',
          });
        }
      }
    } catch (error) {
      this.config.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
