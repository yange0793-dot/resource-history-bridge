# resource-history-bridge

一个独立运行的本机 HTTP 桥，也可作为 Node.js 纯库使用。不依赖 Mixrouter、特定 Agent、桌面应用或第三方 npm 包；不修改客户端持久历史，也不会自动修改任何软件配置。

## 它恢复什么

仅在 `/responses` 上游返回下面这个已知错误时，尝试一次最小历史投影：

> The requested item was created under a different Azure OpenAI resource.

第一次仍发送原始 JSON 请求字节；恢复请求只去掉 `input` 数组中 **`reasoning.id` 和 `function_call.id`**。保留 `encrypted_content`、工具 `call_id`、`name`、`arguments`、工具输出、文本、模型和所有其他请求字段。其他类型的 `id` 不删除，不生成替代 `call_id`，不改 session/header/cache 身份，不切上游、模型或密钥。

识别范围是 HTTP 400 JSON 错误，或提交前 SSE 的已知 `error` / `response.failed` 帧。其他 400、认证失败、限流、500、断网和无细节错误不重试。总共最多两次上游请求，第二次错误直接透传；不是通用重试器。

这一投影方法依据一次 AgentRouter Azure 后端的工具续接对照实验：原生回放跨资源失败，去掉两类 item ID、保留加密 reasoning 与工具配对后得到 `RESULT_42`。**独立桥本身只做了本机 mock 回归，未对真实上游联网验证，也不保证其他供应商、全部历史类型或长期负载有效。**

## 直接启动

需要 Node.js 18 或更新版本。不需要 `npm install`。

```sh
cd /Users/tufu/Documents/zcode/resource-history-bridge
node --test
RHB_UPSTREAM=https://api.example.com/v1 node cli.js
```

`api.example.com` 只是占位地址：改成你实际使用的 Responses 服务 API Base URL。URL 不允许用户名、密码、query 或 fragment。Base URL 为 `/v1` 时会请求上游 `/v1/responses`，为根路径时会请求 `/responses`；按上游真实入口填写，不要重复 `/v1`。

默认监听 `http://127.0.0.1:8787/v1`。在 Agent 的 **API Base URL / Base URL / endpoint** 字段中填这个地址，并继续选择原模型、Responses 协议和原 API key。客户端发出的 Authorization / `api-key` / `x-api-key` 等 header 会透传。模型仍在调用方请求 JSON 中指定。

如果客户端不能更改 API Base URL，或它只支持其他协议，这个桥不能让它自动生效。SDK 若会自动补 `/v1`，Base URL 应填写 `http://127.0.0.1:8787`；桥同时接受 `/responses` 和 `/v1/responses`。

按 `Ctrl+C` 停止。CLI 不接受任何 argv，包括密钥参数。

### 可选：桥从环境读取上游密钥

优先使用客户端原有密钥管理。若需要桥统一提供密钥，在当前 shell 中安全读取，不把密钥写进命令历史或文件。

Bash：

```sh
read -r -s -p 'API key: ' RHB_API_KEY
printf '\n'
export RHB_API_KEY
export RHB_UPSTREAM=https://api.example.com/v1
node cli.js
unset RHB_API_KEY
```

zsh：

```sh
read -r -s 'RHB_API_KEY?API key: '
printf '\n'
export RHB_API_KEY
export RHB_UPSTREAM=https://api.example.com/v1
node cli.js
unset RHB_API_KEY
```

环境提供的密钥会覆盖调用方三类认证 header。默认发送 `Authorization: Bearer <环境密钥>`；直接 Azure 风格可设置 `RHB_KEY_HEADER=api-key`。密钥只存在于进程环境/内存和上游请求，不记录请求正文或认证日志。环境变量仍可能被同机有权限的进程读取。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RHB_UPSTREAM` | 无，必填 | 固定上游 API Base URL；生产建议 HTTPS |
| `RHB_API_KEY` | 未设置 | 不设置则使用调用方 header；设置则覆盖上游密钥 |
| `RHB_KEY_HEADER` | `authorization` | 仅 `authorization` / `api-key` / `x-api-key` |
| `RHB_HOST` | `127.0.0.1` | 仅 `127.0.0.1` / `::1` / `localhost` |
| `RHB_PORT` | `8787` | 1–65535 |
| `RHB_TIMEOUT_MS` | `180000` | 从接收请求体到两次上游结束的共用总时限，1–1800000 ms |
| `RHB_REQUEST_LIMIT` | `8388608` | 请求体最大字节数，最大 64 MiB |
| `RHB_BUFFER_LIMIT` | `65536` | 提交前错误/SSE 缓冲上限，最大 64 KiB；到上限即透传且不恢复 |

`/responses/compact`、`/chat/completions` 和 `/messages` 支持普通 POST JSON 转发，**不参与恢复，不修复它们的签名或历史**。其他路径、query、非 JSON 和压缩请求体不接受。不是 Azure 原生含 `api-version` query 的通用网关；本版适用于固定、不要求 URL query 的 API 入口。

## 作为库使用

```js
const {
  isKnownResourceError,
  projectResponsesHistory,
  createBridge
} = require('/Users/tufu/Documents/zcode/resource-history-bridge');

// requestBody 必须是你自己的完整 Responses 历史；不要只给引用。
const projection = projectResponsesHistory(requestBody);
if (isKnownResourceError(upstreamError) && projection.ok) {
  // 由调用者负责安全提交判据、最多一次恢复和总时限。
  // projection.body 是新对象；requestBody 不被修改。
}

const bridge = createBridge({
  upstream: process.env.RHB_UPSTREAM,
  apiKey: process.env.RHB_API_KEY,
  timeoutMs: 180000
});
await bridge.listen(8787);
// 用完后 await bridge.close(); 关闭监听、在途上游和本桥 socket。
```

上例中的 `await` 放在 async 函数内。库的投影返回 `{ ok: true, body, removed }`，或 `{ ok: false, code, message }`。`createBridge` 返回 `{ server, listen, close }`；库允许 `listen(0)` 分配临时端口，CLI 不允许端口 0。库没有读取环境变量的隐藏行为：需要调用方显式传选项。

## 不能恢复的历史

遇到已知资源错误后，下列情况返回 HTTP 409 的 `resource_history_bridge_error`，不会删字段拼造历史：

- 存在 `previous_response_id` 或服务器 `conversation` 引用，包括同时给了部分 `input` 的情况。
- `item_reference`，只有文本或空 `input`，没有可展开的完整显式历史。
- 工具调用/结果缺配对、顺序不对、重复 `call_id`，或缺 `name` / `arguments` / `output`。
- 没有支持投影的两类 item ID；其他类型的 ID 不会为了“恢复成功”而删除。

普通第一次请求不会预先拒绝这些上游本可处理的历史。桥无法判断调用方是否遗漏了早期历史，只能检查明确引用和工具配对；发送完整历史仍由调用方负责。

## SSE 与提交边界

- 只暂存有界、已识别且无输出的 `response.created` / `response.queued` / `response.in_progress` 生命周期帧。恢复时丢弃第一条失败流的这部分未提交帧。
- 文本/工具/正文帧、未识别事件、坏 JSON、注释心跳、未知字段或原始未知字节立即提交。一旦提交，后续资源错误不再重试，流按原样交给客户端。
- 已识别 SSE 前缀的不完整帧可暂存至 delimiter、字节上限或共用总时限；坏帧不会当作无输出。
- 错误缓冲太大或上游忽略 `Accept-Encoding: identity` 返回压缩内容时，直接透传而不检查恢复。
- 上游连接不完整：未提交时 HTTP 502；已经提交时关闭下游，不能伪造一个完整响应。超时未提交时 HTTP 504，已提交则关闭连接。取消客户端请求会中止在途上游，不会再发恢复请求。
- 只是 SSE 语法或逻辑上缺少完成帧、而 HTTP 正常结束时，现有字节原样透传；桥不生成完成帧，也不据此重试。

## 安全边界

这是**单机单用户、没有独立鉴权**的本机桥，不是多用户网关。固定上游，不能从 URL/请求体指定代理目标。只监听 loopback，检查 loopback `Host`，拒绝任何 `Origin` / `Sec-Fetch-Site` 浏览器 header，不启用 CORS；因此浏览器网页不是受支持客户端。

这些检查不能隔离同机恶意进程或其他本机用户。若设置了统一上游密钥，能访问本机端口的进程可能消耗该密钥额度；不要暴露端口，不用 SSH/容器端口映射将它公开。请求和加密推理材料均会发送给配置的上游；加密字段不代表上游不可读取内容。HTTP 上游不加密网络传输，生产使用 HTTPS。

桥只输出启动监听地址与通用启动失败消息，不输出 API key、请求正文、加密 reasoning、上游错误内容或 upstream URL。上游错误仍会作为 API 响应返回给调用方，这是正常转发而不是日志。

## 测试

```sh
node --test /Users/tufu/Documents/zcode/resource-history-bridge/test/*.test.js
```

测试只创建临时 loopback mock 上游/桥，结束后关闭 listener、socket 和子进程。不需要网络密钥，不访问真实上游。覆盖纯库投影、原请求不可变、身份保留、工具配对、JSON/SSE 恢复预算与提交边界、引用拒绝、请求/缓冲上限、截断、取消、超时、本机访问限制和 CLI 启停。

未验证范围包括真实供应商自动恢复、不同 Agent 的配置入口、所有 Responses 项类型、长期并发负载和环境中的 Node 18；当前回归运行版本见交付说明。请先用不敏感的小会话确认你的上游与客户端兼容，再用于实际工作。
