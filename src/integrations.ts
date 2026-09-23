import { fileURLToPath } from 'node:url';
import { parseClientId, type ClientId } from './contracts.js';

export interface StdioEntry { command: string; args: string[] }
export interface CodexEntry extends StdioEntry {
  env_vars: string[];
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  enabled: boolean;
}
export interface CodexIntegration {
  mcp_servers: { keel_browser: CodexEntry };
  toml: string;
}
export interface ClaudeIntegration { mcpServers: { keel_browser: StdioEntry } }

interface IntegrationRuntime {
  executablePath?: string;
  moduleUrl?: string | URL;
  home?: string;
}

/** Resolve from this installed module, never the caller's working directory. */
export function integrationConfig(clientId: ClientId, runtime: IntegrationRuntime = {}): CodexIntegration | ClaudeIntegration {
  const selected = parseClientId(clientId);
  const command = runtime.executablePath ?? process.execPath;
  const script = fileURLToPath(new URL('./cli.js', runtime.moduleUrl ?? import.meta.url));
  const entry: StdioEntry = { command, args: [script, 'mcp', '--client', selected] };
  if (runtime.home !== undefined) entry.args.push('--home', runtime.home);
  if (selected !== 'codex') return { mcpServers: { keel_browser: entry } };
  const codexEntry: CodexEntry = {
    ...entry, env_vars: ['MULTIZEN_MCP_TOKEN'], startup_timeout_sec: 20, tool_timeout_sec: 120, enabled: true,
  };
  // JSON string escaping is also valid for these TOML basic strings and arrays.
  const toml = [
    '[mcp_servers.keel_browser]',
    `command = ${JSON.stringify(codexEntry.command)}`,
    `args = ${JSON.stringify(codexEntry.args)}`,
    `env_vars = ${JSON.stringify(codexEntry.env_vars)}`,
    `startup_timeout_sec = ${codexEntry.startup_timeout_sec}`,
    `tool_timeout_sec = ${codexEntry.tool_timeout_sec}`,
    `enabled = ${codexEntry.enabled}`,
    '',
  ].join('\n');
  return { mcp_servers: { keel_browser: codexEntry }, toml };
}
