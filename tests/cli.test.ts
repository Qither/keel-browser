import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCli, runCli } from '../src/cli.js';
import { KeelError } from '../src/contracts.js';

beforeEach(() => vi.stubEnv('KEEL_BROWSER_CLIENT', undefined));
afterEach(() => vi.unstubAllEnvs());

function adapter() {
  const call = vi.fn(async () => ({ sessionId: 'session-a', tabs: [{ tabId: 'tab-a' }] }));
  const createClient = vi.fn(() => ({ call }));
  return { call, createClient, deps: { createClient, getHome: () => 'test-home' } };
}

describe('CLI browser adapter', () => {
  it('describes the selected profile alias without requiring machine-specific IDs', async () => {
    const { call, deps } = adapter();
    expect(await executeCli(['--help'], deps)).toMatchObject({ clientId: 'codex', profile: 'Existing MultiZen profile alias codex' });
    expect(await executeCli(['--help', '--client', 'claude-desktop'], deps)).toMatchObject({ clientId: 'claude-desktop', profile: 'Existing MultiZen profile alias claude' });
    expect(call).not.toHaveBeenCalled();
  });

  it('opens a persistent CLI session without accepting profile overrides', async () => {
    const { call, createClient, deps } = adapter();
    await executeCli(['open', '--url', 'https://example.com', '--json'], deps);
    expect(createClient).toHaveBeenCalledWith({ persistent: true, home: 'test-home', clientId: 'codex' });
    expect(call).toHaveBeenCalledWith('open', { mode: 'cli', url: 'https://example.com' });
    await expect(executeCli(['open', '--profile', 'another-profile'], deps)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('selects a startup client from environment with explicit option precedence', async () => {
    const { call, createClient, deps } = adapter();
    vi.stubEnv('KEEL_BROWSER_CLIENT', 'claude-desktop');
    await executeCli(['open'], deps);
    expect(createClient).toHaveBeenLastCalledWith({ persistent: true, home: 'test-home', clientId: 'claude-desktop' });
    await executeCli(['open', '--client', 'claude-cli'], deps);
    expect(createClient).toHaveBeenLastCalledWith({ persistent: true, home: 'test-home', clientId: 'claude-cli' });
    expect(call).toHaveBeenLastCalledWith('open', { mode: 'cli' });
  });

  it('rejects an unknown client before browser access', async () => {
    const { createClient, deps } = adapter();
    await expect(executeCli(['open', '--client', 'unknown'], deps)).rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    vi.stubEnv('KEEL_BROWSER_CLIENT', 'unknown');
    await expect(executeCli(['open'], deps)).rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('generates client-specific integration JSON without config or browser access', async () => {
    const { createClient, deps } = adapter();
    vi.stubEnv('KEEL_BROWSER_CLIENT', 'unused-environment');
    const output = vi.fn();
    const getHome = vi.fn(() => { throw new Error('Integration must not read runtime state.'); });
    expect(await runCli(['integration', 'claude-desktop'], { ...deps, getHome }, output)).toBe(0);
    const config = JSON.parse(output.mock.calls[0]![0] as string);
    expect(config.mcpServers.keel_browser).toMatchObject({ command: process.execPath });
    expect(config.mcpServers.keel_browser.args.slice(1)).toEqual(['mcp', '--client', 'claude-desktop']);
    expect(config.mcpServers.keel_browser).not.toHaveProperty('cwd');
    expect(getHome).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    await expect(executeCli(['integration', 'claude-cli', '--client', 'codex'], deps)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('diagnoses the selected client binding', async () => {
    const { deps } = adapter();
    const loadConfig = vi.fn().mockReturnValue({ testConfig: true });
    const doctor = vi.fn().mockResolvedValue({ ok: true });
    await executeCli(['doctor', '--client', 'claude-cli'], { ...deps, loadConfig, doctor });
    expect(doctor).toHaveBeenCalledWith({ testConfig: true }, 'claude-cli');
  });

  it('dispatches session, tab and literal input text without reinterpretation', async () => {
    const { call, deps } = adapter();
    const text = 'quotes " $HOME $(command)\n中文';
    await executeCli(['fill', '--session', 'session-a', '--tab', 'tab-a', '--ref', 'r1', '--text', text], deps);
    expect(call).toHaveBeenCalledWith('fill', { sessionId: 'session-a', tabId: 'tab-a', ref: 'r1', text });
    await executeCli(['fill', '--session', 'session-a', '--tab', 'tab-a', '--ref', 'r1', '--text', ''], deps);
    expect(call).toHaveBeenLastCalledWith('fill', { sessionId: 'session-a', tabId: 'tab-a', ref: 'r1', text: '' });
  });

  it.each([
    ['navigate', '--session', 's', '--tab', 't', '--url', 'file:///private'],
    ['navigate', '--session', 's', '--url', 'https://example.com'],
    ['screenshot', '--session', 's', '--tab', 't', '--output', 'host.png'],
    ['scroll', '--session', 's', '--tab', 't', '--direction', 'down', '--amount', '10001'],
    ['scroll', '--session', 's', '--tab', 't', '--direction', 'diagonal'],
    ['open', '--session', 'unrelated'],
    ['open', 'unexpected'],
  ])('rejects invalid invocation before browser access: %s', async (...argv) => {
    const { call, deps } = adapter();
    await expect(executeCli(argv, deps)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(call).not.toHaveBeenCalled();
  });

  it('converts a bounded scroll amount to a number', async () => {
    const { call, deps } = adapter();
    await executeCli(['scroll', '--session', 's', '--tab', 't', '--direction', 'left', '--amount', '700'], deps);
    expect(call).toHaveBeenCalledWith('scroll', { sessionId: 's', tabId: 't', direction: 'left', amount: 700 });
  });

  it('produces one JSON record and sanitizes unexpected failures', async () => {
    const output = vi.fn();
    const createClient = () => ({ call: async () => { throw new Error('private-multizen-token ws://localhost:12345'); } });
    expect(await runCli(['open'], { createClient, getHome: () => 'test-home' }, output)).toBe(1);
    const record = JSON.parse(output.mock.calls[0]![0] as string);
    expect(record.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(record)).not.toContain('private-multizen-token');
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('retains an actionable safe broker failure', async () => {
    const output = vi.fn();
    const createClient = () => ({ call: async () => { throw new KeelError('SESSION_NOT_FOUND', 'The session has expired.'); } });
    expect(await runCli(['status', '--session', 'expired'], { createClient, getHome: () => 'test-home' }, output)).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).error).toEqual({ code: 'SESSION_NOT_FOUND', message: 'The session has expired.' });
  });

  it('runs MCP without adding JSON to its stdio protocol', async () => {
    const output = vi.fn();
    const startMcp = vi.fn(async () => ({ close: async () => undefined }));
    expect(await runCli(['mcp'], { startMcp, getHome: () => 'test-home' }, output)).toBe(0);
    expect(startMcp).toHaveBeenCalledWith('test-home', 'codex');
    expect(await runCli(['mcp', '--client', 'claude-cli'], { startMcp, getHome: () => 'test-home' }, output)).toBe(0);
    expect(startMcp).toHaveBeenLastCalledWith('test-home', 'claude-cli');
    expect(output).not.toHaveBeenCalled();
  });
});
