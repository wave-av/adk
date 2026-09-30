#!/usr/bin/env node
/**
 * Refresh contract/openapi-operations.json from the live WAVE OpenAPI.
 *
 *   npm run contract:sync            # writes the snapshot
 *   npm run contract:sync -- --check # exits 1 if the snapshot is stale
 *
 * The snapshot keeps only what the contract test needs (method, full /v1 path,
 * operationId), so a spec refresh is a small, reviewable diff.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPEC_URL = process.env.WAVE_OPENAPI_URL ?? 'https://gateway.wave.online/openapi.json';
const OUT = fileURLToPath(new URL('../contract/openapi-operations.json', import.meta.url));

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
      operations.push({ method: method.toUpperCase(), path: `${server}${path}`, operationId: op.operationId ?? null });
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
