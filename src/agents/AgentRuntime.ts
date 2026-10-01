/**
 * AgentRuntime — Production runtime for WAVE agents
 *
 * Provides: HTTP health endpoint, heartbeat monitoring,
 * graceful shutdown, structured log forwarding.
 *
 * @example
 * ```typescript
 * const runtime = new AgentRuntime(agent, {
 *   healthPort: 8080,
 *   heartbeatIntervalMs: 30_000,
 * });
 * await runtime.start();
 * ```
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { WaveAgent } from './WaveAgent';
import { AgentLogger, type LogLevel } from './AgentLogger';

export interface AgentRuntimeConfig {
  readonly healthPort?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly logLevel?: LogLevel;
  /** Full URL of your log collector endpoint; batches are POSTed as `{ logs: [...] }`. */
  readonly logForwardUrl?: string;
  readonly onShutdown?: () => Promise<void>;
}

export interface AgentHealthStatus {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly agentName: string;
  readonly uptime: number;
  readonly totalCalls: number;
  readonly lastHeartbeat: string | null;
  readonly version: string;
}

export class AgentRuntime {
  private readonly agent: WaveAgent;
  private readonly config: Required<AgentRuntimeConfig>;
  private readonly logger: AgentLogger;
  private server: Server | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: Date | null = null;
  private lastHeartbeatAt: Date | null = null;
  private shutdownInProgress = false;
  /** Detaches the SIGTERM/SIGINT handlers start() installed, so a stopped runtime leaves none behind. */
  private removeSignalHandlers: () => void = () => {};

  constructor(agent: WaveAgent, config: AgentRuntimeConfig = {}) {
    this.agent = agent;
    this.config = {
      healthPort: config.healthPort ?? 8080,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 10_000,
      logLevel: config.logLevel ?? 'info',
      logForwardUrl: config.logForwardUrl ?? '',
      onShutdown: config.onShutdown ?? (async () => {}),
    };

    this.logger = new AgentLogger({
      agentName: agent['config'].agentName,
      level: this.config.logLevel,
      forwardUrl: this.config.logForwardUrl,
      apiKey: agent['config'].apiKey,
      waveBaseUrl: agent['config'].baseUrl,
    });
  }

  async start(): Promise<void> {
    this.startedAt = new Date();

    // Start the agent
    this.logger.info('Agent starting', { agentType: this.agent['config'].agentType });
    await this.agent.start();

    // Start health HTTP server
    await this.startHealthServer();

    // Start heartbeat
    this.startHeartbeat();

    // Register signal handlers for graceful shutdown
    this.registerSignalHandlers();

    this.logger.info('Agent runtime started', {
      healthPort: this.config.healthPort,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
    });
  }

  async stop(): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    this.logger.info('Agent runtime shutting down');

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.removeSignalHandlers();

    // Run custom shutdown handler with timeout. The timer is cleared either way,
    // so a fast handler does not hold the process open for shutdownTimeoutMs.
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.config.onShutdown(),
        new Promise<never>((_, reject) => {
          shutdownTimer = setTimeout(() => reject(new Error('Shutdown handler timeout')), this.config.shutdownTimeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      this.logger.error('Shutdown handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(shutdownTimer);
    }

    // Stop agent
    await this.agent.stop();

    // Close health server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    this.logger.info('Agent runtime stopped');

    // Flush logs (one retry), then stop the logger's auto-flush timer. If the
    // collector still refuses, say so on stderr: the records were written to
    // stdout/stderr already, but they never reached the collector.
    const delivered = (await this.logger.flush()) || (await this.logger.flush());
    if (!delivered) {
      process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        agent: this.agent['config'].agentName,
        message: 'Log forwarding failed at shutdown; records were written to stdout/stderr but not delivered to logForwardUrl',
        data: { undelivered: this.logger.pendingCount, dropped: this.logger.droppedCount },
      }) + '\n');
    }
    this.logger.destroy();
  }

  getHealth(): AgentHealthStatus {
    const uptimeMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
    const stats = this.agent.getUsageStats();

    return {
      status: this.agent.isRunning ? 'healthy' : 'unhealthy',
      agentName: this.agent['config'].agentName,
      uptime: uptimeMs,
      totalCalls: stats.totalCalls,
      lastHeartbeat: this.lastHeartbeatAt?.toISOString() ?? null,
      version: '2.0.0',
    };
  }

  getLogger(): AgentLogger {
    return this.logger;
  }

  private async startHealthServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleHealthRequest(req, res);
      });

      this.server.on('error', (error) => {
        this.logger.error('Health server error', { error: error.message });
        reject(error);
      });

      this.server.listen(this.config.healthPort, () => {
        resolve();
      });
    });
  }

  private handleHealthRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health' || req.url === '/healthz') {
      const health = this.getHealth();
      const statusCode = health.status === 'healthy' ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    if (req.url === '/ready' || req.url === '/readyz') {
      const isReady = this.agent.isRunning && !this.shutdownInProgress;
      res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: isReady }));
      return;
    }

    if (req.url === '/metrics') {
      const stats = this.agent.getUsageStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...stats,
        uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private startHeartbeat(): void {
    const sendHeartbeat = async () => {
      try {
        // A platform heartbeat only means something for an agent the platform
        // knows about. Unregistered agents (the default) keep a local
        // heartbeat for /health and make no network call.
        if (this.agent.isRegistered) {
          await this.agent['apiCall']('agents', {
            body: {
              action: 'heartbeat',
              name: this.agent['config'].agentName,
              status: this.agent.isRunning ? 'healthy' : 'unhealthy',
              uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
              stats: this.agent.getUsageStats(),
            },
          }, { maxRetries: 0 });
        }
        this.lastHeartbeatAt = new Date();
      } catch (error: unknown) {
        this.logger.warn('Heartbeat failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Send initial heartbeat
    void sendHeartbeat();

    // Schedule recurring heartbeats
    this.heartbeatTimer = setInterval(() => void sendHeartbeat(), this.config.heartbeatIntervalMs);
  }

  private registerSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      this.logger.info('Received signal', { signal });
      await this.stop();
      process.exit(0);
    };

    const onTerm = () => void shutdown('SIGTERM');
    const onInt = () => void shutdown('SIGINT');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);
    this.removeSignalHandlers = () => {
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
    };
  }
}
