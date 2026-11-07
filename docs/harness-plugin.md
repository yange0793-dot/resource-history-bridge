# DeepSeek Harness 自动续跑插件

透明恢复只管**同一条请求**在输出前的可恢复故障；原生重试耗尽、turn 已经以错误终结之后，要让任务自己接着跑，就得在同一个 session 里再发一个 turn。本文接口于 2026-11-07 在**本机安装的 Harness（0.2.1-rc.4）**中核对。

宿主适配器本体在 `lib/harness-host.js`，策略内核仍是 `lib/client-continuation.js` 的 `createHarnessTurnContinuation`。插件入口是 [`plugins/harness-auto-continue.mjs`](../plugins/harness-auto-continue.mjs)，使用相对路径加载仓库内的宿主模块，无需复制代码或修改源码里的绝对路径。

## 结论先说

- **能自动发起新的 turn**，不需要键盘注入、不需要 UI 自动化：Harness 的 Cordis 插件拿得到本进程里的 `Agent` 句柄，`agent.followup(message)` 就是"排队下一个 turn 并唤醒驱动"的原生入口。已安装版本里这条路是可用的。
- **没有**公开的 "continue/retry turn" RPC，也**没有** turn 级别的 `willRetry` 标记；这两件事由宿主自己从耐久 session 日志折叠出证据（见下表）。
- 续跑 turn 在会话里就是一个普通的 `user/message`（`source.kind = 'user'`，带 `rpcId`），界面上会显示成一条用户消息。这是刻意的：不伪造助手输出，也不改动历史。
- 插件只能续跑**本进程里 Agent 还活着**的 session。应用重启后的冷 session 没有可续跑的驱动。

## 真实接口（全部在安装目录里核对过）

安装路径：`/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/`。

| 能力 | 真实接口 | 说明 |
| --- | --- | --- |
| 拿 Agent | `ctx.agents.get(sessionId) → Agent` | `@deepseek-ai/dsh-agent` 的 `AgentRegistry`，服务名 `agents` |
| 发下一个 turn | `agent.followup(message)` | 插入 `next-turn` 并 `wakeDriver()`；`mode: 'steer'` 对应 `agent.steer(message)`（插 `next-step`） |
| 观察状态 | `agent.status` | `'idle'` \| `'running'` |
| 读日志 | `agent.session.snapshotEvents()` | 提交点之后的完整耐久事件数组 |
| 读待发消息 | `agent.inbox.nextTurn` / `nextStep` | 耐久 inbox 投影 |
| 耐久屏障 | `ctx.sessions.flush(session)` | 派发 `session/flush` 并等写入端落盘；服务名 `sessions` |
| 会话事件 | `ctx.on('session/event', (session, event) => …)` | 每个已提交事件一次 |
| 状态事件 | `ctx.on('agent/status', payload)` | `payload = { agent, status: 'idle' \| 'running' }` |
| 认领事件 | `ctx.on('agent/inbox/claimed', payload)` | `payload = { agent, message, turn }`，**同步**发生在 `followup()` 里 |
| turn 终结 | 日志事件 `turn/end` | `data = { turn, reason }` |

`turn/end` 的 `reason.kind` 取值：`completed` / `blocked` / `aborted` / `interrupted` / `error` / `max-tokens` / `forked`。**只有 `error` 带失败**：

```
{ kind: 'error', error: { message, code, status?, providerRetryAfterMs?, requestId?, offloadImages? } }
```

`error` 就是 `LlmError#failure`。`code` 是适配器自己的词表（`TRANSPORT`、`STREAM_CLOSED`、`TIMEOUT`、`RATE_LIMIT`、`SERVER`、`AUTH`、`QUOTA`、`ACCOUNT_QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`INVALID_CREDENTIAL`、`IMAGE_OFFLOAD_REQUIRED`、`EMPTY_RESPONSE`、`PI_AI_ERROR`、`UNKNOWN_MODEL`、`ABORTED`、`UNKNOWN` …），`status` 是上游 HTTP 状态（有才带）。

## 安装

保留完整仓库，在目标 profile 的用户 patch 中引用插件入口。不改应用安装目录，不需要安装 npm 依赖。

### 1. 取得插件路径

在仓库根目录运行：

```sh
node -p "require('node:path').resolve('plugins/harness-auto-continue.mjs')"
```

将输出的绝对路径填到下一步的 `name`。插件依赖同仓库的 `lib`，不要单独移动这个文件。

### 2. 插入 profile patch

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`（**先手工备份一份**；它同时是应用自己的 patch 层，应用升级或损坏恢复时可能被重写），在文件末尾追加：

```yaml
- insert:
    - id: harness-auto-continue
      name: "/absolute/path/to/resource-history-bridge/plugins/harness-auto-continue.mjs"
      inject: [ agents, sessions ]
```

- 这一行是**可选条目**：加载失败只会打一条警告，不会让应用起不来（app-boot 的启动矩阵对 optional entry 是 "warn; continue"）。
- 用户级的 `~/.dsh/cordis.patch.yml` 对**所有** profile 生效；只在 desktop 使用时放在 desktop profile 中。
- 其他 profile（例如 `headless`）要用，就在那个 profile 的 patch 里加同样一行。

### 3. 生效

- 安装自带的 `@deepseek-ai/dsh-hmr` 在 profile 启动时会监视 profile 清单和两层用户 patch；改完 patch 通常**热生效**。
- 不确定时**重启应用**最稳（HMR 只在 HMR 条启用、patch 可解析时才重载）。
- 验证是否挂上：应用日志里有 `harness-auto-continue: enabled`。桌面端是 Electron 应用，`--dump-config` 是 `dsh` 启动器（app-boot）的能力，不是这里必用的检查手段。

## 卸载与回退

1. 删掉 `cordis.patch.yml` 里属于 `harness-auto-continue` 的整个 `insert` 条目，保留其他条目。
2. 重启应用（或等 HMR 重载）。插件卸载时 Cordis 会回收监听，`host.dispose()` 会取消由宿主启动的续跑等待，防止卸载后再发送新 turn。已经开始的原生 turn 由 Harness 管理。

回退成本很低，因为：

- 插件不改任何用户配置、不写 session 文件、不加工具、不改模型路由；它只是**在既有 session 里发一条普通的用户消息**。
- 已经发出去的续跑 turn 就留在历史里，跟用户自己打的"继续"没有区别。
- 真要清干净：删行 + 重启即可，没有残留状态。若 patch 写坏导致启动异常，用 `--dump-config` 先确认是不是自己的条目，再删行。

## 行为规则

宿主统计一次失败（`turn/end { reason.kind: 'error' }`），等 Agent 回到 `idle`，然后按下表决定动不动手：

| 条件 | 动作 |
| --- | --- |
| 失败码可恢复（`TRANSPORT` / `STREAM_CLOSED` / `TIMEOUT` / `RATE_LIMIT` / `SERVER`，或 HTTP 408/429/5xx，或之前识别过的 Azure 资源不匹配） | 续跑 |
| 认证、额度、上下文超限、参数/schema、策略拦截、未知码 | 停，不发 turn |
| `interrupted` / `aborted`（用户按了停止）、`blocked`（pre-step 被拒，如归档会话） | 停 |
| 失败 turn 不是最新那个（后面已经跑过别的 turn） | 停 |
| 有工具调用没结算（已发起未回结果 / 只回了兜底错误结果） | 停：副作用可能已经发生，交给用户判断 |
| 有未决策的审批 | 停 |
| 原生重试还在飞（`llm/retry` 有、`llm/retry-started` 没到） | 停 |
| 耐久屏障失败 / 读不到日志 | 停 |
| 同一个失败 turn 已经续过 | 停 |
| 每个 session 的自动轮次用尽（默认 3） | 停 |

一次续跑流程内部还有内核自己的约束：最多 3 次续跑、总时限 180 秒、退避 250 ms 起、同一失败指纹不重复续、同一 session 同时只允许一个续跑。

## 边界（诚实清单）

`HARNESS_MISSING_SEAM` 逐条对应本机安装版**确实没有**的公开能力，以及宿主的替代做法：

1. **没有 turn 级的 retry/continue 调用** —— 用 `Agent` 句柄的 `followup()` / `steer()` 起下一个 turn。
2. **`requestId` 幂等只存在于 session-controller 的 `prompt` 里** —— 宿主按它的 `hasPromptRequest()` 规则在耐久日志上重做一遍（`user/message` 的 `source.rpcId`，加上 inbox 待发消息），所以同一个 `requestId` 只会被接受一次。
3. **`turn/end` 没有 `willRetry` / `nativeRetryPending` 字段** —— 由"没有 open turn + 没有未完成的 `llm/retry`"推出来。
4. **没有公开的 pending-approval 读取口** —— 由 `approval/asked` 没有被同一 turn 内的 `approval/decided` 结清推出来。
5. **没有 turn 级持久身份**，只有 session id + 从 1 开始递增的整数 turn。
6. **冷 session 没有进程内入口** —— Agent 不在本进程里就不能续跑（这就是"重启后不会再自动继续"的原因）。

另外明确不做：键盘/UI 自动化、重放原 prompt 或工具输出、回滚文件、裁剪上下文、绕过额度、处理取消、伪造助手消息。续跑会保留已完成的工具结果，但模型在新 turn 里仍可能重复同类工具调用，**不是 exactly-once**。

## 验证方式

- 单元测试：`node --test test/harness-host.test.js`，覆盖触发、原生重试期间不触发、工具未结算/待批准不触发、同指纹不重复续、预算与取消、插件入口加载以及卸载期间的任务取消。测试用的是**真实事件与 payload 形状的 mock**，不是真实模型调用。
- 手动冒烟（可选，需要你自己开应用）：断掉上游或让代理端口不可用，制造一次 `TRANSPORT` 终结 → 日志出现 `turn/end { reason.kind: 'error', code: 'TRANSPORT' }` → 几秒内会话里出现一条 `Continue from where the previous turn stopped.` 的用户消息，并且新 turn 正常跑完。
- 关掉自动续跑做对照：移除插件条目并重启或重载。自行嵌入宿主时可以设置 `autoContinue: false`，再由调用方决定何时调用续跑接口。

## 未验证部分

- 插件**没有**装进桌面应用的实际 profile，也没有对真实上游做过续跑实跑；续跑行为验证使用 mock 会话。
- 仓库插件入口已由 mock Cordis 上下文验证：一次 `TRANSPORT` 终结后只发出一条续跑消息，卸载会回收监听，落盘等待期间卸载不会继续发消息。安装版 Cordis Loader 的独立装载结果见[验证记录](verification.md)；它使用 mock `agents` / `sessions` 服务，不等于真实 Agent 时序验证。
- HMR 热重载这条路径按 app-boot 文档与 base bundle 的 `hmr` 条目推断；实测以重启后行为为准。
- 续跑 turn 的 UI 呈现（以普通用户消息出现）按 `user/message` 的日志语义推断，未截图核对。
