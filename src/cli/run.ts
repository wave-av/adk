/**
 * wave-adk CLI logic, kept apart from the bin entry so it can be tested.
 *
 * Only `init` does real work: it delegates to `@wave-av/create-app`, which
 * owns the project templates. `deploy`, `test`, `logs` and `status` have no
 * WAVE API operation behind them yet, so they say so and exit non-zero rather
 * than printing a success they never achieved.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

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

/** How to start npx without a shell: an executable plus the arguments that come before npx's own. */
export interface NpxInvocation {
  readonly cmd: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Locate npx so it can be spawned with no shell on every platform.
 *
 * On macOS/Linux `npx` is an executable on PATH. On Windows it is `npx.cmd`,
 * and Node refuses to spawn a .cmd without a shell (CVE-2024-27980). Instead of
 * turning a shell on, run npm's own `npx-cli.js` with the current Node binary;
 * the standard Windows Node install ships it next to node.exe. Returns null
 * when it is not there, and the caller prints the command to run by hand.
 */
export function resolveNpx(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): NpxInvocation | null {
  if (platform !== 'win32') return { cmd: 'npx', prefixArgs: [] };
  const cli = win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return exists(cli) ? { cmd: execPath, prefixArgs: [cli] } : null;
}

export interface CliDeps {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  /** Runs `cmd` with an argv array and no shell. */
  readonly spawn: (cmd: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'error'>;
  readonly npx?: () => NpxInvocation | null;
}

const defaultDeps: CliDeps = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  spawn: (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: false }),
  npx: () => resolveNpx(),
};

const isTemplate = (name: string): name is keyof typeof INIT_TEMPLATES => Object.hasOwn(INIT_TEMPLATES, name);

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
    if (!isTemplate(template)) {
      deps.error(`Unknown template: ${template}\nAvailable templates: ${Object.keys(INIT_TEMPLATES).join(', ')}`);
      return 1;
    }
    if (!SAFE_NAME.test(dir) || dir === '.' || dir === '..') {
      deps.error(`Invalid project directory "${dir}": use letters, digits, ".", "_" or "-" (no leading "-", no path separators).`);
      return 1;
    }
    const createArgs = ['--yes', '@wave-av/create-app@^1', dir, '--template', template];
    const npx = (deps.npx ?? resolveNpx)();
    if (!npx) {
      deps.error(`Could not find npm's npx-cli.js next to ${process.execPath}, and wave-adk does not run npx through a shell.\nRun it yourself: npx ${createArgs.join(' ')}`);
      return 1;
    }
    const result = deps.spawn(npx.cmd, [...npx.prefixArgs, ...createArgs]);
    if (result.error) {
      deps.error(`Could not run npx @wave-av/create-app: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  }

  const reason = Object.hasOwn(NOT_IMPLEMENTED, command) ? NOT_IMPLEMENTED[command] : undefined;
  if (reason) {
    deps.error(`wave-adk ${command}: not implemented. ${reason}`);
    return 1;
  }

  deps.error(`Unknown command: ${command}\n${HELP}`);
  return 1;
}
