# 验证记录

验证按版本、执行环境和故障来源区分。每条记录只证明它记录的那次提交与环境，测试数字不自动继承给之后的代码，也不以旧 CI 或旧客户端实验代替新版本验证。表中的提交、合入与部署状态是记录当时的状态。原始数据见同目录的 `verification-*.json`。

## 测试方式

- `node --test`：跨平台单测，使用 loopback mock，无需真实 key 或安装 Harness。
- `node scripts/verify-harness.mjs` / `node scripts/verify-harness-parity.mjs`：安装版 PiAiAdapter 的定向 loopback 验证，不读取用户 profile/key，不修改安装文件，不冒充完整 GUI 或真实渠道实跑。需满足安装版要求（当前 ≥22.19），可用 `RHB_HARNESS_MODULES` 指定 `dsh/node_modules`；缺依赖即明确失败，不伪记通过。

恢复测试在保留官方目标 URL 的同时，通过测试专用传输映射将 HTTP 请求送到本机 mock；不增加生产声明开关，不读取真实 key，也不实际出网。其他目标用例验证仅一次上游调用、请求/响应字节与协议保持、错误原样转发。

单测、跨平台 CI 与 Harness 脚本中的故障都来自 mock 或本机注入，不来自真实上游。部分历史记录另含真实上游请求或真实客户端操作，范围以表中该行说明为准。

## 记录

按时间倒序。

| 记录 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| [2026-11-07 优化轮收尾](verification-optimize-20261107.json) | 本机 macOS Node.js 18.20.8 / 22.23.3 / 24.18.0 各 1688/1688。修正终态 HTTP 错误原因、asctime 重试日期时区、Harness 插件卸载后的续跑取消；原字节透传与输出后不重放回归通过。Codex 0.167.0 schema 核对与临时目录真实握手通过；Harness 0.2.1-rc.4 adapter 91 项、parity 71 项通过；安装版 Cordis 4.0.5 / Loader 1.0.6 在独立进程中加载、卸载、重新加载仓库插件通过，相关服务使用 mock。 | 此记录在本轮推送前生成，GitHub CI 需按提交单独核对；未合入 main、未部署或修改客户端配置。没有真实上游故障或 GUI 续跑证据；Loader 的重新加载不等于桌面应用文件监视器的 HMR 实跑。 |
| [2026-10-26 透明恢复与续跑](verification-transparent-recovery-20261026.json) | 本机 macOS Node.js 18.20.8 / 22.23.2 / 24.18.0 各 1608/1608，含透明恢复 119 项与续跑 52 项；安装版 Harness PiAiAdapter 91 项与聚焦 parity 检查通过，临时监听已关闭；[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40308130259) 九个组合全部通过。已合入 `main` 并作为新版本发布到本机 `8790`：回环 `/health` 就绪、运行指纹与实际发布目录一致、客户端 profile 的 SHA-256 未变；用该发布目录对 loopback 503→200 mock 冒烟，客户端只拿到最终一次 200，没有中间错误。 | 未复现自然 AgentRouter Azure 故障；续跑适配器只用 mock 原生契约测试，没有真实桌面客户端驱动续跑。同一提交另一次 PR 运行中 Windows Node 24 的 PowerShell5.1 启动子集失败一次，同作业此前与重跑均通过、该子集该版无代码改动，按环境抖动记录、未改断言。不证明长期负载或所有历史形状。 |
| [2026-10-26 自动/嵌入/后台改造](verification-automatic-runtime-20261026.json) | 本机 macOS 三版 Node 各 1418/1418（含 42 项服务用例），验证期间运行与测试文件指纹未变；同一默认入口处理 Responses/Messages，旧显式覆盖保留，嵌入会话复用相同恢复核心，嵌入预算、原始字节与输出保护通过；安装版 Harness 71＋91 项与默认自动入口两轮加密 reasoning 续接故障注入 25 项通过；真实仓库 dry-run 通过。服务修复后，服务用例为 45 项：本机三版 Node 的聚焦运行均通过；[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40291204080) 九个作业成功，Linux/macOS 各 1421/1421，Windows 各 1420 通过、0 失败、1 项符号链接权限测试明确跳过，PowerShell5.1 启动各 13/13。 | 已提交并推送功能分支，未合入 main 或部署；首轮 CI 失败保留在记录中。服务测试使用注入后端与真实仓库 dry-run，不证明真实安装、启停或登录自启。未接入正在运行的 Mixrouter，未修改客户端；不证明自然故障、完整 GUI、所有模型/历史或长期负载。 |
| [2026-10-26 加密 reasoning 降级](verification-encrypted-reasoning-20261026.json) | 本机 Node.js 18/22/24 各 1078/1078，含新增 132 项明确错误、投影、预算、输出/未知/截断保护、作用域及脱敏检查；安装版 Harness 原有 71＋91 项和新增两轮原生工具续接 25 项通过，可读摘要/纯密文两种历史按约定投影（保留可读摘要、省略纯密文 reasoning），调用方历史不改，临时连接已关闭。[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40272685786) 的 Windows/macOS/Linux × Node18/22/24 九个组合全部通过，含 Windows PowerShell5.1 实际启动检查。 | 以上均为 mock，不证明自然 AgentRouter 解密故障恢复。未验证安装版 Codex/Claude Code 的加密故障续接或完整 Harness GUI，不保证所有模型、历史形状或长期负载。已推送功能分支 `feat/encrypted-reasoning-recovery-20261026`，未合入 main 或部署，未改客户端配置或重启服务。 |
| [2026-10-26 目标识别与透传](verification-provider-scope-20261026.json) | 本机 Node.js 18/22/24 各 946/946；后续恢复原有伪造主机组合用例后，受影响文件各 29/29。其他目标单次调用、原字节/协议/编码、上游错误透传；安装版 Codex 152 项复制历史在两类故障注入下均精确投影完成，Harness 71＋91 项通过并清理临时资源。已推送 `main`，[跨平台 CI](https://github.com/yange0793-dot/resource-history-bridge/actions/runs/40268472510) 的 Windows/macOS/Linux × Node18/22/24 九个组合全部通过，含 Windows PowerShell 7/5.1 实际启动检查。 | 首次 Windows 测试预加载路径失败已修正；后续 macOS Node24 一项触发现有 1 秒测试时限，原样重跑失败作业通过，未改运行代码或放宽断言；两次失败样本均已保留。未部署，未改客户端配置或重启服务；不证明自然上游故障恢复率、所有历史或长期负载。 |
| [2026-10-26 AgentRouter 聚焦](verification-agentrouter-focus-20261026.json) | 本机 Node.js 18/22/24 各 887/887；安装版 Codex 152 项复制历史的 Azure 包装与严格 400 注入均精确投影后完成；安装版 Harness 71 项与 91 项检查通过，临时 listener/socket 全关闭。候选两轮及合入 main 的 Windows/macOS/Linux × Node18/22/24 九个 CI 组合全部通过，Windows PowerShell7/5.1 实际启动检查通过。 | 不证明自然上游故障恢复率、所有历史类型、管理工具版本或长期负载；未修改本地客户端或重启现有服务。 |
| [2026-10-26 Codex 同步](verification-codex-parity-20261026.json) | 此前 runtime cc89085：macOS Node.js 18/22/24 各 827/827；Ubuntu/macOS/Windows × 三版 Node 九个 CI job 成功，实际 PowerShell 启动检查。安装版 Codex 0.164.0 对 loopback 故障 mock 完成 152 项历史投影与工具续接；Harness parity 71 项、完整 91 项检查通过。 | 不验证之后的 AgentRouter 聚焦重构；Codex 故障与恢复响应均为 mock，不是自然 AgentRouter 跨资源故障；不覆盖所有历史或持续负载。 |
| [2026-10-25 资源恢复](verification-resource-only-20261025.json) | 历史版本的真实 macOS Claude Code 工具续接、Codex 本机注入后真实 AgentRouter 恢复响应，以及小型 encrypted reasoning 两工具 API 对照；旧跨平台启动/恢复结果。 | 注入错误不来自真实上游；小型 API 对照不等于 Codex 长混合 CLI 历史通过，失败与限流样本仍保留。 |
| [2026-10-25 Harness 连续恢复](verification-harness-recovery-20261025.json) | 历史连续恢复版本的 loopback 单测、安装版 PiAiAdapter、脱敏/预算/清理检查；一项普通真实上游 smoke。 | 非完整 Harness GUI，普通 smoke 非自然资源故障；记录中的当时 Windows/推送状态不代表后续同步版本。 |
| [更早 Harness](verification-harness-20261025.json) / [早期验证](verification-20261025.json) | 早期行为及实验存档。 | 被取消的全客户端空响应策略不代表当前功能。 |

## 未核范围

- 未复现自然 AgentRouter Azure 故障；自然上游故障的恢复率与长期负载不在验证范围。
- 续跑适配器只用 mock 原生契约测试，没有真实桌面客户端驱动续跑；Codex app-server 客户端与 Harness 插件各自已验证和未验证的部分见[客户端续跑](continuation.md)与[Harness 自动续跑插件](harness-plugin.md)。
- 后台服务只用注入后端与真实仓库 dry-run 验证，没有真实用户会话的服务安装、启停与登录自启证据。
- Windows CI 使用 mock，未验证 Windows 安装版 Claude Code/Codex 对真实 AgentRouter。
- 配置管理工具仅有 endpoint 接入说明，未实测全部工具/版本。
- 不证明所有模型、所有历史形状或完整 Harness GUI。
