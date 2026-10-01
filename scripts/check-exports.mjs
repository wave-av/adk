#!/usr/bin/env node
/**
 * Prove every entry in package.json "exports" resolves, in BOTH module systems,
 * and that the package's own README quick-start imports work.
 *
 * Usage:
 *   node scripts/check-exports.mjs            # in this repo after `npm run build` (package self-reference)
 *   node <repo>/scripts/check-exports.mjs     # with cwd = a consumer project that installed the tarball
 *
 * 1.0.15 shipped with only "." built, so `import '@wave-av/adk/tools'` threw
 * ERR_PACKAGE_PATH_NOT_EXPORTED for every customer following the README. This
 * script is the gate that makes that regression impossible to publish again.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '@wave-av/adk';
const cwd = process.cwd();
const require = createRequire(join(cwd, 'noop.js'));

const pkgPath = require.resolve(`${NAME}/package.json`);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const subpaths = Object.keys(pkg.exports).filter((k) => k !== './package.json');

// Minimum named exports each subpath must provide (what README/docs import).
const EXPECT = {
  '.': ['AgentToolkit', 'WaveToolError', 'StreamMonitorAgent', 'AgentRuntime', 'createMastraTools', 'WAVE_ROUTES'],
  './tools': ['AgentToolkit', 'WaveToolError'],
  './agents': ['WaveAgent', 'AgentRuntime', 'AgentLogger'],
  './adapters': ['createMastraTools', 'createLangGraphTools', 'createLiveKitWaveTools', 'createKernelTools'],
  './adapters/mastra': ['createMastraTools', 'createWaveMCPConfig', 'createStreamMonitorStep'],
  './adapters/langgraph': ['createLangGraphTools', 'createStreamMonitorNode', 'createClipNode'],
  './adapters/livekit': ['createLiveKitWaveTools', 'createWaveStreamSource'],
  './adapters/kernel': ['createKernelTools'],
  './templates': ['StreamMonitorAgent', 'AutoProducerAgent', 'ClipFactoryAgent', 'ModerationAgent', 'CaptionAgent'],
  './types': [],
};

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

for (const sub of subpaths) {
  const spec = sub === '.' ? NAME : `${NAME}/${sub.slice(2)}`;
  const want = EXPECT[sub] ?? [];
  if (!(sub in EXPECT)) fail(`${sub}: no expectation declared in check-exports.mjs`);
  for (const mode of ['esm', 'cjs']) {
    try {
      const mod = mode === 'esm' ? await import(spec) : require(spec);
      const missing = want.filter((n) => !(n in mod));
      if (missing.length) fail(`${mode} ${spec}: missing ${missing.join(', ')}`);
      else console.log(`ok   ${mode} ${spec} (${Object.keys(mod).length} exports)`);
    } catch (err) {
      fail(`${mode} ${spec}: ${err.code ?? ''} ${err.message.split('\n')[0]}`);
    }
  }
}

// One WaveToolError class across entries: an error thrown by code loaded via a
// subpath must satisfy `instanceof` against the root export, in both formats.
for (const mode of ['esm', 'cjs']) {
  const load = (s) => (mode === 'esm' ? import(s) : Promise.resolve(require(s)));
  const root = await load(NAME);
  const tools = await load(`${NAME}/tools`);
  try {
    new tools.AgentToolkit({ apiKey: '' });
    fail(`${mode}: AgentToolkit accepted an empty apiKey`);
  } catch (err) {
    if (err instanceof root.WaveToolError && err.code === 'WAVE_ERR_MISSING_API_KEY') {
      console.log(`ok   ${mode} WaveToolError is shared across subpaths`);
    } else {
      fail(`${mode}: error from ${NAME}/tools is not instanceof root WaveToolError (${err?.name} ${err?.code})`);
    }
  }
}

if (failed) {
  console.error(`\ncheck-exports: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`\ncheck-exports: all ${subpaths.length} subpaths resolve in ESM and CJS`);
