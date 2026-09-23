#!/usr/bin/env node
// Launches the keel-browser MCP server for the Claude Code plugin.
//
// The plugin cannot point `command` straight at `npx`: on Windows npx is a
// `.cmd` shim, and an MCP client spawning it without a shell fails with ENOENT
// (Node also refuses to exec `.cmd` without `shell: true`), so the server dies
// before the handshake. Resolving npx ourselves keeps one cross-platform
// `.mcp.json` entry that starts on Windows, macOS, and Linux alike.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE = 'keel-browser@0.1.1';
// Fixed by the project rules: the Claude CLI entry point always binds to the
// claude-cli client, which maps to the existing MultiZen `claude` profile.
const ARGS = ['-y', PACKAGE, 'mcp', '--client', 'claude-cli'];

const nodeDirectory = dirname(process.execPath);
const npxCli = [
  join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
].find(candidate => existsSync(candidate));

const child = npxCli
  ? spawn(process.execPath, [npxCli, ...ARGS], { stdio: 'inherit' })
  : spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ARGS, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

child.on('error', error => {
  process.stderr.write(`keel-browser: failed to launch ${PACKAGE}: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
