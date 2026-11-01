import { vi } from 'vitest';

export interface RecordedCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch stub that records every request and answers from `respond`. */
export function stubFetch(
  respond: (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> } = () => ({ body: {} }),
) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    const call: RecordedCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    const status = r.status ?? 200;
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json', ...r.headers } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** The exact 404 the live gateway returns for an unserved path (captured 2026-09-30). */
export const ROUTE_NOT_FOUND_BODY = {
  error: {
    code: 'ROUTE_NOT_FOUND',
    message: 'No WAVE capability is served at this path.',
    doc_url: 'https://gateway.wave.online/.well-known/wave-skills.json',
    request_id: 'fb990d81-2114-4602-8b30-5ad12ff00a5b',
  },
};
