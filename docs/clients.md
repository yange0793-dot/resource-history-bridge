# 客户端接入

组件面向同机 API 客户端，固定连接配置的上游，仅对 AgentRouter 启用恢复。默认按请求自动处理，不再选择客户端类型。已有网关可以直接[嵌入恢复核心](architecture.md)，无网关用户可使用自动 HTTP 桥或可选[后台服务](service.md)。其他供应商原协议透传；需要 Node.js ≥18，不读取配置管理工具或自动改客户端设置。

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

脚本按自身位置找到 `cli.js`，不询问客户端或协议。显式环境配置继续生效；不询问或保存 key，不修改 PowerShell ExecutionPolicy。如果本机策略禁止脚本，遵循管理员策略，或直接用 Node.js 运行 `cli.js`。

也可在仓库目录直接启动：

```sh
node cli.js
```

```powershell
node .\cli.js
```

默认自动模式在同一个进程中接受 Responses 和 Messages；原生 Responses 首请求不改写，Messages 在官方 AgentRouter 上按已有适配转换。不靠 User-Agent 或名称选择恢复策略。

`RHB_CLIENT=codex/harness/claude-code/generic` 仍是高级兼容覆盖；`RHB_HISTORY_MODE`、`RHB_UPSTREAM_PROTOCOL` 显式值优先。只有旧显式 historyMode 而未指定客户端时仍保留原 generic 预设，避免改变既有协议接线。自动模式不隐式启用 Harness 空响应/泛化 400 恢复。

默认上游是 `https://agentrouter.org/v1`。如需官方备用入口：

```sh
RHB_UPSTREAM=https://ps.air-outer.com/v1 node cli.js
```

```powershell
$env:RHB_UPSTREAM = 'https://ps.air-outer.com/v1'
node .\cli.js
```

上游填 Base URL，不是完整 `/responses` 路径。不能包含用户名、密码、query 或 fragment。按固定目标 URL 自动识别两个 HTTPS 官方主机并启用恢复；其他 HTTP(S) 主机及本机代理仅透传，不需要额外声明或开关，不因为供应商不同而报错。生产使用 HTTPS。默认端口 `8790`，有冲突时设置 `RHB_PORT` 并同步修改客户端地址。

例如设置 `RHB_UPSTREAM=https://api.example.com/v1` 后，桥仍正常启动，但不会删除历史 ID、恢复重试或转换 Messages。这里是占位地址，应改为自己的实际上游；非 AgentRouter 时，客户端与上游须使用同一协议。

桥在前台运行。启动信息显示脱敏上游、`AgentRouter recovery: enabled` 或 `disabled (passthrough)`、历史预设、实际协议、认证来源和监听地址；不显示 key。非 AgentRouter 目标即使选择 `claude-code` 预设，也显示实际 `protocol: passthrough`。确认监听成功后再连接客户端，按 `Ctrl+C` 停止。启动失败不代表桥已运行。

## 2. 配置客户端地址

以下示例使用默认端口。配置由客户端或用户已有管理工具负责，桥不会写入这些文件。

### Codex

桥保持默认自动模式。在 Codex 自己管理的 `config.toml` 中选择 provider，保留已有实际模型值：

```toml
model_provider = "local_bridge"

[model_providers.local_bridge]
name = "Local bridge"
base_url = "http://127.0.0.1:8790/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

如果已有 provider，只修改其 `base_url`，不重复创建同名 TOML 表。密钥继续由现有环境管理提供 `OPENAI_API_KEY`，不写进 TOML。配置或客户端环境改变后，从正确环境启动新的 Codex 会话。

`RHB_CLIENT` 是桥的启动设置，不是 Codex 模型名称或 TOML 配置项。Codex 的历史 ID 模式只投影已校验的四类 item ID；工具结果必须完整内联并唯一配对，nullable reasoning 原样保留。另有仅在明确 `invalid_encrypted_content` 后尝试一次的[有损 reasoning 降级](scope.md#加密-reasoning-解密失败降级)，不主动删除正常密文或压缩历史。完整形状见 [Codex 契约](scope.md#codex-历史投影契约)。

### Claude Code

桥保持默认自动模式，客户端 Base URL 不带 `/v1`：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
```

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8790'
```

保留原模型及现有 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 来源，不复制或重写 key。如果配置管理工具提供 Base URL，修改那个来源，避免终端与配置文件两处值冲突。

默认自动入口按 `/messages` 端点把 Messages 转为 AgentRouter Responses，再转回 Messages。原生 Responses 请求仍原协议转发；这类请求的明确密文解密错误可按[降级规则](scope.md#加密-reasoning-解密失败降级)恢复。Claude Code 的 Messages thinking.signature 不等同于 Responses encrypted_content，本规则不把普通签名错误当成密文故障，也不修改签名来伪造有效历史。转换会映射认证、token 上限、effort 和部分身份字段，不能笼统称为无损互转；支持与保留边界见 [Messages 转换](scope.md#messages-转换)。

### DeepSeek Harness

桥保持默认自动模式即可恢复约定的资源/密文错误。在当前 AgentRouter provider 中设置：

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

Harness 模式适配 PiAiAdapter 的原生历史，不修改持久 replayState、签名或 backfill；恢复只在请求副本上进行。明确的 `invalid_encrypted_content` 还可触发一次有损 reasoning 降级，保留可读摘要与完整工具历史，并以响应 header 标记；不能重建的压缩历史不删，见 [降级范围](scope.md#加密-reasoning-解密失败降级)。如需原有瞬时错误与明确空终态连续恢复，可显式使用 `RHB_CLIENT=harness`；这不是自动识别的结果。耗尽后仍返回实际最后响应，客户端仍可能报告原生 `EMPTY_RESPONSE`。其他客户端空完成策略不因此改变。见 [Harness 契约](scope.md#harness-历史投影契约)。

原生 DeepSeek API / `openai-completions` 不是 Responses。配置为其他供应商时本桥只做原协议透传，不启用 AgentRouter 的历史投影或连续恢复；Chat Completions 只有原协议转发能力。

### CCSwitch、Magpie 与其他配置管理工具

只修改工具自己管理的客户端/provider 的 API Base URL 或 endpoint：

| 客户端 | 本机地址 | 桥设置 |
| --- | --- | --- |
| Codex | `http://127.0.0.1:8790/v1` | 默认自动 |
| Harness | `http://127.0.0.1:8790/v1` | 默认自动 |
| Claude Code | `http://127.0.0.1:8790` | 默认自动 |

管理工具若只是保存配置，不需要把它变成桥的依赖。若它本身代理或转换请求，优先把恢复核心嵌到实际上游已确定的出站层；不需要再维护 HTTP 桥。独立桥按收到的端点处理，但不能插在 Chat 路径上却期待恢复 Responses 历史。

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

只有实际发往两个 HTTPS 官方主机的请求才启用恢复，包括 [严格 AgentRouter 400 历史包装](scope.md#严格-agentrouter-历史错误)。即使本机代理最终连接官方入口，桥也不会凭客户端/代理 header 或错误内容猜测其身份；不启用投影、Harness 连续恢复或 Messages 转换。需要代理链内恢复时，应由能识别实际出站目标的代理调用 `createRecoverySession`；见[嵌入边界](architecture.md)。核心不启第二个监听，也不会自行读取或修改网关配置。

## 停止与安全

- 停止桥后，连接它的客户端不能继续请求；需要直连时，在原配置来源改回实际上游的 Base URL。
- 只支持同机桌面应用、CLI 或 SDK，不支持网页 CORS。
- 单机单用户、无独立多用户鉴权；不能防止同机恶意进程消耗统一 key。不要公开端口、远程转发或共享。
- 请求历史和加密 reasoning 会发送给固定上游；协议转换不是隐私保证。
- 当前重构的验证状态与此前平台证据见 [验证记录](scope.md#验证记录与未核范围)，不将旧版 CI 当作本轮通过。
