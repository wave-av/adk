/**
 * WaveAgent — Base class for all WAVE AI agents
 *
 * Provides: API client, event subscriptions, tool execution,
 * usage tracking, webhook delivery, rate limiting.
 */

import type { AgentType, AgentTier, AgentInvocation } from '../types';

export interface WaveAgentConfig {
  readonly apiKey: string;
  readonly agentName: string;
  readonly agentType: AgentType;
  readonly baseUrl?: string;
  readonly tier?: AgentTier;
  readonly webhookUrl?: string;
  readonly onError?: (error: Error) => void;
}

export type AgentEventHandler = (event: Record<string, unknown>) => Promise<void>;

export class WaveAgent {
  protected readonly config: Required<WaveAgentConfig>;
  private readonly eventHandlers = new Map<string, AgentEventHandler[]>();
  private readonly invocations: AgentInvocation[] = [];
  private _isRunning = false;

  constructor(config: WaveAgentConfig) {
    this.config = {
      apiKey: config.apiKey,
      agentName: config.agentName,
      agentType: config.agentType,
      baseUrl: config.baseUrl ?? 'https://api.wave.online',
      tier: config.tier ?? 'free',
      webhookUrl: config.webhookUrl ?? '',
      onError: config.onError ?? console.error,
    };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async start(): Promise<void> {
    // Register agent with WAVE platform
    await this.apiCall('POST', '/v1/agents/register', {
      name: this.config.agentName,
      type: this.config.agentType,
      tier: this.config.tier,
      webhookUrl: this.config.webhookUrl,
    });

    this._isRunning = true;
  }

  async stop(): Promise<void> {
    this._isRunning = false;
  }

  on(event: string, handler: AgentEventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  protected async emit(event: string, data: Record<string, unknown>): Promise<void> {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (error) {
        this.config.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  protected async apiCall<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { maxRetries?: number },
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();

      try {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          method,
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            'X-Wave-Agent': this.config.agentName,
            'X-Wave-Agent-Type': this.config.agentType,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const durationMs = Date.now() - startTime;

        // Rate limit — back off and retry
        if (response.status === 429 && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('Retry-After') ?? '1');
          await this.sleep(retryAfter * 1000);
          continue;
        }

        // Server error — retry with exponential backoff
        if (response.status >= 500 && attempt < maxRetries) {
          await this.sleep(Math.min(1000 * 2 ** attempt, 10_000));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const error = new Error(`WAVE API error: ${response.status} ${response.statusText} ${errorBody}`);
          this.trackInvocation(method, path, body, durationMs, 'error');
          throw error;
        }

        this.trackInvocation(method, path, body, durationMs, 'success');
        return response.json() as Promise<T>;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Network errors — retry with backoff
        if (attempt < maxRetries && !(lastError.message.includes('WAVE API error'))) {
          await this.sleep(Math.min(1000 * 2 ** attempt, 10_000));
          continue;
        }

        this.trackInvocation(method, path, body, Date.now() - startTime, 'error');
        throw lastError;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  private trackInvocation(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    durationMs: number,
    status: 'success' | 'error',
  ): void {
    this.invocations.push({
      id: crypto.randomUUID(),
      agentId: this.config.agentName,
      toolName: `${method} ${path}`,
      eventType: 'api_call',
      input: body ?? {},
      output: {},
      durationMs,
      costCents: 0,
      status,
      createdAt: new Date(),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getUsageStats(): { totalCalls: number; totalDurationMs: number } {
    return {
      totalCalls: this.invocations.length,
      totalDurationMs: this.invocations.reduce((sum, i) => sum + i.durationMs, 0),
    };
  }
}
