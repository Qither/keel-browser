# Portable Configuration Examples

[English](README.md) | [简体中文](README.zh-CN.md)

`config.json` contains only generic defaults and bindings by the names `codex` / `claude`. It contains no personal paths or real profile IDs; omitted `tokenFile` and `settingsFile` values are derived from the current user's environment. On the target machine, run `node dist/cli.js init` to pin the resolved IDs of existing profiles in the user's runtime directory.

Generate client configuration from the installation directory after building:

```powershell
node dist/cli.js integration codex
node dist/cli.js integration claude-cli
node dist/cli.js integration claude-desktop
```

- Codex returns an `mcp_servers` object and a `toml` field ready to merge.
- Claude CLI / Desktop return `{ "mcpServers": { "keel_browser": ... } }`. For CLI registration, use the `mcpServers.keel_browser` entry; for Desktop, merge using the outer `mcpServers` structure.
- Configuration generation does not read browser credentials or start the Router or MultiZen. The generated command uses the actual absolute paths to the current Node executable and installed module, with the client fixed in its launch arguments; it does not depend on the caller's working directory.
- Store generated output in `integrations` under the user's runtime directory, or merge it into the corresponding user configuration. Do not commit these machine-specific files. After moving the installation directory, regenerate the output and update client registrations.

`codex.config.toml` provides generation instructions, not an MCP configuration that can be enabled directly; the repository does not assume a globally installed `keel-browser` command.
