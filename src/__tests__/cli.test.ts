import { describe, it, expect, vi } from 'vitest';
import { run, type CliDeps } from '../cli/run';

const deps = () => {
  const out: string[] = [];
  const err: string[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, error: undefined }));
  const d: CliDeps = { log: (m) => out.push(m), error: (m) => err.push(m), spawn };
  return { d, out, err, spawn };
};

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
