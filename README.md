# resource-history-bridge

面向 **AgentRouter** 的恢复组件：请求在输出前遇到可恢复的上游错误时，在单个请求的预算内静默重试，或校验历史后改写请求副本再发；其他上游原样透传。

## 快速开始

需要 Node.js ≥18，无第三方 npm 依赖，不依赖 Mixrouter 或配置管理工具；不修改客户端配置、持久历史或模型池。在仓库目录运行：

```sh
node cli.js
```

Windows PowerShell：

```powershell
node .\cli.js
```

也可双击 `scripts/start-macos.command`，或运行 `scripts/start-windows.ps1`。启动不询问客户端或协议，按请求端点自动处理；等待启动信息确认监听成功，按 `Ctrl+C` 停止。

| 日常设置 | 默认值 | 用途 |
| --- | --- | --- |
| `RHB_UPSTREAM` | `https://agentrouter.org/v1` | 官方入口；官方备用入口为 `https://ps.air-outer.com/v1` |
| `RHB_PORT` | `8790` | 更换本机监听端口 |

按固定上游 URL 自动识别，只对这两个 HTTPS 官方主机启用恢复，无需声明或开关。其他 HTTP(S) 上游和本机代理正常启动并原协议透传：不投影历史、不重试、不转换 Messages，上游错误原样交给客户端。固定上游改变后需重启桥。旧显式配置（如 `RHB_CLIENT`）仍优先，见[自动入口与兼容覆盖](docs/scope.md#自动入口与兼容覆盖)。

## 客户端接入

- Codex / Harness / 原生 Responses：`http://127.0.0.1:8790/v1`。
- Claude Code / Messages：`http://127.0.0.1:8790`。
- 保留客户端实际模型与已有密钥来源，不把模型值改成桥或客户端预设的名称。

默认转发客户端认证：客户端换成有效的新 key 后，新的 HTTP 请求即可使用，不必重启桥；同一请求的恢复重试使用首次接收的认证。只有设置了桥侧 `RHB_API_KEY` 覆盖时，才需要更新该环境并重启桥。不要把真实 key 写入脚本、命令示例或仓库。各客户端的配置写法见[客户端接入](docs/clients.md)。

## 接入方式

- **已有网关**：在实际目标已确定的出站层调用 `createRecoverySession`，不再开第二个端口；网关负责发送和完整响应检查，组件只提供受保护的恢复决策。见[嵌入与架构](docs/architecture.md)。不会自动修改 Mixrouter 或其他网关。
- **独立后台运行**：可选[用户级服务](docs/service.md)，由操作系统维护进程；不接管客户端设置，仍需把客户端 Base URL 接入一次。
- **临时运行**：上面的 `node cli.js`，适合试用或调试。

## 能力与边界

- **透明恢复（默认开）**：原生 `/responses` 上，官方 AgentRouter 的输出前瞬时故障（408 / 409 / 临时 429 / 5xx / 连接失败）在单个请求预算内静默重试，客户端看不到中间错误。认证、权限、schema、额度、内容和泛化 400 不重试；合法空完成与 clean EOF 不因透明恢复重试。
- **历史 ID 恢复**：未输出的已知 Azure 跨资源历史错误，按完整实际历史校验后，在请求副本中投影约定的 item ID 再发，不删除加密 reasoning、工具 `call_id`、参数或结果；原生 Responses 首请求保留原 JSON 字节。直接配置官方主机时，严格匹配的一种 HTTP 400 历史包装也参与，不是所有 400 都重试。带 ID 的已完成 `web_search_call` 这类不可投影的合法项按原字节重试，以 `projectionSkipped` 标记。
- **加密 reasoning 降级**：仅由官方目标的结构化 `invalid_encrypted_content` 错误触发，最多一次，只改请求副本。这是丢失隐藏推理状态后重新推理，不是解密或无损迁移；响应带 `x-rhb-recovery: encrypted-reasoning-dropped`。
- **输出后不整轮重放**：任何正文、推理、工具、未知帧或下游提交后都停止。不可恢复的上游错误如实呈现，不伪造成功。
- Messages 转换只处理可表达的内容，不是所有协议无损互转。Chat Completions 仅透传；`/responses/compact` 不参与历史恢复。
- **单机单用户**：只监听 loopback，拒绝浏览器来源，不提供 CORS，无独立多用户鉴权。不要公开端口、远程转发或共享给其他用户。请求历史及加密材料会发送给固定上游；加密字段不是隐私保证。

完整契约、恢复预算与高级选项见[当前范围](docs/scope.md)。

## 文档

- [客户端接入](docs/clients.md)：macOS / Windows、Codex、Harness、Claude Code、配置管理工具、换 key。
- [嵌入与架构](docs/architecture.md)：恢复核心、自动 HTTP 入口与运行壳的边界和源码参考。
- [客户端续跑](docs/continuation.md)：原生重试耗尽后在同一会话受控续跑的接口与宿主前置条件；含内置的 Codex app-server 客户端与 `rhb-codex-continue` 命令。
- [Harness 自动续跑插件](docs/harness-plugin.md)：在已安装的 DeepSeek Harness 里以进程内插件续跑失败的 turn，含真实接口、安装与回退、以及补不了的缺口。
- [后台运行](docs/service.md)：用户级安装、dry-run、状态、启停与卸载，不接管配置或密钥。
- [当前范围](docs/scope.md)：自动契约与旧配置优先级、恢复预算、转换保留字段、库 API 与高级选项。
- [验证记录](docs/verification.md)：各版本记录能证明什么、不能证明什么，区分真实上游、故障注入、安装版 adapter 和跨平台 CI；含测试方式与未核范围。

## 测试

```sh
node --test
```

测试使用 loopback mock，不需要真实 key 或安装 Harness。测试方式与各版本的验证结果见[验证记录](docs/verification.md)。
