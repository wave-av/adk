/**
 * Kernel.sh Adapter for WAVE ADK
 *
 * Provides cloud browser capabilities to WAVE agents via Kernel.sh:
 * - Screenshot live stream players for visual QA
 * - Interact with third-party dashboards (Mux, Cloudflare)
 * - Run visual regression on embedded players
 * - Scrape competitor streaming pages for intelligence
 *
 * Kernel provides managed cloud browsers (unikernel-based)
 * with Playwright API, session persistence, and file I/O.
 *
 * @see https://docs.onkernel.com
 */

import { z } from 'zod';
import type { AgentTool } from '../tools/AgentToolkit';

export interface KernelConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/**
 * Create WAVE ADK tools backed by Kernel.sh cloud browsers.
 *
 * Usage:
 * ```typescript
 * import { createKernelTools } from '@wave-av/adk/adapters/kernel';
 * import { AgentToolkit } from '@wave-av/adk';
 *
 * const kernelTools = createKernelTools({ apiKey: process.env.KERNEL_API_KEY });
 * // Add to existing toolkit or use standalone
 * ```
 */
export function createKernelTools(config: KernelConfig): AgentTool[] {
  const baseUrl = config.baseUrl ?? 'https://api.onkernel.com';

  async function kernelFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Kernel API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  const browseSchema = z.object({ url: z.string().url(), waitForSelector: z.string().optional(), timeoutMs: z.number().optional() });
  const screenshotSchema = z.object({ url: z.string().url(), selector: z.string().optional(), width: z.number().optional(), height: z.number().optional() });
  const playwrightSchema = z.object({ code: z.string().min(1), url: z.string().url().optional() });

  return [
    {
      name: 'browse_url',
      description: 'Navigate a cloud browser to a URL and return the page content/snapshot. Uses Kernel.sh managed browsers — no local browser needed.',
      parameters: {
        url: { type: 'string', description: 'URL to navigate to', required: true },
        waitForSelector: { type: 'string', description: 'CSS selector to wait for before capturing', required: false },
        timeoutMs: { type: 'number', description: 'Navigation timeout in milliseconds', required: false },
      },
      schema: browseSchema,
      handler: async (params: Record<string, unknown>) => {
        const result = await kernelFetch<{ browserId: string; content: string; title: string }>('/v1/browsers/navigate', {
          url: params.url,
          waitForSelector: params.waitForSelector,
          timeout: params.timeoutMs ?? 30_000,
        });
        return result;
      },
    },
    {
      name: 'take_screenshot',
      description: 'Take a screenshot of a URL using a cloud browser. Returns base64-encoded PNG. Useful for visual QA of live stream players.',
      parameters: {
        url: { type: 'string', description: 'URL to screenshot', required: true },
        selector: { type: 'string', description: 'CSS selector to screenshot (optional, defaults to full page)', required: false },
        width: { type: 'number', description: 'Viewport width in pixels', required: false },
        height: { type: 'number', description: 'Viewport height in pixels', required: false },
      },
      schema: screenshotSchema,
      handler: async (params: Record<string, unknown>) => {
        const result = await kernelFetch<{ screenshotBase64: string; width: number; height: number }>('/v1/browsers/screenshot', {
          url: params.url,
          selector: params.selector,
          viewport: {
            width: params.width ?? 1920,
            height: params.height ?? 1080,
          },
        });
        return result;
      },
    },
    {
      name: 'run_playwright',
      description: 'Execute Playwright code in a Kernel.sh cloud browser. For complex browser automation like testing embed players or monitoring dashboards.',
      parameters: {
        code: { type: 'string', description: 'Playwright JavaScript code to execute', required: true },
        url: { type: 'string', description: 'Starting URL (optional)', required: false },
      },
      schema: playwrightSchema,
      handler: async (params: Record<string, unknown>) => {
        const result = await kernelFetch<{ output: string; logs: string[] }>('/v1/browsers/execute', {
          code: params.code,
          url: params.url,
        });
        return result;
      },
    },
  ];
}
