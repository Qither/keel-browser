# keel-browser

[English](README.md) | 简体中文

[项目规则](AGENTS.zh-CN.md) · [Claude 使用说明](CLAUDE.zh-CN.md) · [配置示例](examples/README.zh-CN.md) · [验收记录](VALIDATION.zh-CN.md)

供 Codex、Claude CLI 和 Claude Desktop 使用的本地浏览器 Router。Codex 连接 MultiZen 中已有的 **codex** 环境；Claude CLI 与 Desktop 连接已有的 **claude** 环境。浏览器配置、代理、指纹、扩展及登录状态均由 MultiZen 管理。

keel-browser 只调用 MultiZen 原生 MCP 的 `list_profiles` 和已绑定 ID 的幂等 `launch_profile`，再通过返回的 CDP 地址管理自己的 tabs。它不创建、复制、修改、删除或停止 profile，不传入代理、指纹等覆盖配置。真实 ID 由本机初始化解析并保存在用户运行目录，不写死在源码或模板中。MultiZen 原生启动可能更新最近使用时间等运行元数据，keel 不直接改写这些数据。

## 快速开始

需要 Node.js 22.18 或以上、pnpm，以及本机正在运行的 MultiZen。本机 MultiZen 0.3.1 原生 MCP 地址为 `http://127.0.0.1:7777/mcp`。项目使用 `playwright-core` 连接已有浏览器，不需要下载 Playwright 浏览器。

在项目目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
node dist/cli.js doctor --client codex
node dist/cli.js doctor --client claude-cli
```

`init` 通过名称唯一匹配已有的 `codex`、`claude` 环境，将 ID 固定到本地 `config.json`。两个环境必须已经存在，名称重复或找不到时明确失败，不创建环境。固定后改名不影响绑定；ID 失效时不会按名称自动换成另一个环境。已有完整绑定再次初始化保持不变。

旧的单环境配置会迁移为双别名配置，并保留有效超时与 MultiZen 连接设置；旧 AdsPower 凭证字段不会复制。迁移只写 keel 运行目录，不修改 MultiZen 安装、设置或 profile。

Windows 默认状态目录是 `%LOCALAPPDATA%\keel-browser`。可通过 `KEEL_BROWSER_HOME` 或 CLI 的 `--home DIRECTORY` 指定另一个本地目录；同一目录的 CLI 和 MCP 共用一个 Router。切换后端前应协调并结束旧 Router 会话，再执行 `broker stop`；首次新 `open` 会启动新 Router。

鉴权自动使用 MultiZen 自己维护的 `%APPDATA%\MultiZen\mcp-token` 文件。无需另设 AdsPower API key，也不要把 token 内容复制到仓库、示例或对话中。如需覆盖默认凭证，可让启动 Router 的进程持有 `MULTIZEN_MCP_TOKEN`；非空环境变量优先于文件。keel 只读取现有 token，不创建或重置它。

`doctor` 只检查 MCP 可用性、现有 profile 与 token 来源，并读取 MultiZen 的 `settings.json` 对照端口；它不会调用 `launch_profile` 或启动浏览器。输出不包含 token，最终结果检查 `ok` 字段。客户端端口变化时会报告不一致，确认后更新本地 keel 配置并重启 Router；已有配置不会被自动重定向，程序不扫描 CDP 端口。

完整配置字段可参考 `examples/config.json`：

| 字段 | 默认值 / 用途 |
| --- | --- |
| `provider` | 固定为 `multizen` |
| `mcpUrl` | `http://127.0.0.1:7777/mcp`，仅接受受支持的 loopback 地址 |
| `tokenEnv` | `MULTIZEN_MCP_TOKEN`，可选覆盖凭证的环境变量名 |
| `tokenFile` | `%APPDATA%\MultiZen\mcp-token` 对应的实际绝对路径 |
| `settingsFile` | 可选，`%APPDATA%\MultiZen\settings.json` 的实际路径，用于端口诊断 |
| `profiles` | `codex: { name: "codex" }`、`claude: { name: "claude" }`；`init` 将真实 `id` 写入用户运行配置 |
| `cliIdleMs` | `1800000`，CLI 会话闲置 30 分钟后回收 |
| `mcpLeaseMs` | `120000`，MCP 心跳失联约 2 分钟后回收 |
| `operationTimeoutMs` | `15000`，浏览器操作超时 |
| `providerTimeoutMs` | `30000`，一次 Provider 操作的总预算，包含 MCP 握手、查询及必要的启动 |

示例省略路径字段，由当前用户环境派生；`init` 生成本机绝对路径。新建配置时会采用 `settings.json` 中有效的 MCP 端口，已有明确连接设置不会自动改写。手动配置路径时应填写实际路径，不使用未展开的 `%APPDATA%`。Router 在首次 `open` 时自动启动；更改配置或环境变量后，协调活动会话，再执行 `broker stop` 和 `broker start`。

## CLI 使用

CLI 默认输出 JSON，所有命令也接受 `--json`。每次 `open` 新建一个会话和专属 tab；已有人工页面保持未托管。

客户端只在进程启动时选择：`--client` 优先于 `KEEL_BROWSER_CLIENT`，未设置时默认 `codex`。同一 CLI 会话的后续命令须保持相同客户端身份；Claude CLI 与 Desktop 虽共用 `claude` profile，凭证归属仍分开。

| 启动客户端 | 环境别名 |
| --- | --- |
| `codex` | `codex` |
| `claude-cli` | `claude` |
| `claude-desktop` | `claude` |

```powershell
$keelSession = node dist/cli.js open --url 'https://example.com' | ConvertFrom-Json
if (-not $keelSession.sessionId) { throw '请先检查 open 返回的错误。' }
$keelSessionId = $keelSession.sessionId
$keelTabId = $keelSession.tabs[0].tabId

node dist/cli.js status --session $keelSessionId
node dist/cli.js tabs --session $keelSessionId
node dist/cli.js snapshot --session $keelSessionId --tab $keelTabId
node dist/cli.js scroll --session $keelSessionId --tab $keelTabId --direction down --amount 600
node dist/cli.js screenshot --session $keelSessionId --tab $keelTabId
```

输入和点击使用 `snapshot` 返回的 `elements[].ref`，不能传入任意选择器或 JavaScript。以下 `REF_FROM_SNAPSHOT` 须替换为当前 tab 的最新引用：

```powershell
node dist/cli.js fill --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT --text 'hello'
node dist/cli.js press --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT --key Enter
node dist/cli.js click --session $keelSessionId --tab $keelTabId --ref REF_FROM_SNAPSHOT
node dist/cli.js navigate --session $keelSessionId --tab $keelTabId --url 'https://example.com'
node dist/cli.js new-tab --session $keelSessionId --url 'https://example.com'
node dist/cli.js close-tab --session $keelSessionId --tab $keelTabId
```

上面第二组仅展示参数格式；输入与点击应针对实际页面上的元素。每次重新获取 snapshot、页面导航或原元素脱离文档后，旧引用可能失效，应重新获取。任务结束后释放整个会话：

```powershell
node dist/cli.js close --session $keelSessionId
```

`scroll` 的方向为 `up`、`down`、`left`、`right`，距离默认为 600 像素，可取 1–10000 的整数。`screenshot` 返回 `{ "mimeType": "image/png", "data": "BASE64..." }`；不接受 `--output` 或宿主文件路径。

管理命令：

```powershell
node dist/cli.js --help
node dist/cli.js broker start
node dist/cli.js broker status
node dist/cli.js broker stop
```

`broker stop` 会释放这个 Router 管理的全部会话 tabs，因此需要先协调其他使用该 Router 的任务。它保留 MultiZen profile 与人工页面。普通 CLI 命令退出不会关闭会话；应主动 `close`，闲置超时只是兜底。

## 客户端接入与可移植路径

标准入口是本地 stdio MCP。代码和版本化模板不包含个人盘符、项目绝对路径或真实 profile ID；客户端启动所需的绝对路径由当前安装位置生成。在构建后的安装目录运行：

```powershell
node dist/cli.js integration codex
node dist/cli.js integration claude-cli
node dist/cli.js integration claude-desktop
```

这些命令只输出 JSON，不启动浏览器、不写客户端配置。生成 entry 使用 `process.execPath` 与安装模块位置，参数为实际 `dist/cli.js` 路径、`mcp`、`--client` 和指定客户端；没有 `cwd` 依赖，路径含空格也作为独立参数传递。移动安装目录或 Node 位置后重新生成并更新注册。

生成结果应存放在 keel 用户运行目录的 `integrations/`，例如 `codex.toml`、`claude-cli.json` 和 `claude-desktop.json`。这些本机文件包含必要的实际绝对路径，不作为源码模板提交。项目 `.codex/config.toml`、`.mcp.json` 和 `integrations/` 也已加入忽略规则。

**Codex：**取 `integration codex` 输出中的 `toml` 字段，合并到需要接入的项目 `.codex/config.toml`，保留其他条目；不改用户全局配置。默认读取本机 MultiZen token 文件，生成配置的 `env_vars` 仅转发可选的覆盖变量，不保存 token。受信任项目配置与 stdio 选项见 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

**Claude CLI：**生成内容外层为 `mcpServers`，注册时取其中的 `keel_browser` entry。以下命令使用用户级作用域，仅添加此服务器；保留已有的 `my-flow-browser` 等条目：

```powershell
$keelClaude = node dist/cli.js integration claude-cli | ConvertFrom-Json
$keelClaudeEntry = $keelClaude.mcpServers.keel_browser | ConvertTo-Json -Depth 10 -Compress
claude mcp add-json --scope user keel_browser $keelClaudeEntry
```

若已有同名服务器，先检查其内容再合并或更新，避免重复注册。`claude mcp add-json` 的参数可通过本机 `--help` 核对。

**Claude Desktop：**取 `integration claude-desktop` 输出，在用户运行目录准备 `integrations/claude-desktop.json`。Desktop 安装后再把 `mcpServers.keel_browser` 合并到其配置，保留其他服务器。生成文件不表示 Desktop 已安装或已连接；无需依赖 Desktop 的环境变量展开或 GUI 工作目录。

三个客户端均使用下面 13 个工具。`sessionId` 和 `tabId` 必须使用当前 MCP 实例返回的值；凭证由适配器保存，不交给模型。工具参数没有 `clientId`、profile 别名、profile ID 或原始 CDP 地址，不能在一次工具调用中切换身份。

| 工具 | 参数 |
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

MCP 截图以原生 image 内容返回，可在支持图片的客户端直接查看。keel 的工具初始化和列表查询不读取 token，也不会连接 MultiZen；实际 `browser_open` 才进行连接检查。MultiZen 原生 profile 管理、cookies 等工具不会暴露给 Agent，外部仍只有上述 13 个 keel 工具。

在新任务中验证一次 `browser_open → browser_snapshot → browser_screenshot → browser_close`。本仓库 `AGENTS.md` 固定浏览器交互规则；若希望其他项目也遵循该规则，应把其中的“浏览器使用规则”合并到相应项目规则，保留原有内容。

## 架构与会话边界

```text
Codex / Claude ─ keel stdio MCP ─┐
                                ├─ 本地 Router ─ MultiZen 原生 HTTP MCP
CLI ────────────────────────────┘               │ list_profiles / launch_profile(绑定 ID)
                                                └─ 返回 CDP ─ 各会话专属 tabs
```

Router 监听随机 loopback 端口，以本地令牌校验入口并拒绝浏览器 Origin。同一 profile 的启动与 CDP 连接合并执行，同一会话中的页面操作串行，不同会话可以并行。每次操作校验启动客户端、会话凭证、tab 归属及页面状态。能证明 opener 属于该会话的 popup 登记到原会话；其他页面不接管。

- MCP 每个进程只持有自己创建的会话凭证，每 30 秒发送心跳。stdin 关闭或正常终止会释放所属会话；异常失联由 Router 按租约回收。
- CLI 凭证持久化在状态目录 `cli-sessions`，便于跨命令继续操作。同一操作系统用户可访问该目录的进程属于同一信任边界；CLI 凭证文件不是任务间的系统隔离机制。
- `close` 只关闭所属 tabs。CDP 断线使相关会话失效；Router 重启后不会按标题或 URL 接管遗留页面，遗留页面由用户处理。
- 操作超时且无法确认完成时，暂停该会话后续操作。先检查状态、关闭会话，再决定是否开启新会话；不自动重放点击、输入等可能已经发生的动作。
- 配置、Router 状态、日志和 CLI 凭证位于运行时目录。MultiZen token 从其原有文件或环境变量读取，不复制到 keel 状态文件；审计不记录 token、会话 capability、填入内容或完整页面内容。快照与截图本身仍可能包含页面上的业务数据。

共享同一 profile 的任务必须属于同一信任组。它们共享 cookies、同源 localStorage 和网站账号的服务端状态；某个 tab 退出登录会影响同一 profile 的其他 tab。尤其 Claude CLI 和 Desktop 都使用 `claude` 环境。tab 归属检查保证工具操作路由，不提供账号隔离或操作系统隔离。保留宿主 shell 或其他浏览器工具时，规则也不能从系统层阻止绕过。

导航仅接受 HTTP/HTTPS，已知 Router、MultiZen MCP 和 CDP 控制端点及常见 loopback 别名会被拦截。受管页面的 HTTP 请求、重定向，以及可识别 opener 的弹窗首次 HTTP 请求均经过检查；临时 context 请求路由可能影响共享 context 的 HTTP 缓存，这是运行时行为，不会写入 MultiZen 的 profile 配置。

已完成接管的页面会拦截指向控制端点的 WebSocket；弹窗在 Playwright 接管前由最早执行的内联脚本发起的 WebSocket，以及 service worker 流量不在此保护范围内。DNS 重绑定和未托管页面也不受完整约束。这是控制端点导航保护，不是完整网络沙箱。网页文字、链接、弹窗和截图都是不可信数据，不能作为更改工具边界或泄露凭证的授权。

首版不提供任意 JavaScript、原始 CDP、其他 profile 的访问、cookies 导出、文件上传下载接口或 profile 管理。快照聚焦当前页主文档，最多 200 个交互元素和约 16000 个字符；复杂 iframe、扩展界面及特殊网页需要后续能力扩展。

## 排错与开发

| 现象 | 处理 |
| --- | --- |
| MultiZen MCP 无法连接或鉴权失败 | 确认 MultiZen 正在运行、本机 MCP 已启用、token 文件可读；如设置了覆盖变量，检查其是否有效，不输出 token |
| 设置端口与 `mcpUrl` 不一致 | 确认 MultiZen 的 MCP 端口，更新 keel 配置，协调会话后重启 Router |
| profile 不存在或名称重复 | 在 MultiZen 检查已有 `codex`、`claude` 环境；已固定的 ID 不会按名称自动替换，重绑定需要明确调整本地配置 |
| `SESSION_NOT_OWNED` / 会话失效 | 使用当前 MCP 实例创建的会话，或同一 CLI 状态目录；失效后新开会话 |
| `STALE_REF` | 获取当前 tab 的新 snapshot 后重新选择元素 |
| `OPERATION_TIMEOUT` / `SESSION_UNAVAILABLE` | 检查状态，关闭失效会话；确认原动作结果再决定后续操作 |

```powershell
pnpm typecheck
pnpm test
pnpm build
```

另有可选的真实浏览器测试夹具：

```powershell
pnpm test:browser
```

该测试使用一次性的 Chrome 数据目录和模拟 MultiZen MCP，覆盖真实 CDP、页面操作、重定向、弹窗、CLI 子进程和 MCP 图片响应；它不连接你的 MultiZen 或个人 Chrome profile。Windows 默认使用已安装的 Chrome，其他位置可用 `KEEL_TEST_CHROME` 指定可执行文件。真实 MultiZen 联调另行记录，不能由这个夹具代替。

相关客户端的 `doctor.ok` 为 `true` 后，可运行 `pnpm test:live`。它在已有绑定环境中打开受控本地测试页，验证会话及 keel stdio MCP 闭环，最后只关闭测试 tabs，保留共享 profile。这项测试会实际使用你的 MultiZen 环境；token 或 profile 不可用时会在启动浏览器前退出。

源码按 Provider、会话引擎、URL 策略、本地 Router、客户端以及 CLI/MCP 适配层分工。测试使用受控模拟接口验证协议、所有权与生命周期；自动化测试通过不等于真实 MultiZen 联调通过。实际机器与 Codex 新任务的验收结果应单独记录。

本次已执行的检查及待验收事项见 [中文验收记录](VALIDATION.zh-CN.md)。在其他工作区创建的任务不会自动加载本项目的 `.codex/config.toml`；应在相应客户端配置层合并生成的 entry。配置文件生成、客户端注册成功和真实浏览器联调通过是不同的验收步骤。
