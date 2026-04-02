/**
 * LangGraph Adapter for WAVE ADK
 *
 * Integrates WAVE video tools with LangChain's LangGraph framework.
 * LangGraph uses a state-machine graph model with typed nodes and edges.
 *
 * Tool format: LangGraph ToolNode expects tools as
 * { name, description, schema, func } — maps directly from WAVE MCP tools.
 *
 * @see https://langchain-ai.github.io/langgraph/
 */

import { AgentToolkit } from '../tools/AgentToolkit';

/**
 * Create LangGraph-compatible tool definitions from WAVE AgentToolkit.
 *
 * Usage with LangGraph (TypeScript):
 * ```typescript
 * import { createLangGraphTools } from '@wave-av/adk/adapters/langgraph';
 * import { ToolNode } from '@langchain/langgraph/prebuilt';
 *
 * const tools = createLangGraphTools({ apiKey: process.env.WAVE_AGENT_KEY });
 * const toolNode = new ToolNode(tools);
 * ```
 */
export function createLangGraphTools(config: { apiKey: string; baseUrl?: string }) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();

  return waveTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description },
        ])
      ),
      required: Object.entries(tool.parameters)
        .filter(([, val]) => val.required)
        .map(([key]) => key),
    },
    func: async (input: Record<string, unknown>): Promise<string> => {
      const result = await tool.handler(input);
      return JSON.stringify(result);
    },
  }));
}

/**
 * Create a WAVE stream monitoring graph node.
 *
 * Usage:
 * ```typescript
 * import { createStreamMonitorNode } from '@wave-av/adk/adapters/langgraph';
 * import { StateGraph } from '@langchain/langgraph';
 *
 * const graph = new StateGraph({ channels: { ... } })
 *   .addNode('monitor', createStreamMonitorNode({ streamId: 'stream_abc' }))
 *   .addEdge('__start__', 'monitor')
 *   .compile();
 * ```
 */
export function createStreamMonitorNode(config: {
  apiKey: string;
  streamId: string;
  baseUrl?: string;
}) {
  const toolkit = new AgentToolkit({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  return async (state: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tools = toolkit.getTools();
    const monitorTool = tools.find((t) => t.name === 'monitor_stream');

    if (!monitorTool) {
      return { ...state, error: 'monitor_stream tool not found' };
    }

    const health = await monitorTool.handler({ streamId: config.streamId });
    return { ...state, streamHealth: health, streamId: config.streamId };
  };
}

/**
 * Create a WAVE clip creation graph node.
 *
 * Usage:
 * ```typescript
 * const graph = new StateGraph({ channels: { ... } })
 *   .addNode('clip', createClipNode({ apiKey: key }))
 *   .compile();
 * ```
 */
export function createClipNode(config: {
  apiKey: string;
  baseUrl?: string;
}) {
  const toolkit = new AgentToolkit({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  return async (state: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tools = toolkit.getTools();
    const clipTool = tools.find((t) => t.name === 'create_clip');

    if (!clipTool) {
      return { ...state, error: 'create_clip tool not found' };
    }

    const clip = await clipTool.handler({
      streamId: state.streamId as string,
      startTime: state.clipStart as number,
      endTime: state.clipEnd as number,
    });

    return { ...state, clip };
  };
}
