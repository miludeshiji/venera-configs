# 轻书架发现页单连接加载优化设计

## 目标

在只修改漫画源配置、不修改 VeneraNext 应用核心的前提下，缩短 `lightnovelshelf.js` 整合发现页的首次加载时间，同时保持现有页面结构与功能：

1. 发现页仍为唯一的“轻书架” `multiPartPage`；
2. 区块顺序仍为“最近更新”→“热门漫画”→“阅读历史”；
3. 三个区块仍显示原生“查看更多”；
4. 发现页每个区块仍加载 12 项；
5. 点进任一“查看更多”后的分类页改为每页 24 项；
6. 搜索仍为每页 20 项。

版本从 `0.2.10` 更新为 `0.2.11`。

## 现状与限制

用户日志显示，旧实现从 `2026-08-30 16:35:07.285669` 开始刷新会话 Token，到 `16:35:15.378829` 才取得最后一批阅读历史详情，约耗时 8.1 秒。期间三个区块严格串行加载，并为以下四次 Hub 调用分别建立 SignalR Long Polling 连接：

1. `GetComicList`，`Order: "latest"`；
2. `GetComicList`，`Order: "view"`；
3. `GetReadHistory`；
4. `GetBookListByIds`。

每个连接都重复执行 negotiate、transport 初始化、handshake、invoke、poll 和 close，网络往返成为主要耗时。

VeneraNext 当前的 `multiPartPage` 契约只在 `load()` Promise 完整结束后一次性解析并显示全部 `ExplorePagePart`。漫画源无法在不修改应用核心的情况下，让“最近更新”先渲染，再原位填充其余区块，也无法提供区块级骨架屏。因此本设计不承诺渐进渲染，而是通过复用单个连接和批量 Invocation 缩短整页等待时间。

## 方案选择

采用“单个 SignalR 会话 + 混合目标批量 Invocation + 同会话历史详情”的方案。

未采用以下方案：

- `Promise.all` 建立多个独立连接：改动简单，但仍重复 negotiate/handshake，并可能并发刷新同一个短期 Token；
- `mixed` 渐进发现页：当前 VeneraNext 的 `mixed` 解析路径不能可靠解析现有 `viewMore` 对象，而且后续区块只能在滚动到底时追加，无法同时满足三个原生“查看更多”和固定区块结构；
- 假漫画骨架项：返回值解析后不可由漫画源异步原位更新，会留下不可替换的伪数据。

## SignalR 批量调用层

新增通用 `_hubInvokeBatch(session, calls)`。`calls` 为有序数组：

```text
[
  { target: string, params: object },
  ...
]
```

该方法负责：

1. 为每个调用分配独立、递增的 `invocationId`；
2. 将不同 `target` 的 SignalR Invocation 帧拼接进同一个 HTTP POST payload；
3. 继续轮询同一个 Long Polling 会话；
4. 按 `invocationId` 接收可能乱序到达的 Completion；
5. 使用每项自己的 `target` 调用 `_unwrapHubResult` 并生成错误信息；
6. 最终按输入调用顺序返回结果数组。

现有 `_hubInvokeMany(session, target, paramsList)` 保留原签名，并改为把同一 `target` 的参数列表转换为 `calls` 后委托 `_hubInvokeBatch`。这样章节正文的同目标批量分页行为保持不变。

## SignalR 会话生命周期

提取 `_runHubSession(operationName, operation)`，统一管理：

1. 使用当前 Token 打开 Hub；
2. 在该会话中执行调用方提供的异步 `operation(session)`；
3. 若明确收到 unauthorized，关闭旧连接、清空短期 Token、强制刷新 Token，并完整重试 `operation` 一次；
4. 成功后异步关闭连接，不阻塞数据返回；
5. 除 `SignIn` 自身外，成功请求继续机会式触发自动签到。

现有 `_hubCall(target, params)` 改为通过 `_runHubSession` 执行单次 `_hubInvoke`，保持所有普通请求的既有行为。发现页则在一次 `_runHubSession` 中完成两个依赖阶段。

操作回调可能因 unauthorized 执行两次，因此发现页在回调内部只使用局部变量，不提前更新阅读历史实例状态。只有整套调用成功并通过请求代际检查后才提交状态。

## 发现页数据流

新增 `_loadDiscoveryPage()`，由唯一的 `explore[0].load` 调用。

### 第一阶段

打开一个 Hub 会话后，通过一次 `_hubInvokeBatch` 同时发送：

```text
GetComicList({ Page: 1, Size: 12, Order: "latest" })
GetComicList({ Page: 1, Size: 12, Order: "view" })
GetReadHistory({})
```

三项结果按调用顺序分别解释为最近更新、热门漫画和历史 ID 快照。服务端即使乱序返回 Completion，也不会改变区块顺序。

### 第二阶段

从历史响应的 `Comic`/`comic` 中过滤出正安全整数 ID，并截取前 12 个：

- ID 为空时不调用详情接口；
- ID 非空时，在同一个会话调用：

```text
GetBookListByIds({
  Ids: firstTwelveHistoryIds,
  Type: "Comic"
})
```

详情继续通过 `_comicFromListItem` 转换，并按系列 ID 去重。

### 页面组装

两阶段全部成功后，按固定顺序返回现有三个 `{ title, comics, viewMore }` 区块。`viewMore` 的分类名称和内部参数保持不变：

- 最近更新 → `latest`；
- 热门漫画 → `view`；
- 阅读历史 → `history`。

任一实际 Hub 调用失败时，整个发现页仍按现有行为加载失败，不把认证或服务故障伪装为空区块。

## 分页大小

新增两个明确的常量：

```text
LightNovelShelf.discoveryPageSize = 12
LightNovelShelf.categoryPageSize = 24
```

各入口使用以下固定大小：

| 入口 | 请求大小 |
| --- | ---: |
| 发现页最近更新 | 12 |
| 发现页热门漫画 | 12 |
| 发现页阅读历史详情 ID | 12 |
| “查看更多”最近更新 | 24 |
| “查看更多”热门漫画 | 24 |
| “查看更多”阅读历史详情 ID | 24 |
| 搜索 | 20 |

`_loadComicList(order, page, pageSize)` 接收显式分页大小；分类路由传入 24。发现页直接在批量请求中使用 12。

`_loadReadingHistory(page, pageSize)` 默认并由分类路由显式使用 24。其 `maxPage` 改为：

```text
max(1, ceil(validHistoryIdCount / 24))
```

这与轻书架网页端单批最多提交 24 个 ID 的行为一致。

## 阅读历史状态与并发隔离

现有历史状态增加当前快照的分页大小：

```text
_historyPageSize
```

状态包含：

- 有效历史 ID 快照；
- 已展示系列集合；
- 期待的下一页页码；
- 当前快照采用的分页大小；
- 请求代际编号。

以下任一情况重新读取历史并重置去重集合：

- 加载第 1 页；
- 没有有效 ID 快照；
- 页码不是期待的连续下一页；
- 请求的分页大小与状态中的分页大小不同。

发现页成功后可将其 12 项历史快照状态提交为页码大小 12、期待下一页 2。进入“查看更多”时分类页从第 1 页以 24 项重新读取，因此不会把发现页的 12 项切片边界错误复用于分类分页；即使内部直接请求不同大小的连续页，分页大小不一致也会强制刷新。

`_loadDiscoveryPage` 与 `_loadReadingHistory` 都使用 `_historyRequestGeneration`。刷新发现页、打开历史分类、退出账号或其他并发历史请求都会使旧请求失效。旧请求在第一阶段、第二阶段和最终提交前检查代际；失效结果不得更新历史状态或返回为当前页面数据。

## 解析复用

提取只负责解析 `GetComicList` 响应的辅助方法，供普通分类加载和发现页批量结果共同使用，避免复制 `Data`/`data`、`TotalPages`/`totalPages` 兼容逻辑。

提取只负责把 `GetBookListByIds` 响应转换并按给定集合去重的辅助方法，供普通历史分页和发现页共同使用。辅助方法不发起网络请求，也不自行提交实例状态。

## 错误处理

保持以下规则：

- unauthorized：强制刷新 Token，并在新连接中完整重试整套发现页操作一次；
- 其他 Hub、HTTP、协议或响应错误：向上传递；
- 历史字段缺失、不是数组或只含无效 ID：按空历史处理；
- 历史 ID 为空：不发送 `GetBookListByIds`；
- 批量详情 `Data`/`data` 缺失或不是数组：按空详情处理；
- 未知分类参数：明确抛出错误；
- 不输出或持久化 RefreshToken、JWT、密码、访客 ID 或认证请求头。

## 兼容性与变更范围

正式修改：

- `lightnovelshelf.js`
  - 通用混合目标 Hub 批量调用；
  - 可重试的共享 Hub 会话生命周期；
  - 单连接发现页加载器；
  - 12/24/20 三类分页大小；
  - 历史分页大小状态和并发隔离；
  - 版本更新为 `0.2.11`。
- `index.json`
  - 版本同步为 `0.2.11`；
  - 描述补充单连接发现页加载和 24 项分类分页。

新增设计与实施文档。专项测试文件仅在实现期间临时创建，验证完成后删除。

保持：

- `lightnovelshelf.js` 为 CRLF；
- `index.json` 与 Markdown 文档为 LF；
- `jm.js`、`cache/web`、`cache/Venera-Next` 和其他漫画源不修改；
- 工作区已有的无关改动不格式化、不暂存、不提交。

## 验收标准

1. 发现页第一阶段的三个不同 Hub target 位于同一个 POST payload；
2. Completion 乱序返回时结果仍按调用输入顺序映射；
3. 阅读历史详情与第一阶段复用同一个 Hub session；
4. 正常发现页只 open 一次、close 一次；
5. unauthorized 时完整重试一次，且失败尝试不提交历史状态；
6. 退出、刷新和并发请求后旧结果不能污染当前历史状态；
7. 发现页三个区块各请求或截取 12 项；
8. 三个“查看更多”分类页每页请求或截取 24 项；
9. 搜索仍请求 20 项；
10. 三个区块顺序和 `viewMore` 均不变；
11. `_hubInvokeMany` 的同目标批量顺序保持兼容；
12. 空历史不调用详情接口；
13. 源和索引版本均为 `0.2.11`；
14. JavaScript 语法、JSON、版本、whitespace、行尾和 Venera CLI 验证通过。

## 非目标

本次不包含：

- 修改 VeneraNext 以支持区块级渐进渲染或骨架屏；
- 改为 `mixed` 发现页；
- 缓存最近更新或热门漫画；
- 修改搜索分页大小；
- 小说阅读历史；
- 清空或编辑服务端历史；
- 修改轻书架网页端或服务端；
- 与发现页性能无关的 SignalR 协议重写。
