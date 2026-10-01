/**
 * The single request path for every WAVE API call the ADK makes.
 *
 * Resolves a named route from WAVE_ROUTES, sends `Authorization: Bearer <key>`,
 * and turns any non-2xx answer into a WaveToolError carrying the gateway's
 * error code and request id. A gateway error is never returned as a result.
 */

import { WaveToolError } from './errors';
import { WAVE_ROUTES, buildPath, type WaveRouteName } from './routes';

export const DEFAULT_BASE_URL = 'https://api.wave.online';

export interface WaveRequest {
  readonly params?: Record<string, string | number | undefined>;
  readonly query?: Record<string, string | undefined>;
  readonly body?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

/** Call a named route from the WAVE API contract (src/routes.ts). */
export function waveRequest<T = unknown>(
  baseUrl: string,
  apiKey: string,
  routeName: WaveRouteName,
  req: WaveRequest = {},
): Promise<T> {
  const route = WAVE_ROUTES[routeName];
  return waveFetch<T>(baseUrl, apiKey, route.method, buildPath(route.path, req.params, req.query), {
    body: req.body,
    headers: req.headers,
    operation: `${route.method} ${route.path}`,
  });
}

/**
 * Low-level fetch against the WAVE gateway. The ADK itself only reaches this
 * through `waveRequest`; it is exported for subclasses that call a raw path.
 */
export async function waveFetch<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: string,
  pathWithQuery: string,
  opts: { body?: Record<string, unknown>; headers?: Record<string, string>; operation?: string } = {},
): Promise<T> {
  const operation = opts.operation ?? `${method} ${pathWithQuery.split('?')[0]}`;
  const sendBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD';

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${pathWithQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: sendBody ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw WaveToolError.fromApiResponse(response.status, text, operation, {
      statusText: response.statusText,
      requestIdHeader: response.headers?.get?.('x-request-id') ?? null,
      retryAfterHeader: response.headers?.get?.('retry-after') ?? null,
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WaveToolError(
      `WAVE API returned a non-JSON 2xx body on ${operation}.`,
      'WAVE_ERR_BAD_RESPONSE',
      { operation, body: text.slice(0, 500) },
      'Retry; if it persists, report it with the operation name.',
    );
  }
}
