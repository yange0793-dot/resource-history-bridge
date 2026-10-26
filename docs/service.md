# 后台运行

这是可选的用户级运行壳。已有网关用户优先[嵌入恢复核心](architecture.md)，不用再维护一个本机端口；无网关用户可以一次安装后台桥，不必保持终端窗口。

需要 Node.js ≥18，使用本机现有 Node 的绝对路径。安装器不下载程序、不保存密钥、不修改客户端配置，不申请管理员权限。默认自动处理请求，不需要选择客户端或协议。

## 命令

在仓库目录运行：

```sh
node service-cli.js install --dry-run
node service-cli.js install
node service-cli.js status
node service-cli.js stop
node service-cli.js start
node service-cli.js uninstall
```

Windows PowerShell 同样可用：

```powershell
node .\service-cli.js install --dry-run
node .\service-cli.js install
node .\service-cli.js status
```

`help` 查看命令。`--dry-run` 只展示计划文件和原生服务命令，不写文件、不注册服务或查询真实模型。普通 `install` 复制本地已安装来源到独立运行目录，注册用户登录启动，并等待有界健康检查；安装失败尝试验证后回滚，只操作本组件创建且未被改写的文件。

安装前确认需要此服务。仓库开发、测试或查看 dry-run 不会自动安装；安装服务也不代表已经接入客户端。独立使用仍需一次在客户端或配置管理工具中设置 Base URL，见[客户端接入](clients.md)。

## 平台与启动时间

| 平台 | 原生机制 | 启动条件 |
| --- | --- | --- |
| macOS | 当前用户 LaunchAgent | 用户登录，运行于该用户的 GUI 会话 |
| Linux | systemd `--user` | 用户会话可用；不启用需额外授权的 linger |
| Windows | 当前用户 Scheduled Task | 当前用户交互登录，LeastPrivilege，不保存账户密码 |

这是登录后自动启动，不是所有平台开机未登录即运行的系统服务。Linux 无用户 systemd/session、Windows 任务策略限制或本机 Node 不可用时会明确失败，不提升权限绕过。

## 安装内容与身份

服务标识为 `org.resource-history-bridge.user`，不会接管历史的 `com.tufu.resource-history-bridge` 服务。

- macOS 数据目录：`~/Library/Application Support/org.resource-history-bridge.user`；定义：`~/Library/LaunchAgents/org.resource-history-bridge.user.plist`。
- Linux 数据目录：`~/.local/share/org.resource-history-bridge.user`；定义：`~/.config/systemd/user/org.resource-history-bridge.user.service`。
- Windows 数据目录：`~/AppData/Local/org.resource-history-bridge.user`；任务名增加按 home 派生的稳定后缀，另核对当前用户 SID、固定启动动作、工作目录和触发条件。启动时先清理继承的 Node 启动环境再调用固定运行副本，不保存用户账户密码。

安装记录包含版本、运行文件哈希和原生定义指纹。运行副本按版本和内容哈希隔离；临时工作目录与源码目录分离。只有匹配的文件、定义与原生身份可以启停或卸载，不按进程名/PID 随便结束进程。Windows 本地 task.xml 按字节核对，注册任务另核对实际动作、主体、登录触发与关键运行设置，不把系统规范化后的 XML 当成原文件逐字比较。其他程序占用端口时拒绝启动，不抢占或自动切换客户端地址。

`status` 区分未安装、已安装、启动中、运行、失败和端口占用，只读取状态/健康信息，不输出日志或原始请求。

Windows 运行日志保留已有字节，达到 1MiB 后停止追加，重启不会清空或突破上限。Linux 日志进入用户 journal；macOS stdout/stderr 进入上述日志目录，这两个平台的日志保留与清理由系统或用户管理，安装器不声称统一轮转。服务仅记录脱敏启动/退出信息，不记录原始 API 请求、密文或认证。

## 设置与密钥

默认使用官方 AgentRouter、loopback `8790`、自动请求模式。安装时仅记录明确设置的非密钥变量：`RHB_UPSTREAM`、`RHB_PORT`，以及可选旧覆盖 `RHB_CLIENT`、`RHB_HISTORY_MODE`、`RHB_UPSTREAM_PROTOCOL`。任意 shell 环境不会被捕获到服务。

例如更换端口：

```sh
RHB_PORT=8791 node service-cli.js install
```

PowerShell：

```powershell
$env:RHB_PORT = '8791'
node .\service-cli.js install
```

已有客户端认证继续随每个请求转发。检测到 `RHB_API_KEY` 安装会拒绝，不把它写入服务定义、运行脚本或安装记录；需要统一 key 的高级用户应自行安全管理前台运行，不使用这个安装器持久化。

## 停止、升级与卸载

`stop` 停止本组件拥有的当前服务；`start` 在验证定义/运行副本后启动。停止不会改写客户端 Base URL；客户端仍指向桥时将无法发请求。

重复安装同版同设置可以复用；不同内容或配置的安装不静默覆盖。初版升级采用：保存需要的非秘密设置 → 停止 → 验证卸载 → 安装新来源。没有自动下载升级或无人值守原子切换，不宣称更新失败后仍始终可用。

卸载保留已变更/外来文件、日志及不能安全验证的状态；不会删用户历史或替用户恢复 Base URL。确认客户端有可用的直连或网关地址后再停止/卸载。

## 健康检查的含义

`GET /health` 只返回服务名、版本和 ready 状态，且保留本机 Host / Origin 限制。健康接口证明桥已经监听，不证明端口属于某个安装、不证明模型请求成功，也不证明自然 Azure 或密文故障恢复率。后台管理还必须检查原生服务身份和文件指纹。

当前开发验证的 45 项服务用例在本机三版 Node 通过，采用临时文件与注入的原生后端；真实仓库 macOS dry-run 通过，不在用户机器注册真实后台服务。修复后的九个跨平台 CI 作业成功，Windows 保留一项符号链接权限测试的明确跳过，PowerShell5.1 前台启动测试各 13/13。详见[当版验证记录](verification-automatic-runtime-20261026.json)；没有实际服务安装/启停与登录自启证据，不将模拟结果或前台启动当成后台部署成功。
