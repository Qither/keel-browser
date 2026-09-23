# keel-browser 插件

[English](README.md) | 简体中文

一层薄壳，用于把 `keel_browser` MCP 服务器注册到 Claude Code。实现位于已发布的 npm 包中；插件本身只固定版本与客户端身份。路由、会话与安全模型见[项目 README](../../README.zh-CN.md)。

## 前置条件

插件启动的是本地进程，因此运行 Claude Code 的机器仍需要：

- Node.js 22.18 或更高版本，供 `npx` 运行该包
- 正在运行且已启用原生 MCP 端点的本地 MultiZen 应用
- MultiZen 中已存在名为 `claude` 的配置文件

插件不创建配置文件，也不修改任何 MultiZen 设置。在不启动浏览器的情况下诊断环境：

```powershell
npx -y keel-browser@0.1.0 doctor --client claude-cli
```

## 安装

```
/plugin marketplace add Qither/keel-browser
/plugin install keel-browser@keel-browser
```

服务器注册名为 `keel_browser`，提供与 CLI 入口相同的 13 个 `browser_*` 工具。会话归属于创建它的 MCP 进程：先打开会话，只操作其返回的标签页，任务结束后关闭会话。

## 版本固定

`.mcp.json` 固定了确切的包版本，使一次插件发布对应一个实现版本。发布新的包版本时，同时提升 `.claude-plugin/plugin.json` 中的 `version` 与 `.mcp.json` 中固定的版本号。

## 原生 Windows

若在原生 Windows 上因无法直接启动 `npx` 而导致插件服务器启动失败，请将 `.mcp.json` 中的条目改为 `"command": "cmd"`，并使用 `"args": ["/c", "npx", "-y", "keel-browser@0.1.0", "mcp", "--client", "claude-cli"]`。
