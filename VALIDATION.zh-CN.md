# 可移植配置与 Claude 接入验收

[English](VALIDATION.md) | [简体中文](VALIDATION.zh-CN.md)

日期：2026-09-23。环境：Windows、Node.js 24、MultiZen 0.3.1、Claude Code 2.1.259。

## 客户端与环境绑定

| 客户端入口 | MultiZen 环境 | 状态 |
| --- | --- | --- |
| `codex` | 已有 `codex` | 独立绑定，诊断通过 |
| `claude-cli` | 已有 `claude` | 用户级 MCP 已注册；Claude CLI 检查显示 Connected |
| `claude-desktop` | 已有 `claude` | 连接文件已生成，原生 stdio 入口与真实环境联调通过；Desktop 应用本身尚未接入 |

两个 Claude 客户端复用同一浏览器连接，各自的会话凭证和 tabs 分开。Codex 使用另一条 profile 连接。初始化只读取现有 profile，并将解析后的真实 ID 固定到用户运行配置；没有新建或修改 MultiZen profile。

## 路径清理

- 源码、版本化模板和说明文档不包含本机用户名、项目盘符路径或真实 profile ID。
- 示例按 `codex` / `claude` 名称绑定；token 和 settings 路径根据当前用户环境派生。
- `integration` 命令根据当前 Node 和安装模块位置生成客户端配置，无调用者工作目录依赖。
- 实际客户端配置需要绝对路径，生成结果保存在用户运行目录的 `integrations/`；项目本机 `.codex/config.toml`、`.mcp.json` 和本机 integrations 输出已忽略，不作为源码提交。
- 本机已生成 `codex.toml`、`claude-cli.json`、`claude-desktop.json`。Claude Desktop 文件仅准备在 keel 用户目录，没有创建或覆盖 Desktop 应用配置。
- 移动安装目录或 Node 位置后应重新生成并更新客户端注册。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 10 个测试文件，195 项通过 |
| `pnpm build` | 通过 |
| 双浏览器隔离夹具 | 通过：Codex 单独浏览器，两个 Claude 客户端共用另一浏览器，原有页面保留 |
| 三客户端 doctor | 全部通过，别名与真实环境绑定一致 |
| `claude mcp get keel_browser` | User scope，Connected |
| 真实 Claude CLI/Desktop 会话验收 | 两会话、快照、输入、点击、截图、独立关闭与原生 MCP 图片返回通过 |
| 已生成 Desktop 配置的原样启动 | 不指定额外环境变量，成功列出 13 个工具并打开、关闭 `claude-desktop → claude` 会话 |
| 源码与模板路径扫描 | 未发现本机私人路径或真实 profile UUID |

测试覆盖客户端身份不可由工具参数覆盖、跨客户端凭证拒绝、CLI 凭据目录隔离、每个 profile 的独立连接与启动合并、不同浏览器中重复 target ID 的隔离、单 profile 断线隔离，以及关闭失败和迟到页面清理。

图像、脚本与生命周期回归仍覆盖：过期元素引用、直接导航／重定向／popup HTTP 控制端点拦截、PNG 截图、CLI 子进程和原生 MCP。真实测试只操作本次新建的受控页面，不接管人工页面。

## 使用边界

`clientId` 是受信任启动配置选择的路由身份，不是操作系统用户认证。具备宿主 shell 或本机文件权限的进程仍属于同一信任边界。Claude CLI/Desktop 共享 `claude` 的 cookies、同源存储及账号状态；任务 tabs 的独立管理不等于账号隔离。

页面执行仍使用 Playwright/CDP。反检测效果与 MultiZen 原生驱动是否等价未验证；早期 popup WebSocket、service worker、DNS 重绑定等也不构成完整网络沙箱。

源码不修改全局 Codex 配置。Claude CLI 仅新增 `keel_browser` 用户级条目；已有其他 MCP 设置保留。Desktop 应用接入需未来合并准备好的连接条目后再验收。
