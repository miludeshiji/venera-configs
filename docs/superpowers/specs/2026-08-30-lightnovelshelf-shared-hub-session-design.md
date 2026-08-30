# 轻书架后台预连接与共享 Hub 会话设计

## 目标

在只修改 `lightnovelshelf.js`、不修改 VeneraNext 核心的前提下，优化两类等待：

1. 首次进入轻书架发现页时，避免把 Token 刷新和 SignalR 建连全部串行放在页面加载路径上；
2. 从发现页进入“查看更多”时，复用刚建立的 Hub 会话，避免再次 negotiate、初始化 transport 和 handshake。

保持现有发现页结构和功能：

- 唯一的“轻书架” `multiPartPage`；
- “最近更新”→“热门漫画”→“阅读历史”三个区块；
- 三个原生“查看更多”；
- 发现页每区块 12 项；
- 分类页每页 24 项；
- 搜索每页 20 项。

源与 `index.json` 的版本从 `0.2.11` 更新为 `0.2.12`。

## 背景与依据

用户日志中，发现页从 `23:07:21.364911` 开始刷新 Token，到 `23:07:27.088949` 取得最后一批历史详情，数据路径约耗时 5.72 秒；首批封面请求在 `23:07:27.147609` 发出。主要阶段为：

- RefreshToken 换取短期 Token：约 1.12 秒；
- Long Polling negotiate、transport 初始化和 handshake：约 2.57 秒；
- 首批列表与历史详情：约 2.03 秒。

发现页在 `23:07:27.091027` 立即关闭 Hub。用户于 `23:07:31.742032` 打开“查看更多”后重新 negotiate，到 `23:07:35.430671` 才取得分类结果，约耗时 3.69 秒；其中分类 Invocation 自身约耗时 1.19 秒，其余主要是重复建连。

官方 Flutter App 的 HEAD `4d6fa854662bb62fe371a5f6edfbf02d7fbb9b56` 使用以下策略：

- `lib/core/network/signalr_connection.dart`：WebSocket + skip negotiation，并长期复用连接；
- `lib/main.dart` 与 `lib/data/app_runtime.dart`：首帧前不等待认证与连接，启动后在后台恢复会话并预连接；
- `lib/features/discover/discover_screen.dart`：各区块独立骨架和独立数据状态；
- `lib/features/discover/home_providers.dart`：首页漫画只加载 6 项最近更新，不加载当前漫画源的热门和阅读历史；
- `lib/features/discover/catalog_providers.dart`：目录状态保活 5 分钟。

Venera 漫画源 JS 只暴露 HTTP 请求接口，没有可用的 WebSocket 桥接；其 `multiPartPage` 也必须等待整个 `load()` Promise 后一次性解析所有区块。因此无法完全复制官方 App，但可以通过后台预连接和短期复用 Long Polling session 消除页面间的重复建连。

## 方案选择

采用“后台预连接 + 单个共享 Long Polling session + Hub 操作串行队列 + 15 秒空闲关闭”。

不采用：

- **后台预取发现页**：虽然预取完成后可以近乎立即返回，但用户未进入轻书架也会产生完整列表和历史请求，并可能展示几秒前的快照；
- **长期持续轮询**：更接近官方 WebSocket，但会增加长期后台流量，并显著扩大 Token 过期、轮询分发和恢复逻辑的复杂度；
- **改变发现页内容**：不把三个区块缩减为官方 App 的 6 项最近漫画，不改变现有 Venera 页面结构。

## 共享会话状态

新增实例级共享状态，职责彼此分离：

- 当前可复用的 Hub session；
- 当前建连 Promise，用于合并 `init()` 预热与正式请求的并发建连；
- Hub 操作队列尾 Promise，用于串行化 session 上的完整操作；
- 当前正在执行的操作数量；
- 空闲关闭代际号；
- 共享会话代际号。

每个共享 session 固定记录：

- API 地址；
- 认证代际；
- RefreshToken 所有权；
- 建连时的短期 Token；
- SignalR URL、Invocation 序号和 Poll 序号；
- 建立时间。

取得共享 session 前必须确认 API 地址、认证代际、RefreshToken 和当前短期 Token 所有权仍匹配。任一不匹配时先淘汰旧 session，再建立新 session。短期 Token 不新增持久化，也不写入日志或 UI。

## 后台预热

新增 `init()`。Venera 加载漫画源后，若账号处于已登录状态，则在后台进入同一 Hub 操作队列并调用共享建连逻辑：

1. 复用或创建 Token 刷新 Promise；
2. negotiate；
3. 初始化 Long Polling transport；
4. 发送并确认 SignalR JSON handshake；
5. 将通过所有权检查的 session 安装为共享 session；
6. 安排 15 秒空闲关闭。

`init()` 不请求漫画列表、热门数据或阅读历史。预热错误被吞掉，不显示错误，也不改变登录数据；稍后的正式请求会正常重试。若用户在预热完成前进入发现页，正式请求等待同一个建连 Promise，不再建立第二条连接。

预热只在其空闲窗口内提供加速。若用户在预热 session 已关闭后才进入页面，则按正常路径重新建连；本设计不通过永久后台轮询换取无限期热连接。

## Hub 操作队列

Long Polling 实现仍采用“发送 Invocation 后主动 poll Completion”。为避免多个调用同时 poll 同一个连接并抢走彼此的 Completion，所有完整 Hub 操作必须进入同一串行队列。

队列规则：

1. 每个队列项独占共享 session，直到其全部依赖调用完成；
2. 发现页的首批三项 Invocation 和后续历史详情属于同一队列项；
3. 自动签到排在触发它的业务操作之后，不插入发现页两阶段之间；
4. 一个队列项失败后，队列尾转换为已完成状态，后续项目仍可执行；
5. 等待队列的调用仍保留现有认证代际和请求代际检查，旧账号结果不得提交。

现有 `_hubInvokeBatch`、`_hubInvokeMany` 和 `_hubInvoke` 的协议职责保持不变。

## 会话取得与 `_runHubSession`

`_runHubSession` 从“每次调用拥有并关闭独立 session”改为“在队列中租用共享 session”：

1. 进入队列时推进空闲关闭代际，使所有旧关闭任务失效；
2. 复用有效共享 session，或等待/创建共享建连 Promise；
3. 执行调用方的完整 operation；
4. 成功后保留 session，并安排新的 15 秒空闲关闭；
5. 失败时按错误类别决定淘汰、重试或直接向上传递；
6. 操作完成后释放队列槽。

发现页仍通过一次 `_runHubSession("LoadDiscovery", operation)` 完成：

```text
GetComicList(latest, 12) ┐
GetComicList(view, 12)   ├─ 同一批 Invocation
GetReadHistory           ┘
          ↓
GetBookListByIds(first 12 comic history IDs)
```

“查看更多”若在空闲期内进入队列，将直接在原 session 上发送 `GetComicList(..., Size: 24)`，不再刷新 Token、negotiate 或 handshake。

## 15 秒空闲关闭

Venera JS 的 `setTimeout` 没有 `clearTimeout`，因此采用代际失效而非取消计时器：

1. 每次取得 session、开始操作或安排新关闭时递增空闲代际；
2. `setTimeout(..., 15000)` 捕获当时代际和 session 身份；
3. 回调仅在以下条件全部满足时处理捕获的 session：
   - 捕获代际仍是最新值；
   - 捕获 session 仍是当前共享 session；
   - 当前没有活动操作；
4. 条件满足后，无论认证和 API 地址所有权是否仍匹配，都先从共享状态移除该 session，再异步发送 `DELETE`；所有权失配只会禁止复用，不能阻止旧连接被清理。

这样，新请求不会取得正在关闭的连接，过期计时任务也不能关闭后来创建的 session，认证或配置变化也不会造成旧连接泄漏。关闭请求不阻塞业务结果。

## 认证与配置变化

以下事件推进共享会话代际并从共享状态移除旧 session：

- 登录开始或新账号登录提交；
- 退出账号；
- 已知的 RefreshToken 变化；
- unauthorized 后准备强制刷新；
- transport 明确关闭或协议损坏。

漫画源没有设置变更监听器，因此 API 地址变化在下一次取得共享 session 时通过快照比较发现；该次操作必须先淘汰旧 session，再连接新地址。

淘汰操作仅关闭其拥有的旧 session，不能清除新账号或新连接的 Token。现有 `_authGeneration`、`_clearSessionTokenIfOwned`、发现页请求代际和历史请求代际继续作为最终提交保护。

## 错误与重试

### 预热错误

预热失败只清理其建连 Promise/session，不向 UI 抛错。正式请求不复用失败 Promise。

### Unauthorized

保持现有语义：

1. 淘汰并关闭失败 session；
2. 仅在认证所有权完全匹配时清除短期 Token；
3. 强制刷新 Token；
4. 建立新共享 session；
5. 完整重试当前 operation 一次。

### Transport 失效

为连接关闭、HTTP transport 失效和 SignalR 协议关闭引入明确的内部错误分类，不依赖易变的中文消息匹配。

- 只有显式标记为幂等的目录读取操作才能淘汰 session，并在新连接上完整重试一次；
- `GetComicContent` 可能关联下载计费，不因不确定 transport 结果自动重放；
- `PostComment`、`ReplyComment` 等写入操作也不在 Completion 丢失后自动重放，避免服务端已执行但客户端重复提交；
- 业务 Completion 错误不是 transport 错误，直接向上传递，不重连重试；
- 所有自动重试合计最多一次，避免循环。

幂等目录读取范围明确限定为本次性能路径使用的发现页、`GetComicList`、`GetReadHistory` 和 `GetBookListByIds`。其他操作保留现有 unauthorized 重试，但不因不确定 transport 结果而重复提交。

## 自动签到

成功业务操作仍机会式触发 `_tryAutoSignIn()`。签到通过同一队列使用共享 session：

- 不阻塞触发它的原请求；
- 不插入正在执行的发现页操作；
- 成功或失败后按正常规则更新空闲计时；
- `SignIn` 自身不递归触发自动签到。

## 性能预期

按用户日志的网络条件估算：

- 若后台预热已完成，发现页跳过约 3.69 秒的 Token/建连路径，仅保留约 2.03 秒的数据调用；
- 发现页完成后 15 秒内打开“查看更多”，跳过约 2.5 秒的重复建连，保留约 1.19 秒的分类 Invocation；
- 若页面进入早于预热完成，仍需等待网络建连，但只等待同一个 Promise；
- 若进入发生在预热空闲关闭之后，本次表现与正常冷启动相同。

这些数字是日志条件下的估算，不作为固定时限保证。协议调用数量和是否重复 negotiate 是确定性验收指标。

## 测试设计

使用隔离的 Node.js `vm` harness 和可控 `Network`/`setTimeout` 桩覆盖：

1. `init()` 预热与正式请求共享同一个建连 Promise；
2. 未登录时不预热；
3. 预热失败静默，正式请求可以重新建连；
4. 成功请求后不立即 `DELETE`；
5. 15 秒内后续读取操作使用同一 session，且没有第二次 negotiate；
6. 新操作使旧空闲关闭回调失效；
7. 最新空闲回调只关闭一次；
8. 关闭时先移除共享状态，新操作不会拿到正在关闭的 session；
9. 多个操作严格串行，发现页两阶段不可被其他调用插入；
10. 队列项目拒绝后，后续项目仍执行；
11. unauthorized 强制刷新并完整重试一次；
12. 失效的幂等目录读取在新连接上重试一次；
13. 不确定的章节下载、发表评论和回复结果不会自动重放；
14. 登录、退出、RefreshToken 和 API 地址变化淘汰旧 session；
15. 旧 session 的关闭或错误不能清除新认证状态；
16. 自动签到排队并复用 session，且不递归；
17. 发现页区块、分页大小、搜索、章节、评论和账号功能回归；
18. 源和索引版本均为 `0.2.12`。

正式验证包括：

- Node.js 专项测试；
- JavaScript 语法检查；
- `index.json` 解析和版本一致性检查；
- `git diff --check` 与 CRLF/LF 检查；
- Venera CLI 漫画源验证；
- 敏感信息扫描。

## 实际日志验收

在账号已登录、发现页加载后 15 秒内进入“查看更多”：

1. 整段用户流程最多出现一次 `refresh_token`、一次 negotiate 和一次 handshake；
2. 发现页的首批三个 target 位于同一个 POST payload；
3. 历史详情复用该 session；
4. 分类 `GetComicList` 直接发送到相同 Hub connection URL；
5. 最后一个操作完成约 15 秒后才出现一次 `DELETE`；
6. 不记录或展示 RefreshToken、JWT、Cookie、密码、访客 ID 或 Authorization 请求头。

## 变更范围

正式修改：

- `lightnovelshelf.js`
  - `init()` 后台预热；
  - 共享 session 与共享建连 Promise；
  - Hub 操作串行队列；
  - 15 秒空闲关闭；
  - transport 错误分类和读取安全重试；
  - 认证/config 变化时的会话淘汰；
  - 版本更新为 `0.2.12`。
- `index.json`
  - 版本同步为 `0.2.12`；
  - 描述补充后台预连接和短期会话复用。
- 本设计文档和后续实施计划。

保持：

- `lightnovelshelf.js` 为 CRLF；
- `index.json` 与 Markdown 为 LF；
- 不修改 VeneraNext、官方 Flutter App、轻书架 Web 或服务端；
- 不修改其他漫画源；
- 不覆盖、格式化、暂存或提交工作区已有的无关改动。

## 非目标

本次不包含：

- 为 Venera JS 新增 WebSocket API；
- 持续后台 Long Polling 或永久保活；
- 后台预取或持久化缓存发现页内容；
- 把 `multiPartPage` 改为区块级渐进渲染；
- 改变发现页区块、顺序或分页大小；
- 本轮实现封面 `height` 缩略图优化；
- 修改服务端限流、认证期限或 SignalR 配置。
