#!/usr/bin/env node
/**
 * Refresh contract/openapi-operations.json from the live WAVE OpenAPI.
 *
 *   npm run contract:sync            # writes the snapshot
 *   npm run contract:sync -- --check # exits 1 if the snapshot is stale
 *
 * The snapshot keeps only what the contract test needs (method, full /v1 path,
 * operationId, and for a JSON request body its top-level property names and
 * required names), so a spec refresh is a small, reviewable diff.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPEC_URL = process.env.WAVE_OPENAPI_URL ?? 'https://gateway.wave.online/openapi.json';
const OUT = fileURLToPath(new URL('../contract/openapi-operations.json', import.meta.url));

/** Resolve a local `#/...` $ref (one hop at a time) inside the spec. */
function deref(spec, schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 10) return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key], spec);
    return deref(spec, target, depth + 1);
  }
  return schema;
}

/**
 * Top-level shape of an operation's JSON request body: property names, required
 * names, and whether other properties are allowed. `null` when the operation
 * declares no JSON body. A oneOf/anyOf body is recorded as `open` (the test
 * then checks only that a body is sent).
 */
export function bodyShape(spec, op) {
  const schema = deref(spec, op.requestBody?.content?.['application/json']?.schema);
  if (!schema || typeof schema !== 'object') return null;
  const parts = Array.isArray(schema.allOf) ? schema.allOf.map((s) => deref(spec, s)) : [schema];
  if (parts.some((p) => p?.oneOf || p?.anyOf)) return { open: true };
  const properties = new Set();
  const required = new Set();
  let additional = false;
  for (const part of parts) {
    for (const name of Object.keys(part?.properties ?? {})) properties.add(name);
    for (const name of part?.required ?? []) required.add(name);
    if (part?.additionalProperties !== undefined && part.additionalProperties !== false) additional = true;
  }
  return { properties: [...properties].sort(), required: [...required].sort(), ...(additional ? { additional: true } : {}) };
}

export async function fetchOperations(url = SPEC_URL) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const spec = await res.json();
  const server = new URL(spec.servers?.[0]?.url ?? 'https://api.wave.online/v1').pathname.replace(/\/$/, '');
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const body = bodyShape(spec, op);
      operations.push({
        method: method.toUpperCase(),
        path: `${server}${path}`,
        operationId: op.operationId ?? null,
        ...(body ? { body } : {}),
      });
    }
  }
  operations.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return { source: url, specVersion: spec.info?.version ?? null, operations };
}

/** One operation per line, so a spec refresh diffs line-by-line. */
export function formatSnapshot(snapshot) {
  const ops = snapshot.operations.map((o) => `    ${JSON.stringify(o)}`).join(',\n');
  return `{\n  "source": ${JSON.stringify(snapshot.source)},\n  "specVersion": ${JSON.stringify(snapshot.specVersion)},\n  "operations": [\n${ops}\n  ]\n}\n`;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const snapshot = await fetchOperations();
  const body = formatSnapshot(snapshot);
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== body) {
      console.error('contract/openapi-operations.json is stale: run `npm run contract:sync` and review the diff.');
      process.exit(1);
    }
    console.log(`snapshot current (spec ${snapshot.specVersion}, ${snapshot.operations.length} operations)`);
  } else {
    writeFileSync(OUT, body);
    console.log(`wrote ${OUT} (spec ${snapshot.specVersion}, ${snapshot.operations.length} operations)`);
  }
}
