# resource-history-bridge

面向 **AgentRouter** 的独立本机 API 桥。支持 Codex、DeepSeek Harness 的原生 Responses 请求，以及 Claude Code 的 Messages → Responses 转换；在未输出的已知 Azure 跨资源历史错误上，校验完整历史、投影约定的 item ID，并在单个请求预算内重发。

只需 Node.js ≥18，无第三方 npm 依赖，不需要 Mixrouter 或配置管理工具。桥不修改客户端配置、持久历史或模型池。

## 快速开始

在仓库目录运行：

```sh
RHB_CLIENT=codex node cli.js
```

Windows PowerShell：

```powershell
$env:RHB_CLIENT = 'codex'
node .\cli.js
```

默认上游为 `https://agentrouter.org/v1`，官方备用入口可显式设置为 `https://ps.air-outer.com/v1`。其他远程主机和官方域名的 HTTP 地址会被拒绝；已有本机代理及测试可使用固定 loopback 上游，不代表支持其他供应商。

也可双击 `scripts/start-macos.command`，或运行 `scripts/start-windows.ps1`。启动脚本只询问客户端类型，留空选择 `codex`；已有 `RHB_CLIENT` 或旧 `RHB_HISTORY_MODE` 时不再询问。等待启动信息确认监听成功，按 `Ctrl+C` 停止。

| 日常设置 | 默认值 | 用途 |
| --- | --- | --- |
| `RHB_CLIENT` | CLI 未设置时为 `generic` | `codex` / `harness` / `claude-code` / `generic`，选择历史与协议预设 |
| `RHB_UPSTREAM` | `https://agentrouter.org/v1` | 官方入口；通常不用设置 |
| `RHB_PORT` | `8790` | 更换本机监听端口 |

客户端接入地址：

- Codex / Harness / 原生 Responses：`http://127.0.0.1:8790/v1`。
- Claude Code / Messages：`http://127.0.0.1:8790`，桥选择 `RHB_CLIENT=claude-code`。
- 保留客户端实际模型与已有密钥来源，不把模型值改成桥或客户端预设的名称。

默认转发客户端认证。客户端换成有效的新 key 后，新的 HTTP 请求即可使用它，不必重启桥；同一请求的恢复重试使用首次接收的认证。只有设置了桥侧 `RHB_API_KEY` 覆盖时，才需要更新该环境并重启桥。不要把真实 key 写入脚本、命令示例或仓库。

## 当前能力与边界

- 原生 Responses 默认首请求保留原 JSON 字节；恢复不删除加密 reasoning、工具 `call_id`、参数或结果。Codex / Harness 使用各自的完整历史校验契约，不是删除所有 ID。
- 直接配置官方 AgentRouter 主机时，严格匹配的一种 HTTP 400 `{error}` 历史包装也参与资源恢复；不是所有 400 都重试。本机代理不能通过 header 冒充官方主机。
- `harness` 原生 Responses 另有有界瞬时/明确空终态恢复。`codex`、`generic` 与 Messages 转换默认不因空完成重试，不制造额外空输出错误。
- Messages 转换只处理明确可表达的内容，不是所有协议无损互转。Chat Completions 仅透传；`/responses/compact` 不参与历史恢复。
- 输出、未知内容或下游提交后不整轮重放。不可恢复的上游错误如实呈现，不伪造成功。

这是无独立多用户鉴权的**单机单用户**桥，只监听 loopback，拒绝浏览器来源，不提供 CORS。不要公开端口、远程转发或共享给其他用户。请求历史及加密材料会发送给固定上游；加密字段不是隐私保证。

## 详细说明

- [客户端接入](docs/clients.md)：macOS / Windows、Codex、Harness、Claude Code、配置管理工具、换 key。
- [当前范围](docs/scope.md)：预设与旧配置优先级、投影契约、恢复预算、转换保留字段、库 API 与高级选项。
- [验证记录](docs/scope.md#验证记录与未核范围)：区分真实上游、故障注入、安装版 adapter 和跨平台 CI。

```sh
node --test
```

测试使用 loopback mock，不需要真实 key。本轮 AgentRouter 聚焦重构在本机 Node.js 18/22/24 各 887/887；安装版 Codex 的 152 项复制历史在两类故障注入下均完成精确投影，Harness 的 71 项与 91 项检查通过。跨平台 CI 状态见 [本轮记录](docs/verification-agentrouter-focus-20261026.json)；自然上游故障和长期负载不在本轮验证范围。
