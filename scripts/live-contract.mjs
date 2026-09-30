#!/usr/bin/env node
/**
 * Live contract smoke: run the ADK's own code against the live WAVE gateway and
 * report, route by route, what the gateway actually serves. READ-ONLY.
 *
 *   WAVE_AGENT_KEY=wave_live_... npm run contract:live            # report; fail on client defects
 *   WAVE_AGENT_KEY=wave_live_... npm run contract:live -- --strict # also fail if any ADK route is unserved
 *
 * Every request goes through a hard guard that throws on any method but GET,
 * so this script can never create, start, charge or change anything. POST
 * routes are classified by an authenticated GET to the same path, next to a
 * made-up sibling path: a 402 or 403 that a made-up path also gets comes from
 * a prefix rule and proves nothing (a 402 proves a route is priced, not served).
 *
 * Client defects (exit 1 in every mode):
 *   - a control that must answer 200 does not (network/surface, x402 facilitator)
 *   - the key is refused on the authenticated control (GET /v1/billing/usage)
 *   - an ADK route is missing from the live OpenAPI contract
 *   - an ADK GET tool resolves a gateway error body as a result (wave-av/adk#62)
 *     or throws anything other than a WaveToolError with the gateway request id
 *
 * The key is read from WAVE_AGENT_KEY (or WAVE_API_KEY) and is never printed.
 * Use a customer key; never an internal gateway key.
 */

const BASE = (process.env.WAVE_BASE_URL ?? 'https://api.wave.online').replace(/\/+$/, '');
const SPEC_URL = process.env.WAVE_OPENAPI_URL ?? 'https://gateway.wave.online/openapi.json';
const STRICT = process.argv.includes('--strict');
const API_KEY = process.env.WAVE_AGENT_KEY || process.env.WAVE_API_KEY || '';
const PROBE_ID = '00000000-0000-4000-8000-000000000000';

// ---- hard GET-only guard, installed before the ADK is loaded ---------------
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET') {
    return Promise.reject(new Error(`live-contract GET-only guard blocked ${method} ${String(input)}`));
  }
  return realFetch(input, init);
};

if (!API_KEY) {
  console.error('live-contract: set WAVE_AGENT_KEY (a customer wave_live_* key). Nothing was sent.');
  process.exit(2);
}

const { AgentToolkit, WaveToolError, WAVE_ROUTES, createWaveStreamSource } = await import('@wave-av/adk');

const defects = [];
const rows = [];
const auth = { authorization: `Bearer ${API_KEY}` };

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json', ...headers } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const code = body?.error?.code ?? body?.code ?? (typeof body?.error === 'string' ? body.error : undefined);
  return { status: res.status, body, code, requestId: body?.error?.request_id ?? res.headers.get('x-request-id') ?? undefined };
}

// ---- 1. controls -----------------------------------------------------------
const controls = [
  { path: '/v1/network/surface', headers: {}, marker: 'product' },
  { path: '/v1/x402/facilitator/supported', headers: {}, marker: 'schemes' },
  { path: '/v1/billing/usage', headers: auth, marker: 'organizationId' },
];
for (const c of controls) {
  const r = await get(c.path, c.headers);
  const ok = r.status === 200 && r.body && c.marker in r.body;
  console.log(`${ok ? 'ok  ' : 'FAIL'} control GET ${c.path} -> ${r.status} ${ok ? `(has ${c.marker})` : r.code ?? ''} rid=${r.requestId ?? ''}`);
  if (!ok) defects.push(`control GET ${c.path} answered ${r.status} ${r.code ?? ''}`);
}

// ---- 2. every ADK route is in the live contract ------------------------------
const spec = await (await realFetch(SPEC_URL, { headers: { accept: 'application/json' } })).json();
const prefix = new URL(spec.servers?.[0]?.url ?? `${BASE}/v1`).pathname.replace(/\/$/, '');
const specOps = new Map();
for (const [p, item] of Object.entries(spec.paths ?? {})) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    if (item[m]) specOps.set(`${m.toUpperCase()} ${prefix}${p}`, item[m]);
  }
}
for (const [name, route] of Object.entries(WAVE_ROUTES)) {
  const op = specOps.get(`${route.method} ${route.path}`);
  if (!op) defects.push(`route ${name} (${route.method} ${route.path}) is not in the live contract ${SPEC_URL} v${spec.info?.version}`);
}

// ---- 3. drive the ADK's own GET code paths -----------------------------------
const toolkit = new AgentToolkit({ apiKey: API_KEY, baseUrl: BASE });
const getCases = [
  ['wave_monitor_stream', () => toolkit.findTool('wave_monitor_stream').handler({ streamId: PROBE_ID })],
  ['wave_analyze_quality', () => toolkit.findTool('wave_analyze_quality').handler({ streamId: PROBE_ID, timeRange: '1h' })],
  ['livekit getPlaybackUrl', () => createWaveStreamSource({ apiKey: API_KEY, baseUrl: BASE, streamId: PROBE_ID }).getPlaybackUrl()],
];
for (const [label, run] of getCases) {
  try {
    const result = await run();
    if (result && typeof result === 'object' && 'error' in result) {
      defects.push(`${label} resolved a gateway error body as a result: ${JSON.stringify(result).slice(0, 200)}`);
      console.log(`FAIL adk  ${label}: resolved an error body (wave-av/adk#62 regression)`);
    } else {
      console.log(`ok   adk  ${label}: resolved ${JSON.stringify(result).slice(0, 80)}`);
    }
  } catch (err) {
    const typed = err instanceof WaveToolError;
    if (!typed || !err.status) {
      defects.push(`${label} threw ${err?.name ?? typeof err}: ${String(err?.message).slice(0, 200)}`);
      console.log(`FAIL adk  ${label}: ${err?.name} ${String(err?.message).slice(0, 160)}`);
    } else if (err.status === 401) {
      defects.push(`${label}: gateway refused the key (401 ${err.gatewayCode ?? ''}), so the client's auth is wrong`);
      console.log(`FAIL adk  ${label}: 401 ${err.gatewayCode ?? ''} rid=${err.requestId ?? ''}`);
    } else {
      console.log(`ok   adk  ${label}: threw WaveToolError ${err.status} ${err.gatewayCode ?? ''} rid=${err.requestId ?? ''}`);
    }
  }
}

// ---- 4. classify every ADK route --------------------------------------------
const UNSERVED = new Set(['ROUTE_NOT_FOUND', 'ROUTE_NOT_MAPPED']);
for (const [name, route] of Object.entries(WAVE_ROUTES)) {
  const concrete = route.path.replace(/\{[^}]+\}/g, PROBE_ID);
  const r = await get(concrete, auth);
  const segment = route.path.split('/')[2];
  const bogus = await get(`/v1/${segment}/zz-adk-bogus-probe/not/a/route`, auth);
  let verdict;
  if (UNSERVED.has(r.code)) verdict = 'UNSERVED';
  else if (r.status === 401) verdict = 'AUTH-REFUSED';
  else if ((r.status === 402 || r.status === 403) && bogus.status === r.status && bogus.code === r.code) verdict = 'PREFIX-GATED (not proof)';
  else if (r.status === 402) verdict = 'PRICED (not proof)';
  else if (r.status === 403) verdict = `SCOPE-GATED${route.scope ? ` (${route.scope})` : ''}`;
  else if (r.status < 500) verdict = 'SERVED';
  else verdict = 'INDETERMINATE';
  rows.push({ name, route: `${route.method} ${route.path}`, probe: `GET ${concrete}`, status: r.status, code: r.code ?? '', verdict, requestId: r.requestId ?? '' });
}

console.log('\nADK route                       status code                     verdict');
for (const row of rows) {
  console.log(`${row.name.padEnd(31)} ${String(row.status).padEnd(6)} ${String(row.code).padEnd(24)} ${row.verdict}  rid=${row.requestId}`);
}
const served = rows.filter((r) => r.verdict === 'SERVED').length;
const unserved = rows.filter((r) => r.verdict === 'UNSERVED');
console.log(`\n${served}/${rows.length} ADK routes proven served; ${unserved.length} unserved by the gateway (server-side: the contract advertises them).`);

if (defects.length) {
  console.error(`\nlive-contract: ${defects.length} client defect(s):\n - ${defects.join('\n - ')}`);
  process.exit(1);
}
if (STRICT && served !== rows.length) {
  console.error(`\nlive-contract --strict: ${rows.length - served} ADK route(s) not proven served.`);
  process.exit(1);
}
console.log('\nlive-contract: no client defects.');
