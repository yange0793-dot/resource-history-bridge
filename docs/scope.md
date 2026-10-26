# 当前范围

## 要实现的使用方式

独立本机组件，不要求用户更换模型管理工具。适配 macOS 上的 Codex（Responses）、Claude Code（Messages → Responses）及 DeepSeek Harness（PiAiAdapter 原生 Responses）。Windows 提供同一 Node.js 核心与 PowerShell 启动入口，实跑和 CI 结果单独记录，不以 macOS 结果代替。

可以直连上游，也可以连接用户已有本机代理。管理工具仅切换配置时，修改它管理的 Base URL；管理工具本身转协议时，必须选择桥实际可见的协议位置。组件不自动扫描或重写 Magpie、CC Switch 等工具的配置，不承担模型池、计费或路由管理。

## 能力分层

1. 原协议转发：保留请求正文、模型、认证和会话身份。
2. 明确配置的 Messages → Responses 转换：复用已有 MIT 许可模块，只处理能明确表示的文本、图像、工具与思考形状。
3. 资源错误恢复：已知 Azure 400 的一次 item ID 投影，并对同类未输出错误做有界同字节重发；默认 `minimal`，Codex 选择 `codex`、DeepSeek Harness 选择 `harness` 契约。
4. Harness 连续运行：仅原生 Responses 的 `harness` 模式默认启用瞬时错误、限流（含无 event/type 的纯 `{error}` SSE 帧）、输出前断流或完整空/仅元数据但无终态的 SSE EOF、明确空 failed/completed 的有界自动恢复，及可校验泛化400的单次历史投影。其他客户端默认仍不重试空完成。
5. 共享传输边界：固定上游、loopback、总时限、取消传播、有界缓冲；已输出或未知内容不透明重放。

这些能力分别验证。成功转换不代表资源错误恢复成功；不根据费用或 usage 为零修改响应或伪造正常完成。

默认其他客户端的资源恢复最多投影一次；同一投影再遇已知资源错误时重发相同字节，默认最多10次上游请求、间隔1秒。Harness原生Responses另使用下述共享预算。其他模式次数与间隔可通过 `RHB_RESOURCE_ATTEMPTS` / `RHB_RETRY_DELAY_MS` 配置，只约束桥收到的**单个 HTTP 请求**并共享取消信号与总时限。最后一次原样转发实际错误，不新增终止性状态。其他客户端空响应不触发重试或额外错误。客户端重发属于独立请求，不据此宣称端到端次数上限。

## Codex 历史投影契约

CLI 用 `RHB_HISTORY_MODE=codex`，库用 `createBridge({ ..., historyMode: 'codex' })`；纯投影函数用 `projectResponsesHistory(body, { mode: 'codex' })`。这些配置位置不同，不是客户端模型或 provider 名称。默认 `minimal` 只允许移除 `reasoning.id` 与 `function_call.id`，不会自动升级为 Codex 模式。

`codex` 模式在已知资源错误或下述严格 AgentRouter 历史错误、且尚未提交输出时，移除 `input` 内 `message`、`reasoning`、`function_call`、`function_call_output` 的 `id`。它不删除 `additional_tools`、`custom_tool_call`、`custom_tool_call_output` 的 `id`，也不删除 `encrypted_content`、`call_id`、名称、参数、输入、输出或其他字段。第一条原生 Responses 请求不预先投影；返回的是新的历史对象，不修改客户端持久历史。

恢复要求非空显式 `input` 数组，每一项是对象；拒绝服务端 `previous_response_id` / `conversation` 引用、`item_reference`、不完整项、其他未经支持类型的顶层 item ID，以及没有可移除 ID 的请求。接受的 Codex 扩展形状有以下约束：

| 历史形状 | 接受条件与保留边界 |
| --- | --- |
| `message` | `role` 为 `user` / `developer` / `system` / `assistant`，`content` 为非空内联数组；已有 `id` 必须是非空字符串。`phase` 仅可缺省、`commentary` 或 `final_answer`；显式 `null` 拒绝。 |
| message 的文本内容 | 仅接受 `input_text` / `output_text`，其 `text` 必须为字符串。 |
| message 的图像内容 | `input_image.image_url` 必须为带主机的 HTTP(S) URL，或完整且有非空数据载荷的 `data:image/...,...` URL；不接受 `file_id`，即使同时有 `image_url`。 |
| `additional_tools` | 保留非空字符串 `id`；`role` 必须为 `developer`，`tools` 必须是完整内联 schema 数组。每个 schema 需非空字符串 `name`，并满足下列 schema 类型要求。 |
| `function` schema | `parameters` 必须为对象，不能是 `null` 或数组；不据此宣称完整 JSON Schema 语义验证。 |
| `namespace` schema | `tools` 必须为数组，递归校验其中每个 schema；嵌套 namespace 也适用相同要求。 |
| `custom` schema | `format` 必须为对象，`format.type` 可为 `text`；或为 `grammar`，此时 `syntax` 仅为 `lark` / `regex`，`definition` 必须为非空字符串。 |
| `custom_tool_call` | 保留非空字符串 `id`、`call_id` 与 `name`，`input` 为字符串。`status` 仅可缺省或 `completed`；`null` 和其他状态拒绝。 |
| `custom_tool_call_output` | 保留非空字符串 `id`，必须具有 `output` 字段，且跟在相同 `call_id` 的 custom 调用之后。 |
| `reasoning` | 完整 `summary` 数组；可选 `content` 为 `null` 或完整 `reasoning_text` 数组，可选 `encrypted_content` 为非空字符串；内容与加密材料保留。 |
| 带 `id` 的 `function_call_output` | `id` 为非空字符串，显式 `status` 仅可为 `completed`；`output` 为字符串（允许空串）或非空完整内联文本/图像数组，不接受服务端 `file_id`；按唯一 `call_id` 与前面的标准调用配对。无 ID 的既有结果及保留 custom ID 的结果契约不因本修复收紧。 |

function 与 custom 调用都要求唯一的非空 `call_id`、非空名称和字符串形式的参数或输入。每个结果必须在对应调用之后、与调用类型匹配、恰好一次；所有调用必须有结果。保持上述 schema 和配对不等于所有历史类型都可跨资源移植；未支持形状不通过删字段兜底。

### 严格 AgentRouter 历史错误

固定上游 URL 的主机仅为 `ps.air-outer.com` 或 `agentrouter.org`，HTTP 状态仅为 400；响应为纯 `{error}`，内部恰有 `message`、`type`、`param`、`code`，分别是完整匹配的 `Upstream rejected the request as invalid [trace_id=…]`、`invalid_request_error`、空字符串和 `null`。trace 限 1–256 个字母、数字或 `._:-` 字符。额外输出、未知字段、typed SSE、普通参数错误、权限/认证/内容拦截以及未知端点不参与。

这条窄规则默认可用，不依赖 `automaticRecovery` 或 Harness 的 `generic400Projection` 开关；仍要求完整可投影历史、没有已输出/未知/部分尾帧，复用既有资源预算和 deadline。投影最多一次，后续同类错误重发同一字节；校验拒绝与耗尽返回实际最后上游响应。它不是对错误内部 Azure 原因的证明，也不启用其他客户端空响应重试。

## Harness 历史投影契约

CLI 用 `RHB_HISTORY_MODE=harness`，库用 `historyMode: 'harness'`；面向 DeepSeek Harness 的原生 `openai-responses` PiAiAdapter，不改变默认 `minimal` 或既有 `codex` 契约。

- 默认第一条原生请求字节不变；明确资源错误或受限泛化400候选、未提交输出时移除已校验的 `message.id`、`reasoning.id`、`function_call.id`、`function_call_output.id`（带 ID 结果须完整内联并唯一配对）。显式portable可提前投影。同类错误重发同一投影，保留 encrypted_content、call_id、参数/结果、模型、认证与会话 header，不改写 replayState/签名或 backfill。
- 有类型的 message 要求完整 role、内联 content，已有 phase 为已知值，status 只可缺省或 completed。PiAiAdapter 的无类型 easy message 仅接受已知原生形状：developer/system 的字符串 content，或 user 的内联 content 数组；不能带待猜测的顶层 ID。
- inline `additional_tools` 要求 developer role 和完整工具 schema；ID 可以缺省，已有 ID 保留。
- `custom_tool_call` / `custom_tool_call_output` 的 ID 可以缺省，已有 ID 必须为非空字符串并保留。调用必须具有唯一 call_id、名称和字符串 input，结果按相同类型配对，并出现在对应调用之后；调用 status 只可缺省或 completed。
- 服务端引用、item_reference、工具缺配对、其他类型的顶层 ID 仍拒绝，不通过删除加密材料或改写 replayState 兜底。可选工具参数与 strict:false 保持原样。

这是请求线上的恢复，不接管Harness主模型或子代理选择。Harness原生Responses另默认启用有界瞬时恢复：总10次、transient含首轮3次、resource10次、共用180秒deadline；默认250ms退避、2秒本地上限，尊重Retry-After。泛化400仅在无输出且完整历史存在约定资源ID时，允许一次校验投影；认证、权限、schema、内容过滤不参与。任何空格正文、推理、工具或未知输出/下游提交后都不整轮重放。空failed/completed用同一transient预算，最后实际响应仍透传，不生成终止性预算状态或伪造成功。其他客户端空响应策略不变。

默认首请求保留原字节；`RHB_HISTORY_STRATEGY=portable`为明确提前投影选项。默认关闭诊断，启用后仅落白名单结构/计数/哈希/状态/预算，不落正文、工具参数结果、凭据或加密回放。日志失败不影响请求。外层客户端重新发送另一个HTTP请求不计入桥内总次数。

## 不在本轮的内容

- 所有 Agent 零配置接入；封闭客户端或无法修改 endpoint 的客户端无法保证支持。
- 所有协议无损互转。Chat Completions 当前仅转发，不能转换到 Responses。
- 多用户/远程网关、浏览器 CORS、云服务或模型管理面板。
- 将资源错误扩成所有 400 重试，或删除所有 ID/加密材料来换取成功。
- 不受控地重放用户历史、切换真实上游、改全局 endpoint、重启已运行的服务。

## 验收条件

- 实际 CLI 请求通过独立桥，完成纯文本对话及工具调用/结果续接；记录客户端版本、模式和退出状态。
- 默认同协议第一次请求不被预先改写；显式portable可提前投影。恢复始终不修改客户端持久历史。
- 已知故障本机注入可验证提交边界及请求预算，但记录为注入实验，不伪称真实上游故障。
- 正文、思考、工具、拒绝、终态独有内容保持；其他客户端空完成不重试，Harness明确空终态有界重试后返回实际最后响应，不额外报错；未知形状不会触发盲重试。
- 不可恢复错误能呈现给客户端，不再通过伪造正常终态变成静默成功。
- Node.js 18/22/24 与 Windows/macOS/Linux 验证入口存在；只有实际执行成功的平台才标通过。

## 本轮已有证据与未核范围

- macOS 上真实 Claude Code 经桥连接 AgentRouter，纯文本返回 `CLAUDE_BRIDGE_OK`；Read 工具调用及结果续接返回 `RESULT_42`。
- macOS 上真实 Codex 经桥连接 AgentRouter，baseline 纯文本及工具调用/结果续接成功。
- 早期 Codex 外层 capture 候选实验：注入已知资源错误并得到 baseline 409 后，由**实验外层**仅移除 8 个完整 `message.id`；additional_tools/custom ID、call_id 配对和其他字段保留。真实 API 的投影请求返回 `RESULT_42`，Codex 退出 0。该实验的真实 API 请求共 6 次、状态均为 200，注入错误不来自真实上游；这是候选投影兼容证据，不是当前桥的直接恢复实跑。
- 当前桥 `codex` 模式由真实 Codex CLI 对本机 mock 的资源错误注入完成工具结果续接，属于 CLI 兼容与投影机制证据；错误与恢复响应均来自 mock。该项、早期外层实验和真实 AgentRouter baseline 分别记录，不能互相替代；均不证明当前实现对自然 Azure 跨资源故障已实跑，也不构成跨资源恢复率。
- 加入连续资源重试前的资源恢复修订对真实 AgentRouter 的 Codex 注入实验成功（历史投影函数与当前版本相同）：工具实际执行输出 `42`；续接处本机注入资源错误后，桥删除 7 个约定 message ID，保留 custom/additional ID、call_id 和其余字段；真实恢复请求得到 completed、`RESULT_42` 与 Codex 退出 0。共 2 次真实 API、1 次本机错误注入。之前限流失败仍保留，不把本次受控成功当作自然故障或恢复率。
- 两工具真实续接实验暴露过投影后的自然 Azure 资源错误（已含 encrypted reasoning）；旧版只试一次因此失败。当前加入仅针对已知资源错误的有界同字节重发，不删除 encrypted_content。更小的两工具 Responses 原生 API 对照已保留加密 reasoning 并恢复得到 RESULT_42；Codex 长混合历史仍曾被限流/无细节 invalid_request_error 阻断，不能把 API 对照当成该 CLI 场景通过。
- 旧版全客户端空响应恢复实验仅留历史：2026-10-25用户取消该功能。新增策略只针对后续明确要求连续运行的Harness原生Responses，不重新接入旧recoverEmpty开关；其他客户端不重试空响应，全路径不额外制造空输出错误。
- 旧版包含空响应重试/422 的 macOS 三版本 366/366 记录保存在 [历史验证](verification-20261025.json)。该功能已撤销，旧记录不代替当前修订验证。
- 此前资源恢复修订的最新真实 [CI 40153989577](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40153989577) 在 Ubuntu/macOS/Windows × Node.js 18/22/24 九个组合全部 382/382、0 fail/skip；此前 [CI 40151876122](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40151876122) 的 381/381 保留为历史。Windows 实际启动 PowerShell 脚本、进行 HTTP 转换与恢复、停止进程树并检查端口关闭，不只是语法解析。首轮 Windows 启动超时修复后重跑通过。两轮 CI 使用 mock 上游，未运行 Windows 实际 Claude Code/Codex 对真实 AgentRouter；详见 [资源恢复验证](verification-resource-only-20261025.json)。
- 此前Azure-only Harness修订在macOS Node.js18.20.8、22.23.3、24.18.0各410/410、0 fail/skip；不代替当前连续运行修订，同版结果见 [当前验证](verification-harness-recovery-20261025.json)。当前代码尚未推送或运行Windows CI。Windows 启动入口已新增 Harness 模式测试，但不把测试存在记为 Windows 执行通过；此前 Windows 适配证据不代替新增 Harness 修订的验证。
- 此前Azure-only修订的安装版PiAiAdapter0.2.1-rc.1 / pi-ai1.1.0公开API在Node.js24.18.0经loopback mock完成90项检查、14次请求、0失败（仅旧版证据）；两次只读算术工具实际执行，最终返回 `RESULT_42`。首请求字节、encrypted reasoning/backfill、replayState/签名、call_id、strict:false 和 headers 保持；已知未输出资源错误后仅投影约定三类 ID，重复错误重发同一投影。原生空响应策略不变。这是安装版 adapter 与 mock 的证据，不是完整 Harness GUI 或真实 AgentRouter 实跑，详见 [Harness 验证](verification-harness-20261025.json)。
- 配置管理工具仅提供 endpoint 接入说明，未实测所有工具或版本，不承诺所有供应商、历史形状、长混合历史或长期并发。

2026-10-25 的授权仅涵盖独立测试分支与 Windows CI，当轮未授权合入 main 或发布版本。2026-10-26 用户要求同步插件、确保独立使用获得同样恢复效果；本轮同步保留既有 Harness 功能并验证独立路径，本机部署仍不更改客户端 endpoint、模型、effort、上游或凭据。
