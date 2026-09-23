import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { integrationConfig } from '../src/integrations.js';

afterEach(() => vi.restoreAllMocks());

describe('portable client integration generation', () => {
  const install = join(tmpdir(), 'keel portable install', 'dist');
  const executablePath = join(tmpdir(), 'Node Runtime', 'node.exe');
  const moduleUrl = pathToFileURL(join(install, 'integrations.js'));

  it.each(['claude-cli', 'claude-desktop'] as const)('emits a direct stdio entry for %s with space-containing paths', clientId => {
    const result = integrationConfig(clientId, { executablePath, moduleUrl });
    expect(result).toEqual({ mcpServers: { keel_browser: {
      command: executablePath, args: [join(install, 'cli.js'), 'mcp', '--client', clientId],
    } } });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).not.toHaveProperty('cwd');
  });

  it('uses its module location even when invoked from an unrelated working directory', () => {
    const elsewhere = join(tmpdir(), 'unrelated caller directory');
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    const result = integrationConfig('claude-cli');
    if (!('mcpServers' in result)) throw new Error('Expected Claude config');
    expect(result.mcpServers.keel_browser.command).toBe(process.execPath);
    expect(result.mcpServers.keel_browser.args[0]).toBe(fileURLToPath(new URL('../src/cli.js', import.meta.url)));
    expect(isAbsolute(result.mcpServers.keel_browser.args[0]!)).toBe(true);
    expect(result.mcpServers.keel_browser.args[0]).not.toContain(elsewhere);
    expect(result.mcpServers.keel_browser).not.toHaveProperty('cwd');
  });

  it('regenerates the entry from a moved installation without keeping the old path', () => {
    const first = integrationConfig('claude-desktop', { moduleUrl });
    const moved = join(tmpdir(), 'moved installation', 'dist');
    const second = integrationConfig('claude-desktop', { moduleUrl: pathToFileURL(join(moved, 'integrations.js')) });
    if (!('mcpServers' in first) || !('mcpServers' in second)) throw new Error('Expected Claude configs');
    expect(first.mcpServers.keel_browser.args[0]).toBe(join(install, 'cli.js'));
    expect(second.mcpServers.keel_browser.args[0]).toBe(join(moved, 'cli.js'));
    expect(JSON.stringify(second)).not.toContain(install);
  });

  it('returns Codex JSON and TOML for the same runtime paths without secrets or cwd', () => {
    const result = integrationConfig('codex', { executablePath, moduleUrl });
    if (!('mcp_servers' in result)) throw new Error('Expected Codex config');
    const entry = result.mcp_servers.keel_browser;
    expect(entry).toEqual({
      command: executablePath,
      args: [join(install, 'cli.js'), 'mcp', '--client', 'codex'],
      env_vars: ['MULTIZEN_MCP_TOKEN'], startup_timeout_sec: 20, tool_timeout_sec: 120, enabled: true,
    });
    expect(result.toml).toContain(`command = ${JSON.stringify(executablePath)}\n`);
    expect(result.toml).toContain(`args = ${JSON.stringify(entry.args)}\n`);
    expect(result.toml).not.toContain('cwd');
    expect(entry).not.toHaveProperty('env');
  });

  it('preserves an explicitly chosen state directory as one command argument', () => {
    const home = join(tmpdir(), 'custom keel state');
    const result = integrationConfig('claude-cli', { executablePath, moduleUrl, home });
    if (!('mcpServers' in result)) throw new Error('Expected Claude config');
    expect(result.mcpServers.keel_browser.args).toEqual([join(install, 'cli.js'), 'mcp', '--client', 'claude-cli', '--home', home]);
  });
});
