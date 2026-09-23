# keel-browser plugin

English | [简体中文](README.zh-CN.md)

A thin shell that registers the `keel_browser` MCP server with Claude Code. The implementation lives in the published npm package; this plugin only pins the version and the client identity. See the [project README](../../README.md) for the router, session, and security model.

## Prerequisites

The plugin starts a local process, so the machine running Claude Code still needs:

- Node.js 22.18 or later, so that `npx` can run the package
- A running local MultiZen application with its native MCP endpoint enabled
- An existing MultiZen profile named `claude`

The plugin creates no profile and changes no MultiZen setting. Diagnose the environment without starting a browser:

```powershell
npx -y keel-browser@0.1.0 doctor --client claude-cli
```

## Install

```
/plugin marketplace add Qither/keel-browser
/plugin install keel-browser@keel-browser
```

The server registers as `keel_browser` and exposes the same 13 `browser_*` tools as the CLI entry point. Sessions belong to the MCP process that created them: open a session, operate only on its returned tabs, and close it when the task is finished.

## Version pinning

`.mcp.json` pins an exact package version so a plugin release maps to one implementation. Raise both `version` in `.claude-plugin/plugin.json` and the pinned version in `.mcp.json` when publishing a new package version.

## Native Windows

If the plugin's server fails to start on native Windows because `npx` is not spawnable directly, change the entry in `.mcp.json` to `"command": "cmd"` with `"args": ["/c", "npx", "-y", "keel-browser@0.1.0", "mcp", "--client", "claude-cli"]`.
