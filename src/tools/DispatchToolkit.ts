/**
 * DispatchToolkit — WAVE Dispatch model routing as agent tools.
 *
 * Dispatch is NOT behind the product gateway: it runs on its OWN host and takes a plain bearer, so
 * this toolkit defaults to `dispatch.wave.online` rather than the gateway front door. Mixing the two
 * base URLs is the easy mistake here — `api.wave.online` fronts the product spokes and the payment
 * rails; it does not front Dispatch.
 *
 * Paths come from wave-dispatch's own committed, resolver-verified facts:
 *
 *   POST /          classify a prompt → { route, decision }
 *   GET  /profiles  named routing profiles (Fast / Expert / Heavy / Code)
 *
 * `/profiles` is behind a server-side feature flag, so it can legitimately report as unavailable in a
 * given environment. That is surfaced to the caller as a `WaveToolError` rather than hidden behind an
 * empty list — an agent that silently gets `[]` cannot tell "no profiles" from "feature is off".
 */

import { z } from 'zod';
import {
  assertOk,
  toMCPToolDefs,
  validated,
  type AgentTool,
  type MCPToolDef,
} from './shared';

export interface DispatchToolkitConfig {
  /** WAVE API key. Read it from the environment — never hardcode it. */
  apiKey: string;
  /** Dispatch host. Defaults to production Dispatch, NOT the product gateway. */
  baseUrl?: string;
}

export class DispatchToolkit {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: DispatchToolkitConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://dispatch.wave.online';
  }

  private async call(tool: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    await assertOk(tool, response);
    return response.json();
  }

  /** Classify a prompt and get back the route Dispatch selected plus its reasoning. */
  async route(params: { prompt: string; profile?: string }): Promise<unknown> {
    const body: Record<string, unknown> = { prompt: params.prompt };
    if (params.profile) body.profile = params.profile;
    return this.call('wave_route', '/', body);
  }

  /** List the named routing profiles. Feature-flagged server-side. */
  async listProfiles(): Promise<unknown> {
    return this.call('wave_list_routing_profiles', '/profiles');
  }

  getTools(): AgentTool[] {
    const routeSchema = z.object({ prompt: z.string().min(1), profile: z.string().optional() });
    const profilesSchema = z.object({});

    return [
      {
        name: 'wave_route',
        description:
          'Classify a prompt with WAVE Dispatch and get back the model route it selected plus the ' +
          'reasoning behind that decision. Use this to pick the cheapest capable model for a task ' +
          'instead of hardcoding one.',
        parameters: {
          prompt: { type: 'string', description: 'The prompt to classify and route', required: true },
          profile: { type: 'string', description: 'Named routing profile to route under' },
        },
        schema: routeSchema,
        handler: validated(routeSchema, (params) =>
          this.route(params as { prompt: string; profile?: string }),
        ),
      },
      {
        name: 'wave_list_routing_profiles',
        description:
          "List WAVE Dispatch's named routing profiles (Fast / Expert / Heavy / Code chains). This is " +
          'feature-flagged server-side and may report as unavailable in some environments.',
        parameters: {},
        schema: profilesSchema,
        handler: validated(profilesSchema, () => this.listProfiles()),
      },
    ];
  }

  toMCPTools(): MCPToolDef[] {
    return toMCPToolDefs(this.getTools());
  }
}
