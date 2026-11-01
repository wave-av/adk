import { defineConfig } from 'tsup';

// One entry per public subpath in package.json "exports". 1.0.15 built only
// src/index.ts, which silently dropped the ./tools, ./agents, ./adapters,
// ./templates and ./types subpaths 1.0.14 shipped. scripts/check-exports.mjs
// imports every exports entry from the packed tarball, in ESM and CJS.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'tools/index': 'src/tools/index.ts',
    'agents/index': 'src/agents/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'adapters/mastra': 'src/adapters/mastra.ts',
    'adapters/langgraph': 'src/adapters/langgraph.ts',
    'adapters/livekit': 'src/adapters/livekit.ts',
    'adapters/kernel': 'src/adapters/kernel.ts',
    'templates/index': 'src/templates/index.ts',
    types: 'src/types.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // Shared chunks in BOTH formats, so WaveToolError is one class across
  // subpaths and `instanceof` works whichever entry threw it.
  splitting: true,
  clean: true,
  target: 'node18',
});
