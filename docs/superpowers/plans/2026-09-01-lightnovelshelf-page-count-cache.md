# 轻书架章节 PageCount 复用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复用 `GetComicSeriesInfo` 返回的章节 `PageCount`，使正常详情页进入阅读器时 `loadEp` 不再为总页数请求 `Skip: 0`。

**Architecture:** `loadInfo` 在当前 API 线路和认证代际下缓存全部有效章节页数；`loadEp` 优先使用正文状态或该缓存生成虚拟图片键。只有历史、深链或冷启动没有详情缓存时，才保留现有 `Skip: 0, Take: 6` 回退；第一张实际图片仍由 `onImageLoad` 请求当前页所属批次。

**Tech Stack:** JavaScript ComicSource API、SignalR `GetComicSeriesInfo`/`GetComicContent`、Node.js `vm`/`node:test`、Git

---

### Task 1: 固化 PageCount 正常路径和冷启动回退

**Files:**
- Create temporarily: `test/lightnovelshelf-page-count-cache.test.cjs`
- Test: `lightnovelshelf.js`

- [ ] 创建隔离测试宿主，提供包含 `books[].chapters[].pageCount` 的 `GetComicSeriesInfo` 响应和 6 页 `GetComicContent` 响应。
- [ ] 验证详情响应含 `PageCount: 13` 时，`loadEp` 返回 13 个虚拟键且正文调用数为 0。
- [ ] 验证随后加载第 13 页时，只调用 `{ Cid, Skip: 12, Take: 6 }`。
- [ ] 验证没有执行 `loadInfo` 时，`loadEp` 回退调用 `{ Cid, Skip: 0, Take: 6 }`。
- [ ] 验证 `PageCount: 0` 直接抛出“该章节未返回任何图片”，不调用正文接口。
- [ ] 验证 API 线路或认证代际变化后，旧 PageCount 不复用。
- [ ] 运行 `node --test test/lightnovelshelf-page-count-cache.test.cjs`，确认正常路径测试在实现前因 `Skip: 0` 多余调用而失败。

### Task 2: 缓存详情页章节总页数

**Files:**
- Modify: `lightnovelshelf.js` 的章节缓存字段、`_clearComicContentStates`、`_comicContentStateKey`、`comic.loadInfo` 和 `comic.loadEp`

- [ ] 新增实例字段：

```javascript
  _comicChapterPageCounts = new Map();
```

- [ ] 让正文上下文键支持显式快照：

```javascript
  _comicContentStateKey(
    chapterId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${chapterId}`;
  }
```

- [ ] `_clearComicContentStates()` 同时清空 `_comicChapterPageCounts`。

- [ ] `loadInfo` 调用 Hub 前捕获 `apiBase` 和 `_authGeneration`；解析章节时只缓存正安全整数 ID 对应的非负安全整数 `PageCount`。完整解析后，仅在上下文仍匹配时整体替换页数 Map。

- [ ] 新增已知页数解析：优先使用正文状态 `total`，其次使用当前上下文 PageCount，并把命中的 PageCount 写入正文状态。

```javascript
  _knownComicPageCount(chapterId) {
    const state = this._getComicContentState(chapterId);
    if (state.total !== null) return state.total;

    const pageCount = this._comicChapterPageCounts.get(
      this._comicContentStateKey(chapterId),
    );
    if (Number.isSafeInteger(pageCount) && pageCount >= 0) {
      state.total = pageCount;
      return pageCount;
    }
    return null;
  }
```

- [ ] `loadEp` 改为：

```javascript
    loadEp: async (comicId, epId) => {
      const chapterId = this._comicChapterId(epId);
      if (chapterId === null) {
        throw new Error(`无效章节 ID: ${epId}`);
      }

      let total = this._knownComicPageCount(chapterId);
      if (total === null) {
        total = (await this._loadComicContentBatch(chapterId, 0)).total;
      }
      if (total === 0) {
        throw new Error("该章节未返回任何图片");
      }

      return {
        images: Array.from({ length: total }, (_, page) =>
          this._encodeComicPageKey(chapterId, page),
        ),
      };
    },
```

- [ ] 运行测试，确认正常路径、目标批次、冷启动回退、空章节和上下文失效全部通过。

### Task 3: 发布 0.2.18 并验证

**Files:**
- Modify: `lightnovelshelf.js` 文件头和实例版本
- Modify: `index.json` 轻书架版本与描述
- Delete: `test/lightnovelshelf-page-count-cache.test.cjs`

- [ ] 将脚本和索引版本同步到 `0.2.18`，描述加入“复用章节 PageCount”。
- [ ] 运行行为、语法、JSON 和 CRLF 检查：

```bash
node --test test/lightnovelshelf-page-count-cache.test.cjs
node --check lightnovelshelf.js
node -e "JSON.parse(require('node:fs').readFileSync('index.json','utf8')); console.log('index ok')"
git -c core.whitespace=cr-at-eol diff --check
```

- [ ] 提交 `lightnovelshelf.js` 和 `index.json` 后运行：

```bash
node scripts/validate-pr-versions.js HEAD~1
```

- [ ] 预期所有测试通过、输出 `index ok` 和 `Version validation passed for 1 config file(s).`。
- [ ] 删除忽略目录中的临时测试。
