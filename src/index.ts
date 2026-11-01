/**
 * WAVE Agent Developer Kit (ADK)
 *
 * The complete toolkit for AI agents to create, manage,
 * and interact with live video infrastructure.
 *
 * @example
 * ```typescript
 * import { WaveAgent, StreamMonitorAgent } from '@wave-av/adk';
 *
 * const agent = new StreamMonitorAgent({
 *   apiKey: process.env.WAVE_AGENT_KEY!,
 *   agentName: 'my-monitor',
 *   streamIds: [process.env.WAVE_STREAM_ID!],
 *   onQualityDrop: async (alert) => {
 *     console.log(`${alert.streamId} went ${alert.status}`);
 *   },
 * });
 *
 * await agent.start();
 * ```
 */

// Core agent base class
export { WaveAgent, type WaveAgentConfig, type AgentEventHandler } from './agents/WaveAgent';

// Agent runtime (v2 — health, heartbeat, logging)
export { AgentRuntime, type AgentRuntimeConfig, type AgentHealthStatus } from './agents/AgentRuntime';
export { AgentLogger, type LogLevel, type AgentLoggerConfig } from './agents/AgentLogger';

// Pre-built agent templates
export { StreamMonitorAgent } from './templates/StreamMonitorAgent';
export { AutoProducerAgent } from './templates/AutoProducerAgent';
export { ClipFactoryAgent } from './templates/ClipFactoryAgent';
export { ModerationAgent } from './templates/ModerationAgent';
export { CaptionAgent } from './templates/CaptionAgent';

// Agent tools (MCP-compatible)
export { AgentToolkit, type AgentTool, type AgentToolParameter } from './tools/AgentToolkit';

// Errors and the WAVE API routes the ADK calls
export { WaveToolError } from './errors';
export { WAVE_ROUTES, type WaveRoute, type WaveRouteName } from './routes';

// Template result types
export type { ModerationVerdict } from './templates/ModerationAgent';
export type { CaptionJob, CaptionDownload } from './templates/CaptionAgent';

// Framework adapters
export { createMastraTools, createWaveMCPConfig, createStreamMonitorStep } from './adapters/mastra';
export { createLiveKitWaveTools, createWaveStreamSource } from './adapters/livekit';
export { createLangGraphTools, createStreamMonitorNode, createClipNode } from './adapters/langgraph';
export { createKernelTools, type KernelConfig } from './adapters/kernel';

// Types
export type {
  AgentType,
  AgentTier,
  AgentInvocation,
  AgentWebhookEvent,
  StreamQualityAlert,
  ClipHighlight,
  ModerationFlag,
} from './types';
