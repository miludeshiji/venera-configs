# 轻书架章节图片 URL 按需加载设计

## 目标

在不修改 Venera / VeneraNext 应用核心的前提下，将 `lightnovelshelf.js` 的章节正文加载从“打开章节后立即取得全章图片 URL”改为“按阅读位置每 12 页取得图片 URL”。

完成后应满足：

1. `comic.loadEp(comicId, epId)` 仍一次返回与章节总页数相同的 `images` 数组，保持 Venera 漫画源契约；
2. 打开章节时至多探测第一个 12 页批次，以取得服务端报告的准确总页数；
3. Venera 实际显示或预加载某页时，才请求该页所在的 12 页批次；
4. 直接跳到章节末页时，不请求首尾批次之间的图片 URL；
5. 同一批次的并发图片加载共享一个 Promise，不重复调用 `GetComicContent`；
6. 退出、切换账号或切换 API 线路后，不复用旧认证或旧线路取得的批次；
7. 章节图片文件仍由 Venera 自身的显示、预加载、缓存和离线下载流程管理。

版本从 `0.2.16` 更新为 `0.2.17`，并同步更新 `index.json`。

## 现状与约束

当前 `comic.loadEp` 先调用：

```text
GetComicContent({ Cid, Skip: 0, Take: 12 })
```

取得 `total` 后，会构造所有剩余 `Skip`，通过 `_hubInvokeMany` 在同一次操作中取得完整章节 URL。章节有 $N$ 页时，正文 Hub 调用数量为：

```text
ceil(N / 12)
```

这些调用只取得 URL，不直接下载图片文件，但打开章节即产生全章正文请求。

VeneraNext 的漫画源接口有两个关键约束：

- `comic.loadEp` 必须返回完整的字符串数组，数组长度就是阅读器认定的章节页数；
- `comic.onImageLoad` 可以异步返回 `ImageLoadingConfig`，并用其中的 `url` 替换图片键后再发起实际图片请求。

因此，不能简单让 `loadEp` 只返回 12 个 URL；这样阅读器会把章节总页数错误地认定为 12。也不修改 VeneraNext 核心，为 `loadEp` 新增分页参数。采用已有漫画源使用的“虚拟图片键 + 异步 `onImageLoad`”扩展点实现按需解析。

## 方案选择

采用“首批探测 + 稳定虚拟图片键 + 12 页批次缓存”的方案。

未采用以下方案：

- **只返回首批 12 个真实 URL**：无法表达真实总页数，后续页面不可达；
- **在 `loadInfo` 缓存 `PageCount`，完全不探测正文**：可以减少一次首批请求，但目录页数可能滞后；`loadEp` 返回数组后无法再修正长度；
- **修改 VeneraNext，给 `loadEp` 增加分页回调**：能原生维护稀疏页面，但破坏源脚本的独立分发与旧版 Venera 兼容目标；
- **继续完整取得全章 URL，仅依赖 Venera 懒加载图片文件**：无法解决本次要求的正文 URL 请求量。

该方案不能让脚本像官方 App 一样直接知道当前目标页。Venera 会在 `loadEp` 返回后才恢复或跳转阅读位置，所以脚本仍需探测第一个批次以获得权威总页数。直接跳到末页时，预期取得首批和末批 URL，不取得中间批次。

## 虚拟图片键

`loadEp` 返回的每一项均为脚本生成的稳定虚拟键，而不是实际 HTTP URL。格式固定为：

```text
lightnovelshelf-page://<chapterId>/<zeroBasedPage>
```

要求：

- `chapterId` 必须是已验证的正安全整数章节 ID；
- `zeroBasedPage` 必须是 `[0, total)` 内的安全整数；
- 每个章节页面有唯一、确定的键；
- `onImageLoad` 对不匹配此前缀的字符串保持现有行为，直接把原 URL 与请求头返回，以兼容旧阅读状态或其他调用路径；
- 解析出的章节 ID 必须与 `epId` 一致，防止损坏或伪造的图片键读取另一章节。

Venera 以图片键、源 key、漫画 ID 和章节 ID 组成图片缓存键。稳定虚拟键使同一页即使实际 CDN URL 改变，也仍由 Venera 作为同一章节页面管理。

## 正文批次状态

新增实例级章节批次状态，按以下上下文隔离：

```text
apiBase + authGeneration + chapterId
```

每个章节状态包含：

```text
{
  apiBase,
  authGeneration,
  chapterId,
  total,
  batches: Map<skip, Promise<Batch>>,
  lastUsed
}
```

每个 `Batch` 包含：

```text
{
  skip,
  total,
  images
}
```

其中 `images` 最多 12 项，均为归一化后的实际图片 URL。

### Promise 去重

批次请求开始前先把 Promise 放入 `batches`。同一章节中第 13～24 页的多个图片加载同时触发时，都等待 `skip = 12` 的同一个 Promise。

请求成功后保留已完成 Promise，供该批次后续页面复用。请求失败时仅删除仍指向该失败 Promise 的条目，使 Venera 的图片重试能够重新请求。

### 有界保留

VeneraNext 的瀑布流可以同时保留当前章、上一章和下一章。章节状态按最近使用顺序最多保留 3 个上下文：

- 创建或读取状态时更新 `lastUsed`；
- 超过 3 个时删除最久未使用的状态；
- 删除状态不取消已经返回给调用者的在途 Promise；
- 以后再次访问被删除章节时重新取得相应批次。

每个状态最终最多缓存该章节已实际访问过的 URL，未访问批次不占用条目。

### 认证与线路失效

`_invalidateAuthState()` 同时清空全部章节批次状态。状态键还包含 `apiBase`，因此设置中切换 API 线路后，即使认证代际未改变，也不会命中旧线路状态。

在途请求继续遵循现有 `_runHubSession` 的认证代际检查；账号切换后旧结果不得写入新状态。

## 批次请求与解析

提取单批读取方法，固定：

```text
Take: 12
Skip: floor(page / 12) * 12
```

`GetComicContent` 是幂等读取，单批请求通过现有 Hub 会话层执行，并允许现有的一次 transport 重试。解析同时兼容 camelCase 与 PascalCase：

- `chapter` / `Chapter`；
- `images` / `Images`；
- `total` / `Total`；
- `skip` / `Skip`（若服务端返回）。

解析要求：

1. 响应必须包含章节对象；
2. `total` 必须是非负安全整数；
3. `skip` 必须是非负的 12 倍数；`total` 为 0 时只接受 `skip = 0`，否则 `skip` 必须小于 `total`；
4. 返回图片数必须等于 `min(12, total - skip)`；`total` 为 0 时必须返回空数组；
5. 若响应携带 `skip`，必须等于请求值；
6. 同一章节后续批次报告的 `total` 必须与首批一致；
7. 每个图片值必须是非空字符串，并通过 `_normalizeUrl` 归一化。

任何校验失败都让该图片加载失败，并移除失败批次 Promise；不返回错误页 URL，不用空字符串掩盖不完整响应。

## `loadEp` 数据流

`comic.loadEp(comicId, epId)` 执行：

1. 将 `epId` 转为正安全整数章节 ID；
2. 获取当前 `apiBase`、认证代际和章节对应状态；
3. 请求或复用 `skip = 0` 的批次；
4. 以首批 `total` 为准记录章节总页数；
5. 生成长度为 `total` 的虚拟图片键数组；
6. 返回 `{ images }`。

首批保存于状态中，但返回数组仍统一使用虚拟键。这样所有页面走相同解析路径；第 1～12 页的 `onImageLoad` 只读取已完成首批 Promise，不会再次请求 Hub。

若章节没有任何图片，保持现有用户可见错误“该章节未返回任何图片”。

## `onImageLoad` 数据流

`comic.onImageLoad(url, comicId, epId)` 改为异步函数：

1. 若 `url` 不是虚拟图片键，直接返回现有 User-Agent、Referer 配置；
2. 解析并验证章节 ID、页码和 `epId`；
3. 计算 `skip = floor(page / 12) * 12`；
4. 从当前线路、认证代际和章节状态中请求或复用该批次；
5. 读取 `images[page - skip]`；
6. 返回实际 URL 与现有图片请求头。

返回格式：

```text
{
  url: actualImageUrl,
  headers: {
    "User-Agent": userAgent,
    "Referer": siteBase + "/"
  }
}
```

URL 解析发生在 Venera 真正显示、预加载、收藏或下载该图片时。Venera 的图片字节缓存仍以虚拟键为主键，脚本不接管图片文件缓存。

## 并发和会话行为

Venera 可能并发请求相邻图片。每个未命中的批次会进入现有 `_hubOperationQueue`，不同批次继续按共享 Long Polling Hub 会话串行执行；同一批次先由 Promise 缓存合并，所以不会排入重复 operation。

一次批次读取只包含一个 `GetComicContent` Invocation，不再用 `_hubInvokeMany` 预先发送章节全部剩余分页。`_hubInvokeMany` 仍由 `_hubInvoke` 的单调用路径复用，因此保留现有实现；发现页及其他调用不受影响。

成功的正文批次仍可触发现有自动签到和 15 秒共享 Hub 空闲复用逻辑。多个接近发生的按需批次可以复用同一 Hub 会话。

## 直接跳转与预加载结果

以 120 页章节为例：

```text
loadEp
  -> GetComicContent(Cid, Skip: 0, Take: 12)
  -> 返回 120 个虚拟键

Venera 直接跳到第 120 页
  -> onImageLoad(pageIndex: 119)
  -> GetComicContent(Cid, Skip: 108, Take: 12)
```

预期不会请求 `Skip: 12` 到 `Skip: 96`。Venera 默认预加载末页附近图片时，它们都落在 `Skip: 108` 的同一批次，因此只复用该批次。

正常顺序阅读跨过第 12、24、36 页时，分别按需请求 `Skip: 12`、`24`、`36`。离线下载主动遍历全章图片键时会最终请求全部批次，这是预期行为。

## 错误处理

- 虚拟键格式错误：抛出“无效轻书架章节图片键”；
- 虚拟键章节与 `epId` 不一致：抛出“轻书架章节图片键与当前章节不匹配”；
- 页码越界：抛出“轻书架章节图片页码越界”；
- 批次格式或数量不完整：沿用明确的章节分页错误并允许图片重试；
- unauthorized：由现有 Hub 会话层刷新认证并重试一次；
- transport 失败：幂等批次读取允许一次重试，仍失败时交给 Venera 图片错误 UI；
- 账号切换：认证代际检查拒绝旧结果，并清空章节状态。

不把正文错误转换为空图片或占位图，否则 Venera 会缓存错误结果并掩盖可重试故障。

## 兼容性

VeneraNext 已确认支持：

- `loadEp` 返回任意字符串作为图片键；
- `onImageLoad` 返回 Promise；
- `ImageLoadingConfig.url` 替换实际请求 URL；
- 图片只在显示或预加载时调用配置解析器。

旧 Venera 仍使用已有 `onImageLoad` 扩展点，但当前仓库未包含其应用源码。发布前通过现有兼容运行环境至少验证：异步 `onImageLoad` 能返回替换 URL。若旧 Venera 不支持异步 URL 替换，则不能在不提高 `minAppVersion` 或保留旧版完整加载分支的情况下提供此优化；不在未验证前静默宣称兼容。

## 验证

使用可控的 JS 测试宿主模拟 `ComicSource`、`Network`、存储和 UI，并记录 Hub Invocation。覆盖以下可观察行为：

1. 25 页章节的 `loadEp` 只请求 `Skip: 0`，返回 25 个唯一虚拟键；
2. 加载第 25 页后只新增 `Skip: 24`，不请求 `Skip: 12`；
3. 同一批次多个 `onImageLoad` 并发调用只产生一个 `GetComicContent`；
4. 第 1 页的 `onImageLoad` 复用首批，不新增正文调用；
5. 不同批次按需分别请求，返回的页面 URL 下标正确；
6. 失败批次从缓存移除，下一次调用重新请求；
7. 退出或切换账号后旧批次不复用；
8. API 线路切换后旧批次不复用；
9. 非虚拟 URL 继续原样返回并附带现有请求头；
10. 虚拟键损坏、章节不匹配、页码越界和批次数量不完整均明确失败；
11. 三个章节状态保留，第四个加入后淘汰最久未使用状态；
12. 既有详情、章节分组、评论、发现页、认证和签到入口仍可加载。

最终运行项目的配置校验脚本，并在 VeneraNext 实际阅读器中验证：打开长章节、直接跳到末页、顺序跨越 12 页边界、切换章节及瀑布流跨章。网络日志中不得出现未访问的中间 `Skip`。

## 发布与非目标

同步修改：

- `lightnovelshelf.js` 文件头版本；
- `LightNovelShelf.version`；
- `index.json` 中轻书架版本与描述。

本次不修改：

- SignalR Long Polling 传输协议；
- `UseGzip` 设置；
- Venera / VeneraNext 应用核心；
- Venera 图片预加载数量与图片文件缓存；
- 章节分组、评论、阅读历史、发现页或登录行为；
- 离线下载必须解析全章图片这一语义。
