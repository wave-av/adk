/**
 * WaveAgent — Base class for all WAVE AI agents
 *
 * Provides: API client, event subscriptions, tool execution,
 * usage tracking, webhook delivery, rate limiting.
 */

import type { AgentType, AgentTier, AgentInvocation } from '../types';
import { WaveToolError, assertApiKey } from '../errors';
import { DEFAULT_BASE_URL, waveFetch, waveRequest, type WaveRequest } from '../http';
import { WAVE_ROUTES, type WaveRouteName } from '../routes';

export interface WaveAgentConfig {
  readonly apiKey: string;
  readonly agentName: string;
  readonly agentType: AgentType;
  readonly baseUrl?: string;
  readonly tier?: AgentTier;
  readonly webhookUrl?: string;
  /**
   * Register the agent with the WAVE agents capability (`POST /v1/agents`) on
   * `start()`, and send platform heartbeats from AgentRuntime. Needs a key
   * with the `agents:write` scope. Default `false`: `start()` makes no
   * registration call, so a key without that scope can run an agent.
   */
  readonly register?: boolean;
  readonly onError?: (error: Error) => void;
}

export type AgentEventHandler = (event: Record<string, unknown>) => Promise<void>;

export class WaveAgent {
  protected readonly config: Required<WaveAgentConfig>;
  private readonly eventHandlers = new Map<string, AgentEventHandler[]>();
  private readonly invocations: AgentInvocation[] = [];
  private _isRunning = false;
  private _isRegistered = false;

  constructor(config: WaveAgentConfig) {
    this.config = {
      apiKey: assertApiKey(config?.apiKey, 'WaveAgent'),
      agentName: config.agentName,
      agentType: config.agentType,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      tier: config.tier ?? 'free',
      webhookUrl: config.webhookUrl ?? '',
      register: config.register ?? false,
      onError: config.onError ?? console.error,
    };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /** True once `start()` registered the agent with `POST /v1/agents`. */
  get isRegistered(): boolean {
    return this._isRegistered;
  }

  async start(): Promise<void> {
    if (this.config.register) {
      await this.apiCall('agents', {
        body: {
          action: 'register',
          name: this.config.agentName,
          type: this.config.agentType,
          tier: this.config.tier,
          ...(this.config.webhookUrl ? { webhookUrl: this.config.webhookUrl } : {}),
        },
      });
      this._isRegistered = true;
    }

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

  /**
   * Call one route of the WAVE API contract (src/routes.ts). Retries 429 (after
   * Retry-After), 5xx and network errors with backoff; throws a WaveToolError
   * carrying the gateway error code and request id for everything else.
   */
  protected apiCall<T>(route: WaveRouteName, req?: WaveRequest, options?: { maxRetries?: number }): Promise<T>;
  /**
   * @deprecated Raw-path form kept for subclasses written against 1.0.15 and
   * earlier. Prefer a named route so the call is checked against the contract.
   */
  protected apiCall<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { maxRetries?: number },
  ): Promise<T>;
  protected async apiCall<T>(
    routeOrMethod: string,
    reqOrPath?: WaveRequest | string,
    bodyOrOptions?: Record<string, unknown> | { maxRetries?: number },
    legacyOptions?: { maxRetries?: number },
  ): Promise<T> {
    const agentHeaders = {
      'X-Wave-Agent': this.config.agentName,
      'X-Wave-Agent-Type': this.config.agentType,
    };
    let send: () => Promise<T>;
    let toolName: string;
    let body: Record<string, unknown> | undefined;
    let maxRetries: number;

    if (typeof reqOrPath === 'string') {
      const method = routeOrMethod;
      body = bodyOrOptions as Record<string, unknown> | undefined;
      maxRetries = legacyOptions?.maxRetries ?? 3;
      toolName = `${method} ${reqOrPath}`;
      send = () => waveFetch<T>(this.config.baseUrl, this.config.apiKey, method, reqOrPath, { body, headers: agentHeaders });
    } else {
      const route = routeOrMethod as WaveRouteName;
      const req = reqOrPath ?? {};
      body = req.body;
      maxRetries = (bodyOrOptions as { maxRetries?: number } | undefined)?.maxRetries ?? 3;
      toolName = `${WAVE_ROUTES[route].method} ${WAVE_ROUTES[route].path}`;
      send = () => waveRequest<T>(this.config.baseUrl, this.config.apiKey, route, {
        ...req,
        headers: { ...agentHeaders, ...req.headers },
      });
    }

    let lastError: Error = new Error('Max retries exceeded');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        const result = await send();
        this.trackInvocation(toolName, body, Date.now() - startTime, 'success');
        return result;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.trackInvocation(toolName, body, Date.now() - startTime, 'error');
        if (attempt >= maxRetries) break;

        if (lastError instanceof WaveToolError) {
          const status = lastError.status ?? 0;
          if (status === 429) {
            const retryAfter = Number(lastError.context.retryAfter ?? 1);
            await this.sleep(Math.min(Math.max(retryAfter, 1), 60) * 1000);
            continue;
          }
          if (status >= 500) {
            await this.sleep(Math.min(1000 * 2 ** attempt, 10_000));
            continue;
          }
          break; // 4xx, validation, missing key: retrying cannot help
        }

        // Network error — retry with backoff
        await this.sleep(Math.min(1000 * 2 ** attempt, 10_000));
      }
    }

    throw lastError;
  }

  private trackInvocation(
    toolName: string,
    body: Record<string, unknown> | undefined,
    durationMs: number,
    status: 'success' | 'error',
  ): void {
    this.invocations.push({
      id: crypto.randomUUID(),
      agentId: this.config.agentName,
      toolName,
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
