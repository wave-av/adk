/**
 * wave-adk CLI logic, kept apart from the bin entry so it can be tested.
 *
 * Only `init` does real work: it delegates to `@wave-av/create-app`, which
 * owns the project templates. `deploy`, `test`, `logs` and `status` have no
 * WAVE API operation behind them yet, so they say so and exit non-zero rather
 * than printing a success they never achieved.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** Templates shipped by @wave-av/create-app. */
export const INIT_TEMPLATES = {
  'stream-monitor': 'Stream monitor agent (StreamMonitorAgent)',
  'mastra-agent': 'Mastra agent with the WAVE tools',
  'livekit-agent': 'LiveKit agent with the WAVE tools',
  'webhook-handler': 'WAVE webhook handler',
  'nextjs-supabase': 'Next.js + Supabase streaming app',
} as const;

const NOT_IMPLEMENTED: Record<string, string> = {
  deploy: 'Hosted agent deployment has no WAVE API operation yet. Run your agent with AgentRuntime on your own infrastructure.',
  test: 'There is no local mock-stream harness yet. Run your agent with a test stream id instead.',
  logs: 'Hosted agent logs have no WAVE API operation yet. AgentRuntime writes structured JSON logs to stdout.',
  status: 'Hosted agent status has no WAVE API operation yet. Query your agent\'s own GET /health endpoint (AgentRuntime).',
};

const SAFE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export interface CliDeps {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  readonly spawn: (cmd: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'error'>;
}

const defaultDeps: CliDeps = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  spawn: (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' }),
};

export const HELP = `
WAVE ADK — Agent Developer Kit

Usage: wave-adk <command> [options]

Commands:
  init [template] [dir]   Scaffold a new agent project (runs npx @wave-av/create-app)
  help                    Show this help

Not implemented yet (exit 1): deploy, test, logs, status

Templates:
${Object.entries(INIT_TEMPLATES).map(([k, v]) => `  ${k.padEnd(20)}${v}`).join('\n')}

Docs: https://docs.wave.online/docs/adk
`;

export function run(argv: string[], deps: CliDeps = defaultDeps): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    deps.log(HELP);
    return 0;
  }

  if (command === 'init') {
    const template = rest[0] ?? 'stream-monitor';
    const dir = rest[1] ?? 'my-wave-agent';
    if (!(template in INIT_TEMPLATES)) {
      deps.error(`Unknown template: ${template}\nAvailable templates: ${Object.keys(INIT_TEMPLATES).join(', ')}`);
      return 1;
    }
    if (!SAFE_NAME.test(dir) || dir === '.' || dir === '..') {
      deps.error(`Invalid project directory "${dir}": use letters, digits, ".", "_" or "-" (no leading "-", no path separators).`);
      return 1;
    }
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = deps.spawn(npx, ['--yes', '@wave-av/create-app@^1', dir, '--template', template]);
    if (result.error) {
      deps.error(`Could not run npx @wave-av/create-app: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  }

  const reason = NOT_IMPLEMENTED[command];
  if (reason) {
    deps.error(`wave-adk ${command}: not implemented. ${reason}`);
    return 1;
  }

  deps.error(`Unknown command: ${command}\n${HELP}`);
  return 1;
}
