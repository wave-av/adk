/**
 * PaymentsToolkit — WAVE's agent-payment rails (x402 and MPP) as agent tools.
 *
 * These gateway routes are PUBLIC BY DESIGN: the gateway serves them with no key auth, only a per-IP
 * rate limit, because a paying agent has to discover what it can buy and which payment schemes are
 * supported BEFORE it holds a WAVE key.
 *
 *   GET /v1/mpp/services                 semantic search over WAVE's MPP service records
 *   GET /v1/x402/facilitator/supported   payment schemes/networks the x402 facilitator supports
 *   GET /v1/mpp/facilitator/supported    the same, for MPP
 *
 * This class takes NO API KEY — not an optional one, none at all. Sending a credential to an endpoint
 * that does not authenticate it leaks the credential for zero benefit, and the surest way to never do
 * that is to have nothing to send.
 *
 * Only the READ half of the rails is exposed. The facilitator's `verify` and `settle` endpoints are
 * the money-moving side and are deliberately NOT wrapped as agent tools.
 */

import { z } from 'zod';
import {
  assertOk,
  toMCPToolDefs,
  validated,
  type AgentTool,
  type MCPToolDef,
} from './shared';

export interface PaymentsToolkitConfig {
  /** Gateway front door. Defaults to the production gateway. */
  baseUrl?: string;
}

export class PaymentsToolkit {
  private readonly baseUrl: string;

  constructor(config: PaymentsToolkitConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'https://api.wave.online';
  }

  /** Unauthenticated GET against the gateway's public plane. No Authorization header, on purpose. */
  private async publicGet(tool: string, path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`);
    await assertOk(tool, response);
    return response.json();
  }

  /** Search the MPP service directory for machine-payable services. */
  async findPaidServices(params: {
    q: string;
    protocol?: string;
    tag?: string;
    topK?: number;
  }): Promise<unknown> {
    const p = new URLSearchParams({ q: params.q });
    if (params.protocol) p.set('protocol', params.protocol);
    if (params.tag) p.set('tag', params.tag);
    if (params.topK !== undefined) p.set('topK', String(params.topK));
    return this.publicGet('wave_find_paid_services', `/v1/mpp/services?${p.toString()}`);
  }

  /** List the payment schemes and networks WAVE's facilitator supports for a rail. */
  async paymentSchemes(params: { rail: 'x402' | 'mpp' }): Promise<unknown> {
    return this.publicGet('wave_payment_schemes', `/v1/${params.rail}/facilitator/supported`);
  }

  getTools(): AgentTool[] {
    const findSchema = z.object({
      q: z.string().min(1),
      protocol: z.string().optional(),
      tag: z.string().optional(),
      topK: z.number().int().positive().max(50).optional(),
    });
    const schemesSchema = z.object({ rail: z.enum(['x402', 'mpp']) });

    return [
      {
        name: 'wave_find_paid_services',
        description:
          "Search WAVE's MPP service directory for machine-payable services an agent can buy from. " +
          'Semantic search — describe what you need in plain language. Public: no API key required.',
        parameters: {
          q: { type: 'string', description: "What you're looking for, in plain language", required: true },
          protocol: { type: 'string', description: "Filter by payment protocol, e.g. 'x402'" },
          tag: { type: 'string', description: 'Filter by service tag' },
          topK: { type: 'number', description: 'How many results to return (max 50)' },
        },
        schema: findSchema,
        handler: validated(findSchema, (params) =>
          this.findPaidServices(params as { q: string; protocol?: string; tag?: string; topK?: number }),
        ),
      },
      {
        name: 'wave_payment_schemes',
        description:
          "List the payment schemes and networks WAVE's facilitator supports, for x402 or MPP. Call " +
          'this before constructing a payment so you settle on a scheme WAVE actually accepts. ' +
          'Public: no API key required.',
        parameters: {
          rail: { type: 'string', description: 'Which payment rail to query: x402 or mpp', required: true },
        },
        schema: schemesSchema,
        handler: validated(schemesSchema, (params) =>
          this.paymentSchemes(params as { rail: 'x402' | 'mpp' }),
        ),
      },
    ];
  }

  toMCPTools(): MCPToolDef[] {
    return toMCPToolDefs(this.getTools());
  }
}
