# 轻书架发现页整合与阅读历史设计

## 目标

将 `lightnovelshelf.js` 当前的三个独立发现页整合为一个名为“轻书架”的多区块发现页，并增加轻书架账号提供的漫画阅读历史。

最终发现页固定按以下顺序展示：

1. 最近更新
2. 热门漫画
3. 阅读历史

“最新收录”入口和 `new` 排序不再出现在轻书架发现页。三个区块右侧均显示 Venera 原生“查看更多”按钮，并可进入对应的分页列表。发现页区块和“查看更多”分页统一每页加载 12 项。

## 依据

### 禁漫天堂源

`jm.js` 的发现页使用 `multiPartPage`：一个发现页返回多个 `{ title, comics, viewMore }` 区块。只要区块提供有效的 `viewMore`，Venera 就会在标题右侧显示“查看更多”。本次沿用这一结构，不复制禁漫天堂的具体接口实现。

### Venera 页面跳转能力

`cache/Venera-Next/lib/features/comic_source/models.dart`、`source.dart` 与 `routing/page_jump_target.dart` 表明：

- `multiPartPage` 区块的 `viewMore` 会被解析为 `PageJumpTarget`；
- Venera 原生支持从该按钮跳转至 `category` 或 `search`；
- 分类跳转可携带 `category` 与 `param`，再由源的 `categoryComics.load` 分页加载。

轻书架的最近更新、热门漫画和阅读历史都不是普通关键词搜索，因此使用分类页作为三个“查看更多”的落点。

### 轻书架网页端阅读历史

`cache/web/src/services/user/index.ts` 与 `cache/web/src/pages/History.vue` 表明，漫画阅读历史通过两个 SignalR Hub 方法取得：

1. `GetReadHistory` 返回 `{ Novel: number[], Comic: number[] }`，其中 `Comic` 按最近阅读顺序保存漫画分卷 ID；
2. `GetBookListByIds({ Ids, Type: "Comic" })` 根据分卷 ID 返回按系列聚合的漫画列表。

网页端每批最多提交 24 个 ID，并使用系列标识去重。本源统一采用更小的 12 项分页，并保留网页端的跨连续分页系列去重语义。

## 方案选择

采用“单一多区块发现页 + 分类分页落点”方案。

未采用保留隐藏分页发现页的方案，因为 Venera 的“查看更多”不能跳转至指定发现页，而且额外发现页仍会破坏“合并为一页”的要求。未采用搜索页落点，因为轻书架搜索接口不能准确表达 `latest`、`view` 或账号阅读历史。

## 发现页结构

`explore` 只保留一个条目：

- `title`: `轻书架`
- `type`: `multiPartPage`
- `load`: 加载三个区块的第 1 页并按固定顺序返回

返回结构为：

```text
[
  最近更新（12 项，分类跳转参数 latest）,
  热门漫画（12 项，分类跳转参数 view）,
  阅读历史（最多 12 项，分类跳转参数 history）
]
```

每个区块的 `viewMore` 使用对象形式：

```text
{
  page: "category",
  attributes: {
    category: 区块标题,
    param: 内部加载参数
  }
}
```

区块顺序在代码中显式写定，不依赖接口返回顺序。旧的“最近更新”“热门漫画”“最新收录”三个 `multiPageComicList` 发现页全部删除。

## 分类与“查看更多”

新增轻书架分类定义，分类标题为“轻书架”，固定包含：

- 最近更新，参数 `latest`
- 热门漫画，参数 `view`
- 阅读历史，参数 `history`

新增 `categoryComics.load(category, param, options, page)`：

- `latest` 调用漫画列表接口的最近更新排序；
- `view` 调用漫画列表接口的热门排序；
- `history` 调用阅读历史加载逻辑；
- 未知参数明确抛出“不支持的轻书架分类”错误。

分类只承担“查看更多”的分页数据加载，不增加新的发现页。分类页不提供额外筛选选项。

## 最近更新与热门漫画数据流

现有 `_loadComicList(order, page)` 继续负责调用：

```text
GetComicList({
  Page: page,
  Size: 12,
  Order: order
})
```

`order` 只在本功能中使用：

- `latest`：最近更新
- `view`：热门漫画

返回的 `Data` 继续通过 `_comicFromListItem` 转换，`TotalPages` 继续作为分类分页上限。搜索仍保持当前每页 20 项，不受发现页分页调整影响。

## 阅读历史数据流

新增独立的阅读历史加载辅助逻辑，输入为 1-based 页码，输出与其他分页列表一致：

```text
{
  comics: Comic[],
  maxPage: number
}
```

首次加载、第 1 页刷新或非连续分页加载时：

1. 调用 `GetReadHistory({})`；
2. 兼容读取 `Comic` 或 `comic`；
3. 只保留正安全整数 ID，保持服务端原顺序；
4. 保存当前历史 ID 快照；
5. 重置已展示系列集合。

每页加载时：

1. 按 `(page - 1) * 12` 至 `page * 12` 截取当前 ID 快照；
2. ID 为空时直接返回空漫画列表，不调用批量详情接口；
3. 调用：

```text
GetBookListByIds({
  Ids: 当前页 ID,
  Type: "Comic"
})
```

4. 兼容读取返回值的 `Data` 或 `data`；
5. 使用 `_comicFromListItem` 转换为现有系列漫画对象；
6. 以转换后漫画的 `id`（轻书架系列标题）去重；
7. 连续加载下一页时过滤前页已经展示的系列；
8. 将期待页码更新为当前页加一。

`maxPage` 按原始有效历史 ID 数量计算：

```text
max(1, ceil(idCount / 12))
```

这与网页端按历史 ID 分批、再按系列过滤的行为一致。某一批 ID 全部属于已经展示过的系列时，该页可以返回空列表，但分页上限仍以服务端历史 ID 为准。

历史快照仅保存在当前 `LightNovelShelf` 实例内，不写入持久化存储。重新加载第 1 页会重新读取轻书架服务端记录，因此不会长期展示旧历史。

## 认证、错误处理与降级

所有新请求复用现有 `_hubCall`，因此继续获得：

- RefreshToken 换取短期会话 Token；
- SignalR Bearer Token 认证；
- HTTP Long Polling；
- 未授权时强制刷新 Token 并重试一次；
- 请求成功后的机会式自动签到；
- 请求完成后的连接关闭。

具体规则：

- `GetReadHistory` 或 `GetBookListByIds` 的网络、认证和 Hub 错误向上传递，由 Venera 显示加载失败；
- 历史记录缺少 `Comic`/`comic` 或该字段不是数组时，按空历史处理；
- 无效历史 ID 被过滤，不发送给批量接口；
- 批量结果缺少 `Data`/`data` 或该字段不是数组时，按空结果处理；
- 未知分类参数明确失败，不回退到其他榜单；
- 不记录或展示 RefreshToken、会话 Token、密码、访客 ID 或认证头；
- 不新增阅读历史本地持久化，也不调用清空历史接口。

发现页按固定顺序请求并组装三个区块。任一实际 Hub 请求失败时，整个发现页加载失败，避免将认证或服务异常伪装为空内容。

## 状态边界

阅读历史状态只包含：

- 当前有效历史 ID 快照；
- 已展示系列 ID 集合；
- 连续分页所期待的下一页页码。

加载第 1 页时总是重置这些状态。若请求页码不是期待的连续页，也重新读取历史并重置去重集合，避免把另一个页面会话的去重状态错误应用到当前列表。

最近更新和热门漫画不使用实例缓存，继续以服务端每次响应为准。

## 文件与版本范围

正式功能修改包括：

- `lightnovelshelf.js`
  - 发现页合并为单一 `multiPartPage`；
  - 增加三个区块的分类跳转；
  - 增加分类定义与分页加载；
  - 增加阅读历史读取、分页及系列去重；
  - 漫画榜单分页大小调整为 12；
  - 顶部功能说明增加发现页与阅读历史；
  - 版本从 `0.2.9` 升至 `0.2.10`。
- `index.json`
  - 轻书架条目版本同步为 `0.2.10`；
  - 描述增加整合发现页与账号阅读历史能力。

保持 `lightnovelshelf.js` 当前 CRLF 行尾和 `index.json` 当前 LF 行尾。`jm.js`、`cache/web`、`cache/Venera-Next` 与其他漫画源只作参考，不修改。

## 测试与验收

使用隔离的 Node.js 测试 harness 模拟 `_hubCall`，不使用真实轻书架账号。测试覆盖：

1. `explore` 只包含一个标题为“轻书架”的 `multiPartPage`；
2. 发现页严格按“最近更新”“热门漫画”“阅读历史”返回；
3. 三个区块均包含正确的分类 `viewMore`；
4. 最近更新调用 `GetComicList`，参数为 `Page: 1`、`Size: 12`、`Order: "latest"`；
5. 热门漫画调用 `GetComicList`，参数为 `Page: 1`、`Size: 12`、`Order: "view"`；
6. 源中不再有“最新收录”发现页，也不再从发现页请求 `Order: "new"`；
7. 历史依次调用 `GetReadHistory` 与 `GetBookListByIds`，后者携带 `Type: "Comic"`；
8. 历史 ID 保持原顺序、每页截取 12 项并过滤无效 ID；
9. 历史结果在单页及连续分页间按系列去重；
10. 第 1 页或非连续页重置历史去重状态；
11. 空历史不调用 `GetBookListByIds`，并返回 `maxPage: 1`；
12. 分类分页将 `latest`、`view`、`history` 路由到正确加载器；
13. 未知分类明确失败；
14. 搜索仍保持现有每页 20 项；
15. 登录、签到、详情、章节和评论接口没有行为回归；
16. `lightnovelshelf.js` 与 `index.json` 版本及说明同步为 `0.2.10`。

最终验证包括：

- Node.js 专项与回归测试；
- `node --check lightnovelshelf.js`；
- `index.json` JSON 与版本一致性检查；
- Git whitespace 与行尾检查；
- 仓库版本校验脚本；
- Venera CLI 漫画源验证。

## 功能边界

本次包含发现页整合、三个“查看更多”分类页及服务端漫画阅读历史读取。

本次不包含：

- 小说阅读历史；
- 清空或编辑轻书架阅读历史；
- 本地 Venera 阅读历史与轻书架历史合并；
- 新增筛选、排行周期或“最新收录”替代入口；
- 修改轻书架网页端；
- 修改其他漫画源；
- 与本功能无关的 SignalR 重构或并发优化。
