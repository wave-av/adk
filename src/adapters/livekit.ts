/**
 * LiveKit Agents Adapter for WAVE ADK
 *
 * Integrates WAVE video tools with LiveKit's real-time agent framework.
 * LiveKit Agents is best for real-time: WebRTC + LLM + tool calling
 * in a single native pipeline.
 *
 * @see docs/integration-research/agent-frameworks-2026-04-01.md
 */

import { AgentToolkit } from '../tools/AgentToolkit';
import { WaveToolError, assertApiKey } from '../errors';
import { DEFAULT_BASE_URL, waveRequest } from '../http';

/**
 * Create LiveKit Agent function tools from WAVE AgentToolkit.
 *
 * Usage with LiveKit Agents (Python):
 * ```python
 * from wave_adk.adapters.livekit import create_wave_tools
 *
 * @function_tool()
 * async def monitor_stream(stream_id: str) -> str:
 *     tools = create_wave_tools(api_key=os.environ["WAVE_AGENT_KEY"])
 *     health = await tools["wave_monitor_stream"](stream_id=stream_id)
 *     return json.dumps(health)
 * ```
 *
 * Usage with LiveKit Agents (TypeScript):
 * ```typescript
 * import { createLiveKitWaveTools } from '@wave-av/adk/adapters/livekit';
 *
 * const tools = createLiveKitWaveTools({ apiKey: process.env.WAVE_AGENT_KEY });
 * // Register with LiveKit VoicePipelineAgent
 * ```
 */
export function createLiveKitWaveTools(config: { apiKey: string; baseUrl?: string }) {
  const toolkit = new AgentToolkit(config);
  const waveTools = toolkit.getTools();

  // Convert to LiveKit function_tool format
  return waveTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description },
        ])
      ),
      required: Object.entries(tool.parameters)
        .filter(([_, v]) => v.required)
        .map(([k]) => k),
    },
    handler: tool.handler,
  }));
}

/**
 * WAVE stream source for LiveKit room.
 *
 * Bridges a WAVE stream into a LiveKit room as a track,
 * enabling AI agents to process video/audio in real-time.
 */
export function createWaveStreamSource(config: {
  streamId: string;
  apiKey: string;
  baseUrl?: string;
}) {
  const apiKey = assertApiKey(config.apiKey, 'createWaveStreamSource');
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  return {
    type: 'wave_stream' as const,
    streamId: config.streamId,
    /** The stream's playback URL, from `GET /v1/streams/{streamId}` (contract: getStream). */
    getPlaybackUrl: async (): Promise<string> => {
      const stream = await waveRequest<{ playback_url?: string | null }>(baseUrl, apiKey, 'getStream', {
        params: { streamId: config.streamId },
      });
      if (!stream?.playback_url) {
        throw new WaveToolError(
          `Stream ${config.streamId} has no playback_url yet.`,
          'WAVE_ERR_NO_PLAYBACK_URL',
          { streamId: config.streamId },
          'Start the stream first; playback_url is set once it has been live.',
        );
      }
      return stream.playback_url;
    },
  };
}
