/**
 * Shared plumbing for the ADK toolkits.
 *
 * `AgentTool` and the MCP-shape mapping live here (rather than inside `AgentToolkit`) so every
 * toolkit in this directory produces the SAME tool shape and the SAME MCP definitions. Behaviour is
 * unchanged for existing consumers: `AgentToolkit` re-exports `AgentTool` from here, so
 * `import { type AgentTool } from '@wave-av/adk'` resolves exactly as before.
 */

import { z } from 'zod';

/** A single agent-invocable tool. `parameters` is the human/MCP-facing description of the inputs;
 *  `schema` is the zod contract actually enforced at call time. They are kept side by side because
 *  MCP clients need a JSON-Schema-ish shape while the handler needs real validation. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, { type: string; description: string; required?: boolean }>;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/** An MCP tool definition, as consumed by Claude / Cursor / any MCP client. */
export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Thrown when a WAVE endpoint answers with a non-2xx status.
 *
 * The raw response body is preserved verbatim on `.body` rather than being summarised away: WAVE's
 * gateway and spokes return structured, actionable error bodies (`{"error":"discovery_unavailable",
 * "reason":"vectorize_unbound"}`), and swallowing them is how a real production gap goes unnoticed.
 * These bodies are gateway-authored and carry no credential material.
 */
export class WaveToolError extends Error {
  readonly status: number;
  readonly body: string;
  readonly tool: string;

  constructor(tool: string, status: number, body: string) {
    super(`${tool} failed: HTTP ${status}${body ? ` — ${body.slice(0, 500)}` : ''}`);
    this.name = 'WaveToolError';
    this.tool = tool;
    this.status = status;
    this.body = body;
  }

  /** A 429 is the one status a caller is expected to back off on rather than treat as fatal
   *  (`.wave-rules/require-rate-limit-awareness.md`). */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Metering + rate-limit facts every WAVE response carries. Surfaced on results so an agent can see
 *  what a call cost and how much headroom it has left, instead of discovering both from an invoice. */
export interface WaveUsage {
  /** The billing meter the spoke reported, e.g. `wave_voice_minutes`. */
  readonly meter: string | null;
  /** Billable minutes for this call, if the spoke reported them. */
  readonly usageMinutes: number | null;
  /** Remaining calls in the current rate-limit window, if the gateway reported it. */
  readonly rateLimitRemaining: number | null;
}

/** Read the usage/rate-limit headers off a response. Absent headers become `null` — never `0`,
 *  which would falsely read as "no quota left". */
export function readUsage(response: Response): WaveUsage {
  const minutes = response.headers.get('x-wave-usage-minutes');
  const remaining = response.headers.get('x-ratelimit-remaining');
  return {
    meter: response.headers.get('x-wave-meter'),
    usageMinutes: minutes === null ? null : Number(minutes),
    rateLimitRemaining: remaining === null ? null : Number(remaining),
  };
}

/** Wrap a handler so its params are zod-validated before the network call is made. */
export function validated(
  schema: z.ZodObject<z.ZodRawShape>,
  handler: (params: Record<string, unknown>) => Promise<unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async (params: Record<string, unknown>) => {
    const parsed = schema.parse(params);
    return handler(parsed as Record<string, unknown>);
  };
}

/** Map `AgentTool[]` to MCP tool definitions. */
export function toMCPToolDefs(tools: readonly AgentTool[]): MCPToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters).map(([key, val]) => [
          key,
          { type: val.type, description: val.description },
        ]),
      ),
      required: Object.entries(tool.parameters)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

/** Throw `WaveToolError` unless the response is 2xx. Reads the body once, so callers must not read
 *  it again on the failure path. */
export async function assertOk(tool: string, response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => '');
  throw new WaveToolError(tool, response.status, body);
}
