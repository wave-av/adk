// src/agents/WaveAgent.ts
var WaveAgent = class {
  config;
  eventHandlers = /* @__PURE__ */ new Map();
  invocations = [];
  _isRunning = false;
  constructor(config) {
    this.config = {
      apiKey: config.apiKey,
      agentName: config.agentName,
      agentType: config.agentType,
      baseUrl: config.baseUrl ?? "https://api.wave.online",
      tier: config.tier ?? "free",
      webhookUrl: config.webhookUrl ?? "",
      onError: config.onError ?? console.error
    };
  }
  get isRunning() {
    return this._isRunning;
  }
  async start() {
    await this.apiCall("POST", "/v1/agents/register", {
      name: this.config.agentName,
      type: this.config.agentType,
      tier: this.config.tier,
      webhookUrl: this.config.webhookUrl
    });
    this._isRunning = true;
  }
  async stop() {
    this._isRunning = false;
  }
  on(event, handler) {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }
  async emit(event, data) {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const handler of handlers) {
      try {
        await handler(data);
      } catch (error) {
        this.config.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  async apiCall(method, path, body, options) {
    const maxRetries = options?.maxRetries ?? 3;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      try {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          method,
          headers: {
            "Authorization": `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-Wave-Agent": this.config.agentName,
            "X-Wave-Agent-Type": this.config.agentType
          },
          body: body ? JSON.stringify(body) : void 0
        });
        const durationMs = Date.now() - startTime;
        if (response.status === 429 && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
          await this.sleep(retryAfter * 1e3);
          continue;
        }
        if (response.status >= 500 && attempt < maxRetries) {
          await this.sleep(Math.min(1e3 * 2 ** attempt, 1e4));
          continue;
        }
        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const error = new Error(`WAVE API error: ${response.status} ${response.statusText} ${errorBody}`);
          this.trackInvocation(method, path, body, durationMs, "error");
          throw error;
        }
        this.trackInvocation(method, path, body, durationMs, "success");
        return response.json();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries && !lastError.message.includes("WAVE API error")) {
          await this.sleep(Math.min(1e3 * 2 ** attempt, 1e4));
          continue;
        }
        this.trackInvocation(method, path, body, Date.now() - startTime, "error");
        throw lastError;
      }
    }
    throw lastError ?? new Error("Max retries exceeded");
  }
  trackInvocation(method, path, body, durationMs, status) {
    this.invocations.push({
      id: crypto.randomUUID(),
      agentId: this.config.agentName,
      toolName: `${method} ${path}`,
      eventType: "api_call",
      input: body ?? {},
      output: {},
      durationMs,
      costCents: 0,
      status,
      createdAt: /* @__PURE__ */ new Date()
    });
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  getUsageStats() {
    return {
      totalCalls: this.invocations.length,
      totalDurationMs: this.invocations.reduce((sum, i) => sum + i.durationMs, 0)
    };
  }
};

// src/agents/AgentRuntime.ts
import { createServer } from "http";

// src/agents/AgentLogger.ts
var LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var AgentLogger = class {
  config;
  buffer = [];
  maxBufferSize = 100;
  flushTimer = null;
  constructor(config) {
    this.config = config;
    if (this.config.forwardUrl) {
      this.flushTimer = setInterval(() => void this.flush(), 1e4);
    }
  }
  debug(message, data) {
    this.log("debug", message, data);
  }
  info(message, data) {
    this.log("info", message, data);
  }
  warn(message, data) {
    this.log("warn", message, data);
  }
  error(message, data) {
    this.log("error", message, data);
  }
  async flush() {
    if (this.buffer.length === 0 || !this.config.forwardUrl) return;
    const entries = this.buffer.splice(0, this.buffer.length);
    try {
      await fetch(`${this.config.forwardUrl}/v1/agents/logs`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "X-Wave-Agent": this.config.agentName
        },
        body: JSON.stringify({ logs: entries })
      });
    } catch {
      const remaining = this.maxBufferSize - this.buffer.length;
      if (remaining > 0) {
        this.buffer.unshift(...entries.slice(-remaining));
      }
    }
  }
  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
  log(level, message, data) {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.level]) return;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      agent: this.config.agentName,
      message,
      ...data && Object.keys(data).length > 0 ? { data } : {}
    };
    const output = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
    if (this.config.forwardUrl) {
      this.buffer.push(entry);
      if (this.buffer.length >= this.maxBufferSize) {
        void this.flush();
      }
    }
  }
};

// src/agents/AgentRuntime.ts
var AgentRuntime = class {
  agent;
  config;
  logger;
  server = null;
  heartbeatTimer = null;
  startedAt = null;
  lastHeartbeatAt = null;
  shutdownInProgress = false;
  constructor(agent, config = {}) {
    this.agent = agent;
    this.config = {
      healthPort: config.healthPort ?? 8080,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 3e4,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 1e4,
      logLevel: config.logLevel ?? "info",
      logForwardUrl: config.logForwardUrl ?? "",
      onShutdown: config.onShutdown ?? (async () => {
      })
    };
    this.logger = new AgentLogger({
      agentName: agent["config"].agentName,
      level: this.config.logLevel,
      forwardUrl: this.config.logForwardUrl,
      apiKey: agent["config"].apiKey
    });
  }
  async start() {
    this.startedAt = /* @__PURE__ */ new Date();
    this.logger.info("Agent starting", { agentType: this.agent["config"].agentType });
    await this.agent.start();
    await this.startHealthServer();
    this.startHeartbeat();
    this.registerSignalHandlers();
    this.logger.info("Agent runtime started", {
      healthPort: this.config.healthPort,
      heartbeatIntervalMs: this.config.heartbeatIntervalMs
    });
  }
  async stop() {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    this.logger.info("Agent runtime shutting down");
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      await Promise.race([
        this.config.onShutdown(),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("Shutdown handler timeout")), this.config.shutdownTimeoutMs)
        )
      ]);
    } catch (error) {
      this.logger.error("Shutdown handler failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await this.agent.stop();
    if (this.server) {
      await new Promise((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    await this.logger.flush();
    this.logger.info("Agent runtime stopped");
  }
  getHealth() {
    const uptimeMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
    const stats = this.agent.getUsageStats();
    return {
      status: this.agent.isRunning ? "healthy" : "unhealthy",
      agentName: this.agent["config"].agentName,
      uptime: uptimeMs,
      totalCalls: stats.totalCalls,
      lastHeartbeat: this.lastHeartbeatAt?.toISOString() ?? null,
      version: "2.0.0"
    };
  }
  getLogger() {
    return this.logger;
  }
  async startHealthServer() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleHealthRequest(req, res);
      });
      this.server.on("error", (error) => {
        this.logger.error("Health server error", { error: error.message });
        reject(error);
      });
      this.server.listen(this.config.healthPort, () => {
        resolve();
      });
    });
  }
  handleHealthRequest(req, res) {
    if (req.url === "/health" || req.url === "/healthz") {
      const health = this.getHealth();
      const statusCode = health.status === "healthy" ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    if (req.url === "/ready" || req.url === "/readyz") {
      const isReady = this.agent.isRunning && !this.shutdownInProgress;
      res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: isReady }));
      return;
    }
    if (req.url === "/metrics") {
      const stats = this.agent.getUsageStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...stats,
        uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
  startHeartbeat() {
    const sendHeartbeat = async () => {
      try {
        await this.agent["apiCall"]("POST", "/v1/agents/heartbeat", {
          agentName: this.agent["config"].agentName,
          status: this.agent.isRunning ? "healthy" : "unhealthy",
          uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
          stats: this.agent.getUsageStats()
        });
        this.lastHeartbeatAt = /* @__PURE__ */ new Date();
      } catch (error) {
        this.logger.warn("Heartbeat failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    void sendHeartbeat();
    this.heartbeatTimer = setInterval(() => void sendHeartbeat(), this.config.heartbeatIntervalMs);
  }
  registerSignalHandlers() {
    const shutdown = async (signal) => {
      this.logger.info("Received signal", { signal });
      await this.stop();
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  }
};

// src/templates/StreamMonitorAgent.ts
var StreamMonitorAgent = class extends WaveAgent {
  streamIds;
  pollingIntervalMs;
  onQualityDrop;
  autoRemediate;
  pollingTimer = null;
  constructor(config) {
    super({ ...config, agentType: "stream_monitor" });
    this.streamIds = config.streamIds;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 3e4;
    this.onQualityDrop = config.onQualityDrop;
    this.autoRemediate = config.autoRemediate ?? false;
  }
  async start() {
    await super.start();
    this.pollingTimer = setInterval(async () => {
      for (const streamId of this.streamIds) {
        await this.checkStreamHealth(streamId);
      }
    }, this.pollingIntervalMs);
  }
  async stop() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    await super.stop();
  }
  async checkStreamHealth(streamId) {
    try {
      const health = await this.apiCall("GET", `/v1/streams/${streamId}/health`);
      if (health.status === "degraded" || health.status === "critical") {
        const alert = {
          streamId,
          metric: "rebuffering",
          severity: health.status === "critical" ? "critical" : "warning",
          currentValue: health.metrics.rebufferingRatio,
          threshold: 0.02,
          timestamp: /* @__PURE__ */ new Date()
        };
        await this.emit("quality.drop", alert);
        await this.onQualityDrop?.(alert);
        if (this.autoRemediate && health.status === "critical") {
          await this.apiCall("POST", `/v1/streams/${streamId}/remediate`, {
            action: "reduce_bitrate",
            reason: "Auto-remediation by StreamMonitorAgent"
          });
        }
      }
    } catch (error) {
      this.config.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
};

// src/templates/AutoProducerAgent.ts
var AutoProducerAgent = class extends WaveAgent {
  switcherId;
  style;
  confidenceThreshold;
  constructor(config) {
    super({ ...config, agentType: "auto_producer" });
    this.switcherId = config.switcherId;
    this.style = config.style ?? "conference";
    this.confidenceThreshold = config.confidenceThreshold ?? 0.7;
  }
  async start() {
    await super.start();
    await this.apiCall("POST", `/v1/ghost-producer/sessions`, {
      switcherId: this.switcherId,
      style: this.style,
      confidenceThreshold: this.confidenceThreshold,
      agentControlled: true
    });
  }
  async switchToSource(sourceId, reason) {
    await this.apiCall("POST", `/v1/switcher/${this.switcherId}/switch`, {
      sourceId,
      transition: "mix",
      duration: 500,
      reason
    });
  }
  async showGraphic(templateId, data) {
    await this.apiCall("POST", `/v1/graphics/show`, {
      switcherId: this.switcherId,
      templateId,
      data
    });
  }
  async markHighlight(label) {
    await this.apiCall("POST", `/v1/replay/poi`, {
      switcherId: this.switcherId,
      label,
      timestamp: Date.now(),
      autoGenerated: true
    });
  }
};

// src/templates/ClipFactoryAgent.ts
var ClipFactoryAgent = class extends WaveAgent {
  streamIds;
  platforms;
  stingerId;
  minConfidence;
  constructor(config) {
    super({ ...config, agentType: "clip_factory" });
    this.streamIds = config.streamIds;
    this.platforms = config.platforms ?? ["youtube_shorts", "tiktok"];
    this.stingerId = config.stingerId;
    this.minConfidence = config.minConfidence ?? 0.8;
  }
  async start() {
    await super.start();
    for (const streamId of this.streamIds) {
      this.on(`stream.${streamId}.highlight`, async (event) => {
        const highlight = event;
        if (highlight.confidence >= this.minConfidence) {
          await this.exportClip(highlight);
        }
      });
    }
  }
  async exportClip(highlight) {
    const clip = await this.apiCall("POST", "/v1/clips/export", {
      streamId: highlight.streamId,
      startTime: highlight.startTime,
      endTime: highlight.endTime,
      stingerId: this.stingerId,
      platforms: this.platforms
    });
    return clip.clipId;
  }
};

// src/templates/ModerationAgent.ts
var ModerationAgent = class extends WaveAgent {
  streamIds;
  rules;
  constructor(config) {
    super({ ...config, agentType: "moderator" });
    this.streamIds = config.streamIds;
    this.rules = config.rules ?? {
      blockProfanity: true,
      blockSpam: true,
      blockHarassment: true
    };
  }
  async start() {
    await super.start();
    await this.apiCall("POST", "/v1/moderation/configure", {
      streamIds: this.streamIds,
      rules: this.rules,
      agentControlled: true
    });
  }
  async blockUser(streamId, userId, reason) {
    await this.apiCall("POST", `/v1/moderation/block`, {
      streamId,
      userId,
      reason,
      duration: 3600
    });
  }
  async approveMessage(messageId) {
    await this.apiCall("POST", `/v1/moderation/approve`, { messageId });
  }
};

// src/templates/CaptionAgent.ts
var CaptionAgent = class extends WaveAgent {
  streamIds;
  languages;
  provider;
  constructor(config) {
    super({ ...config, agentType: "captioner" });
    this.streamIds = config.streamIds;
    this.languages = config.languages ?? ["en"];
    this.provider = config.provider ?? "deepgram";
  }
  async start() {
    await super.start();
    for (const streamId of this.streamIds) {
      await this.apiCall("POST", "/v1/captions/start", {
        streamId,
        languages: this.languages,
        provider: this.provider,
        agentControlled: true
      });
    }
  }
  async translateTo(streamId, targetLanguage) {
    await this.apiCall("POST", `/v1/captions/${streamId}/translate`, {
      targetLanguage
    });
  }
  async getTranscript(streamId) {
    return this.apiCall("GET", `/v1/captions/${streamId}/transcript`);
  }
};

// src/tools/AgentToolkit.ts
import { z } from "zod";
var AgentToolkit = class {
  baseUrl;
  apiKey;
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.wave.online";
  }
  validated(schema, handler) {
    return async (params) => {
      const parsed = schema.parse(params);
      return handler(parsed);
    };
  }
  getTools() {
    const createStreamSchema = z.object({ title: z.string().min(1), protocol: z.enum(["webrtc", "srt", "rtmp", "ndi"]).optional() });
    const streamIdSchema = z.object({ streamId: z.string().uuid() });
    const clipSchema = z.object({ streamId: z.string().uuid(), startTime: z.number().min(0), endTime: z.number().min(0) });
    const switchSchema = z.object({ switcherId: z.string(), sourceId: z.string(), transition: z.enum(["cut", "mix", "wipe"]).optional() });
    const graphicSchema = z.object({ switcherId: z.string(), templateId: z.string(), data: z.record(z.unknown()).optional() });
    const moderateSchema = z.object({ messageId: z.string(), action: z.enum(["approve", "flag", "block"]) });
    const captionSchema = z.object({ streamId: z.string().uuid(), language: z.string().length(2).optional() });
    const analyticsSchema = z.object({ streamId: z.string().uuid(), timeRange: z.enum(["1h", "24h", "7d"]).optional() });
    const highlightSchema = z.object({ streamId: z.string().uuid(), label: z.string().min(1) });
    const cameraSchema = z.object({ cameraId: z.string(), pan: z.number().min(0).max(1).optional(), tilt: z.number().min(0).max(1).optional(), zoom: z.number().min(0).max(1).optional() });
    return [
      {
        name: "wave_create_stream",
        description: "Create a new live stream with specified protocol and settings",
        parameters: {
          title: { type: "string", description: "Stream title", required: true },
          protocol: { type: "string", description: "Protocol: webrtc, srt, rtmp, ndi" }
        },
        schema: createStreamSchema,
        handler: this.validated(createStreamSchema, (params) => this.call("POST", "/v1/streams", params))
      },
      {
        name: "wave_monitor_stream",
        description: "Get real-time quality metrics for a stream",
        parameters: {
          streamId: { type: "string", description: "Stream ID", required: true }
        },
        schema: streamIdSchema,
        handler: this.validated(streamIdSchema, (params) => this.call("GET", `/v1/streams/${params.streamId}/health`))
      },
      {
        name: "wave_create_clip",
        description: "Extract a clip from a stream at specified timestamps",
        parameters: {
          streamId: { type: "string", description: "Stream ID", required: true },
          startTime: { type: "number", description: "Start time in seconds", required: true },
          endTime: { type: "number", description: "End time in seconds", required: true }
        },
        schema: clipSchema,
        handler: this.validated(clipSchema, (params) => this.call("POST", "/v1/clips", params))
      },
      {
        name: "wave_switch_camera",
        description: "Switch the live production to a different camera source",
        parameters: {
          switcherId: { type: "string", description: "Switcher instance ID", required: true },
          sourceId: { type: "string", description: "Source to switch to", required: true },
          transition: { type: "string", description: "Transition type: cut, mix, wipe" }
        },
        schema: switchSchema,
        handler: this.validated(switchSchema, (params) => this.call("POST", `/v1/switcher/${params.switcherId}/switch`, params))
      },
      {
        name: "wave_show_graphic",
        description: "Display a graphics overlay on the live production",
        parameters: {
          switcherId: { type: "string", description: "Switcher instance ID", required: true },
          templateId: { type: "string", description: "Graphics template ID", required: true },
          data: { type: "object", description: "Template data bindings" }
        },
        schema: graphicSchema,
        handler: this.validated(graphicSchema, (params) => this.call("POST", "/v1/graphics/show", params))
      },
      {
        name: "wave_moderate_chat",
        description: "Moderate a chat message (approve, flag, or block)",
        parameters: {
          messageId: { type: "string", description: "Message ID", required: true },
          action: { type: "string", description: "Action: approve, flag, block", required: true }
        },
        schema: moderateSchema,
        handler: this.validated(moderateSchema, (params) => this.call("POST", "/v1/moderation/action", params))
      },
      {
        name: "wave_start_captions",
        description: "Start real-time captioning on a stream",
        parameters: {
          streamId: { type: "string", description: "Stream ID", required: true },
          language: { type: "string", description: "Language code (e.g., en, es, fr)" }
        },
        schema: captionSchema,
        handler: this.validated(captionSchema, (params) => this.call("POST", "/v1/captions/start", params))
      },
      {
        name: "wave_analyze_quality",
        description: "Get detailed quality analytics for a stream",
        parameters: {
          streamId: { type: "string", description: "Stream ID", required: true },
          timeRange: { type: "string", description: "Time range: 1h, 24h, 7d" }
        },
        schema: analyticsSchema,
        handler: this.validated(analyticsSchema, (params) => this.call("GET", `/v1/analytics/stream/${params.streamId}/qoe`))
      },
      {
        name: "wave_mark_highlight",
        description: "Mark a point of interest for replay/highlights",
        parameters: {
          streamId: { type: "string", description: "Stream ID", required: true },
          label: { type: "string", description: "Highlight label", required: true }
        },
        schema: highlightSchema,
        handler: this.validated(highlightSchema, (params) => this.call("POST", "/v1/replay/poi", params))
      },
      {
        name: "wave_control_camera",
        description: "Control a PTZ camera (pan, tilt, zoom, focus)",
        parameters: {
          cameraId: { type: "string", description: "Camera ID", required: true },
          pan: { type: "number", description: "Pan position (0-1)" },
          tilt: { type: "number", description: "Tilt position (0-1)" },
          zoom: { type: "number", description: "Zoom level (0-1)" }
        },
        schema: cameraSchema,
        handler: this.validated(cameraSchema, (params) => this.call("POST", `/v1/cameras/${params.cameraId}/control`, params))
      }
    ];
  }
  toMCPTools() {
    return this.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, val]) => [key, { type: val.type, description: val.description }])
        ),
        required: Object.entries(tool.parameters).filter(([_, v]) => v.required).map(([k]) => k)
      }
    }));
  }
  async call(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: body && method !== "GET" ? JSON.stringify(body) : void 0
    });
    return response.json();
  }
};

// src/adapters/mastra.ts
function createMastraTools(config) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();
  const mastraTools = {};
  for (const tool of waveTools) {
    mastraTools[tool.name] = {
      description: tool.description,
      parameters: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description }
        ])
      ),
      execute: tool.handler
    };
  }
  return mastraTools;
}
function createWaveMCPConfig(_config) {
  return {
    servers: {
      wave: {
        command: "npx",
        args: ["@wave-av/mcp-server"],
        env: {
          WAVE_API_KEY: process.env.WAVE_AGENT_KEY ?? ""
        }
      }
    }
  };
}
function createStreamMonitorStep(config) {
  return {
    id: `wave-monitor-${config.streamId}`,
    description: `Monitor stream ${config.streamId} quality`,
    execute: async (context) => {
      const health = await context.tools["wave_monitor_stream"]?.execute({
        streamId: config.streamId
      });
      return { health, streamId: config.streamId };
    }
  };
}

// src/adapters/livekit.ts
function createLiveKitWaveTools(config) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();
  return waveTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description }
        ])
      ),
      required: Object.entries(tool.parameters).filter(([_, v]) => v.required).map(([k]) => k)
    },
    handler: tool.handler
  }));
}
function createWaveStreamSource(config) {
  return {
    type: "wave_stream",
    streamId: config.streamId,
    getPlaybackUrl: async () => {
      const toolkit = new AgentToolkit({ apiKey: config.apiKey, baseUrl: config.baseUrl });
      const tools = toolkit.getTools();
      const playbackTool = tools.find((t) => t.name === "wave_monitor_stream");
      if (!playbackTool) throw new Error("wave_monitor_stream tool not found");
      const result = await playbackTool.handler({ streamId: config.streamId });
      return result;
    }
  };
}

// src/adapters/langgraph.ts
function createLangGraphTools(config) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();
  return waveTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description }
        ])
      ),
      required: Object.entries(tool.parameters).filter(([, val]) => val.required).map(([key]) => key)
    },
    func: async (input) => {
      const result = await tool.handler(input);
      return JSON.stringify(result);
    }
  }));
}
function createStreamMonitorNode(config) {
  const toolkit = new AgentToolkit({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  return async (state) => {
    const tools = toolkit.getTools();
    const monitorTool = tools.find((t) => t.name === "monitor_stream");
    if (!monitorTool) {
      return { ...state, error: "monitor_stream tool not found" };
    }
    const health = await monitorTool.handler({ streamId: config.streamId });
    return { ...state, streamHealth: health, streamId: config.streamId };
  };
}
function createClipNode(config) {
  const toolkit = new AgentToolkit({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  return async (state) => {
    const tools = toolkit.getTools();
    const clipTool = tools.find((t) => t.name === "create_clip");
    if (!clipTool) {
      return { ...state, error: "create_clip tool not found" };
    }
    const clip = await clipTool.handler({
      streamId: state.streamId,
      startTime: state.clipStart,
      endTime: state.clipEnd
    });
    return { ...state, clip };
  };
}

// src/adapters/kernel.ts
import { z as z2 } from "zod";
function createKernelTools(config) {
  const baseUrl = config.baseUrl ?? "https://api.onkernel.com";
  async function kernelFetch(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Kernel API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
  const browseSchema = z2.object({ url: z2.string().url(), waitForSelector: z2.string().optional(), timeoutMs: z2.number().optional() });
  const screenshotSchema = z2.object({ url: z2.string().url(), selector: z2.string().optional(), width: z2.number().optional(), height: z2.number().optional() });
  const playwrightSchema = z2.object({ code: z2.string().min(1), url: z2.string().url().optional() });
  return [
    {
      name: "browse_url",
      description: "Navigate a cloud browser to a URL and return the page content/snapshot. Uses Kernel.sh managed browsers \u2014 no local browser needed.",
      parameters: {
        url: { type: "string", description: "URL to navigate to", required: true },
        waitForSelector: { type: "string", description: "CSS selector to wait for before capturing", required: false },
        timeoutMs: { type: "number", description: "Navigation timeout in milliseconds", required: false }
      },
      schema: browseSchema,
      handler: async (params) => {
        const result = await kernelFetch("/v1/browsers/navigate", {
          url: params.url,
          waitForSelector: params.waitForSelector,
          timeout: params.timeoutMs ?? 3e4
        });
        return result;
      }
    },
    {
      name: "take_screenshot",
      description: "Take a screenshot of a URL using a cloud browser. Returns base64-encoded PNG. Useful for visual QA of live stream players.",
      parameters: {
        url: { type: "string", description: "URL to screenshot", required: true },
        selector: { type: "string", description: "CSS selector to screenshot (optional, defaults to full page)", required: false },
        width: { type: "number", description: "Viewport width in pixels", required: false },
        height: { type: "number", description: "Viewport height in pixels", required: false }
      },
      schema: screenshotSchema,
      handler: async (params) => {
        const result = await kernelFetch("/v1/browsers/screenshot", {
          url: params.url,
          selector: params.selector,
          viewport: {
            width: params.width ?? 1920,
            height: params.height ?? 1080
          }
        });
        return result;
      }
    },
    {
      name: "run_playwright",
      description: "Execute Playwright code in a Kernel.sh cloud browser. For complex browser automation like testing embed players or monitoring dashboards.",
      parameters: {
        code: { type: "string", description: "Playwright JavaScript code to execute", required: true },
        url: { type: "string", description: "Starting URL (optional)", required: false }
      },
      schema: playwrightSchema,
      handler: async (params) => {
        const result = await kernelFetch("/v1/browsers/execute", {
          code: params.code,
          url: params.url
        });
        return result;
      }
    }
  ];
}
export {
  AgentLogger,
  AgentRuntime,
  AgentToolkit,
  AutoProducerAgent,
  CaptionAgent,
  ClipFactoryAgent,
  ModerationAgent,
  StreamMonitorAgent,
  WaveAgent,
  createClipNode,
  createKernelTools,
  createLangGraphTools,
  createLiveKitWaveTools,
  createMastraTools,
  createStreamMonitorNode,
  createStreamMonitorStep,
  createWaveMCPConfig,
  createWaveStreamSource
};
