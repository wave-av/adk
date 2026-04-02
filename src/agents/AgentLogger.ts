/**
 * AgentLogger — Structured log forwarding for WAVE agents
 *
 * Outputs JSON-structured logs to stdout and optionally forwards
 * to the WAVE observability platform (Dash0/Sentry).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentLoggerConfig {
  readonly agentName: string;
  readonly level: LogLevel;
  readonly forwardUrl: string;
  readonly apiKey: string;
}

interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly agent: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class AgentLogger {
  private readonly config: AgentLoggerConfig;
  private readonly buffer: LogEntry[] = [];
  private readonly maxBufferSize = 100;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentLoggerConfig) {
    this.config = config;

    // Auto-flush every 10 seconds if forwarding is enabled
    if (this.config.forwardUrl) {
      this.flushTimer = setInterval(() => void this.flush(), 10_000);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.config.forwardUrl) return;

    const entries = this.buffer.splice(0, this.buffer.length);

    try {
      await fetch(`${this.config.forwardUrl}/v1/agents/logs`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Wave-Agent': this.config.agentName,
        },
        body: JSON.stringify({ logs: entries }),
      });
    } catch {
      // Re-add entries on failure (drop oldest if buffer is full)
      const remaining = this.maxBufferSize - this.buffer.length;
      if (remaining > 0) {
        this.buffer.unshift(...entries.slice(-remaining));
      }
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      agent: this.config.agentName,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    // Always write to stdout as structured JSON
    const output = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }

    // Buffer for forwarding
    if (this.config.forwardUrl) {
      this.buffer.push(entry);

      // Auto-flush if buffer is full
      if (this.buffer.length >= this.maxBufferSize) {
        void this.flush();
      }
    }
  }
}
