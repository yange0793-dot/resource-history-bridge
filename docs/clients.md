# 客户端接入

这个桥面向同一台电脑上的桌面应用或 CLI，不依赖 Mixrouter、Homebrew 或某个固定 Agent。需要 Node.js 18 或更新版本；启动桥不会安装常驻服务，也不会自动修改任何客户端配置。

## 先启动桥

### macOS

双击 `scripts/start-macos.command`，或在终端运行：

```sh
bash "/完整路径/resource-history-bridge/scripts/start-macos.command"
```

脚本根据自身位置查找 `cli.js`，不要求当前目录是仓库。已有环境变量优先；没有 `RHB_UPSTREAM` 时询问真实上游 API Base URL；没有 `RHB_UPSTREAM_PROTOCOL` 时询问 `responses` / `passthrough`，留空默认 `responses`。`responses` 把客户端的 Messages 请求转换为上游 Responses 请求；`passthrough` 不转换。Codex 原生 Responses 请求不需要 Messages 转换。

当前 Harness 修订在本机 macOS 的 Node.js 18.20.8、22.23.3、24.18.0 全量各 410/410、0 fail/skip；见 [Harness 验证](verification-harness-20261025.json)。此前资源恢复修订的 Ubuntu/macOS/Windows CI 九个组合各 382/382，见 [资源恢复验证](verification-resource-only-20261025.json)，不代替当前 Harness 修订的平台验证。启动验证包含不同工作目录、loopback HTTP 转发/转换/恢复、停止和 listener 关闭；旧版 366/366 只保留为历史。

### Windows PowerShell

在 PowerShell 中运行：

```powershell
& "C:\完整路径\resource-history-bridge\scripts\start-windows.ps1"
```

脚本通过 `$PSScriptRoot` 定位仓库父目录，并用 `Get-Command node` 查找 Node.js。上游地址、协议选择与 macOS 相同。脚本不修改 ExecutionPolicy；如果当前策略禁止运行脚本，请遵循本机管理员的策略，或使用 Node.js 直接启动 `cli.js`。

此前资源恢复修订的 Windows 脚本已在真实 Windows runner 的 Node.js 18/22/24 下运行，全量各 382/382、0 fail/skip；PowerShell 7 与系统 Windows PowerShell 5.1 均实际运行启动测试通过。测试实际启动 `.ps1`、进行 HTTP 转发与 Messages 转换、注入资源错误后恢复、关闭启动进程树并验证端口不再监听；不是仅做语法解析。最新已完成 [CI 40153989577](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40153989577) 的九个组合均为 382/382；此前 [CI 40151876122](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40151876122) 的 381/381 保留为历史。两轮 CI 使用 mock 上游，未运行 Windows 实际 Claude Code/Codex 对真实 AgentRouter。当前 Harness 修订尚未推送或运行 Windows CI；虽已新增 Windows 启动入口的 Harness 模式测试，不将测试存在记为 Windows 执行通过。Windows 与 Mac 共用恢复核心，但此前平台适配证据不代替新增 Harness 修订的验证。

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

## DeepSeek Harness

Harness 使用 `openai-responses` 的 PiAiAdapter 路由不需要 Messages 转换。原生 DeepSeek API / `openai-completions` 路由并不是 Responses：本桥只透传它们，不能用 Responses 历史恢复修复所有渠道错误。先在启动桥的环境中选择 `RHB_HISTORY_MODE=harness`；保留默认 `passthrough` 即可：

```sh
RHB_UPSTREAM=https://api.example.com/v1 \
RHB_UPSTREAM_PROTOCOL=passthrough \
RHB_HISTORY_MODE=harness \
node cli.js
```

Windows 使用相同环境变量与 `scripts/start-windows.ps1`。上游填写当前渠道真实 Base URL，`api.example.com` 仅为占位符。

适配不需要修补 Harness 安装文件或重现偶发 Azure 错误。验证脚本 `node scripts/verify-harness.mjs` 使用安装版 PiAiAdapter 的公开原生 API 对本机 loopback mock 上游；PiAiAdapter 0.2.1-rc.1 / pi-ai 1.1.0 在 Node.js 24.18.0 完成 90 项检查、14 次请求、0 失败，两次只读算术工具实际执行，最终返回 `RESULT_42`。检查原生 replayState/签名、encrypted reasoning 与 backfill、call_id、strict:false 和 headers 保留，首请求字节不变，以及资源错误后同一投影的重复重发。详见 [Harness 验证](verification-harness-20261025.json)。这不是完整 Harness GUI 或真实 AgentRouter 实跑。需 Node.js 满足安装版 PiAiAdapter 要求（当前为 ≥22.19）；可用 `RHB_HARNESS_MODULES` 指定其 `dsh/node_modules` 路径。脚本不读取用户 profile 或密钥，也不调用真实渠道；普通桥本身仍只要求 Node.js ≥18。

Harness 当前 provider 的 **Base URL** 填 `http://127.0.0.1:8790/v1`，协议选 **`openai-responses`**；保留原 provider ID、模型 ID 和已有密钥来源，避免换 provider 导致客户端将历史当成跨渠道重放。桥不替换模型，不扫描或托管 Harness 配置。

原生 `llm-pi-ai` 的对应字段示例（只展示待设置的字段，不是整份配置）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      ag:  # 示例：保留已有 provider ID
        api: openai-responses
        baseURL: http://127.0.0.1:8790/v1
        compat:
          supportsStrictMode: true
```

`supportsStrictMode: true` 表示 PiAiAdapter 可以发显式 `strict: false`，并非开启严格工具模式；不填时某些 Responses 上游会默认严格化工具 schema，使本应可选的子代理参数变为必填。合并到现有 provider，不删除已有 models、headers、apiKeyEnv 或其他 compat 字段；不要整体替换 `config`，也不要写 `config: !!js`。

`harness` 模式接受安装版 PiAiAdapter 的普通助手文本 ID、encrypted reasoning、function call/result，以及没有 item ID 的 custom 调用/结果和 inline additional_tools。恢复只移除已校验的 message/reasoning/function_call 顶层 ID；保留加密材料、call_id、工具参数、结果和已有 custom/additional ID。第一次请求原字节转发，不修改 Harness 持久会话或 replayState。具体规则见 [Harness 契约](scope.md#harness-历史投影契约)。

安装版 Harness 自己会把合法空 completed 映射为 `EMPTY_RESPONSE`；桥仍原样转发这类完成，不新增空响应检测或修改 Harness 的原生策略。

模型选择或子代理候选池接入，不等于已经具备 Azure item 历史恢复。恢复桥应放在实际 Responses 请求链上；不把它插在 Chat Completions 路径上并期待修复 Responses 错误。本文不自动修改用户现有配置或重启服务。

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
