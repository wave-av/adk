/**
 * Mastra Framework Adapter for WAVE ADK
 *
 * Integrates WAVE video tools with the Mastra agent framework.
 * Mastra is the strongest match for WAVE ADK:
 * - Native TypeScript, 300K+ weekly npm downloads
 * - First-class MCP client via @mastra/mcp
 * - createTool() maps directly to streaming lifecycle
 *
 * @see docs/integration-research/agent-frameworks-2026-04-01.md
 */

import { AgentToolkit } from '../tools/AgentToolkit';

/**
 * Create Mastra-compatible tool definitions from WAVE AgentToolkit.
 *
 * Usage with Mastra:
 * ```typescript
 * import { createMastraTools } from '@wave-av/adk/adapters/mastra';
 * import { Agent } from '@mastra/core';
 *
 * const tools = createMastraTools({ apiKey: process.env.WAVE_AGENT_KEY });
 *
 * const agent = new Agent({
 *   name: 'stream-monitor',
 *   instructions: 'Monitor live streams and alert on quality drops',
 *   model: { provider: 'ANTHROPIC', name: 'claude-sonnet-4-6' },
 *   tools,
 * });
 * ```
 */
export function createMastraTools(config: { apiKey: string; baseUrl?: string }) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();

  // Convert WAVE tools to Mastra createTool() format
  const mastraTools: Record<string, {
    description: string;
    parameters: Record<string, { type: string; description: string }>;
    execute: (params: Record<string, unknown>) => Promise<unknown>;
  }> = {};

  for (const tool of waveTools) {
    mastraTools[tool.name] = {
      description: tool.description,
      parameters: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description },
        ])
      ),
      execute: tool.handler,
    };
  }

  return mastraTools;
}

/**
 * Create a Mastra MCP server configuration for WAVE.
 *
 * Usage:
 * ```typescript
 * import { createWaveMCPConfig } from '@wave-av/adk/adapters/mastra';
 * import { MCPClient } from '@mastra/mcp';
 *
 * const mcp = new MCPClient(createWaveMCPConfig({ apiKey: process.env.WAVE_AGENT_KEY }));
 * const tools = await mcp.tools();
 * ```
 *
 * `apiKey` falls back to `WAVE_AGENT_KEY`, then `WAVE_API_KEY`. `serverPath`
 * runs a local MCP server build with `node` instead of `npx @wave-av/mcp-server`.
 */
export function createWaveMCPConfig(config: { apiKey?: string; serverPath?: string } = {}) {
  const apiKey = config.apiKey ?? process.env.WAVE_AGENT_KEY ?? process.env.WAVE_API_KEY ?? '';
  return {
    servers: {
      wave: {
        command: config.serverPath ? 'node' : 'npx',
        args: config.serverPath ? [config.serverPath] : ['@wave-av/mcp-server'],
        env: {
          WAVE_API_KEY: apiKey,
        },
      },
    },
  };
}

/**
 * Create a Mastra workflow step that monitors stream quality.
 *
 * Usage:
 * ```typescript
 * import { createStreamMonitorStep } from '@wave-av/adk/adapters/mastra';
 * import { Workflow } from '@mastra/core';
 *
 * const workflow = new Workflow({ name: 'quality-monitor' })
 *   .step(createStreamMonitorStep({ streamId: 'stream_abc' }))
 *   .then(alertStep)
 *   .commit();
 * ```
 */
export function createStreamMonitorStep(config: {
  streamId: string;
  thresholds?: { rebuffering?: number; startupTime?: number };
}) {
  return {
    id: `wave-monitor-${config.streamId}`,
    description: `Monitor stream ${config.streamId} quality`,
    execute: async (context: { tools: Record<string, { execute: (p: Record<string, unknown>) => Promise<unknown> }> }) => {
      const health = await context.tools['wave_monitor_stream']?.execute({
        streamId: config.streamId,
      });
      return { health, streamId: config.streamId };
    },
  };
}
