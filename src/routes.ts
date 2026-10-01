/**
 * The WAVE API routes the ADK calls — every one, in one table.
 *
 * Each entry is bound to an operation in the live OpenAPI contract
 * (https://gateway.wave.online/openapi.json, servers[0] = https://api.wave.online/v1).
 * Nothing in the ADK builds a WAVE URL any other way, and
 * `src/__tests__/contract.test.ts` fails if an entry is missing from the
 * vendored contract snapshot (`contract/openapi-operations.json`) or if any
 * tool/template sends a request that does not match an entry here.
 * `scripts/live-contract.mjs` re-checks the table against the LIVE spec and
 * reports which routes the gateway actually serves.
 *
 * `io: 'undeclared'` marks capability routes whose request body the contract
 * does not declare yet (the capability index lists them with `io: null`); the
 * ADK sends its own fields plus an `action` discriminator until it does.
 */

import { WaveToolError } from './errors';

export interface WaveRoute {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Full gateway path template, including the `/v1` server prefix. */
  readonly path: string;
  /** operationId (or capability name) in the OpenAPI contract. */
  readonly operation: string;
  /** Scope the gateway enforces, when the contract declares one. */
  readonly scope?: string;
  readonly io: 'declared' | 'undeclared';
}

export const WAVE_ROUTES = {
  createStream: { method: 'POST', path: '/v1/streams', operation: 'createStream', io: 'declared' },
  getStreamStatus: { method: 'GET', path: '/v1/streams/{streamId}/status', operation: 'getStreamStatus', io: 'declared' },
  getStreamAnalytics: { method: 'GET', path: '/v1/streams/{streamId}/analytics', operation: 'getStreamAnalytics', io: 'declared' },
  getStream: { method: 'GET', path: '/v1/streams/{streamId}', operation: 'getStream', io: 'declared' },
  startStream: { method: 'POST', path: '/v1/streams/{streamId}/start', operation: 'startStream', io: 'declared' },
  markStreamHighlight: { method: 'POST', path: '/v1/streams/{streamId}/highlights', operation: 'markStreamHighlight', io: 'declared' },
  createClip: { method: 'POST', path: '/v1/clips', operation: 'createClip', io: 'declared' },
  createCaptionJob: { method: 'POST', path: '/v1/captions', operation: 'createCaptionJob', io: 'declared' },
  downloadCaptions: { method: 'GET', path: '/v1/captions/{jobId}/download', operation: 'downloadCaptions', io: 'declared' },
  moderateContent: { method: 'POST', path: '/v1/moderate', operation: 'moderateContent', io: 'declared' },
  controlCamera: { method: 'POST', path: '/v1/cameras/{cameraId}/control', operation: 'controlCamera', io: 'declared' },
  switcher: { method: 'POST', path: '/v1/switcher', operation: 'switcher', scope: 'switcher:write', io: 'undeclared' },
  graphicsEngine: { method: 'POST', path: '/v1/graphics-engine', operation: 'graphicsEngine', scope: 'graphics-engine:write', io: 'undeclared' },
  replay: { method: 'POST', path: '/v1/replay', operation: 'replay', scope: 'replay:write', io: 'undeclared' },
  ghostProducer: { method: 'POST', path: '/v1/ghost-producer', operation: 'ghostProducer', scope: 'ghost-producer:write', io: 'undeclared' },
  agents: { method: 'POST', path: '/v1/agents', operation: 'agents', scope: 'agents:write', io: 'undeclared' },
} as const satisfies Record<string, WaveRoute>;

export type WaveRouteName = keyof typeof WAVE_ROUTES;

/**
 * Fill a route's `{param}` placeholders. Every value is URL-encoded and dot
 * segments are refused, so an id can never add or remove path segments or add
 * a query string to the request.
 */
export function buildPath(
  path: string,
  params: Record<string, string | number | undefined> = {},
  query: Record<string, string | undefined> = {},
): string {
  const filled = path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      // A typed validation error, so callers do not mistake it for a network
      // failure and retry; no request is sent.
      throw new WaveToolError(
        `Missing path parameter "${name}" for ${path}. No request was sent.`,
        'WAVE_ERR_VALIDATION',
        { field: name, path },
        `Pass a non-empty ${name} (check that the environment variable holding it is set).`,
      );
    }
    const text = String(value);
    // encodeURIComponent leaves "." and ".." as they are, and URL parsing
    // resolves them as dot segments: /v1/streams/../status would be sent to
    // /v1/status with the same key. No real WAVE id is a dot segment.
    if (text === '.' || text === '..') {
      throw new WaveToolError(
        `Path parameter "${name}" cannot be "${text}" for ${path}. No request was sent.`,
        'WAVE_ERR_VALIDATION',
        { field: name, path },
        `Pass the real ${name}; "." and ".." would change which route the request reaches.`,
      );
    }
    return encodeURIComponent(text);
  });
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') qs.set(key, value);
  }
  const search = qs.toString();
  return search ? `${filled}?${search}` : filled;
}
