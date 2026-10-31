import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitCode, ToolError } from '../../shared/ts/src/errors.ts';
import { createOutput } from '../../shared/ts/src/output.ts';

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolError', () => {
  it('defaults to exit code 1', () => {
    const error = new ToolError('boom');
    expect(error.code).toBe(ExitCode.failure);
    expect(error.message).toBe('boom');
  });

  it('keeps an explicit exit code', () => {
    expect(new ToolError('bad flag', ExitCode.usage).code).toBe(2);
  });
});

describe('createOutput', () => {
  it('result writes only JSON to stdout when json is true', () => {
    const { out, err } = capture();
    createOutput({ json: true }).result({ a: 1 });
    expect(JSON.parse(out.join(''))).toEqual({ a: 1 });
    expect(err).toEqual([]);
  });

  it('info and error never write to stdout', () => {
    const { out, err } = capture();
    const output = createOutput({ json: false });
    output.info('hello');
    output.error('bad');
    expect(out).toEqual([]);
    expect(err.join('')).toContain('hello');
    expect(err.join('')).toContain('bad');
  });

  it('result prints strings verbatim in human mode', () => {
    const { out } = capture();
    createOutput({ json: false }).result('plain');
    expect(out.join('')).toBe('plain\n');
  });

  it('writes to the given streams instead of the process streams', () => {
    const { out, err } = capture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = createOutput({
      json: true,
      streams: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });
    output.result([1]);
    output.info('note');
    expect(stdout).toEqual(['[1]\n']);
    expect(stderr).toEqual(['note\n']);
    expect([...out, ...err]).toEqual([]);
  });
});
