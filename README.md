# resource-history-bridge

面向 **AgentRouter** 的恢复组件：已有网关可直接嵌入恢复核心；没有网关时，使用同一个自动本机 API 入口，也可安装为用户级后台服务。普通启动无需选择 Codex、Harness 或 Claude Code，按请求端点和已验证历史结构处理。

在未输出的已知 Azure 跨资源历史错误上，校验完整历史、投影约定的 item ID，并在单个请求预算内重发。原生 Responses 明确返回 `invalid_encrypted_content` 时，可在同一预算内尝试一次加密 reasoning 有损降级。

只需 Node.js ≥18，无第三方 npm 依赖，不依赖 Mixrouter 或配置管理工具。不修改客户端配置、持久历史或模型池。

## 快速开始

在仓库目录运行：

```sh
node cli.js
```

Windows PowerShell：

```powershell
node .\cli.js
```

默认上游为 `https://agentrouter.org/v1`，官方备用入口可显式设置为 `https://ps.air-outer.com/v1`。只对这两个 HTTPS 官方主机启用恢复。设置其他 HTTP(S) 上游时正常启动，进入原协议透传：不投影历史、不重试、不进行 Messages → Responses 转换，不因为供应商不同而报错。上游自身返回的错误仍原样交给客户端；生产连接建议使用 HTTPS。

按请求实际发往的固定上游 URL 自动识别，不需要额外声明或开关。本机代理不是可识别的官方目标，因此也仅透传，不猜测代理后的供应商。桥不会自动跟踪客户端或代理的供应商切换；固定上游改变后需用新的启动环境重启桥。

也可双击 `scripts/start-macos.command`，或运行 `scripts/start-windows.ps1`。不再询问客户端或协议，默认按请求自动处理。等待启动信息确认监听成功，按 `Ctrl+C` 停止。旧显式配置仍优先，不会被自动默认覆盖。

| 日常设置 | 默认值 | 用途 |
| --- | --- | --- |
| `RHB_UPSTREAM` | `https://agentrouter.org/v1` | 官方入口；通常不用设置 |
| `RHB_PORT` | `8790` | 更换本机监听端口 |

客户端接入地址：

- Codex / Harness / 原生 Responses：`http://127.0.0.1:8790/v1`。
- Claude Code / Messages：`http://127.0.0.1:8790`，无需桥侧客户端选择。
- 保留客户端实际模型与已有密钥来源，不把模型值改成桥或客户端预设的名称。

默认转发客户端认证。客户端换成有效的新 key 后，新的 HTTP 请求即可使用它，不必重启桥；同一请求的恢复重试使用首次接收的认证。只有设置了桥侧 `RHB_API_KEY` 覆盖时，才需要更新该环境并重启桥。不要把真实 key 写入脚本、命令示例或仓库。

## 选择接入方式

- **已有网关**：调用 `createRecoverySession`，放在实际目标已确定的出站层。不再开第二个端口；网关自己负责发送和完整响应检查，组件只提供受保护的恢复决策。见 [嵌入与架构](docs/architecture.md)。这不代表所有网关已经接入，也不会自动修改你的 Mixrouter。
- **独立后台运行**：使用可选 [用户级服务命令](docs/service.md)，一次安装后由操作系统维护进程。不接管客户端设置；仍需把客户端 Base URL 接入一次。
- **临时运行**：使用上面的 `node cli.js`，适合试用或调试。

## 当前能力与边界

- **透明恢复（默认开）**：在原生 `/responses` 上，官方 AgentRouter 的输出前瞬时故障（408 / 409 / 临时 429 / 5xx / 连接失败）在单次请求预算内静默重试，客户端看不到中间错误，成功后任务直接继续。认证、权限、schema、额度、内容和泛化 400 不重试。
- **输出后不整轮重放**：任何正文、推理、工具、未知帧或下游提交后都停止；合法的空完成与 clean EOF 不会因为透明恢复而被重试。
- 原生 Responses 默认首请求保留原 JSON 字节；历史 ID 恢复不删除加密 reasoning、工具 `call_id`、参数或结果。默认按完整实际历史校验，保留旧显式契约；不是根据客户端名称删除所有 ID。
- **不可投影的内置项**：历史里出现带 ID 的已完成 `web_search_call` 这类无法安全投影的合法项时，保留当前请求字节原样重试，并以 `projectionSkipped` 标记、不声称已投影。
- 加密 reasoning 降级仅由官方目标的结构化 `invalid_encrypted_content` 错误触发，且必须完整结束、尚未输出。只移除请求副本中 reasoning 的密文及其 ID，保留可读摘要/明文；仅有密文的 reasoning 项会省略。其他历史与工具关联不变，不修改持久历史。这是丢失隐藏推理状态后重新推理，不是解密或无损迁移；响应以 `x-rhb-recovery: encrypted-reasoning-dropped` 标记，最多降级一次。无法重建的加密压缩历史、未知形状或工具缺配对不降级，保留实际上游错误。
- 直接配置官方 AgentRouter 主机时，严格匹配的一种 HTTP 400 `{error}` 历史包装也参与资源恢复；不是所有 400 都重试。本机代理不能通过 header 冒充官方主机。
- 默认自动入口只恢复约定资源/密文错误，不因合法空完成、普通限流或泛化 400 扩大重试。旧显式 `harness` 连续恢复预设仍保留，与历史形状识别分开；其他上游不启用恢复。
- Messages 转换只处理明确可表达的内容，不是所有协议无损互转。Chat Completions 仅透传；`/responses/compact` 不参与历史恢复。
- 输出、未知内容或下游提交后不整轮重放。不可恢复的上游错误如实呈现，不伪造成功。

`invalid` 不等于加密错误：`invalid_request_error` 是通用类型，`Upstream rejected the request as invalid [trace_id=…]` 按已有窄规则处理历史 ID，只有明确的 `invalid_encrypted_content` 才进入密文降级。普通参数、权限或 thinking 签名错误不靠删除 reasoning 兜底。

这是无独立多用户鉴权的**单机单用户**桥，只监听 loopback，拒绝浏览器来源，不提供 CORS。不要公开端口、远程转发或共享给其他用户。请求历史及加密材料会发送给固定上游；加密字段不是隐私保证。

## 详细说明

- [客户端接入](docs/clients.md)：macOS / Windows、Codex、Harness、Claude Code、配置管理工具、换 key。
- [嵌入与架构](docs/architecture.md)：恢复核心、自动 HTTP 入口与运行壳的边界和源码参考。
- [客户端续跑](docs/continuation.md)：原生重试耗尽后在同一会话受控续跑的接口与宿主前置条件。
- [后台运行](docs/service.md)：用户级安装、dry-run、状态、启停与卸载，不接管配置或密钥。
- [当前范围](docs/scope.md)：自动契约与旧配置优先级、恢复预算、转换保留字段、库 API 与高级选项。
- [验证记录](docs/scope.md#验证记录与未核范围)：区分真实上游、故障注入、安装版 adapter 和跨平台 CI。

```sh
node --test
```

测试使用 loopback mock，不需要真实 key。恢复用例保留官方目标 URL，测试专用传输映射将请求送到本机 mock；其他目标的透传用例检查原始字节、单次请求、状态与协议不被改变。

**当版（透明恢复 + 续跑）**在本机 macOS Node.js 18.20.8 / 22.23.2 / 24.18.0 各通过 **1608/1608**，其中新增透明恢复用例 119 项、续跑用例 52 项。安装版 DeepSeek Harness PiAiAdapter 的 91 项检查与聚焦 parity 检查通过，临时监听已关闭。见 [当版验证记录](docs/verification-transparent-recovery-20261026.json)。[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40308130259) 九个组合全部通过；另一次同一提交的 PR 运行里 Windows Node 24 的 PowerShell5.1 启动子集失败一次，同作业此前与重跑均通过、该子集本轮没有代码改动，按环境抖动记录、未改断言。已合入 `main` 并作为新版本发布到本机 `8790`：回环 `/health` 就绪、运行指纹与实际发布目录一致、客户端 profile 的 SHA-256 未变；用该发布目录对 loopback 503→200 mock 冒烟，客户端拿到的是一次 200，没有中间错误。未复现自然 AgentRouter Azure 故障，也没有真实桌面客户端驱动续跑适配器。

此前自动/嵌入/后台改造在本机 macOS 三版 Node 各通过 **1418/1418**，含默认自动入口、嵌入预算与原始字节检查、42 项服务管理用例；安装版 Harness 原有 71＋91 项及两轮加密 reasoning 故障注入的 25 项检查通过。见 [该版验证记录](docs/verification-automatic-runtime-20261026.json)。该版其后的[修复后 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40291204080) 九个作业全部成功：Linux/macOS × 三版 Node 各 1421/1421；Windows × 三版 Node 各 1420 通过、0 失败、1 项符号链接权限测试明确跳过。服务管理仍采用注入的原生后端与真实仓库 dry-run，尚未验证真实用户会话的服务安装/登录自启。

以下为自动/嵌入/后台改造前的加密 reasoning 版本证据，不作为当前改造验证：加密 reasoning 降级版本已在本机 Node.js 18/22/24 各通过 **1078/1078**，其中新增故障与安全边界测试 132 项。安装版 Harness 原有 71＋91 项检查通过；新增两轮工具续接故障注入的 25 项检查通过，覆盖保留可读摘要和省略纯密文 reasoning，原历史不改、临时连接全部关闭。见 [本次验证记录](docs/verification-encrypted-reasoning-20261026.json)。已提交并推送到 `feat/encrypted-reasoning-recovery-20261026`，[本版跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40272685786) 的 Windows/macOS/Linux × Node18/22/24 九个组合全部通过，含 Windows PowerShell5.1 实际启动检查。尚未合入 `main` 或部署，未改客户端配置或重启服务，也未复现自然 AgentRouter 解密故障。

以下为加密 reasoning 降级加入前的目标识别版本证据，不当作新增路径的验证：本次目标识别与透传修改在本机 Node.js 18/22/24 各 946/946；恢复原有伪造主机组合用例后，受影响文件在三版 Node 各 29/29。安装版 Codex 的 152 项复制历史在两类故障注入下均完成精确投影，Harness 的 71 项与 91 项检查通过，见 [本次记录](docs/verification-provider-scope-20261026.json)。已提交并推送到 `main`，[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40268472510) 的 Windows/macOS/Linux × Node.js 18/22/24 九个组合全部通过，包含 Windows PowerShell 7/5.1 实际启动检查。首次 Windows 测试预加载路径问题已修正；后续 macOS Node24 一项触发现有1秒测试时限，原样重跑失败作业通过，未改运行代码或放宽断言。未改客户端配置或重启服务。

此前版本的九个跨平台 CI 组合及 Windows PowerShell 7/5.1 启动检查见 [历史记录](docs/verification-agentrouter-focus-20261026.json)，不当作本次版本证据。自然上游故障和长期负载不在本轮验证范围。
