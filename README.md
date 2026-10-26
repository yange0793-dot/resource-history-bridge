# resource-history-bridge

独立运行的本机 API 桥，支持 Codex 与 DeepSeek Harness 的原生 Responses 请求，以及 Claude Code 的 Messages → Responses 转换。Codex 独立使用需在桥侧设置 `RHB_HISTORY_MODE=codex`；这不是客户端的模型名称。可作为 Node.js 纯库使用，不依赖 Mixrouter、模型管理工具、某个 Agent 或第三方 npm 包，不自动修改客户端配置或持久历史。

## Azure 跨资源历史恢复

### Azure 跨资源历史错误

仅在 Responses 上游明确返回下面的已知错误、且尚未向客户端提交输出时，执行一次最小历史投影；投影后再遇同类资源错误，继续重发同一投影请求，不再次删除字段：

> The requested item was created under a different Azure OpenAI resource.

原生 Responses 第一次发送原始 JSON 请求字节；默认 `minimal` 模式的恢复请求只删除 `input` 中 `reasoning.id` 和 `function_call.id`。显式 `codex` / `harness` 模式还允许删除符合各自完整性校验的 `message.id` 与 `function_call_output.id`；工具结果必须完整内联并与调用唯一配对，推理项的 `content: null` 原样保留。所有模式都保留 `encrypted_content`、工具 `call_id`、名称、参数、工具结果、文本、模型及其他字段，不换上游、模型、密钥或会话身份。

此外，固定上游主机为 `ps.air-outer.com` 或 `agentrouter.org` 时，HTTP 400 的严格纯 `{error}` 包装若恰好匹配 `Upstream rejected the request as invalid [trace_id=…]`，也可使用同一安全投影与资源重试预算。它不是所有 400 的重试规则，不证明笼统错误的 Azure 内因；要求 `type: invalid_request_error`、`param: ""`、`code: null`，不接受额外输出或 typed SSE 包装。无需安装 Mixrouter，也无需为 Codex 打开 Harness 的泛化 400 或空响应策略。

检测 HTTP 400 JSON、提交前已知 SSE 错误，以及 AgentRouter 的一种实测包装：HTTP 400 的响应头为 `text/event-stream`、正文却是完整 JSON。后者必须在有界缓冲中完整、严格解析并正常结束，才参与恢复。

默认 `minimal` / `codex` 与 Messages 转换只针对已知资源错误与上述严格 AgentRouter 历史错误恢复。`harness` 原生 Responses 另启用下述连续运行策略；认证、权限、schema、内容过滤错误始终不做盲目重放。

**证据边界：**一次 AgentRouter 工具续接对照中，移除两类 ID、保留加密 reasoning 和工具配对后返回预期 `RESULT_42`。这不证明所有历史类型可移植。桥仍拒绝带 `previous_response_id`、`conversation`、`item_reference`、非对象历史项、工具缺配对、其他未经支持类型的顶层 item ID 或没有可投影 ID 的恢复。默认 `minimal` 模式下，普通助手的 `message.id` 也在未支持范围；不根据名字猜测其安全性。

显式设置 `RHB_HISTORY_MODE=codex` 可启用 Codex 实验支持的投影：仅移除 `message`、`reasoning`、`function_call`、`function_call_output` 四类 item 的 `id`，继续保留 `additional_tools`、`custom_tool_call`、`custom_tool_call_output` 的 `id`，并严格验证完整内联内容、工具 schema 与工具配对。引用历史、不完整项及其他类型的顶层 item ID 仍拒绝。具体接受形状见 [当前范围](docs/scope.md#codex-历史投影契约)。早期外层 capture 实验在注入已知错误后，仅移除 8 个完整 `message.id`，保留其他字段，由真实 API 返回 `RESULT_42`、Codex 退出 0；这验证候选投影与该上游样本兼容，并非当前桥的直接恢复实验。当前桥 `codex` 模式另由真实 Codex CLI 对本机 mock 的故障注入验证工具结果续接，错误与恢复响应均来自 mock。**两项都不是当前实现对自然 Azure 跨资源故障的实跑，也不构成跨资源恢复率证明**；真实 AgentRouter baseline 成功单独记录。

### DeepSeek Harness 原生历史

`RHB_HISTORY_MODE=harness` 专门适配 PiAiAdapter 的 Responses 历史：普通助手文本、encrypted reasoning 和 function 调用/结果可以一同投影；无 ID 的 inline additional_tools 与 custom 调用/结果也可接受。已有 custom/additional ID 保留，工具配对和会话身份不变，不复用要求这几类 ID 必填的 Codex 契约。

Harness 的 provider 保持原 ID、模型和密钥来源，仅在用户启用时将 `baseURL` 指向 `http://127.0.0.1:8790/v1`，协议为 `openai-responses`；使用 `compat.supportsStrictMode: true` 让工具请求显式发送 `strict: false`、保留可选参数。桥不接管 Harness 原生配置，也不修改持久 replayState。详细接入见 [Harness 说明](docs/clients.md#deepseek-harness)。

### Harness 有界连续运行

`RHB_HISTORY_MODE=harness` 的原生 `/responses` 请求默认自动恢复：408/429/5xx、明确服务/过载错误（包括无 event/type 的纯 `{error}` SSE 帧）、未输出前连接失败或无终态的完整空/仅元数据 SSE EOF，以及完整且明确为空的 `response.failed` / completed。每个输入 HTTP 请求最多10次总调用，transient含首轮最多3次，resource最多10次，共用180秒deadline；本地退避默认250ms起、上限2秒，不压短有效Retry-After。预算用尽返回实际最后一个上游响应，不生成 recovery-exhausted 状态。

泛化400不是瞬时错误；只有无输出、完整显式历史且确有约定资源ID时，最多尝试一次校验通过的副本投影，计入同一预算。认证、权限、schema、内容过滤错误不参与。默认 `on-error` 首请求原字节不变；显式 `RHB_HISTORY_STRATEGY=portable` 可提前投影。任何正文（包括空格）、推理、工具、未知输出或下游提交后都不整轮重放。缓存/session身份不旋转，持久历史不改写。

### 其他客户端空响应策略不变

`minimal` / `codex` 与 Messages 转换默认不因正常完成但没有内容而重试，也不生成空输出422/502。旧 `RHB_RECOVER_EMPTY` / `recoverEmpty` 未恢复接入；Harness 的新策略不等于重新启用全客户端空回修复。

其他客户端的资源恢复在**桥收到的每个HTTP请求内**最多投影一次，默认最多10次上游请求、重试间隔1秒，共用取消信号与总时限。Harness原生Responses按上节共享预算处理。其他客户端仅重复已知的未输出Azure资源错误，投影后的加密材料、工具配对及其余内容保持相同；Messages 已重建为无 item ID 的完整历史时可以直接重发原转换字节。最后一次仍失败就返回实际上游错误，不另造终止性状态。客户端或外层代理重发请求不属于桥内预算；真正的其他错误、截断和不能转换的协议仍如实呈现，不伪造成功或无限重放历史。

## Claude Code 转换复用现有代码

`RHB_UPSTREAM_PROTOCOL=responses` 使 `/messages` 请求通过独立适配层转换为 `/responses`，再将上游响应转回 Messages；Codex 的原生 Responses 请求照常透传。

转换器复用 Mixrouter 的 MIT 许可模块，源文件、版本和许可证记录在 `lib/vendor/NOTICE` 与 `lib/vendor/LICENSE`。运行不需要 Mixrouter，不读取它的配置，也不连接它的端口。

转换路径把 Messages 的 `x-api-key` 认证映射为 Responses Bearer；已有 Authorization 不覆盖。纯透传路径仍保留客户端认证，桥统一密钥选项优先。Messages 的超长 `metadata.user_id` 映射为稳定 SHA-256 标识，避免超过 Responses 的 64 字符限制，不改变客户端原历史。

兼容已实际捕获的 Claude Code SDK 字段：固定 beta 路径、`thinking.display=omitted` 与保留全部思考的 context-management no-op。其他上下文裁剪策略不盲删除；display 在 Responses 中没有等价控制，转换不保证客户端隐藏思考。

只支持明确可表达的 Messages 文本、图像、工具与明文 thinking 形状。与已有转换路径一致，默认不展示无明文的加密 reasoning 项；它不能无损表示在 Messages 中，也不会伪造可回放签名。若合法完成响应仅有 opaque 项，默认省略模式仍正常完成，不新增空输出错误。其他不能表达的内容返回错误，不静默丢弃。工具配对保留，Responses 历史按内容重建、不依赖原生 item ID。原协议透传仍是默认模式，不强制所有供应商进行协议转换。`RHB_REASONING_SHAPE=summary`（默认）或 `content` 控制转换后的 reasoning 历史形状，按真实上游能力选择，不以 Agent 名称猜测。

本组件不是所有协议无损互转器。`/chat/completions` 只支持原协议转发，尚没有 Chat → Responses 转换；`/responses/compact` 不参与资源恢复或空输出恢复。Messages 常见客户端附带的固定 `?beta=true` 可接受，其余 query 不接受。

## 启动

需要 Node.js 18 或更新版本，不需要 `npm install`。

```sh
RHB_UPSTREAM=https://api.example.com/v1 \
RHB_UPSTREAM_PROTOCOL=responses \
node cli.js
```

`api.example.com` 是占位地址，替换为实际 API Base URL，不要填写完整 `/responses` 路径。URL 不允许用户名、密码、query、fragment。Base URL 为 `/v1` 时连接 `/v1/responses`，根路径时连接 `/responses`；按真实入口填写。

默认监听 `http://127.0.0.1:8790`。CLI的协议转换默认关闭；上面的命令或启动脚本显式开启。Harness原生Responses按连续运行策略处理；其他原协议用户与Messages空完成行为保留。

默认接入地址：

- Codex / Responses：Base URL 填 `http://127.0.0.1:8790/v1`。
- Claude Code / Messages：Base URL 填 `http://127.0.0.1:8790`；Responses 上游需开启转换。
- 继续使用原模型和密钥。模型从客户端请求中读取，不设置隐藏槽位。
- SDK 如果自动补 `/v1`，使用根地址，避免重复。

可使用 `scripts/start-macos.command` 或 `scripts/start-windows.ps1`；脚本不保存密钥、不自动修改配置、不安装后台服务。详细接入见 [客户端说明](docs/clients.md)。此前资源恢复修订的 Windows 脚本已在真实 Windows runner 上执行，包含启动、HTTP 转发/转换/恢复与进程树停止后的端口关闭；当前 Harness 修订的 Windows CI 尚未执行，见下方验证记录。

按 `Ctrl+C` 停止。CLI 不接受 argv 或密钥参数。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RHB_UPSTREAM` | 必填 | 固定上游 API Base URL，生产建议 HTTPS |
| `RHB_UPSTREAM_PROTOCOL` | `passthrough` | `responses` 开启 Messages → Responses；否则原协议转发 |
| `RHB_REASONING_SHAPE` | `summary` | 转换时的 reasoning 形状，`summary` / `content` |
| `RHB_HISTORY_MODE` | `minimal` | `codex` / `harness` 投影已校验的 message/reasoning/function_call/function_call_output ID；`harness` 另接受 PiAiAdapter 无 ID 的 inline/custom 形状；保留 additional_tools/custom ID |
| `RHB_API_KEY` | 未设置 | 默认透传客户端认证；设置则覆盖上游认证 |
| `RHB_KEY_HEADER` | `authorization` | `authorization` / `api-key` / `x-api-key` |
| `RHB_USER_AGENT` | 未设置 | 仅显式设置时覆盖出站 User-Agent；默认保留客户端值 |
| `RHB_HOST` | `127.0.0.1` | 仅 `127.0.0.1` / `::1` / `localhost` |
| `RHB_PORT` | `8790` | 1–65535 |
| `RHB_TIMEOUT_MS` | `180000` | 从接收正文到全部尝试结束的总时限；Harness最大180000ms，其他模式保留最大1800000ms |
| `RHB_RESOURCE_ATTEMPTS` | `10` | Harness资源调用上限1–10；其他模式保留1–100 |
| `RHB_TOTAL_ATTEMPTS` | `10` | Harness每输入HTTP请求总调用上限1–10 |
| `RHB_TRANSIENT_ATTEMPTS` | `3` | Harness瞬时调用上限1–3，含原始请求 |
| `RHB_RETRY_DELAY_MS` | Harness `250`，其他 `1000` | Harness退避基数0–2000ms（0仍调度1ms），其他保留固定间隔0–60000ms |
| `RHB_MAX_RETRY_DELAY_MS` | `2000` | Harness本地退避上限1–2000ms；服务端Retry-After不截短 |
| `RHB_RETRY_JITTER_RATIO` | `0.2` | Harness随机扰动比例0–1 |
| `RHB_HISTORY_STRATEGY` | `on-error` | `portable`明确提前投影，不改持久历史 |
| `RHB_GENERIC_400_PROJECTION` | Harness `true`，其他 `false` | Harness无输出、完整可投影历史的泛化400最多一次；true/false/1/0 |
| `RHB_DIAGNOSTICS_PATH` | 未设置 | 有界脱敏JSONL；未设置时关闭 |
| `RHB_DIAGNOSTICS_MAX_BYTES` | `1048576` | 每个诊断文件上限，1–16MiB |
| `RHB_DIAGNOSTICS_MAX_FILES` | `3` | 诊断轮转文件总数1–10 |
| `RHB_REQUEST_LIMIT` | `8388608` | 请求/转换正文上限，最大 64 MiB |
| `RHB_BUFFER_LIMIT` | `65536` | 未提交检查缓冲上限，最大 64 KiB；超限不恢复 |

优先使用客户端已有密钥管理。若需要桥统一提供密钥，在 shell 中安全读入 `RHB_API_KEY`，不写入命令历史、脚本或文件。默认发送 Bearer；直接 Azure 风格可选 `RHB_KEY_HEADER=api-key`。环境提供的密钥覆盖客户端三类认证 header；环境仍可能被同机有权限的进程读取。

## 作为库使用

```js
const { createBridge, projectResponsesHistory, isKnownResourceError } = require('./');

async function main() {
  const bridge = createBridge({
    upstream: process.env.RHB_UPSTREAM,
    upstreamProtocol: 'responses',
    historyMode: 'codex', // Codex 显式历史投影；不需要时保留默认 minimal。
    timeoutMs: 180000
  });
  await bridge.listen(8790);
  // 用完 await bridge.close()，关闭 listener、在途请求和本桥 socket。
}
```

库不隐藏读取环境变量，选项须显式传入；允许 `listen(0)` 分配临时端口。`projectResponsesHistory` 返回新对象而不修改原件；调用纯投影库时，由调用方负责提交边界和重试预算。

## 提交与安全边界

错误检查有界。一旦发出正文、思考、工具或无法安全解释的事件，不透明重放。原协议保留保守SSE提交边界；未知/坏帧或缓冲超限立即透传并禁用恢复。转换路径截断/坏协议如实报错；合法空完成正常结束、不重试。Harness原生Responses的明确空终态使用有界transient预算，最后实际响应不被改造成额外错误。

这是没有独立鉴权的**单机单用户**桥，只监听 loopback、检查 Host、拒绝浏览器 Origin/Sec-Fetch-Site、不启用 CORS。固定上游，客户端不能从 URL/正文选择代理目标。不能隔离同机恶意进程或其他用户；统一密钥可能被能够访问端口的本机进程消耗。不要通过端口映射、远程转发将它公开。

历史和加密推理材料会发送给配置的上游；加密字段不意味着上游不可读。日志不记录密钥、正文或加密推理。上游错误作为 API 响应返回给客户端，属于正常转发；不把错误伪装为空答。

## 验证

2026-10-26 独立同步修订加入 Codex 带 ID 标准工具结果与 nullable reasoning 的校验投影，以及严格 AgentRouter 400 恢复。以下 2026-10-25 数字均是历史版本证据，不代替同步修订的结果；本轮实际结果另见 `docs/verification-codex-parity-20261026.json`。安装版 Codex 复制历史对本机故障 mock、安装版 Harness adapter 与跨平台 CI 分别记录，不把 mock 恢复声称为自然上游故障实跑。

```sh
node --test
```

单测使用loopback mock、不需要真实密钥。覆盖历史不可变/工具配对/身份保留、JSON/SSE包装、资源与瞬时恢复预算、输出后禁止重放、Harness空终态有界重试/其他客户端空响应不重试、终态独有载荷、取消/超时、转换、CLI及脱敏日志。

DeepSeek Harness另提供 `node scripts/verify-harness.mjs`，直接使用本机安装版PiAiAdapter的公开原生API发请求，经桥连接loopback mock。此前Azure-only修订的PiAiAdapter0.2.1-rc.1 / pi-ai1.1.0在Node.js24.18.0完成90项检查、14次请求、0失败；这些数字不代表新增连续运行修订。脚本已更新为Harness泛化400单次投影与空终态有界恢复；当前同版结果见 `docs/verification-harness-recovery-20261025.json`。旧验证中两次只读算术工具实际执行，最终得到 `RESULT_42`。验证原生 replayState/签名、encrypted reasoning 与 backfill、call_id、strict:false 和 headers 保留，默认第一次请求字节不变；明确资源错误或受限泛化400候选后移除message/reasoning/function_call ID，重复同类资源错误重发同一投影。它不读取用户 profile/密钥、不修改 Harness 安装文件；没有安装依赖就明确失败，不将未运行伪记为通过。安装版与源码哈希记录在 [Harness 验证](docs/verification-harness-20261025.json)。这是安装版 adapter 对 mock 的验证，不是完整 Harness GUI 或真实 AgentRouter 实跑；Harness 原生空响应策略保持不动，普通跨平台单测不依赖安装 Harness。

`node scripts/verify-harness-parity.mjs` 是新增原生Responses边界的定向安装版验证：无终态的完整空/仅元数据SSE EOF与无 event/type 的纯 `{error}` SSE帧在未输出前有界恢复；耗尽后保持最后原始SSE；正文/推理/工具输出后不重放。也验证安装版能接受缺少 `output_tokens_details.reasoning_tokens` 的原生usage，桥没有Chat→Responses转换，不补造usage或completed。只连接loopback mock、不读取用户配置或密钥。

真实客户端实验与 mock 测试是不同证据。本轮 macOS 实际 CLI 结果：

- Claude Code → 桥 → AgentRouter：纯文本返回 `CLAUDE_BRIDGE_OK`，Read 工具调用及结果续接返回 `RESULT_42`。
- Codex → 桥 → AgentRouter：未注入故障的 baseline 纯文本及工具调用/结果续接成功。
- 早期 Codex 外层 capture 实验：注入已知资源错误后，实验层仅移除 8 个完整 `message.id`，保留 additional_tools/custom ID、call_id 配对与其他字段；真实 API 的投影请求返回 `RESULT_42`、Codex 退出 0。这是候选投影与真实上游样本兼容证据，不是当前桥的直接恢复验证。
- 真实 Codex CLI → 当前桥 `codex` 模式 → 本机 mock：资源错误注入后完成工具结果续接，属于 CLI 兼容与投影机制证据。mock 同时提供错误和恢复响应，不是真实 AgentRouter 恢复。两项都不是当前实现对自然 Azure 跨资源故障的实跑，不能据此推算跨资源恢复率。
- 加入连续资源重试前的资源恢复修订 → 真实 AgentRouter 的 Codex 注入实验已成功（历史投影函数与当前版本相同）：工具实际执行并得到 `42`；本机注入资源错误后，桥仅删除 7 个约定 `message.id`、保留 custom/additional ID、call_id 和其余字段；真实恢复请求返回非空 completed 与 `RESULT_42`，Codex 退出 0。共 2 次真实 API 请求、1 次本机错误注入。之前被 eastus2 限流挡住的失败记录保留；本次成功仍不等于自然 Azure 故障恢复率。
- 当前修订的原生 Responses 两工具实验：保留 encrypted reasoning、两组 function call/result 与 caller 原 prompt cache key，续接处注入资源错误后桥投影，真实 API 返回 `RESULT_42`。这是小型 API 对照，不是 Codex 的长混合 CLI 历史；后者此前仍有真实资源错误/限流/无细节 invalid_request_error，不能冒称全量恢复。
- 旧版的空响应恢复实验不作为当前功能：2026-10-25 按用户要求移除空响应重试和额外空输出错误；旧验证记录仅保留为历史，不能代替本次验证。

此前资源恢复修订的最新真实 [CI 矩阵 40153989577](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40153989577)：Ubuntu/macOS/Windows × Node.js 18/22/24 九个组合均 **382/382 通过，0 fail/skip**。Windows 两个启动测试实际运行 `.ps1`，验证不同工作目录、普通转发、Messages 转换、资源错误投影恢复、进程树停止和端口关闭；并非仅解析脚本。初轮 Windows 启动环境缺失导致超时，补齐系统环境并使用可用的 PowerShell 后重跑通过；旧失败记录及此前 [CI 40151876122](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40151876122) 的 381/381 结果保留。完整结果见 [资源恢复验证](docs/verification-resource-only-20261025.json)。

此前Azure-only Harness修订在本机macOS Node.js18.20.8、22.23.3、24.18.0全量各410/410、0 fail/skip，见 [旧Harness验证](docs/verification-harness-20261025.json)；不代替新增连续运行修订的同版测试。当前结果见 [连续运行验证](docs/verification-harness-recovery-20261025.json)。当前代码尚未推送或运行Windows CI；虽已新增 Windows 启动入口的 Harness 模式测试，不把测试存在记为 Windows 执行通过，也不以此前 CI 代替当前代码的平台验证。旧版 366/366 和空响应策略仅在 [历史验证](docs/verification-20261025.json) 中存档，不代表当前功能。Windows 与 Mac 复用同一恢复核心，但平台适配与联网客户端证据分别记录。CI 使用 mock 上游，未运行 Windows 实际 Claude Code/Codex 对真实 AgentRouter；不承诺全部供应商、历史类型、管理工具或长期并发。
