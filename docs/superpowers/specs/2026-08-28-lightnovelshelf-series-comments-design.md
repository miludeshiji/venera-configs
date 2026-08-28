# 轻书架系列评论设计

## 目标

为 `lightnovelshelf.js` 增加与轻书架网页端系列详情一致的评论能力：按需查看系列评论、分页浏览、查看回复、发表评论以及回复主评论。

轻书架在 Venera 中以系列为一个漫画条目，详情页聚合多个上传者维护的书籍版本。因此评论对象固定为系列，而不是任意一个上传版本：

```text
Type: "Series"
Id: 0
SeriesTitle: comicId
```

详情页不预加载评论。Venera 只显示评论入口，用户打开评论页后才建立 SignalR 连接并请求数据。

## 依据

### Venera 评论接口

`jm.js`、`copy_manga_multi_accounts.js`、`manhuaren.js` 和 `_template_.js` 表明，漫画源通过以下接口提供详情页评论：

- `comic.loadComments(comicId, subId, page, replyTo)`
- `comic.sendComment(comicId, subId, content, replyTo)`

`loadComments` 返回 `Comment[]` 和可选的 `maxPage`。顶层 `Comment` 可通过 `replyCount` 和 `id` 打开回复页；回复页只会把顶层评论 ID 作为 `replyTo` 传回漫画源。

### 轻书架网页端

`cache/Web/src/services/comment` 定义了以下 SignalR Hub 方法：

- `GetComments`
- `PostComment`
- `ReplyComment`

系列详情页 `cache/Web/src/pages/Manga/Detail.vue` 使用：

```text
CommentType.Series + SeriesTitle
```

`GetComments` 返回：

- `Data`：顶层评论 ID 及其 `Reply` ID 列表；
- `Commentaries`：评论正文、用户 ID、时间和回复目标；
- `Users`：用户名称与头像；
- `TotalPages`：顶层评论总页数。

回复嵌在父评论所在的顶层分页响应中，没有独立的“按父评论 ID 获取回复”方法。

## 方案选择

采用“复合评论 ID 携带父评论页码”的无状态方案。

顶层评论暴露给 Venera 的 ID 格式为：

```text
真实评论ID//所在页
```

打开回复页时，漫画源从该 ID 恢复真实父评论 ID 和原始页码，重新调用 `GetComments` 并从对应 `Data[].Reply` 提取回复。这与仓库中 `manhuaren.js` 处理分页内嵌回复的模式一致。

未采用实例内 `评论 ID -> 页码` 映射，因为源重载或并发浏览多个系列时映射可能丢失或冲突。未采用逐页搜索父评论，因为评论较多时会产生大量 SignalR 连接和请求。

## 架构与组件

### 复用现有 SignalR 层

评论请求全部通过现有 `_hubCall` 执行，继续复用：

- RefreshToken 换取短期会话 Token；
- SignalR Bearer Token 认证；
- Long Polling transport；
- 未授权时强制刷新并重试一次；
- 防缓存轮询 URL；
- 请求完成后的连接关闭；
- 普通 Hub 调用成功后的机会式自动签到。

评论功能不新增独立网络协议实现，也不修改登录、签到、列表、搜索、详情或章节读取流程。

### 评论解析辅助逻辑

在 `LightNovelShelf` 内增加聚焦于评论的辅助逻辑，职责包括：

1. 构造系列评论参数；
2. 读取 PascalCase/camelCase 字段；
3. 从 `Users` 与 `Commentaries` 组合单条 Venera `Comment`；
4. 编码和解析 `真实评论ID//页码`；
5. 为回复补充被回复用户名称。

辅助逻辑只依赖现有 `_value`、`_normalizeUrl` 和 `_hubCall`，不引入持久化评论状态。

### Venera 接口

在现有 `comic` 对象中增加：

- `loadComments`：加载顶层系列评论或指定主评论的回复；
- `sendComment`：发送顶层系列评论或回复指定主评论。

不设置 `ComicDetails.subId`。系列标题已经由 `comicId` 提供，且轻书架系列评论接口不需要额外实体 ID。

## 加载顶层评论

调用参数为：

```text
GetComments({
  Type: "Series",
  Id: 0,
  SeriesTitle: comicId,
  Page: page
})
```

对每个 `Data` 项：

1. 根据 `Data[].Id` 查找 `Commentaries` 中的评论记录；
2. 根据评论记录的 `UserId` 查找 `Users` 中的用户记录；
3. 映射为 Venera `Comment`：
   - `userName`：`UserName`；
   - `avatar`：经 `_normalizeUrl` 标准化的 `Avatar`；
   - `content`：`Content`；
   - `time`：`CreatedAt`；
   - `replyCount`：`Reply.length`；
   - `id`：`Data[].Id + "//" + page`。
4. 按 `Data` 原有顺序返回。

`maxPage` 使用服务端的 `TotalPages`。若服务端返回零页但当前请求合法，则至少按一页处理，避免 Venera 分页状态异常。

## 加载回复

当 `replyTo` 非空时：

1. 严格解析 `真实评论ID//所在页`，要求两部分均为正整数；
2. 忽略 Venera 回复页传入的分页值，重新请求复合 ID 中记录的父评论原始页；
3. 找到 `Data[].Id` 与父评论真实 ID 相同的项；
4. 按其 `Reply` 数组顺序，从 `Commentaries` 与 `Users` 组合回复；
5. 回复项不设置 `replyCount`，避免 Venera 继续打开第三级回复页；
6. 返回 `maxPage: 1`。

若回复记录的 `ReplyId` 指向另一条回复，则解析目标回复的用户并在正文前增加：

```text
回复 @用户名：
```

这样可保留轻书架网页端“某用户回复某用户”的语义。直接回复主评论时不添加该前缀，因为 Venera 回复页已经显示父评论上下文。

父评论已经删除、移出该页或不存在时返回空回复列表和 `maxPage: 1`，不进行逐页扫描。

## 发送评论

### 顶层评论

当 `replyTo` 为空时调用：

```text
PostComment({
  Type: "Series",
  Id: 0,
  SeriesTitle: comicId,
  Content: content
})
```

### 回复主评论

当 `replyTo` 非空时：

1. 解析复合 ID 并取得真实父评论 ID；
2. 调用：

```text
ReplyComment({
  Type: "Series",
  Id: 0,
  SeriesTitle: comicId,
  Content: content,
  ParentId: parentCommentId
})
```

Venera 当前只能从主评论进入回复页，不能选择某条子回复作为发送目标，因此不发送 `ReplyId`。读取已有子回复时仍展示服务端返回的子回复目标关系。

发送前要求当前源已登录，并拒绝空字符串或全空白内容。成功完成 Hub 调用即视为发送成功，由 Venera 重新加载评论列表。

## 错误处理与数据降级

- 顶层响应同时兼容 PascalCase 与 camelCase。
- `Data` 必须是数组，`Users` 与 `Commentaries` 必须是对象；整体结构不符合要求时抛出“评论响应格式异常”。
- 单条数据缺少评论记录时跳过该条，避免一条损坏记录阻断整页。
- 评论记录存在但用户记录缺失时，使用“未知用户”并省略头像。
- 头像为空时不生成无效 URL。
- 复合评论 ID 格式错误时拒绝加载回复或发送回复，不向服务端发送错误 ID。
- 未登录和空内容使用明确中文错误。
- 服务端认证错误继续交给 `_hubCall` 的 Token 刷新与单次重试处理。
- 不记录、不持久化也不展示 RefreshToken、会话 Token、密码或 `x-id`。

## 功能边界

本次包含：

- 系列顶层评论读取；
- 顶层评论分页；
- 主评论回复列表；
- 子回复目标名称展示；
- 发表系列评论；
- 回复主评论。

本次不包含：

- 单个上传版本的 `Book` 评论；
- 详情页评论预加载或评论预览；
- 删除评论；
- 评论点赞、投票或评分；
- 回复某条子回复；
- 评论本地缓存；
- 修改 `cache/Web`、`cache/Venera-Next` 或其他漫画源。

## 版本与文件范围

正式变更包括：

- `lightnovelshelf.js`
  - 增加系列评论辅助逻辑；
  - 增加 `comic.loadComments` 和 `comic.sendComment`；
  - 顶部功能说明增加系列评论与回复；
  - 版本从 `0.2.8` 升至 `0.2.9`。
- `index.json`
  - 轻书架条目版本同步为 `0.2.9`；
  - 描述增加系列评论与回复能力。

保持 `lightnovelshelf.js` 当前 CRLF 行尾和 `index.json` 当前 LF 行尾。`jm.js`、`copy_manga_multi_accounts.js`、`cache/Web` 与 `cache/Venera-Next` 只作参考。

## 测试与验收

采用隔离的 JavaScript 测试 harness 模拟 `_hubCall`，不使用真实账号，不向线上评论区写入测试内容。测试覆盖：

1. 顶层评论调用 `GetComments`，系列类型、标题和页码正确；
2. `Users`、`Commentaries`、`Data` 与 `TotalPages` 正确映射；
3. PascalCase/camelCase 响应均可解析；
4. 顶层评论 ID 正确编码真实 ID 和页码；
5. 回复请求恢复父评论原始页并按 `Reply` 顺序返回；
6. 子回复目标名称被正确补充；
7. 回复列表固定为一页，父评论不存在时返回空列表；
8. `PostComment` 参数正确；
9. `ReplyComment` 使用真实 `ParentId` 且不发送 `ReplyId`；
10. 未登录、空内容、无效复合 ID 和异常响应正确失败；
11. 单条评论损坏与用户缺失按设计降级；
12. `loadInfo` 不预加载评论；
13. 登录、六种搜索、章节批量加载和每日签到回归保持通过；
14. `lightnovelshelf.js` 与 `index.json` 版本及说明同步为 `0.2.9`。

最终执行：

- JavaScript 语法检查；
- 评论专项测试与现有轻书架回归测试；
- `index.json` JSON 和版本一致性检查；
- Git whitespace 与行尾检查；
- Venera CLI 源验证。
