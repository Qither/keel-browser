# 可移植配置示例

[English](README.md) | [简体中文](README.zh-CN.md)

`config.json` 只包含通用默认值和 `codex` / `claude` 名称绑定。没有个人路径或真实 profile ID；省略的 `tokenFile`、`settingsFile` 根据当前用户环境派生。实际机器应运行 `node dist/cli.js init`，将解析出的已有环境 ID 固定到用户运行目录。

在构建后的安装目录生成客户端配置：

```powershell
node dist/cli.js integration codex
node dist/cli.js integration claude-cli
node dist/cli.js integration claude-desktop
```

- Codex 返回 `mcp_servers` 对象和可直接合并的 `toml` 字段。
- Claude CLI / Desktop 返回 `{ "mcpServers": { "keel_browser": ... } }`。注册 CLI 时取 `mcpServers.keel_browser` 这个 entry；Desktop 使用外层 `mcpServers` 结构合并。
- 配置生成不读取浏览器凭证，也不启动 Router 或 MultiZen。生成的命令使用当前 Node 与安装模块的实际绝对路径，启动参数已固定客户端；它不依赖调用者的工作目录。
- 生成结果存放在用户运行目录的 `integrations` 中，或合并到对应用户配置。不要提交这些本机文件。移动安装目录后重新生成并更新客户端注册。

`codex.config.toml` 是生成指引，不是可以直接启用的 MCP 配置；仓库不假设全局安装了 `keel-browser` 命令。
