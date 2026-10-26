# 当前范围

## 运行契约

这是面向 **AgentRouter** 的独立本机组件，适配 Codex 原生 Responses、DeepSeek Harness PiAiAdapter 原生 Responses，以及 Claude Code 的 Messages → Responses。Node.js 核心与 macOS / Windows 启动入口不依赖 Mixrouter、管理工具或第三方 npm 包。

默认固定上游 `https://agentrouter.org/v1`，官方备用入口 `https://ps.air-outer.com/v1`。仅这两个精确匹配的 HTTPS 官方主机默认启用恢复与协议转换。其他固定 HTTP(S) 上游正常启动并原协议透传，不因为供应商不同而报错；不意味着为其提供恢复适配。URL 不得含用户名、密码、query 或 fragment，必须有主机；生产使用 HTTPS。客户端不能通过请求 URL、正文或 header 改变代理目标。

按请求实际发往的固定上游 URL 自动识别，无需声明或额外开关。固定 loopback 上游也仅透传，避免本机多供应商代理被误当作 AgentRouter。不从请求正文、header、错误内容或相似域名猜测供应商，不检查或自动跟踪代理内部路由。固定上游改变后需用新的启动配置重启桥。

透传模式无论客户端预设、portable、generic400Projection 或 automaticRecovery 设置如何，都不投影历史、不重试、不转换 Messages。请求 JSON 字节、模型、历史 ID、加密 reasoning、工具参数/结果及原协议认证均保留；上游状态、响应正文和内容编码直接转发，不进行恢复缓冲或强制 identity 编码。固定 `/messages?beta=true` 的 beta 标记在透传时保留。显式统一 key / User-Agent 覆盖仍按配置生效，HTTP hop-by-hop header 仍按代理规范移除。安全检查、application/json Content-Type 要求、请求上限、超时及传输失败处理仍有效。透传路径不解析或校验 JSON 正文，并可直接转发压缩请求体；启用 AgentRouter 恢复的路径仍要求未压缩的合法 JSON 对象。“不因供应商报错”不表示隐藏上游错误或忽略非法配置。

只绑定 `127.0.0.1` / `::1` / `localhost`，检查 Host、拒绝 Origin / Sec-Fetch-Site、不启用 CORS。它是没有独立多用户鉴权的单机单用户桥，不能隔离同机恶意进程；统一 key 可能被能访问端口的进程消耗。不得公开端口、远程转发或共享给其他用户。

接受 JSON POST `/responses`、`/responses/compact`、`/chat/completions`、`/messages`，也接受这些路径的 `/v1` 前缀。Messages 固定 `?beta=true` 路径可接受：AgentRouter 转换路径不把它传给 Responses，其他目标的 Messages 透传保留该 query；其他 query 不接受。Chat Completions 仅透传；compact 不参与资源或空输出恢复。

## 自动入口与兼容覆盖

CLI 与未设置模式的 `createBridge` 默认 `historyMode:auto`、`upstreamProtocol:auto`，无需客户端选择。按请求端点分派，原生 Responses 按严格实际历史形状校验；Messages 在官方 AgentRouter 上使用已有 Messages → Responses 适配。其他目标始终原协议透传。自动适配不猜测未知供应商能力，也不通过 User-Agent 启用策略。

旧显式配置仍保留。`RHB_CLIENT` 是兼容预设，不是客户端模型名称或 provider ID：

| 预设 | `historyMode` | `upstreamProtocol` |
| --- | --- | --- |
| `auto`（默认） | `auto` | `auto` |
| `codex` | `codex` | `passthrough` |
| `harness` | `harness` | `passthrough` |
| `claude-code` | `minimal` | `responses` |
| `generic` | `minimal` | `passthrough` |

CLI 和启动脚本都不询问客户端。未设置模式时统一默认 auto；仅有旧显式 `RHB_HISTORY_MODE=minimal/codex/harness` 时仍采用 generic 的旧协议默认值。库中显式旧 historyMode 且未指定协议时也保留 passthrough。显式 `RHB_HISTORY_MODE`、`RHB_UPSTREAM_PROTOCOL` 及其他选项优先，不能把预设名当成必然行为而忽略覆盖。纯 `projectResponsesHistory` / `projectEncryptedReasoning` 的无选项默认仍为 minimal；需要自动契约时显式 `{mode:'auto'}`。

启动信息仅显示脱敏上游、自动识别的恢复启用状态、历史预设、实际协议、认证来源与监听地址，不输出凭据。非 AgentRouter 目标实际协议始终为 passthrough，所显示的历史预设不代表投影已启用。桥不自动读取或改写客户端/管理工具的配置，不管理模型池、effort、计费或渠道选择。

### 自动历史契约

自动原生 Responses 校验完整显式 input，不根据客户端名称选择模式。标准 message 需要已知 role、phase 与完整内联数组；无 type 的 user/developer/system 消息支持字符串或完整内联数组；reasoning 需要完整 summary 与可选 nullable content。标准/custom 工具调用结果严格按 call_id、类型、顺序唯一配对，additional_tools 使用完整内联 schema。已有 custom/additional ID 保留，ID 可缺省。

资源 ID 投影只移除校验过的 message/reasoning/function_call/function_call_output 顶层 ID；明文、密文、其他字段和请求身份保持。未知类型或字段即使没有 ID 也不能通过；服务端引用、压缩项、file_id、不完整历史和未完成状态不靠猜测恢复。校验拒绝时自动桥保留实际最后上游错误，不生成原有 minimal 的本地 409。

这个契约只决定历史怎样校验，不启用空终态、瞬时或泛化 400 重试。旧显式 harness 连续恢复策略保持独立。自动 additional_tools 的 schema 外层只接受当前明确支持的字段；如带 defer_loading 等未核字段，首请求不受影响，但错误后拒绝投影并保留实际上游错误。

## 资源恢复与提交边界

已知资源错误为：

> The requested item was created under a different Azure OpenAI resource.

原生 Responses 默认 `on-error` 首请求保留原 JSON 字节。只在可识别的未输出错误、完整可投影历史及剩余预算成立时，创建副本并移除约定 item ID；投影最多一次，之后同类错误重发同一投影字节，不继续删字段。显式 `portable` 可提前投影，也不修改客户端持久历史。

历史 ID 恢复保留 `encrypted_content`、`call_id`、工具名称、参数、输入/结果、文本及其他非投影字段；原生请求的模型、effort、认证和 session/cache 标识不因重试旋转。认证在首次接收的单个 HTTP 请求内固定。Messages 转换的字段映射另见下节，不能把资源恢复的保留规则说成所有协议字段无损。

检测 HTTP 400 JSON、提交前已知 SSE 错误，以及 HTTP 400 `text/event-stream` header 下完整 JSON 正文的实测包装。后者须在有界缓冲内完整严格解析并正常结束。

任何正文（包括空格）、推理、工具、未知内容或下游提交后都不整轮重放；未知/坏帧、部分尾帧、缓冲超限不能触发恢复。转换截断或不能表达的内容如实报错。失败不伪装为空答或成功终态。

`auto` / `generic` / `codex` / Messages 默认资源预算为单个输入 HTTP 请求最多 10 次上游调用、1 秒固定间隔、共用 180 秒总时限与取消信号。只重复约定资源错误；不因普通限流、认证、schema、内容过滤或空完成盲重放。耗尽返回实际最后上游错误；若没有可转发的响应，则呈现传输/超时错误。旧显式 minimal 的不可投影历史可能返回明确本地拒绝错误，而不是删字段兜底。客户端或外层代理另发 HTTP 请求不属于该预算。

### 透明恢复（默认开启）

`transparentRecovery` 默认在 `auto` / `codex` / `harness` 原生 `/responses` 上开启，`minimal` 默认关闭；显式布尔值优先，`minimal` 也可显式开启。`RHB_TRANSPARENT_RECOVERY` 与此对应。`automaticRecovery`（`RHB_AUTOMATIC_RECOVERY`，桥默认仅 `harness`）仍是独立的旧空终态/连续恢复选项，两者共用同一预算：每次输入 HTTP 请求最多 10 次上游调用、transient 含首轮最多 3 次、resource 最多 10 次、180 秒总时限，退避尊重 `Retry-After`。

- 只对**已输出的确定性可重试故障**隐藏重试：官方 AgentRouter 目标的 HTTP 408 / 409 / 临时 429 / 5xx，以及无终态载荷的输出前连接失败。中间错误不交给客户端，耗尽时转发实际最后一次上游响应；本来没有响应时仍呈现传输/超时错误。
- 认证、权限、schema/参数、内容过滤、额度/计费（402 或明确 `insufficient_quota` 等）、上下文超限、策略拦截、泛化 400 一律不重试，按原样返回。
- 合法空完成、无错误细节的 failed empty、仅 lifecycle 的干净 EOF 不因透明恢复重试；这些仍只由显式 `automaticRecovery` 处理。
- Messages → Responses 转换请求不在默认范围，保留旧单次语义；Claude Code 的客户端重试不被桥叠加上第二层。
- 任何正文（含空白）、推理、工具、未知帧或下游提交后都停止重试；只有退出前不携带 `data`/`event`/未知字段的纯 SSE 注释心跳视为传输元数据，不作为输出屏障。其余注释、未知与坏帧仍是屏障。
- 不可投影但完整合法的历史（例如带 id 的已完成 `web_search_call`）按“原字节重试”处理：保留首个请求的精确字节、认证、模型、会话与 cache 身份，不删除内置项 ID，也不声称完成投影。决策以 `projectionSkipped: {reason}` 单独标记，重试原因是 `unprojected_resource_retry`。来源不完整、`item_reference`、服务端引用、工具缺配对、未完成内置项或带未知字段的历史都不进入该回退。
- 显式设置超出透明预算的旧配置（如 `resourceAttempts > 10`、`timeoutMs > 180000`、`retryDelayMs > 2000`）会被识别为旧资源恢复配置，透明恢复在该实例上默认关闭，避免旧部署启动即报错；需要新行为时显式设置 `transparentRecovery: true`。

透明重试只恢复**当前请求**；它不能代替客户端开启下一个 turn。客户端在原生重试耗尽后的自动续跑是独立能力，见[客户端续跑](continuation.md)，需要宿主提供会话状态接口。

### 严格 AgentRouter 历史错误

仅当**直接配置的固定上游 URL 主机**为 `agentrouter.org` 或 `ps.air-outer.com`，HTTP 状态为 400，才接受这条窄规则：

- 外层仅 `{error}`，无其他输出或未知字段。
- error 内恰有 `message`、`type`、`param`、`code`。
- message 完整匹配 `Upstream rejected the request as invalid [trace_id=…]`，trace 为 1–256 个字母、数字或 `._:-`。
- type 为 `invalid_request_error`，param 为空字符串，code 为 `null`。

typed SSE、普通参数错误、权限/认证/内容拦截、额外输出或未知端点不参与。仍要求完整可投影历史、未输出、无未知/部分尾帧；投影一次，后续同类错误重发同字节，复用资源预算与 deadline。校验拒绝或耗尽保留实际最后上游响应。

该规则默认可用，不依赖 Harness 的 `generic400Projection` 开关，但不证明错误内部的 Azure 原因，不是所有 400 的重试规则，也不启用其他客户端空响应恢复。

固定 loopback 代理不满足官方主机条件，即使它实际连接 AgentRouter。所有恢复及 Messages 转换均关闭，仅转发原协议；不存在 trusted-header 或错误内容绕过。Harness 的受限泛化 400 候选也是已识别 AgentRouter 后的策略，不能用于证明代理的官方身份。

## 加密 reasoning 解密失败降级

此路径与历史 item ID 投影分开。默认首请求不改密文，也不凭普通 `invalid_request_error`、通用 `invalid` 包装或错误文本中的 `decrypt` 猜测原因。

- 只在固定官方 HTTPS AgentRouter 目标的原生 `/responses` 上生效，无需供应商声明或额外开关。其他上游、Chat、compact 和原生 Messages 不启用此降级。
- 仅识别完整结构化错误中的 `code: "invalid_encrypted_content"`：HTTP 400 错误封装，或成功 HTTP 状态下明确的 error / response.failed。认证、权限、内容拦截等明确终止原因优先；错误外有输出或未知内容时不恢复。
- 完整显式历史须通过自动实际形状或显式兼容契约的工具配对校验；服务端引用、item_reference、compaction / context_compaction、其他加密项及未知类型不靠删除历史兜底。
- 只在请求副本中删除 `type: "reasoning"` 项的 `encrypted_content` 与该 reasoning 的 `id`。有非空可读 summary / content 文本的 reasoning 保留；否则整项省略。其他 item ID、工具 call_id、名称、参数、结果、模型、effort、认证及 session/cache 身份不动，store/include 不改。
- 这是**有损重新推理**，不是恢复或解密原来的隐藏思维链。原始请求与客户端持久历史不修改。不能重建的仅密文压缩历史返回实际错误，不自动开新会话。
- 每个输入 HTTP 请求最多降级一次，共享现有调用上限、总 deadline 和取消信号，不额外叠加一组重试。再次解密失败即返回实际最后错误。先发生 ID 错误再发生密文错误，或顺序相反，均基于当前请求副本处理，不恢复已经删除的密文。
- 输出、推理、工具、未知帧、部分尾帧、下游提交或有界检查缓冲超限后不整轮重放。未成功验证的降级不改变错误，不生成本地 409。
- 应用降级后的响应带 `x-rhb-recovery: encrypted-reasoning-dropped`；不插入自定义 SSE 事件或伪造完成。开启诊断时记录 `encrypted_reasoning_downgrade` 及有损/计数标记，仍不记录密文、摘要、工具内容或原始错误文本。

这里保留对已知错误的补救能力，不声称 AgentRouter 近期的故障频率，也不保证任意模型接受降级后的 reasoning。`item_not_found`、签名错误、加密工具结果和普通 schema 错误不混入此规则。

设计依据：[Codex 跨模型密文失败报告](https://github.com/openai/codex/issues/17541)、[LiteLLM 加密内容路由事故](https://docs.litellm.ai/blog/responses-api-encrypted-content-incident)及其[有损降级实现](https://github.com/BerriAI/litellm/blob/dddbaa803d6e9fcc862ea7a5412f771cb1ae040e/litellm/router_utils/pre_call_checks/encrypted_content_affinity_check.py)。这些是通用故障与源码证据，不是本桥自然 AgentRouter 故障恢复率证据；[Pi 终态回填修复](https://github.com/earendil-works/pi/pull/6608)解决的是漏采密文，不能代替解密失败恢复。

## Codex 历史投影契约

CLI 选 `RHB_CLIENT=codex`，或保留旧 `RHB_HISTORY_MODE=codex`；库用 `createBridge({ ..., historyMode: 'codex' })`；纯函数用 `projectResponsesHistory(body, { mode: 'codex' })`。

旧 `minimal` 契约只允许移除 `reasoning.id` 和 `function_call.id`，不会自动接受带 ID 的普通 message。`codex` 可移除 `input` 中已校验的 `message`、`reasoning`、`function_call`、`function_call_output` 顶层 `id`；保留 `additional_tools`、`custom_tool_call`、`custom_tool_call_output` 的 ID。

恢复要求非空显式 `input` 对象数组，拒绝 `previous_response_id` / `conversation` 服务端引用、`item_reference`、非对象项、不完整项、其他未经支持类型的顶层 item ID，以及没有可移除 ID 的请求。

| 历史形状 | 接受条件与保留边界 |
| --- | --- |
| `message` | role 为 user / developer / system / assistant，content 为非空内联数组；已有 id 为非空字符串。phase 只可缺省、commentary 或 final_answer，显式 null 拒绝。 |
| 文本内容 | 仅 input_text / output_text，text 必须为字符串。 |
| 图像内容 | input_image.image_url 为带主机 HTTP(S) URL，或完整且数据载荷非空的 data:image URL；不接受 file_id，即使另有 image_url。 |
| `additional_tools` | 保留非空字符串 id；developer role，完整内联 tools schema 数组，每项具有非空名称。 |
| function schema | parameters 为对象，非 null、非数组；不承诺完整 JSON Schema 语义验证。 |
| namespace schema | tools 为数组，递归应用 schema 校验。 |
| custom schema | format 为对象，type 为 text；或 grammar，此时 syntax 为 lark / regex，definition 为非空字符串。 |
| `custom_tool_call` | 保留非空 id / call_id / name，input 为字符串，status 只可缺省或 completed。 |
| `custom_tool_call_output` | 保留非空 id，具有 output 字段，跟在相同 call_id 的 custom 调用之后。 |
| `reasoning` | 完整 summary 数组；可选 content 为 null 或完整 reasoning_text 数组；可选 encrypted_content 为非空字符串。null、明文与加密材料均保留。 |
| 带 ID 的 `function_call_output` | id 为非空字符串；status 只可缺省或 completed；output 为字符串（允许空串）或非空完整内联文本/图像数组，无 file_id；与前面的标准调用唯一配对。无 ID 的既有结果契约不因扩展收紧。 |

function 与 custom 调用都需唯一非空 call_id、非空名称、字符串参数或 input。每个结果须在对应调用之后、匹配调用类型、恰好一次；所有调用必须有结果。保持 schema 与配对不等于所有历史可跨资源移植，未支持形状不会通过删除加密材料或额外 ID 兜底。

## Harness 历史投影契约

CLI 选 `RHB_CLIENT=harness`，或旧 `RHB_HISTORY_MODE=harness`；库用 `historyMode: 'harness'`。面向 `openai-responses` PiAiAdapter，不改变 minimal / Codex 契约。

- 默认首请求原字节不变；错误后的投影只移除已校验的 message/reasoning/function_call/function_call_output ID，带 ID 的标准结果须完整内联且唯一配对。显式 portable 可提前投影。
- 保留 encrypted_content、call_id、参数/结果、已有 custom/additional ID、原生模型/认证及会话 header；不修改持久 replayState、签名或 backfill。
- 有类型 message 需完整 role / 内联 content；phase 为已知值，status 只可缺省或 completed。无类型 easy message 仅接受已知原生形状：developer/system 字符串 content，或 user 内联 content 数组，不能有待猜测的顶层 ID。
- inline additional_tools 需 developer role 和完整 schema；ID 可缺省，已有 ID 保留。
- custom 调用/结果 ID 可缺省，已有 ID 需非空并保留。调用有唯一 call_id、名称和字符串 input，status 只可缺省或 completed；结果按类型与顺序配对。
- 服务端引用、item_reference、工具缺配对及其他类型顶层 ID 拒绝；strict:false 和可选工具参数保持原样。

### Harness 连续恢复

默认只对已识别 AgentRouter 目标的 `harness` **原生 `/responses`**启用：

- 408 / 429 / 5xx、明确服务/过载错误，包括无 event/type 的纯 `{error}` SSE 帧。
- 输出前连接失败，或完整空/仅元数据、无终态的 SSE EOF。
- 完整且明确为空的 response.failed / completed。
- 无输出、完整显式历史且确有约定资源 ID 的泛化 400，最多一次校验投影；不是瞬时错误重分类，认证/权限/schema/内容过滤不参与。

每个输入 HTTP 请求总调用上限 10 次；transient 含首轮最多 3 次，resource 最多 10 次，共享最大 180 秒 deadline。默认本地退避 250ms 起、上限 2 秒，尊重有效 Retry-After、不压短它。输出或未知内容后不整轮重放，耗尽保留实际最后响应，不生成 recovery-exhausted 或额外空输出状态。

`codex` / `generic` / Messages 默认不因合法空完成重试。旧 `RHB_RECOVER_EMPTY` / `recoverEmpty` 不接入，Harness 策略不是恢复旧全客户端空回功能。外层 Harness 的另一次 HTTP 请求不计入桥内预算。

## Messages 转换

仅在识别到 AgentRouter 目标时，默认 auto 协议、旧 `RHB_CLIENT=claude-code` 或显式 `RHB_UPSTREAM_PROTOCOL=responses` 将 `/messages` 转为 `/responses` 并转换回 Messages。显式 passthrough 不转换。其他目标始终保留 Messages 协议，客户端与上游须原协议兼容。转换复用 MIT 许可模块，来源版本和许可证见 `lib/vendor/NOTICE`、`lib/vendor/LICENSE`；运行不需要 Mixrouter，不读取其配置或端口。

转换是受约束的字段映射，不承诺模型/协议身份完全无损：

- 从客户端 model 派生出站模型，不选择隐藏模型或模型池；现有转换器会去掉末尾方括号后缀（如 `[1M]`），不能宣称模型字符串原样保留。Messages max_tokens 映射 max_output_tokens；支持的 output_config.effort 映射 reasoning effort，但转换器已知不支持 effort 的模型例外不发送该字段。
- 上游使用 stream:true、store:false、include:[reasoning.encrypted_content]；下游按客户端 stream 选择流式或收集为 JSON。system 文本映射 instructions，工具 schema 显式 strict:false，tool_choice 与并行开关作协议映射。
- 保留可表达的文本、用户图像、普通对象-schema 工具、工具调用/结果配对及非空明文 thinking；工具名称、参数和 call_id 对应关系不因恢复改写。Messages cache hints、defer_loading 和原 thinking 签名没有等价回放；已声明工具的 tool_reference 转为工具名文本，而不是声称块类型原样保留。
- Messages x-api-key 在无 Authorization、无桥统一 key 时映射 Bearer；已有 Authorization 不覆盖。统一 key 按明确配置覆盖。
- metadata.user_id 最多 64 字符时保留，超长时映射稳定 SHA-256；这不是完整身份字段透传。
- 支持固定 beta 路径、thinking.display=omitted，以及保留全部 thinking 的 context-management no-op；display 没有 Responses 等价控制，不保证 UI 隐藏思考。其他裁剪策略不盲删除。
- 默认 summary reasoning 形状，可显式选 content。原生 Responses 的加密 reasoning 保留规则不等于 Messages 可无损回放 opaque 项。
- 无明文的 encrypted-only reasoning 默认省略，不把密文伪造成 thinking 或签名；合法完成仅有 opaque 项时仍正常完成，不新增空输出错误。

不能表达的内容返回错误，不静默丢弃；注释/引用、平台工具、不能精确表示的错误工具结果等不由删字段兜底。Responses 历史按完整 Messages 内容重建，不依赖原生 item ID；在已知资源错误、没有可投影 ID 时可按预算重发原转换字节。

## 认证、库与高级选项

### 认证生命周期

默认每个新 HTTP 请求转发客户端当前认证；换成有效新 key 后不必重启桥，但客户端须加载自己的新环境/配置。同一请求的重试冻结首次认证。

显式 `RHB_API_KEY` 在 bridge 创建时固定，覆盖三类客户端认证 header；更新覆盖 key 要改启动环境并重启桥。默认 Bearer，`RHB_KEY_HEADER` 可选 authorization / api-key / x-api-key。这个选项不扩大上游供应商范围。

### 库 API

```js
const { createBridge, projectResponsesHistory } = require('./');

async function main() {
  const bridge = createBridge({
    upstream: 'https://agentrouter.org/v1'
  });
  await bridge.listen(8790);
  // 用完调用 await bridge.close()。
}
```

库不隐式读取环境变量，历史/协议选项显式传入；可用 listen(0) 分配测试临时端口，close() 关闭 listener、在途请求和本桥 socket。纯投影函数返回新对象，不修改原件；调用方负责提交边界、预算与目标限制。

`createRecoverySession(options)` 提供无监听、无传输的嵌入恢复核心，HTTP 桥也使用它；`current()` 取得请求副本，`decide()` 消费完整检查后的故障并返回受预算保护的决策。网关仍负责真实 URL、认证、输出检查和等待；见[嵌入接口](architecture.md#调用接口)。

`isEncryptedReasoningError(payload, statusCode, upstream)` 检查官方目标及明确错误；`projectEncryptedReasoning(body, { mode })` 校验并创建有损副本，成功返回 `body`、`lossy: true` 和 `removedEncrypted` / `droppedReasoning` / `removedIds` 计数。纯投影本身不识别目标或执行重试，不能绕过桥的输出/预算保护来调用。

### 保留的高级环境设置

日常无需设置 client，只需可选 upstream 和 port，不需要供应商声明开关。以下旧显式选项保留，适合确知边界的库/CLI 集成；恢复和转换相关选项不能为非 AgentRouter 目标启用这些行为：

| 环境变量 | 默认值 / 范围 | 用途 |
| --- | --- | --- |
| RHB_CLIENT | auto；codex / harness / claude-code / generic | 可选旧兼容预设，不是普通启动必填 |
| RHB_HISTORY_MODE | auto 或兼容预设；auto / minimal / codex / harness | 显式覆盖历史契约，不推断重试策略 |
| RHB_UPSTREAM_PROTOCOL | auto 或兼容预设；auto / passthrough / responses | auto 按本组件已支持的端点适配；passthrough 禁止 Messages 转换 |
| RHB_REASONING_SHAPE | summary；content | 转换 reasoning 形状 |
| RHB_API_KEY / RHB_KEY_HEADER | 未设置 / authorization | 桥统一认证覆盖 |
| RHB_USER_AGENT | 未设置 | 显式覆盖出站 User-Agent，否则保留客户端值 |
| RHB_HOST | 127.0.0.1 | 仅 loopback 绑定 |
| RHB_TIMEOUT_MS | 180000 | 总时限；Harness 最大 180000，其他最大 1800000ms |
| RHB_RESOURCE_ATTEMPTS | 10 | Harness 1–10，其他 1–100 |
| RHB_TOTAL_ATTEMPTS | 10，1–10 | Harness 单请求总调用上限 |
| RHB_TRANSIENT_ATTEMPTS | 3，1–3 | Harness transient 上限，含首轮 |
| RHB_RETRY_DELAY_MS | Harness 250，其他 1000 | Harness 0–2000ms（0 仍调度 1ms）；其他固定 0–60000ms |
| RHB_MAX_RETRY_DELAY_MS | 2000，1–2000 | Harness 本地退避上限；不压短 Retry-After |
| RHB_RETRY_JITTER_RATIO | 0.2，0–1 | Harness 随机扰动 |
| RHB_HISTORY_STRATEGY | on-error；portable | portable 显式提前投影 |
| RHB_TRANSPARENT_RECOVERY | auto/codex/harness 为 true，minimal 为 false | 透明恢复开关；true/false/1/0 |
| RHB_AUTOMATIC_RECOVERY | harness 为 true，其他 false | 旧空终态/连续恢复选项，与透明恢复共预算 |
| RHB_GENERIC_400_PROJECTION | Harness true，其他 false | Harness 受限泛化 400 候选；true/false/1/0 |
| RHB_DIAGNOSTICS_PATH | 未设置 | 启用有界脱敏 JSONL，默认关闭 |
| RHB_DIAGNOSTICS_MAX_BYTES | 1048576，1–16MiB | 单个诊断文件上限 |
| RHB_DIAGNOSTICS_MAX_FILES | 3，1–10 | 诊断轮转文件总数 |
| RHB_REQUEST_LIMIT | 8388608，最大 64MiB | 请求/转换正文上限 |
| RHB_BUFFER_LIMIT | 65536，最大 64KiB | 未提交检查缓冲，超限不恢复 |

诊断仅记录白名单结构、计数、哈希、状态与预算，不记录正文、工具参数/结果、凭据、加密回放或原始签名。诊断失败不影响请求；上游错误作为 API 响应返回客户端，不作为原始日志落盘。

## 排除项

- 其他供应商的恢复适配（仅透传）、通用网关、模型池/路由/计费管理。
- 所有 Agent 零配置接入、封闭 endpoint 客户端、所有管理工具版本兼容。
- 多用户/远程访问、浏览器 CORS、云服务与系统级流量接管。可选用户级后台运行见[服务说明](service.md)，不自动修改客户端。
- 所有协议无损互转；Chat → Responses 转换。
- 所有 400 重试、无差别删除 ID/加密材料、解密隐藏思维链、不受控重放或伪造成功/usage。
- 自动修改客户端/全局 endpoint、上游、模型、effort、key 或重启已有服务。
- 对所有历史类型、自然故障恢复率、长混合历史和长期并发的普遍保证。

## 验证记录与未核范围

验证按版本、执行环境和故障来源区分；历史数字不自动继承给新代码。当前自动/嵌入/后台改造在本机 macOS Node.js 18.20.8 / 22.23.3 / 24.18.0 各 **1418/1418**，验证期间运行与测试文件指纹未变。安装版 Harness 原有 71＋91 项通过；默认自动入口两轮加密 reasoning 故障注入的同版 25 项证据已复用，核心与安装版 adapter 未变，临时连接已关闭。42 项服务用例采用临时文件和注入的原生管理器；真实仓库 macOS dry-run 通过但未安装服务。首轮全量的一项旧默认 Messages 测试失败保留在证据中，改成显式 passthrough 并补查字节/认证后重跑通过，没有为它改运行代码或放宽断言。见[当版记录](verification-automatic-runtime-20261026.json)。

本轮自动/嵌入/服务改造已提交并推送功能分支，未合入 main 或部署。首轮 Windows 的只读 fsync 和日志 fixture 句柄清理失败已修，原始 CI 与旧实现回归失败证据保留。修后服务定向检查在本机三版 Node 各 45/45；[修复后 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40291204080) 九个作业全部成功，Linux/macOS 六个组合各 1421/1421，Windows 三个组合各 1420 通过、0 失败、1 项符号链接权限用例明确跳过，PowerShell5.1 启动各 13/13。未执行真实用户会话服务安装，不把前台启动或模拟后端当成后台部署。下表第二行起均为历史版本证据，不以旧 CI 或旧客户端实验代替新增代码。此前加密修复已提交并推送功能分支，Windows/macOS/Linux × Node18/22/24 九个 CI 组合通过；其 1078/1078 等数字只属于此前版本。

恢复测试在保留官方目标 URL 的同时，通过测试专用传输映射将 HTTP 请求送到本机 mock；不增加生产声明开关，不读取真实 key，也不实际出网。其他目标用例验证仅一次上游调用、请求/响应字节与协议保持、错误原样转发。

- `node --test`：跨平台单测，使用 loopback mock，无需真实 key 或安装 Harness。
- `node scripts/verify-harness.mjs` / `node scripts/verify-harness-parity.mjs`：安装版 PiAiAdapter 的定向 loopback 验证，不读取用户 profile/key，不修改安装文件，不冒充完整 GUI 或真实渠道实跑。需满足安装版要求（当前 ≥22.19），可用 `RHB_HARNESS_MODULES` 指定 `dsh/node_modules`；缺依赖即明确失败，不伪记通过。

| 记录 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| [2026-10-26 自动/嵌入/后台改造](verification-automatic-runtime-20261026.json) | 本机 macOS 三版 Node 各 1418/1418；同一默认入口处理 Responses/Messages，旧显式覆盖保留，嵌入会话复用相同恢复核心，预算与输出保护通过；安装版 Harness 71/91 与默认自动入口加密两轮续接 25 项通过；42 项服务用例及真实仓库 dry-run 通过。 | 已提交并推送功能分支、未合入 main 或部署；修复后九个 CI 作业成功，Linux/macOS 各 1421/1421，Windows 各 1420 通过、0 失败、1 项符号链接权限跳过，PowerShell5.1 启动各 13/13；首轮失败保留。服务测试使用注入后端，不证明真实安装、启停或登录自启。未接入正在运行的 Mixrouter，未修改客户端；不证明自然故障、完整 GUI、所有模型/历史或长期负载。 |
| [2026-10-26 加密 reasoning 降级](verification-encrypted-reasoning-20261026.json) | 本机 Node.js 18/22/24 各 1078/1078，含新增 132 项明确错误、投影、预算、输出/未知/截断保护、作用域及脱敏检查；安装版 Harness 原有 71/91 项和新增两轮原生工具续接 25 项通过，可读摘要/纯密文两种历史按约定投影，调用方历史不改，临时连接已关闭。 | Windows/macOS/Linux × Node18/22/24 九个 CI 组合全部通过，含 PowerShell5.1 实际启动检查；均为 mock，不证明自然 AgentRouter 解密故障恢复。未验证安装版 Codex/Claude Code 的加密故障续接或完整 Harness GUI，不保证所有模型、历史形状或长期负载。已推送功能分支、未合入 main 或部署，未改客户端配置或重启服务。 |
| [2026-10-26 目标识别与透传](verification-provider-scope-20261026.json) | 本机 Node.js 18/22/24 各 946/946；后续恢复原始伪造主机组合后受影响文件各 29/29。其他目标单次调用、原字节/协议/编码、上游错误透传；安装版 Codex 152 项两类注入均精确投影完成，Harness 71/91 项通过并清理临时资源。 | 已推送 `main`，本次 Windows/macOS/Linux × Node18/22/24 九个 CI 组合全部通过，含 PowerShell7/5.1；首次测试路径失败及后续原样重跑的超时样本已保留，未部署；不证明自然上游故障恢复率、所有历史或长期负载。 |
| [2026-10-26 AgentRouter 聚焦](verification-agentrouter-focus-20261026.json) | 本机 Node.js 18/22/24 各 887/887；安装版 Codex 152 项复制历史的 Azure 包装与严格400注入均精确投影后完成；安装版 Harness 71 项与 91 项检查通过，临时 listener/socket 全关闭。候选两轮及合入 main 的 Windows/macOS/Linux × Node18/22/24 九个 CI 组合全部通过，Windows PowerShell7/5.1 实际启动检查通过。 | 不证明自然上游故障恢复率、所有历史类型、管理工具版本或长期负载；未修改本地客户端或重启现有服务。 |
| [2026-10-26 Codex 同步](verification-codex-parity-20261026.json) | 此前 runtime cc89085：macOS Node.js 18/22/24 各 827/827；Ubuntu/macOS/Windows × 三版 Node 九个 CI job 成功，实际 PowerShell 启动检查。安装版 Codex 0.164.0 对 loopback 故障 mock 完成 152 项历史投影与工具续接；Harness parity 71 项、完整 91 项检查通过。 | 不验证本轮聚焦重构；Codex 故障与恢复响应均为 mock，不是自然 AgentRouter 跨资源故障；不覆盖所有历史或持续负载。 |
| [2026-10-25 资源恢复](verification-resource-only-20261025.json) | 历史版本的真实 macOS Claude Code 工具续接、Codex 本机注入后真实 AgentRouter 恢复响应，以及小型 encrypted reasoning 两工具 API 对照；旧跨平台启动/恢复结果。 | 注入错误不来自真实上游；小型 API 对照不等于 Codex 长混合 CLI 历史通过，失败与限流样本仍保留。 |
| [2026-10-25 Harness 连续恢复](verification-harness-recovery-20261025.json) | 历史连续恢复版本的 loopback 单测、安装版 PiAiAdapter、脱敏/预算/清理检查；一项普通真实上游 smoke。 | 非完整 Harness GUI，普通 smoke 非自然资源故障；记录中的当时 Windows/推送状态不代表后续同步版本。 |
| [更早 Harness](verification-harness-20261025.json) / [早期验证](verification-20261025.json) | 早期行为及实验存档。 | 被取消的全客户端空响应策略不代表当前功能。 |

此前同步和目标识别版本已有九平台 CI 成功及提交/推送/合入记录；当前加密 reasoning 降级版本也有独立九平台 CI 成功记录，已推送功能分支但未合入 main，两者不能混用。Windows CI 使用 mock，未验证 Windows 安装版 Claude Code/Codex 对真实 AgentRouter。配置管理工具仅有 endpoint 接入说明，未实测全部工具/版本。
