# Portable Configuration and Claude Integration Validation

[English](VALIDATION.md) | [简体中文](VALIDATION.zh-CN.md)

Date: 2026-09-23. Environment: Windows, Node.js 24, MultiZen 0.3.1, Claude Code 2.1.259.

## Client-to-Profile Bindings

| Client entry point | MultiZen profile | Status |
| --- | --- | --- |
| `codex` | Existing `codex` | Separate binding; diagnostics passed |
| `claude-cli` | Existing `claude` | User-level MCP registration completed; Claude CLI reported Connected |
| `claude-desktop` | Existing `claude` | Connection file generated; the native stdio entry point passed integration testing with the real profile; the Desktop app itself has not been connected |

Both Claude clients reuse the same browser connection, with separate session credentials and tabs. Codex uses a connection to a different profile. Initialization only reads existing profiles and pins the resolved profile IDs in the user's runtime configuration; no MultiZen profile was created or modified.

## Path Cleanup

- Source code, versioned templates, and documentation contain no local usernames, project paths with local drive letters, or real profile IDs.
- Examples bind by the names `codex` / `claude`; token and settings paths are derived from the current user's environment.
- The `integration` command generates client configuration from the current Node executable and installed module location, without depending on the caller's working directory.
- Actual client configurations require absolute paths. Generated files are stored under `integrations/` in the user's runtime directory; the project's local `.codex/config.toml`, `.mcp.json`, and local integration output are ignored and are not committed as source code.
- `codex.toml`, `claude-cli.json`, and `claude-desktop.json` have been generated locally. The Claude Desktop file was prepared only in keel's user directory; no Desktop app configuration was created or overwritten.
- After moving the installation directory or Node executable, regenerate the files and update client registrations.

## Validation Results

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm test` | 195 tests passed across 10 test files |
| `pnpm build` | Passed |
| Two-browser isolation fixture | Passed: Codex used its own browser, both Claude clients shared another browser, and existing pages were preserved |
| Doctor checks for all three clients | All passed; aliases matched the actual profile bindings |
| `claude mcp get keel_browser` | User scope, Connected |
| Real-profile Claude CLI/Desktop session validation | Passed: two sessions, snapshots, input, clicks, screenshots, independent closure, and native MCP image responses |
| Launching the generated Desktop configuration unchanged | Without additional environment variables, successfully listed 13 tools and opened and closed a `claude-desktop → claude` session |
| Source and template path scan | No private local paths or real profile UUIDs found |

Tests cover preventing tool arguments from overriding client identity, rejecting credentials from other clients, isolating CLI credential directories, separate connections and coalesced launches per profile, isolating duplicate target IDs across browsers, containing a disconnection to its affected profile, and cleanup after close failures or late-arriving pages.

Image, script, and lifecycle regressions also cover stale element references, blocking HTTP control endpoints during direct navigation, redirects, and popups, PNG screenshots, CLI subprocesses, and native MCP. Live tests operated only on controlled pages created for the tests and did not take over manually opened pages.

## Usage Boundaries

`clientId` is a routing identity selected by trusted launch configuration, not operating-system user authentication. Processes with host shell or local file access remain within the same trust boundary. Claude CLI/Desktop share the `claude` profile's cookies, same-origin storage, and account state; managing task tabs separately does not provide account isolation.

Page execution still uses Playwright/CDP. Equivalence to the anti-detection behavior of MultiZen's native driver has not been verified. Early popup WebSocket connections, service workers, DNS rebinding, and similar cases also mean this is not a complete network sandbox.

The source code does not modify global Codex configuration. Only the user-level `keel_browser` entry was added for Claude CLI; other existing MCP settings were preserved. Connecting the Desktop app will require merging the prepared connection entry and validating the app integration afterward.
