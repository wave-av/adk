/**
 * AgentLogger — Structured log forwarding for WAVE agents
 *
 * Outputs JSON-structured logs to stdout and optionally forwards
 * to the WAVE observability platform (Sentry + OTLP ingest).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentLoggerConfig {
  readonly agentName: string;
  readonly level: LogLevel;
  /**
   * Full URL of the log collector endpoint (batches are POSTed as
   * `{ logs: [...] }`). Empty disables forwarding. The WAVE API has no
   * log-ingest operation, so this is your own collector.
   */
  readonly forwardUrl: string;
  readonly apiKey: string;
  /**
   * WAVE API base URL. The WAVE key is attached to a forward only when
   * `forwardUrl` is on this origin, so it never leaks to a third-party collector.
   */
  readonly waveBaseUrl?: string;
  /** Extra headers for the collector (for example its own auth token). */
  readonly forwardHeaders?: Record<string, string>;
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
  /** The forward currently on the wire; it never rejects. */
  private inFlight: Promise<boolean> | null = null;

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

  /** Records buffered for the collector and not yet delivered. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /**
   * Forward buffered records to the collector. Resolves `true` when nothing is
   * left to send, `false` when the collector refused or was unreachable (the
   * records are put back in the buffer for the next flush).
   *
   * Flushes run one at a time. A flush that starts while a periodic or
   * buffer-full forward is still on the wire waits for it first, so it never
   * reports success just because that forward had already emptied the buffer;
   * if the earlier forward failed, its re-buffered records are sent again here.
   */
  async flush(): Promise<boolean> {
    while (this.inFlight) await this.inFlight;
    if (this.buffer.length === 0 || !this.config.forwardUrl) return true;

    const forward = this.forward(this.buffer.splice(0, this.buffer.length));
    this.inFlight = forward;
    try {
      return await forward;
    } finally {
      if (this.inFlight === forward) this.inFlight = null;
    }
  }

  private async forward(entries: LogEntry[]): Promise<boolean> {
    try {
      const response = await fetch(this.config.forwardUrl, {
        method: 'POST',
        headers: {
          ...(this.sendsWaveKey() ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          'Content-Type': 'application/json',
          'X-Wave-Agent': this.config.agentName,
          ...this.config.forwardHeaders,
        },
        body: JSON.stringify({ logs: entries }),
      });
      if (!response.ok) {
        throw new Error(`log forward failed: HTTP ${response.status}`);
      }
      return true;
    } catch {
      // Re-add entries on failure (drop oldest if buffer is full)
      const remaining = this.maxBufferSize - this.buffer.length;
      if (remaining > 0) {
        this.buffer.unshift(...entries.slice(-remaining));
      }
      return false;
    }
  }

  private sendsWaveKey(): boolean {
    try {
      const target = new URL(this.config.forwardUrl).origin;
      const wave = new URL(this.config.waveBaseUrl ?? 'https://api.wave.online').origin;
      return target === wave;
    } catch {
      return false;
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
