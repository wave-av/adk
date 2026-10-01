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
  /** A full buffer triggers a forward. */
  private readonly maxBufferSize = 100;
  /** Hard cap on records held while the collector is slow or down; the oldest go first. */
  private readonly maxPending = 1_000;
  /** A forward that takes longer than this counts as failed, so shutdown is never stuck behind it. */
  private readonly forwardTimeoutMs = 10_000;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** The forward currently on the wire; it never rejects. */
  private inFlight: Promise<boolean> | null = null;
  /** The one flush waiting for `inFlight`. Every later caller shares it. */
  private queued: Promise<boolean> | null = null;
  /** The last forward failed: a full buffer waits for the periodic flush instead of retrying at once. */
  private failing = false;
  private dropped = 0;
  /** A drop warning was written since the last delivered forward. */
  private dropWarned = false;

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

  /** Records dropped (oldest first) because the collector could not keep up. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Forward buffered records to the collector. Resolves `true` when nothing is
   * left to send, `false` when the collector refused, timed out or was
   * unreachable (the records go back in the buffer for the next flush).
   *
   * At most one forward is on the wire and at most one flush waits behind it.
   * A flush that starts while a forward is in flight waits for it, so it never
   * reports success just because that forward had already emptied the buffer;
   * if the earlier forward failed, its re-buffered records are sent again. Every
   * caller that arrives while a flush is already waiting shares that flush, so a
   * slow or failing collector costs two requests, not one per log line.
   */
  flush(): Promise<boolean> {
    if (this.queued) return this.queued;
    if (!this.inFlight) return this.send();
    const queued = this.inFlight.then(() => {
      this.queued = null;
      return this.send();
    });
    this.queued = queued;
    return queued;
  }

  /** Start one forward of everything buffered. Callers ensure nothing is in flight. */
  private send(): Promise<boolean> {
    if (this.buffer.length === 0 || !this.config.forwardUrl) return Promise.resolve(true);

    const sent: Promise<boolean> = this.forward(this.buffer.splice(0, this.buffer.length)).then((ok) => {
      this.failing = !ok;
      if (ok) this.dropWarned = false; // warn again if the collector falls behind again
      if (this.inFlight === sent) this.inFlight = null;
      return ok;
    });
    this.inFlight = sent;
    return sent;
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
        signal: AbortSignal.timeout(this.forwardTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`log forward failed: HTTP ${response.status}`);
      }
      return true;
    } catch {
      // Put the records back ahead of anything logged since, keeping the newest.
      this.buffer.unshift(...entries);
      this.trim();
      return false;
    }
  }

  /**
   * Keep at most `maxPending` records, dropping the oldest. The first drop in
   * each episode (until a forward is delivered again) is reported on stderr
   * right away, so a collector that recovers later does not hide the loss.
   */
  private trim(): void {
    const excess = this.buffer.length - this.maxPending;
    if (excess <= 0) return;
    this.buffer.splice(0, excess);
    this.dropped += excess;
    if (this.dropWarned) return;
    this.dropWarned = true;
    // Straight to stderr: going through log() would buffer this record too.
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      agent: this.config.agentName,
      message: `Log collector is behind; dropping the oldest records beyond ${this.maxPending}. They were written to stdout/stderr but will not reach forwardUrl.`,
      data: { droppedTotal: this.dropped },
    }) + '\n');
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
      this.trim();

      // Forward early when the buffer is full, unless the collector just failed:
      // then the periodic flush retries, so a down collector is not hit per line.
      if (this.buffer.length >= this.maxBufferSize && !this.failing) {
        void this.flush();
      }
    }
  }
}
