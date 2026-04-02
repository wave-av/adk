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
 *   apiKey: process.env.WAVE_AGENT_KEY,
 *   onQualityDrop: async (alert) => {
 *     await agent.tools.switchToBackup(alert.streamId);
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
export { AgentToolkit, type AgentTool } from './tools/AgentToolkit';

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
