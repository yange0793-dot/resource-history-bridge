# 客户端续跑

透明恢复只能处理**同一条请求**在输出前的可恢复故障。原生重试都耗尽、客户端已经报错停下时，要让任务自己接着跑，就得在客户端一侧发一个新的 turn。本组件提供这一层的策略与被验证的原生适配器，**不**提供客户端本体。

两个接口层分清楚：

| 层 | 作用 | 是否已接到真实客户端 |
| --- | --- | --- |
| 请求层（`transparentRecovery`） | 同请求隐藏重试，成功后客户端完全无感 | 是，默认开（见[透明恢复](scope.md#透明恢复默认开启)） |
| 续跑层（`createTurnContinuation` 与两个适配器） | 原生 turn 失败终结后，在同一会话发一次受控新 turn | 适配器按原生协议实现；宿主仍须提供会话状态接口 |

## 为什么需要宿主参与

续跑不能靠猜。要判断"现在能不能安全地再发一次"，必须知道上一次 turn 是否真的结束、工具调用是否都已结算、有没有待批准的权限、副作用是否未知。这些只有客户端自己的会话状态知道。所以核心强制要求宿主提供：

- `readSnapshot(ctx)`：返回持久、已提交的快照证明。必须全部为真：`durableCommitted`、`turnActive === false`、`pendingApproval === false`、`pendingTools === false`、`startedToolCallsSettled === true`、`ambiguousSideEffects === false`、`nativeRetryPending === false`，并带上失败 turn 的 id 与指纹。任何字段缺失或不为布尔值都直接停止，不会放行。
- `resumeTurn(ctx)`：在**同一会话**发一个新的续接 turn，返回归一化的终态 turn。
- 可选 `sendTurn(ctx)`：由内核发起第一个 turn。不传则用 `initialTurn` 传入已经终结的失败 turn。

核心不发送命令、不重放原 prompt、不回滚文件、不裁剪上下文、不绕过额度、不处理取消，也不注入键盘。运行结果 `hostIntegrationRequired: true` 明确表示这一层还需要宿主。

## 预算与停止条件

- 每次运行最多 3 次续跑、总时限 180 秒；跨多次续跑共用同一份预算，不重置。
- 退避 250ms 起、上限 2 秒，宿主给出的 `Retry-After` 只作为下限，不压短。
- 单个实例单次使用：并发调用报 `TURN_CONTINUATION_BUSY`，结束后再调用报 `TURN_CONTINUATION_CLOSED`。
- 同一 thread / session 同时只允许一个续跑，跨适配器实例共享锁。
- 立即停止：认证、权限、额度/计费、上下文超限、策略拦截、参数/schema、未知错误，以及失败指纹与已续跑过的完全一致（同一种失败不会无限续）。
- `AbortSignal` 取消与总超时都会中断等待，不会再多发一次。

## 原生适配器

### Codex app-server

```js
const { createCodexTurnContinuation } = require('./');

const continuation = createCodexTurnContinuation({
  rpc: { call: (method, params, { signal }) => jsonRpcOverMyTransport(method, params, signal) },
  subscribe: handler => subscribeToCodexNotifications(handler),
  readSnapshot: async ({ threadId, failedTurnId }) => myDurableSnapshotReader(threadId, failedTurnId),
  reconcileStart: async ({ threadId, turnId }) => myStartReconciler(threadId, turnId) // 可选
});

const result = await continuation.run({ threadId, failedTurn });
```

- 流程固定为 `thread/resume {threadId, excludeTurns:true}` 然后 `turn/start {threadId, input:[{type:'text',text}]}`，参数只有这两个键，不夹带模型、cwd、sandbox、工具或输出 schema。
- 只有 `turn/completed` 是终态。带 `willRetry` 的错误通知（无论 true 或 false）都不会触发任何续跑。
- ACK 丢失或超时不盲重发：交给 `reconcileStart`；只有宿主确认"从未启动"才会重发一次，否则停止。

### Codex（内置 app-server 客户端）

上面的 `createCodexTurnContinuation` 需要宿主自己实现 JSON-RPC、快照和 ACK 对账。`lib/codex-app-server.js` 把这三件事按 `codex app-server` 的真实协议做完了：

```js
const { createCodexAppServerClient, createCodexAutoContinue } = require('./');

const client = createCodexAppServerClient();       // 默认命令 codex，参数 DEFAULT_ARGS
await client.initialize();
const runner = createCodexAutoContinue({ client }); // watch 轮询、maxContinuations、deadlineMs 均可选
const result = await runner.run({ threadId, signal: controller.signal });
```

命令行等价入口：

```sh
rhb-codex-continue --thread <threadId>
rhb-codex-continue --thread <threadId> --max-continuations 2 --json
```

- 协议面按 `codex-cli 0.162.1` 的 `generate-json-schema` 与真实 stdio 握手核对：行分隔 JSON-RPC 2.0，`id` 字符串或整数都会原样回显，错误是 `{id, error:{code,message}}`，通知多一个 `emittedAtMs`，`initialize` 之后要发 `initialized`。用到的方法是 `thread/resume`、`thread/turns/list`、`turn/start`；监听的通知是 `turn/started`、`turn/completed`、`error`、`serverRequest/resolved`。
- `createCodexSnapshotReader` 只转述服务端报告的状态：线程不是 idle、失败 turn 不是最新、条目未完整加载、工具调用未结算、有待批审批、服务端给了 `willRetry`，任何一条不满足就拒绝并给出具体拒绝码，绝不推断“应该没事”。失败指纹不匹配也拒绝。
- 退出码：0 完成、1 停止、2 用法错误、3 连不上 app server、130 中断。第二次 Ctrl+C 直接关闭子进程退出。
- 未验证：没有在真实上游故障下观测到一次完整续跑（需要真实可恢复失败），item 状态语义来自生成的 schema 而非实测 turn。协议面本身由真实 `codex` 二进制冒烟覆盖。

### DeepSeek Harness

```js
const { createHarnessTurnContinuation } = require('./');

const continuation = createHarnessTurnContinuation({
  session: myHarnessSessionApi,          // 具备 prompt(content, mode, signal, requestId)
  readSnapshot: myDurableSnapshotReader,
  awaitTurn: myTerminalTurnObserver      // 观测到终态 turn 才返回
});

const result = await continuation.run({ sessionId, failedTurn });
```

- 续跑使用 Harness 原生 `prompt` 的 content / queue / signal / requestId，并利用其 `requestId` 幂等语义做**恰好一次**的相同重发。
- 当前安装版公开客户端契约**没有** turn 级别的重试或续跑调用，也没有持久 turn 身份，因此必须由宿主提供 `awaitTurn` 观测终态。缺少该接口时适配器抛 `HARNESS_SEAM_MISSING` 并说明原因，不会编造一层。
- `describe().missingPublicSeam` 会如实列出缺失的原生能力。

## 能力边界

- 没有桌面运行器、没有 UI 自动化、没有键盘注入、没有按应用写死接线。
- 真实 Codex.app / Harness 桌面端要落地，宿主还需提供：(a) 它自己传输上的 app-server JSON-RPC，(b) 从持久状态实现的 `readSnapshot`，(c) Codex 的 `reconcileStart` 与 Harness 的 `awaitTurn`。
- 本仓库的验证使用 mock 原生契约，**不代表**已对真实客户端 GUI 做过续跑实跑。
- 续跑会保留已完成的工具结果（历史和结果来自客户端自身），但模型在新 turn 中仍可能重复发起同一类工具调用；这不等于 exactly-once。
