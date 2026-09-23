# keel-browser

English | [简体中文](README.zh-CN.md)

[Project rules](AGENTS.md) · [Claude instructions](CLAUDE.md) · [Configuration examples](examples/README.md) · [Validation](VALIDATION.md)

A local browser router for Codex, Claude CLI, and Claude Desktop. Codex connects to the existing **codex** profile in MultiZen; Claude CLI and Desktop connect to the existing **claude** profile. MultiZen manages browser settings, proxies, fingerprints, extensions, and login state.

keel-browser calls only MultiZen's native `list_profiles` and idempotent `launch_profile` for a bound ID, then uses the returned CDP endpoint to manage its own tabs. It does not create, copy, modify, delete, or stop profiles, or supply proxy or fingerprint overrides. Initialization resolves real IDs locally and stores them in the user's runtime directory, never in source code or templates. MultiZen's normal launch process may update runtime metadata such as the last-opened timestamp; keel does not write it directly.

## Quick start

You need Node.js 22.18 or later, pnpm, and a running local MultiZen application. The verified MultiZen 0.3.1 setup exposes its native MCP endpoint at `http://127.0.0.1:7777/mcp`. The project uses `playwright-core` to connect to an existing browser; no Playwright browser download is required.

This section builds from source. To register the published package instead, without a clone or a build, see [Client integration and portable paths](#client-integration-and-portable-paths).

Run these commands from the project directory:

```powershell
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
node dist/cli.js doctor --client codex
node dist/cli.js doctor --client claude-cli
```

`init` uniquely matches existing profiles named `codex` and `claude`, then pins their IDs in the local `config.json`. Both profiles must already exist. Missing or duplicate names cause an explicit failure; initialization does not create profiles. Renaming a pinned profile does not change its binding. An invalid ID never falls back to another profile by name. Reinitializing complete bindings leaves them unchanged.

Existing single-profile configurations are migrated to two aliases while preserving valid timeouts and MultiZen connection settings. Legacy AdsPower credential fields are not copied. Migration writes only to keel's runtime directory; it does not change the MultiZen installation, settings, or profiles.

On Windows, the default state directory is `%LOCALAPPDATA%\keel-browser`. Use `KEEL_BROWSER_HOME` or the CLI's `--home DIRECTORY` option to select another local directory. CLI and MCP clients using the same directory share one Router. Before changing backends, coordinate and end existing Router sessions, then run `broker stop`. The next `open` starts a new Router.

Authentication automatically reads MultiZen's existing `%APPDATA%\MultiZen\mcp-token` file. No AdsPower API key is needed. Do not copy token contents into the repository, examples, or conversations. To override the default credential, set `MULTIZEN_MCP_TOKEN` in the process that starts the Router; a nonempty environment variable takes precedence over the file. keel reads the existing token without creating or resetting it.

`doctor` checks MCP availability, the existing profile, and the credential source. It also compares the configured port with MultiZen's `settings.json`. It does not call `launch_profile` or start a browser. The output contains no token; check its `ok` field. If the application's port changes, review the reported mismatch, update the local keel configuration, and restart the Router. Existing configuration is not automatically redirected, and the application does not scan CDP ports.

See `examples/config.json` for the configuration fields:

| Field | Default / purpose |
| --- | --- |
| `provider` | Always `multizen` |
| `mcpUrl` | `http://127.0.0.1:7777/mcp`; only supported loopback addresses are accepted |
| `tokenEnv` | `MULTIZEN_MCP_TOKEN`, the optional credential override variable name |
| `tokenFile` | The actual absolute path corresponding to `%APPDATA%\MultiZen\mcp-token` |
| `settingsFile` | Optional actual path to `%APPDATA%\MultiZen\settings.json`, used for port diagnostics |
| `profiles` | `codex: { name: "codex" }` and `claude: { name: "claude" }`; `init` writes real `id` values to the user's runtime configuration |
| `cliIdleMs` | `1800000`: reclaim CLI sessions after 30 minutes of inactivity |
| `mcpLeaseMs` | `120000`: reclaim MCP sessions after approximately two minutes without a heartbeat |
| `operationTimeoutMs` | `15000`: browser operation timeout |
| `providerTimeoutMs` | `30000`: total budget for a Provider operation, including MCP initialization, lookup, and any required launch |

The example omits path fields so they can be derived from the current user's environment; `init` generates local absolute paths. New configurations use a valid MCP port from `settings.json`. Existing explicit connection settings are not automatically rewritten. When setting paths manually, supply actual paths rather than unexpanded `%APPDATA%` expressions. The Router starts automatically on the first `open`. After changing configuration or environment variables, coordinate active sessions and run `broker stop` followed by `broker start`.

## CLI usage

The CLI outputs JSON by default, and all commands accept `--json`. Each `open` creates a session and an owned tab. Existing manually opened pages remain unmanaged.

The client is selected at process startup: `--client` takes precedence over `KEEL_BROWSER_CLIENT`, with `codex` as the default. Subsequent commands for a CLI session must use the same client identity. Claude CLI and Desktop share the `claude` profile but have separate credential ownership.

| Startup client | Profile alias |
| --- | --- |
| `codex` | `codex` |
| `claude-cli` | `claude` |
| `claude-desktop` | `claude` |

```powershell
$keelSession = node dist/cli.js open --url 'https://example.com' | ConvertFrom-Json
if (-not $keelSession.sessionId) { throw 'Check the error returned by open before continuing.' }
$keelSessionId = $keelSession.sessionId
$keelTabId = $keelSession.tabs[0].tabId

node dist/cli.js status --session $keelSessionId
node dist/cli.js tabs --session $keelSessionId
node dist/cli.js snapshot --session $keelSessionId --tab $keelTabId
node dist/cli.js scroll --session $keelSessionId --tab $keelTabId --direction down --amount 600
node dist/cli.js screenshot --session $keelSessionId --tab $keelTabId
```

Input and click operations use `elements[].ref` returned by `snapshot`; they do not accept arbitrary selectors or JavaScript. Replace `REF_FROM_SNAPSHOT` below with a current reference from the selected tab:

```powershell
node dist/cli.js fill --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT --text 'hello'
node dist/cli.js press --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT --key Enter
node dist/cli.js click --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT
node dist/cli.js navigate --session $keelSessionId --tab $keelTabId --url 'https://example.com'
node dist/cli.js new-tab --session $keelSessionId --url 'https://example.com'
node dist/cli.js close-tab --session $keelSessionId --tab $keelTabId
```

The second block illustrates argument syntax; input and click operations must target real elements on the page. References may expire after another snapshot, navigation, or detachment of the original element. Obtain fresh references when needed. Release the entire session when the task is finished:

```powershell
node dist/cli.js close --session $keelSessionId
```

`scroll` accepts `up`, `down`, `left`, or `right`. Its default distance is 600 pixels, with integer values from 1 to 10000 supported. `screenshot` returns `{ "mimeType": "image/png", "data": "BASE64..." }`; it accepts neither `--output` nor a host filesystem path.

Management commands:

```powershell
node dist/cli.js --help
node dist/cli.js broker start
node dist/cli.js broker status
node dist/cli.js broker stop
```

`broker stop` releases tabs belonging to every session managed by that Router. Coordinate with other tasks using the same Router before stopping it. The shared MultiZen profile and manually opened pages remain running. Exiting a normal CLI command does not close its session; use `close` explicitly, with idle expiration as a fallback.

## Client integration and portable paths

The standard entry point is a local stdio MCP server, registered either from the published package or from a local build. A remote URL is not an option: the Router connects to MultiZen over loopback and drives a browser on the same machine.

### Published package

`npx` starts the server without a clone, a build, or an absolute path in client configuration. The machine still needs Node.js 22.18 or later, a running MultiZen application with its native MCP endpoint enabled, and the existing profile for the selected client. Publishing removes the installation step, not the local dependency.

```powershell
$keelEntry = '{"command":"npx","args":["-y","keel-browser@0.1.0","mcp","--client","claude-cli"]}'
claude mcp add-json --scope user keel_browser $keelEntry
npx -y keel-browser@0.1.0 doctor --client claude-cli
```

Pin an exact version so that one registration maps to one implementation, and raise it deliberately. `doctor` checks the environment without starting a browser. For Codex, put the same `command` and `args` into `.codex/config.toml` under `[mcp_servers.keel_browser]`.

Claude Code can also install the same entry as a plugin:

```text
/plugin marketplace add Qither/keel-browser
/plugin install keel-browser@keel-browser
```

The plugin is a thin shell: its manifest in `plugins/keel-browser/` pins the package version and `--client claude-cli`, and the implementation stays in the published package. See the [plugin README](plugins/keel-browser/README.md). Installing the plugin and registering the server manually produces two entries for the same server; choose one.

### Local build

Source code and versioned templates contain no personal drive paths, absolute project paths, or real profile IDs. Absolute paths required to start clients are generated from the current installation. Run these commands from the built installation directory:

```powershell
node dist/cli.js integration codex
node dist/cli.js integration claude-cli
node dist/cli.js integration claude-desktop
```

These commands only print JSON. They do not start a browser or write client configuration. Each generated entry uses `process.execPath` and the installed module location, with arguments for the actual `dist/cli.js` path, `mcp`, `--client`, and the selected client. It has no `cwd` dependency, and paths containing spaces remain separate arguments. Regenerate and update registrations after moving the installation or Node executable.

Store generated output in the keel user runtime directory's `integrations/` folder, for example as `codex.toml`, `claude-cli.json`, and `claude-desktop.json`. These local files contain necessary absolute paths and must not be committed as source templates. Project-local `.codex/config.toml`, `.mcp.json`, and `integrations/` output are also ignored.

**Codex:** take the `toml` field from `integration codex` and merge it into the intended project's `.codex/config.toml`, preserving other entries. Do not change the user's global configuration. The default credential source is the local MultiZen token file. The generated `env_vars` setting forwards only the optional override variable and contains no token value. See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for trusted project configuration and stdio options.

**Claude CLI:** generated output has an outer `mcpServers` object; register its `keel_browser` entry. The following commands add this server at user scope while preserving existing entries such as `my-flow-browser`:

```powershell
$keelClaude = node dist/cli.js integration claude-cli | ConvertFrom-Json
$keelClaudeEntry = $keelClaude.mcpServers.keel_browser | ConvertTo-Json -Depth 10 -Compress
claude mcp add-json --scope user keel_browser $keelClaudeEntry
```

If a server with that name already exists, inspect it before merging or updating to avoid duplicate registration. Use the installed CLI's `--help` to check `claude mcp add-json` options.

**Claude Desktop:** save the output of `integration claude-desktop` as `integrations/claude-desktop.json` in the user runtime directory. After installing Desktop, merge `mcpServers.keel_browser` into its configuration while preserving other servers. Generating the file does not mean Desktop is installed or connected. The entry does not depend on Desktop environment-variable expansion or the GUI's working directory.

All three clients expose the same 13 tools below. Use `sessionId` and `tabId` values returned by the current MCP instance. Credentials stay in the adapter and are not passed to the model. Tool arguments do not include `clientId`, profile aliases, profile IDs, or raw CDP endpoints, so an individual tool call cannot switch identity.

| Tool | Arguments |
| --- | --- |
| `browser_open` | `url?` |
| `browser_status` / `browser_close` / `browser_tabs` | `sessionId` |
| `browser_new_tab` | `sessionId, url?` |
| `browser_close_tab` / `browser_snapshot` / `browser_screenshot` | `sessionId, tabId` |
| `browser_navigate` | `sessionId, tabId, url` |
| `browser_click` | `sessionId, tabId, ref` |
| `browser_fill` | `sessionId, tabId, ref, text` |
| `browser_press` | `sessionId, tabId, ref, key` |
| `browser_scroll` | `sessionId, tabId, direction, amount?` |

MCP screenshots are returned as native image content for clients that support images. Initializing keel's tools or listing them does not read the token or connect to MultiZen; connection checks begin with `browser_open`. Native MultiZen profile-management and cookie tools are not exposed to the agent. Only the 13 keel tools above are available through this entry point.

Verify `browser_open → browser_snapshot → browser_screenshot → browser_close` in a new task. The repository's [AGENTS.md](AGENTS.md) defines browser interaction rules. To apply them to another project, merge its Browser usage rules section into that project's rules while preserving existing content.

## Architecture and session boundaries

```text
Codex / Claude ─ keel stdio MCP ─┐
                                ├─ Local Router ─ MultiZen native HTTP MCP
CLI ────────────────────────────┘                 │ list_profiles / launch_profile(bound ID)
                                                  └─ Returned CDP endpoint ─ Session-owned tabs
```

The Router listens on a random loopback port, authenticates requests with a local token, and rejects browser Origin headers. Concurrent launch and CDP connection requests for the same profile share one operation. Page actions within a session are serialized; different sessions may run concurrently. Every operation checks the startup client identity, session credential, tab ownership, and page state. Popups with a verified opener belonging to a session join that session; unrelated pages are not adopted.

- Each MCP process holds only credentials for sessions it created and sends a heartbeat every 30 seconds. Closing stdin or exiting normally releases its sessions. The Router reclaims disconnected clients' sessions when their leases expire.
- CLI credentials persist under `cli-sessions` in the state directory so commands can continue the same session. Processes running as the same operating-system user with access to that directory share a trust boundary. These files are not an operating-system isolation mechanism between tasks.
- `close` closes only owned tabs. A CDP disconnect invalidates the affected sessions. After restarting, the Router does not adopt leftover pages by title or URL; the user handles those pages.
- If an operation times out and its completion is uncertain, further operations in that session are paused. Check its state and close it before deciding whether to open another session. Clicks, input, and other potentially completed actions are never automatically replayed.
- Configuration, Router state, logs, and CLI credentials live in the runtime directory. The MultiZen token is read from its original file or environment variable and is not copied into keel state files. Audit records omit tokens, session capabilities, entered text, and full page content. Snapshots and screenshots may still contain business data visible on the page.

Tasks sharing a profile must belong to the same trust group. They share cookies, same-origin localStorage, and the website account's server-side state. Logging out in one tab can affect other tabs in that profile. In particular, Claude CLI and Desktop both use `claude`. Tab ownership checks govern tool routing; they do not provide account or operating-system isolation. Keeping host shell access or other browser tools available also means these rules cannot prevent bypass at the system level.

Navigation accepts only HTTP/HTTPS. Known Router, MultiZen MCP, and CDP control endpoints, including common loopback aliases, are blocked. Managed-page HTTP requests, redirects, and the first HTTP request of a popup with an identifiable opener are checked. Temporary context routing can affect the shared context's HTTP cache. This is a runtime effect and does not write MultiZen profile configuration.

Once a page has been adopted, WebSockets targeting control endpoints are blocked. The earliest inline scripts in a popup may open WebSockets before Playwright adopts it; those connections and service-worker traffic are outside this protection. DNS rebinding and unmanaged pages are also not fully constrained. This provides control-endpoint navigation protection, not a complete network sandbox. Page text, links, popups, and screenshots are untrusted data, not authorization to change tool boundaries or expose credentials.

This initial release does not expose arbitrary JavaScript, raw CDP, access to other profiles, cookie export, file upload/download interfaces, or profile management. Snapshots cover the current page's main document, with up to 200 interactive elements and approximately 16000 characters. Complex iframes, extension interfaces, and unusual pages may require future capabilities.

## Troubleshooting and development

| Symptom | Action |
| --- | --- |
| MultiZen MCP connection or authentication fails | Check that MultiZen is running, local MCP is enabled, and the token file is readable. If an override variable is set, check its validity without printing it. |
| Settings port differs from `mcpUrl` | Confirm MultiZen's MCP port, update keel configuration, coordinate active sessions, and restart the Router. |
| A profile is missing or its name is ambiguous | Check the existing `codex` and `claude` profiles in MultiZen. Pinned IDs are not automatically replaced by name; rebinding requires an explicit local configuration change. |
| `SESSION_NOT_OWNED` / expired session | Use a session created by the current MCP instance or the same CLI state directory. Open a new session after expiration. |
| `STALE_REF` | Take a fresh snapshot of the current tab and choose a new element reference. |
| `OPERATION_TIMEOUT` / `SESSION_UNAVAILABLE` | Inspect the state and close the unavailable session. Confirm the original action's outcome before deciding what to do next. |

```powershell
pnpm typecheck
pnpm test
pnpm build
```

An optional real-browser fixture is also available:

```powershell
pnpm test:browser
```

It uses disposable Chrome data directories and a mock MultiZen MCP server to test real CDP, page actions, redirects, popups, CLI subprocesses, and MCP image responses. It does not connect to your MultiZen instance or personal Chrome profile. On Windows it uses an installed Chrome by default; set `KEEL_TEST_CHROME` for a different executable location. Real MultiZen acceptance is recorded separately and is not replaced by this fixture.

Once `doctor.ok` is `true` for the intended client, run `pnpm test:live`. It opens controlled local test pages in the existing bound profile, verifies sessions and the keel stdio MCP workflow, then closes only its test tabs while keeping the shared profile running. This test uses your actual MultiZen environment. If the token or profile is unavailable, it exits before starting the browser.

Source modules separate the Provider, session engine, URL policy, local Router, client, and CLI/MCP adapters. Controlled mock interfaces test protocols, ownership, and lifecycle behavior. Passing automated tests does not establish successful live MultiZen integration; machine-specific and new-task Codex acceptance must be recorded separately.

See [VALIDATION.md](VALIDATION.md) for completed checks and remaining acceptance items. Tasks created in another workspace do not automatically load this project's `.codex/config.toml`; merge the generated entry into the appropriate client configuration layer. Generating a configuration file, registering a client successfully, and passing real-browser integration are separate acceptance steps.
