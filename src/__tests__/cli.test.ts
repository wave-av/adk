import { describe, it, expect, vi } from 'vitest';
import { run, resolveNpx, type CliDeps, type NpxInvocation } from '../cli/run';

const deps = (npx: NpxInvocation | null = { cmd: 'npx', prefixArgs: [] }) => {
  const out: string[] = [];
  const err: string[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, error: undefined }));
  const d: CliDeps = { log: (m) => out.push(m), error: (m) => err.push(m), spawn, npx: () => npx };
  return { d, out, err, spawn };
};

describe('resolveNpx (no shell on any platform)', () => {
  it('uses npx from PATH on macOS and Linux', () => {
    expect(resolveNpx('linux', '/usr/bin/node', () => false)).toEqual({ cmd: 'npx', prefixArgs: [] });
    expect(resolveNpx('darwin', '/opt/homebrew/bin/node', () => false)).toEqual({ cmd: 'npx', prefixArgs: [] });
  });

  it('runs npm\'s npx-cli.js with node.exe on Windows instead of npx.cmd through a shell', () => {
    const seen: string[] = [];
    const inv = resolveNpx('win32', 'C:\\Program Files\\nodejs\\node.exe', (p) => { seen.push(p); return true; });
    expect(inv).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'],
    });
    expect(seen).toEqual(['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js']);
  });

  it('returns null on Windows when npx-cli.js is not next to node.exe', () => {
    expect(resolveNpx('win32', 'C:\\tools\\node.exe', () => false)).toBeNull();
  });
});

describe('wave-adk CLI', () => {
  it.each(['deploy', 'test', 'logs', 'status'])('%s exits 1 with "not implemented" and never fakes success', (cmd) => {
    const { d, out, err, spawn } = deps();
    expect(run([cmd], d)).toBe(1);
    expect(err.join('\n')).toMatch(/not implemented/);
    expect(out.join('\n')).not.toMatch(/deployed|agent_/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('init delegates to @wave-av/create-app with an argv array', () => {
    const { d, spawn } = deps();
    expect(run(['init', 'mastra-agent', 'my-agent'], d)).toBe(0);
    expect(spawn.mock.calls[0][1]).toEqual(['--yes', '@wave-av/create-app@^1', 'my-agent', '--template', 'mastra-agent']);
  });

  it('init rejects unknown templates and unsafe directory names', () => {
    const { d, spawn } = deps();
    expect(run(['init', 'nope'], d)).toBe(1);
    expect(run(['init', 'stream-monitor', '--force'], d)).toBe(1);
    expect(run(['init', 'stream-monitor', '../x'], d)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('inherited Object.prototype names are neither templates nor commands', () => {
    const { d, err, spawn } = deps();
    expect(run(['init', 'toString'], d)).toBe(1);
    expect(run(['init', 'constructor'], d)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(run(['constructor'], d)).toBe(1);
    expect(run(['hasOwnProperty'], d)).toBe(1);
    expect(err.slice(-2).every((m) => m.startsWith('Unknown command'))).toBe(true);
  });

  it('on Windows spawns node with npx-cli.js first, then the same argv', () => {
    const { d, spawn } = deps({ cmd: 'C:\\n\\node.exe', prefixArgs: ['C:\\n\\node_modules\\npm\\bin\\npx-cli.js'] });
    expect(run(['init', 'stream-monitor', 'bot'], d)).toBe(0);
    expect(spawn.mock.calls[0][0]).toBe('C:\\n\\node.exe');
    expect(spawn.mock.calls[0][1]).toEqual([
      'C:\\n\\node_modules\\npm\\bin\\npx-cli.js', '--yes', '@wave-av/create-app@^1', 'bot', '--template', 'stream-monitor',
    ]);
  });

  it('when npx cannot be located without a shell, prints the command and exits 1', () => {
    const { d, err, spawn } = deps(null);
    expect(run(['init', 'stream-monitor', 'bot'], d)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('npx --yes @wave-av/create-app@^1 bot --template stream-monitor');
  });

  it('propagates the scaffolder exit code', () => {
    const { d, spawn } = deps();
    spawn.mockReturnValueOnce({ status: 7, error: undefined });
    expect(run(['init'], d)).toBe(7);
  });

  it('help exits 0', () => {
    const { d, out } = deps();
    expect(run([], d)).toBe(0);
    expect(out.join('')).toContain('init [template] [dir]');
  });
});
