/**
 * WaveToolError — the one error type every ADK network call throws.
 *
 * Every error names what happened, the gateway's own error code and request id
 * (so support can find the exact request), and how to fix it. Nothing here ever
 * carries the API key.
 */

/** Shape of a WAVE gateway error body: `{ "error": { code, message, request_id, ... } }`. */
interface GatewayErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly request_id?: unknown;
    readonly doc_url?: unknown;
  };
  readonly code?: unknown;
  readonly message?: unknown;
}

const HTTP_CODES: Record<number, { code: string; message: string; fix: string }> = {
  400: { code: 'WAVE_ERR_BAD_REQUEST', message: 'Invalid request parameters.', fix: 'Check the parameters match the operation schema in https://gateway.wave.online/openapi.json.' },
  401: { code: 'WAVE_ERR_UNAUTHORIZED', message: 'API key is missing, invalid or expired.', fix: 'Set WAVE_AGENT_KEY to a wave_live_* key minted in https://console.wave.online.' },
  402: { code: 'WAVE_ERR_PAYMENT_REQUIRED', message: 'This operation is priced and your organization cannot pay for it yet.', fix: 'Add a payment method or raise the spend cap in https://console.wave.online, or pay the x402 challenge.' },
  403: { code: 'WAVE_ERR_FORBIDDEN', message: 'Your API key lacks the scope this operation requires.', fix: 'Mint a key with the required scope (see https://gateway.wave.online/.well-known/wave-scopes.json) in https://console.wave.online.' },
  404: { code: 'WAVE_ERR_NOT_FOUND', message: 'The resource or route does not exist.', fix: 'Check the id. If gatewayCode is ROUTE_NOT_FOUND or ROUTE_NOT_MAPPED, the gateway does not serve this operation yet; see https://gateway.wave.online/.well-known/wave-skills.json.' },
  409: { code: 'WAVE_ERR_CONFLICT', message: 'Resource is already in the requested state.', fix: 'Read the current state before acting.' },
  429: { code: 'WAVE_ERR_RATE_LIMITED', message: 'Too many requests.', fix: 'Wait for the Retry-After period, then retry.' },
  500: { code: 'WAVE_ERR_SERVER', message: 'WAVE server error.', fix: 'Retry with backoff. If it persists, check https://wave.online/status and quote the requestId.' },
  502: { code: 'WAVE_ERR_UPSTREAM', message: 'WAVE upstream error.', fix: 'Retry with backoff. If it persists, check https://wave.online/status and quote the requestId.' },
  503: { code: 'WAVE_ERR_UNAVAILABLE', message: 'WAVE service temporarily unavailable.', fix: 'Retry with backoff. Check https://wave.online/status.' },
};

export class WaveToolError extends Error {
  /** Stable ADK error code, e.g. `WAVE_ERR_NOT_FOUND`, `WAVE_ERR_MISSING_API_KEY`. */
  readonly code: string;
  /** How to fix it. */
  readonly fix: string;
  /** HTTP status, when the error came from the gateway. */
  readonly status?: number;
  /** The gateway's own error code, e.g. `ROUTE_NOT_FOUND`, `SCOPE_INSUFFICIENT`. */
  readonly gatewayCode?: string;
  /** The gateway request id (body `request_id` or `x-request-id` header). Quote it to support. */
  readonly requestId?: string;
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    fix = '',
    extra: { status?: number; gatewayCode?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'WaveToolError';
    this.code = code;
    this.fix = fix;
    this.context = context;
    this.status = extra.status;
    this.gatewayCode = extra.gatewayCode;
    this.requestId = extra.requestId;
  }

  /**
   * Build an error from a non-2xx gateway response. The message keeps the
   * `WAVE API error: <status>` prefix earlier releases used, so existing
   * `message.includes(...)` checks keep working.
   */
  static fromApiResponse(
    status: number,
    body: string,
    operation: string,
    opts: { statusText?: string; requestIdHeader?: string | null; retryAfterHeader?: string | null } = {},
  ): WaveToolError {
    let parsed: GatewayErrorBody | undefined;
    try {
      parsed = JSON.parse(body) as GatewayErrorBody;
    } catch {
      parsed = undefined;
    }
    const inner = parsed?.error ?? parsed;
    const gatewayCode = typeof inner?.code === 'string' ? inner.code : undefined;
    const gatewayMessage = typeof inner?.message === 'string' ? inner.message : undefined;
    const bodyRequestId = typeof parsed?.error?.request_id === 'string' ? parsed.error.request_id : undefined;
    const requestId = bodyRequestId ?? opts.requestIdHeader ?? undefined;

    const info = HTTP_CODES[status] ?? {
      code: `WAVE_ERR_HTTP_${status}`,
      message: `WAVE API returned HTTP ${status}.`,
      fix: 'See https://docs.wave.online/docs/errors.',
    };

    const detail = [gatewayCode, gatewayMessage].filter(Boolean).join(': ');
    const message =
      `WAVE API error: ${status}${opts.statusText ? ` ${opts.statusText}` : ''} on ${operation}` +
      (detail ? ` (${detail})` : '') +
      (requestId ? ` [request_id ${requestId}]` : '') +
      ` — ${info.message} ${info.fix}`;

    const retryAfter = opts.retryAfterHeader ? Number(opts.retryAfterHeader) : undefined;

    return new WaveToolError(
      message,
      info.code,
      {
        status,
        operation,
        body: body.slice(0, 500),
        ...(retryAfter !== undefined && Number.isFinite(retryAfter) ? { retryAfter } : {}),
      },
      info.fix,
      { status, gatewayCode, requestId },
    );
  }
}

/**
 * Refuse to build a client without a usable key. Without this, a missing
 * `WAVE_AGENT_KEY` becomes the literal header `Authorization: Bearer undefined`
 * and every call dies with a confusing 401.
 */
export function assertApiKey(apiKey: unknown, where: string): string {
  if (typeof apiKey !== 'string' || apiKey.trim() === '' || apiKey === 'undefined' || apiKey === 'null') {
    throw new WaveToolError(
      `${where}: apiKey is required. Set WAVE_AGENT_KEY (a wave_live_* key) and pass it as { apiKey: process.env.WAVE_AGENT_KEY }.`,
      'WAVE_ERR_MISSING_API_KEY',
      { where },
      'Mint a key in https://console.wave.online and export it as WAVE_AGENT_KEY.',
    );
  }
  return apiKey;
}

/** Thrown when a method has no operation in the WAVE API contract to call. */
export function notInContract(method: string, suggestion: string): WaveToolError {
  return new WaveToolError(
    `${method} has no operation in the WAVE API contract (https://gateway.wave.online/openapi.json), so the ADK does not call an invented route. ${suggestion}`,
    'WAVE_ERR_NOT_IN_CONTRACT',
    { method },
    suggestion,
  );
}
