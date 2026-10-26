# 客户端接入

桥面向同一台电脑上的 Codex、DeepSeek Harness、Claude Code 或其他 API 客户端，固定连接配置的上游，仅对 AgentRouter 启用恢复。其他供应商正常透传，不因为供应商不同而拒绝启动。需要 Node.js ≥18；不安装后台服务、不读取配置管理工具、不自动改客户端设置。

## 1. 启动桥

### macOS

双击 `scripts/start-macos.command`，或从任意工作目录运行：

```sh
bash "/完整路径/resource-history-bridge/scripts/start-macos.command"
```

### Windows PowerShell

```powershell
& "C:\完整路径\resource-history-bridge\scripts\start-windows.ps1"
```

脚本按自身位置找到 `cli.js`，只询问客户端类型，留空默认 `codex`。已有 `RHB_CLIENT` 或旧 `RHB_HISTORY_MODE` 时不询问；其他显式环境配置继续生效。脚本不询问或保存 key，不修改 PowerShell ExecutionPolicy。如果本机策略禁止脚本，遵循管理员策略，或直接用 Node.js 运行 `cli.js`。

也可在仓库目录直接启动。选好客户端后通常只需这一项：

```sh
RHB_CLIENT=codex node cli.js
```

```powershell
$env:RHB_CLIENT = 'codex'
node .\cli.js
```

| `RHB_CLIENT` | 历史模式 | 上游协议 | 适用请求 |
| --- | --- | --- | --- |
| `codex` | `codex` | `passthrough` | Codex 原生 Responses |
| `harness` | `harness` | `passthrough` | PiAiAdapter 原生 Responses，含 Harness 连续恢复 |
| `claude-code` | `minimal` | `responses` | Messages → Responses 转换 |
| `generic` | `minimal` | `passthrough` | 保守原协议转发 |

直接运行 CLI 而未设置 `RHB_CLIENT`，仍使用 `generic` 的旧兼容默认值；这与交互启动脚本的默认 `codex` 不同。`RHB_HISTORY_MODE`、`RHB_UPSTREAM_PROTOCOL` 等旧显式配置优先于预设，不会被覆盖。

默认上游是 `https://agentrouter.org/v1`。如需官方备用入口：

```sh
RHB_CLIENT=codex RHB_UPSTREAM=https://ps.air-outer.com/v1 node cli.js
```

```powershell
$env:RHB_CLIENT = 'codex'
$env:RHB_UPSTREAM = 'https://ps.air-outer.com/v1'
node .\cli.js
```

上游填 Base URL，不是完整 `/responses` 路径。不能包含用户名、密码、query 或 fragment。按固定目标 URL 自动识别两个 HTTPS 官方主机并启用恢复；其他 HTTP(S) 主机及本机代理仅透传，不需要额外声明或开关，不因为供应商不同而报错。生产使用 HTTPS。默认端口 `8790`，有冲突时设置 `RHB_PORT` 并同步修改客户端地址。

例如设置 `RHB_UPSTREAM=https://api.example.com/v1` 后，桥仍正常启动，但不会删除历史 ID、恢复重试或转换 Messages。这里是占位地址，应改为自己的实际上游；非 AgentRouter 时，客户端与上游须使用同一协议。

桥在前台运行。启动信息显示脱敏上游、`AgentRouter recovery: enabled` 或 `disabled (passthrough)`、历史预设、实际协议、认证来源和监听地址；不显示 key。非 AgentRouter 目标即使选择 `claude-code` 预设，也显示实际 `protocol: passthrough`。确认监听成功后再连接客户端，按 `Ctrl+C` 停止。启动失败不代表桥已运行。

## 2. 配置客户端地址

以下示例使用默认端口。配置由客户端或用户已有管理工具负责，桥不会写入这些文件。

### Codex

桥选 `RHB_CLIENT=codex`。在 Codex 自己管理的 `config.toml` 中选择 provider，保留已有实际模型值：

```toml
model_provider = "local_bridge"

[model_providers.local_bridge]
name = "Local bridge"
base_url = "http://127.0.0.1:8790/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

如果已有 provider，只修改其 `base_url`，不重复创建同名 TOML 表。密钥继续由现有环境管理提供 `OPENAI_API_KEY`，不写进 TOML。配置或客户端环境改变后，从正确环境启动新的 Codex 会话。

`RHB_CLIENT` 是桥的启动设置，不是 Codex 模型名称或 TOML 配置项。Codex 模式只投影已校验的四类 item ID；工具结果必须完整内联并唯一配对，nullable reasoning 原样保留。完整形状见 [Codex 契约](scope.md#codex-历史投影契约)。

### Claude Code

桥选 `RHB_CLIENT=claude-code`，客户端 Base URL 不带 `/v1`：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
```

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8790'
```

保留原模型及现有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 来源，不复制或重写 key。如果配置管理工具提供 Base URL，修改那个来源，避免终端与配置文件两处值冲突。

该预设把 Messages 转为 AgentRouter Responses，再转回 Messages。原生 Responses 请求仍原协议转发。转换会映射认证、token 上限、effort 和部分身份字段，不能笼统称为无损互转；支持与保留边界见 [Messages 转换](scope.md#messages-转换)。

### DeepSeek Harness

桥选 `RHB_CLIENT=harness`。在当前 AgentRouter provider 中设置：

- **Base URL**：`http://127.0.0.1:8790/v1`。
- **协议**：`openai-responses`。
- 保留已有 provider ID、模型 ID、密钥来源、models、headers 和其他 compat 字段。

`llm-pi-ai` 字段示例，仅合并待改字段，不整体替换配置：

```yaml
- id: llm-pi-ai
  config:
    providers:
      ag:  # 保留已有 provider ID
        api: openai-responses
        baseURL: http://127.0.0.1:8790/v1
        compat:
          supportsStrictMode: true
```

`supportsStrictMode: true` 使 PiAiAdapter 可以显式发送 `strict: false`，不是开启严格工具模式。不填时部分 Responses 上游会默认严格化工具 schema，使可选参数变为必填。不要删除其他 compat 配置，也不要写 `config: !!js`。

Harness 模式适配 PiAiAdapter 的原生历史，不修改持久 replayState、签名或 backfill；恢复只在请求副本上进行。原生 `/responses` 另有共享预算的瞬时错误与明确空终态恢复，耗尽后仍返回实际最后响应，客户端仍可能报告原生 `EMPTY_RESPONSE`。其他客户端空完成策略不因此改变。见 [Harness 契约](scope.md#harness-历史投影契约)。

原生 DeepSeek API / `openai-completions` 不是 Responses。配置为其他供应商时本桥只做原协议透传，不启用 AgentRouter 的历史投影或连续恢复；Chat Completions 只有原协议转发能力。

### CCSwitch、Magpie 与其他配置管理工具

只修改工具自己管理的客户端/provider 的 API Base URL 或 endpoint：

| 客户端协议 | 本机地址 | 桥预设 |
| --- | --- | --- |
| Codex / Responses | `http://127.0.0.1:8790/v1` | `codex` |
| Harness / `openai-responses` | `http://127.0.0.1:8790/v1` | `harness` |
| Claude Code / Messages | `http://127.0.0.1:8790` | `claude-code` |

管理工具若只是保存配置，不需要把它变成桥的依赖。若它本身代理或转换请求，桥应放在实际 Responses 链上，并按桥收到的协议选择模式；不能插在 Chat 路径上却期待恢复 Responses 历史。

客户端或 SDK 如果自动补 `/v1`，填根地址 `http://127.0.0.1:8790`，避免重复路径。具体字段位置取决于工具版本，本文不假定某个按钮存在，也不声称所有管理工具已实测。

## 3. 密钥与换 key

推荐继续使用客户端已有密钥管理，不设置 `RHB_API_KEY`。

- 原协议路径保留客户端认证 header。
- Messages → Responses 路径在没有 Authorization 时，将 `x-api-key` 映射为 Bearer；已有 Authorization 不覆盖。
- 客户端提供有效新 key 后，**新的 HTTP 请求**使用新认证，不必重启桥；需要让客户端本身加载新环境或配置。
- 同一 HTTP 请求的所有恢复尝试使用首次接收的认证，不在重试中换 key、上游或会话身份。

只有确实需要桥统一提供认证时，才通过安全的环境管理设置 `RHB_API_KEY`。它覆盖客户端 `authorization`、`api-key` 和 `x-api-key`，默认发送 Bearer。该覆盖值在桥创建时固定；换 key 必须更新启动环境并重启桥，单独修改客户端 key 不生效。`RHB_KEY_HEADER` 可显式选择三种 header，但不是新增供应商支持。

不要把真实 key 写入 URL、脚本、命令历史、示例或仓库。环境变量也可能被同机有权限的进程读取。

## 已有本机代理

可把 `RHB_UPSTREAM` 固定为已有 loopback 代理的 Base URL，此时只做原协议透传。客户端不能在请求 URL 或正文中选择上游。

只有实际发往两个 HTTPS 官方主机的请求才启用恢复，包括 [严格 AgentRouter 400 历史包装](scope.md#严格-agentrouter-历史错误)。即使本机代理最终连接官方入口，桥也不会凭客户端/代理 header 或错误内容猜测其身份；不启用投影、Harness 连续恢复或 Messages 转换。需要代理链内恢复时，应由能识别实际出站目标的代理实现。

## 停止与安全

- 停止桥后，连接它的客户端不能继续请求；需要直连时，在原配置来源改回实际上游的 Base URL。
- 只支持同机桌面应用、CLI 或 SDK，不支持网页 CORS。
- 单机单用户、无独立多用户鉴权；不能防止同机恶意进程消耗统一 key。不要公开端口、远程转发或共享。
- 请求历史和加密 reasoning 会发送给固定上游；协议转换不是隐私保证。
- 当前重构的验证状态与此前平台证据见 [验证记录](scope.md#验证记录与未核范围)，不将旧版 CI 当作本轮通过。
