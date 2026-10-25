# 客户端接入

这个桥面向同一台电脑上的桌面应用或 CLI，不依赖 Mixrouter、Homebrew 或某个固定 Agent。需要 Node.js 18 或更新版本；启动桥不会安装常驻服务，也不会自动修改任何客户端配置。

## 先启动桥

### macOS

双击 `scripts/start-macos.command`，或在终端运行：

```sh
bash "/完整路径/resource-history-bridge/scripts/start-macos.command"
```

脚本根据自身位置查找 `cli.js`，不要求当前目录是仓库。已有环境变量优先；没有 `RHB_UPSTREAM` 时询问真实上游 API Base URL；没有 `RHB_UPSTREAM_PROTOCOL` 时询问 `responses` / `passthrough`，留空默认 `responses`。`responses` 把客户端的 Messages 请求转换为上游 Responses 请求；`passthrough` 不转换。Codex 原生 Responses 请求不需要 Messages 转换。

当前本机 macOS 三个 Node 版本全量各 382/382 通过；启动验证包含不同工作目录、loopback HTTP 转发/转换/恢复、停止和 listener 关闭。Ubuntu/macOS/Windows CI 九个组合也全部通过，见 [本轮验证](verification-resource-only-20261025.json)。旧版 366/366 只保留为历史。

### Windows PowerShell

在 PowerShell 中运行：

```powershell
& "C:\完整路径\resource-history-bridge\scripts\start-windows.ps1"
```

脚本通过 `$PSScriptRoot` 定位仓库父目录，并用 `Get-Command node` 查找 Node.js。上游地址、协议选择与 macOS 相同。脚本不修改 ExecutionPolicy；如果当前策略禁止运行脚本，请遵循本机管理员的策略，或使用 Node.js 直接启动 `cli.js`。

Windows 脚本已在真实 Windows runner 的 Node.js 18/22/24 下运行，全量各 381/381、0 fail/skip；PowerShell 7 与系统 Windows PowerShell 5.1 均实际运行启动测试通过。测试实际启动 `.ps1`、进行 HTTP 转发与 Messages 转换、注入资源错误后恢复、关闭启动进程树并验证端口不再监听；不是仅做语法解析。详见 [CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40151876122)。CI 使用 mock 上游，未运行 Windows 实际 Claude Code/Codex 对真实 AgentRouter。Windows 与 Mac 共用恢复核心；适配完成不以再次复现偶发上游错误为前提。

### 环境与密钥

桥不检测或重试空响应，不会因为空输出额外返回错误。上游地址应为固定 API Base URL，例如 `https://api.example.com/v1`，不是完整 `/responses` 路径；不得在 URL 中填写密钥、用户名、密码、query 或 fragment。占位地址不能直接用。

默认保留客户端现有密钥，脚本不询问、不保存密钥。纯透传路径保留认证 header；Messages → Responses 转换路径把 `x-api-key` 映射为 Bearer，已有 Authorization 不覆盖。无需设置 `RHB_API_KEY`。只有确实需要桥统一提供认证时，才由用户通过安全的环境管理设置 `RHB_API_KEY`；此值会覆盖客户端传来的认证 header。不得把真实密钥写入脚本、本文示例或配置文件。

如果希望不再询问，可提前设置非敏感变量：

```sh
export RHB_UPSTREAM=https://api.example.com/v1
export RHB_UPSTREAM_PROTOCOL=responses
```

```powershell
$env:RHB_UPSTREAM = 'https://api.example.com/v1'
$env:RHB_UPSTREAM_PROTOCOL = 'responses'
```

桥始终在前台运行，等待 CLI 输出监听地址后再连接客户端；按 `Ctrl+C` 停止监听。不要将启动失败误认为已运行。下面的地址基于默认 `127.0.0.1:8790`；如用户显式改变监听地址或端口，客户端地址也需对应调整。

## Codex

在 Codex 自己管理的 `config.toml` 中添加或选择一个 provider，保留实际模型值不变：

```toml
model_provider = "local_bridge"

[model_providers.local_bridge]
name = "Local bridge"
base_url = "http://127.0.0.1:8790/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

在**启动桥的终端**显式设置历史模式，再运行对应启动脚本；它不是 Codex `config.toml` 的配置项：

```sh
export RHB_HISTORY_MODE=codex
bash "/完整路径/resource-history-bridge/scripts/start-macos.command"
```

```powershell
$env:RHB_HISTORY_MODE = 'codex'
& "C:\完整路径\resource-history-bridge\scripts\start-windows.ps1"
```

库接入对应 `createBridge({ upstream: process.env.RHB_UPSTREAM, historyMode: 'codex' })`。默认 `minimal` 仍拒绝 `message.id` 的恢复；`codex` 只允许删除已校验的 `message`、`reasoning`、`function_call` 的 `id`，保留 `additional_tools`、custom 调用/结果的 `id`。该模式仅在已知跨资源错误、未提交输出时触发，不预先改写请求；完整内容、schema、phase/status 与工具配对要求见 [投影契约](scope.md#codex-历史投影契约)，不承诺所有 Codex 历史类型。

不要重复创建同名 TOML 表。若已有 provider，可只修改该 provider 的 `base_url`，保留其余必要配置。密钥由用户现有环境管理提供 `OPENAI_API_KEY`，不填入 `config.toml`；已有 `model` 设置继续使用原模型，不改成桥的名称。修改后从包含该环境变量的终端启动新的 Codex 会话。

## Claude Code

将 Claude Code 使用的 Base URL 指向本机桥，不带 `/v1`：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
```

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8790'
```

保留原模型及现有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 来源，不复制或重写密钥。如果已有配置管理工具提供 Base URL，请修改那个来源，避免终端与配置文件两处值冲突。

当上游是 Responses 服务时，桥启动环境必须设置 `RHB_UPSTREAM_PROTOCOL=responses`；上述启动脚本默认选择这个模式。它负责 Messages 与 Responses 转换，不能把 Responses-only 上游当成原生 Messages 服务使用。若上游本身原生支持 Messages，则可选择 `passthrough`。

## CCSwitch / Magpie 与其他配置管理工具

只修改对应工具自己管理的 provider 或客户端条目的 API Base URL / endpoint，不更改模型与密钥，不通过本组件自动改写工具配置：

- 管理 Codex / Responses 客户端：`http://127.0.0.1:8790/v1`，继续使用 Responses 协议。
- 管理 Claude Code / Messages 客户端：`http://127.0.0.1:8790`，桥侧选择与实际上游对应的 `RHB_UPSTREAM_PROTOCOL`。

界面名称、字段位置与持久配置来源取决于工具版本；本文不假定存在某个按钮，也不宣称上述工具已实测。客户端若自行追加 `/v1`，填写根地址 `http://127.0.0.1:8790`，不要重复追加。

## 使用边界

- 只支持同机桌面应用、CLI 或 SDK。桥不提供浏览器 CORS，并拒绝浏览器来源 header；网页不是受支持客户端。
- 这是单机单用户桥，没有独立多用户鉴权。不得公开监听、做远程访问、SSH/容器端口映射或共享给其他用户。
- 客户端原请求、历史和加密 reasoning 材料会发送给用户配置的上游。协议转换不代表上游隐私保证。
- 不自动更换模型、上游、密钥或 session，不承诺所有供应商及客户端组合兼容。先用不敏感的小会话验证真实上游和客户端。
- 停止桥后，连接它的客户端不能继续请求；需要恢复原服务时，由用户在原配置来源改回原 Base URL。
