# 接入与架构

恢复能力不应要求用户先辨别客户端。组件分成三层：可嵌入的恢复会话、按请求端点工作的本机 HTTP 桥、可选用户级后台运行壳。三层共用同一套恢复逻辑，不各自维护重试实现。

## 已有网关：嵌入出站层

```text
客户端 → 网关路由/协议适配 → 恢复会话 → AgentRouter
```

接入点必须在实际出站目标和协议已经确定之后。网关为每个入站请求创建一个 `createRecoverySession`，自行负责发送请求、完整检查响应、等待重试和向客户端提交输出。核心不监听端口、不读取环境、不选择模型或凭据，也不安装服务。

只有构造会话时传入的实际出站 URL 是官方 AgentRouter HTTPS 目标，且端点参与恢复时，核心才允许约定重试。响应 header、客户端名称、User-Agent 或错误正文不能替换这个目标。接入者不能把本机代理地址伪装成后面的真实上游。

### 调用接口

```js
const { createRecoverySession } = require('./');

const session = createRecoverySession({
  upstream: resolvedUpstreamUrl, // 网关已经确定的实际目标
  endpoint: 'responses',
  body: parsedRequest,
  rawBody: originalRequestBytes
});

const current = session.current();
// 网关发送 current.rawBody，并完整检查该次响应后：
const decision = session.decide({
  attempt: current.attempt,
  statusCode: upstreamStatus,
  headers: upstreamHeaders,
  payload: inspectedPayload,
  inspectionComplete: true,
  responseComplete: true,
  output: { hasOutput: false, unknown: false, committed: false }
});
// decision.retry 为 true 时，等待 decision.delayMs 后再发送
// decision.rawBody；否则转发原始结果。标志必须来自实际检查。
```

示例中的变量由网关提供，不是让调用者把未知输出写成 false。`inspectionComplete` 表示所有已接收数据已检查完；`responseComplete` 表示 HTTP 正常结束。资源/密文恢复需要两者都为 true，单独一个 `complete:true` 不接受。可选 `attempt` 必须匹配当前会话轮次；复用 failure 对象时必须带它。不带 attempt 则每轮提供新的检查快照，重复旧快照不会重复消费预算。

`current()` 返回当前 body、rawBody、attempt、deadlineAtMs、lossy、state 与 recoveryHeaders；`decide()` 另外返回 retry、delayMs、reason、projection 和兼容 projectionError。返回对象与输入历史均为分离副本；核心不把密文或完整请求写入日志。调用方仍须固定认证、取消等待及自己的提交边界，不应把这些快照原样记录到日志。

### 核心与网关的边界

- 网关确定实际 URL、认证、模型和协议，且在整个恢复请求内保持它们不变。
- 核心保留首请求字节；资源错误后校验副本并投影约定 ID；明确密文错误后最多一次有损 reasoning 降级。
- 网关完整检查 HTTP/JSON/SSE；任何输出、推理、工具、未知内容、部分尾帧或下游提交都必须报告给核心，不能只提取错误码。
- 核心采用保守默认：缺少完整检查及明确无输出的证据，不重试。检查结束与 HTTP 正常结束是两个不同事实；干净的输出前连接失败只在显式连续恢复策略下参与。
- 核心返回重试决策及当前请求副本，不代替网关执行发送或 sleep。接受的重试立即计入私有预算，不能靠反复读取或改写返回快照重置预算。
- 已有网关本身若有重试，集成者须统一总预算，不能把两套循环叠加后冒称仍是十次。

这提供嵌入接口，不代表任意网关已安装本组件。JavaScript 网关可直接调用 CommonJS API；其他语言需要实现适配或使用 HTTP 运行壳。不会自动修改用户正在运行的 Mixrouter 或其他网关。

## 无网关：一个自动 HTTP 入口

```text
客户端 → 同一个本机桥 → AgentRouter
```

默认无需 `RHB_CLIENT`。桥按 `/responses`、`/messages`、`/chat/completions`、`/responses/compact` 分派请求，按完整历史字段而不是客户端名称校验。

- `/responses`：首请求原协议、原字节；约定错误发生后按严格自动历史契约恢复。
- `/messages`：官方 AgentRouter 的默认自动入口使用已有 Messages → Responses 适配，再返回 Messages。不能表达的内容仍拒绝，不宣称无损互转。
- Chat 和 compact：不参与历史恢复。
- 其他固定上游：原协议透传，不猜测供应商，不自动转换。

“自动”只意味着这个组件支持的端点与历史形状，不是推断所有上游能力。旧客户端预设和显式协议覆盖仍可用于兼容，但不再是普通启动的前置选择。自动历史支持也不会隐式开启 Harness 的空终态、瞬时错误或泛化 400 策略。

## 可选后台运行壳

后台运行解决终端窗口和登录后的进程维护，不解决流量从哪里进入。无网关用户仍需一次把自己的客户端 Base URL 接到本机桥；安装器不接管客户端配置或密钥。

后台命令只管理本组件拥有的用户级服务和版本化运行副本。检查服务定义、运行路径和文件指纹后才操作；端口可连接或健康接口返回成功，不足以证明是本组件拥有的服务。

`/health` 只证明本机桥监听已就绪，不证明模型请求成功或自然 Azure 故障已恢复。卸载也不替用户恢复客户端的 Base URL，因此停止/卸载前需确保客户端已有可用接入点。

## 借鉴的实现

借鉴的是接入与生命周期结构，不复制项目的渠道池、账户管理或桌面平台：

- [CLIProxyAPI SDK 指南](https://github.com/router-for-me/CLIProxyAPI/blob/307803510bce87f986fcf7b1a84190f105c7b4aa/docs/sdk-usage.md)：可嵌入运行层、统一启动/停止、服务器与中间件扩展。指南中的模块版本与源码有差异，不照抄安装命令。
- [CLIProxyAPI 生命周期](https://github.com/router-for-me/CLIProxyAPI/blob/307803510bce87f986fcf7b1a84190f105c7b4aa/sdk/cliproxy/service_lifecycle.go)：取消与关闭集中管理；本组件不引入其账户或路由系统。
- [EasyCLIProxyAPI 进程启动](https://github.com/router-for-me/EasyCLIProxyAPI/blob/f9b18a56c7f1d96406dd4c0bdf61c8662d05287c/src-tauri/src/core_runtime.rs#L1544-L1640)：启动需同时检查进程退出和端口就绪，端口占用不能当成已经成功；其路径身份检查也用于避免操作错误进程。
- [CC Switch 模式控制](https://github.com/farion1231/cc-switch/blob/50395742445738d418427d480ef574eaa624a1de/src-tauri/src/mode/controller.rs)：配置接管要有备份与退出恢复。这一层不是本组件的职责，所以本组件不自动改写客户端设置。

不使用系统级 TLS 解密、安装根证书或全局流量劫持来获得“零配置”。普通 HTTPS CONNECT 隧道仅转发加密流，不能修复其中的 API 历史。
