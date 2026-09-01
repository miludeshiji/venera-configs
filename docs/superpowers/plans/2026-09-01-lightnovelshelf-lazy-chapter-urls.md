# 轻书架章节图片 URL 按需加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将轻书架章节正文改为首批探测总页数、Venera 实际加载图片时再按 6 页取得对应 URL，避免直接跳到末页时请求中间批次。

**Architecture:** `loadEp` 只探测首批并返回与总页数等长的稳定虚拟图片键；异步 `onImageLoad` 只将当前被请求的虚拟键映射到其 6 页 `GetComicContent` 批次，再返回实际图片 URL，不在源侧额外预取相邻批次。实例级、认证与 API 线路隔离的三章节 LRU Promise 缓存负责合并相同批次并发请求、保留已解析 URL，并在失败或认证失效后允许安全重试。

**Tech Stack:** JavaScript ComicSource API、Venera/VeneraNext `loadEp`/`onImageLoad`、ASP.NET Core SignalR JSON Hub Protocol、HTTP Long Polling、Node.js `vm`/`node:test`、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 虚拟图片键、单批正文解析、按需批次 Promise 缓存、异步图片 URL 解析、认证失效清理和 `0.2.17` 版本。
- Modify: `index.json` — 同步轻书架 `0.2.17` 版本和按需章节 URL 功能描述。
- Create temporarily: `test/lightnovelshelf-lazy-chapter-urls.test.cjs` — 隔离式按需加载、并发、失效、LRU 和错误回归测试；最终删除，不进入提交。
- Reference only: `docs/superpowers/specs/2026-09-01-lightnovelshelf-lazy-chapter-urls-design.md` — 已批准设计。
- Reference only: `https://github.com/LightNovelShelf/Web/commit/56896742c33a6b21911aee4b50a8a21337414cd1` — 新版网页的 6 页正文批次、后向 URL 窗口和后续 4 张图片预加载策略。
- Reference only: `cache/Flutter/lib/features/reader/comic_reader_screen.dart`、`reader_comic_paging.dart` — 官方 App 稀疏页面与按需批次架构；其中旧的 12 页常量不再作为服务端批次依据。
- Reference only: `cache/Venera-Next/lib/features/comic_source/parser.dart`、`lib/network/images.dart`、`lib/features/reader/images.dart` — 异步 `onImageLoad`、URL 替换和图片预加载契约。

只修改上述两个正式发布文件。保持 `lightnovelshelf.js` 的 CRLF 工作区行尾；禁止整文件格式化。临时测试目录已被 `.gitignore` 忽略，任何提交都不得包含 `test/`、`cache/` 或用户已有改动。

### Task 1: 建立按需加载行为测试

**Files:**
- Create temporarily: `test/lightnovelshelf-lazy-chapter-urls.test.cjs`
- Test: `lightnovelshelf.js`

- [ ] **Step 1: 检查正式文件基线与行尾**

Run:

```bash
git diff --exit-code -- lightnovelshelf.js index.json
git diff --cached --name-only
git ls-files --eol lightnovelshelf.js index.json
git status --short --branch
```

Expected: 两个正式文件相对当前 `HEAD` 无差异，暂存区为空；`lightnovelshelf.js` 工作区为 CRLF。若存在用户改动，保留并围绕它们工作，不暂存无关文件。

- [ ] **Step 2: 创建核心行为测试宿主**

创建 `test/lightnovelshelf-lazy-chapter-urls.test.cjs`：

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "lightnovelshelf.js");
const INDEX_PATH = path.join(ROOT, "index.json");
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, "utf8");

function createHarness() {
  class ComicSource {
    constructor() {
      this.__data = new Map([["refreshToken", "refresh-token"]]);
      this.__settings = new Map([
        ["apiServer", "https://api.lightnovel.life"],
        ["dailySignInTask", false],
      ]);
    }

    get isLogged() {
      return true;
    }

    loadData(key) {
      return this.__data.get(key);
    }

    saveData(key, value) {
      this.__data.set(key, value);
    }

    deleteData(key) {
      this.__data.delete(key);
    }

    loadSetting(key) {
      return this.__settings.get(key);
    }
  }

  const sandbox = {
    ComicSource,
    Network: {},
    Convert: {},
    UI: { showMessage() {} },
    createUuid() {
      return "00112233-4455-6677-8899-aabbccddeeff";
    },
    clearTimeout,
    setTimeout,
    Date,
    Error,
    Map,
    Set,
    Promise,
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `${SOURCE_TEXT}\n;globalThis.__LightNovelShelf = LightNovelShelf;`,
    sandbox,
  );

  return new sandbox.__LightNovelShelf();
}

function plain(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function spinUntil(predicate, message = "condition not reached") {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

function comicBatch(chapterId, skip, total, options = {}) {
  const count = Math.max(0, Math.min(6, total - skip));
  const images = Array.from(
    { length: count },
    (_, offset) => `/images/${chapterId}/${skip + offset}.jpg`,
  );
  if (options.dropLast) images.pop();
  return {
    chapter: {
      id: chapterId,
      total: options.reportedTotal ?? total,
      skip: options.reportedSkip ?? skip,
      images,
    },
  };
}

function attachContentHub(source, handler) {
  source._runHubSession = async (_name, operation) =>
    await operation({ id: "test-session" });
  source._hubInvoke = async (_session, target, params) =>
    await handler(target, plain(params));
  source._hubInvokeMany = async (_session, target, paramsList) =>
    await Promise.all(
      plain(paramsList).map((params) => handler(target, params)),
    );
}

function expectedKey(chapterId, page) {
  return `lightnovelshelf-page://${chapterId}/${page}`;
}

test("loadEp only probes the first batch and returns stable page keys", async () => {
  const source = createHarness();
  const calls = [];
  attachContentHub(source, async (target, params) => {
    assert.equal(target, "GetComicContent");
    calls.push(params);
    return comicBatch(params.Cid, params.Skip, 13);
  });

  const result = await source.comic.loadEp("series", "7");

  assert.deepEqual(calls, [{ Cid: 7, Skip: 0, Take: 6 }]);
  assert.equal(result.images.length, 13);
  assert.deepEqual(
    plain(result.images),
    Array.from({ length: 13 }, (_, page) => expectedKey(7, page)),
  );
});

test("jumping to the final page requests only its batch", async () => {
  const source = createHarness();
  const calls = [];
  attachContentHub(source, async (_target, params) => {
    calls.push(params);
    return comicBatch(params.Cid, params.Skip, 13);
  });
  const result = await source.comic.loadEp("series", "7");
  calls.length = 0;

  const config = await source.comic.onImageLoad(
    result.images[12],
    "series",
    "7",
  );

  assert.deepEqual(calls, [{ Cid: 7, Skip: 12, Take: 6 }]);
  assert.equal(config.url, "https://api.lightnovel.life/images/7/12.jpg");
  assert.equal(config.headers.Referer, "https://www.lightnovel.app/");
});

test("first batch page URLs reuse the loadEp probe", async () => {
  const source = createHarness();
  const calls = [];
  attachContentHub(source, async (_target, params) => {
    calls.push(params);
    return comicBatch(params.Cid, params.Skip, 13);
  });
  const result = await source.comic.loadEp("series", "7");
  calls.length = 0;

  const config = await source.comic.onImageLoad(
    result.images[0],
    "series",
    "7",
  );

  assert.deepEqual(calls, []);
  assert.equal(config.url, "https://api.lightnovel.life/images/7/0.jpg");
});

test("concurrent pages in one batch share one content request", async () => {
  const source = createHarness();
  const gate = deferred();
  const calls = [];
  let holdBatch = false;
  attachContentHub(source, async (_target, params) => {
    calls.push(params);
    if (holdBatch && params.Skip === 6) await gate.promise;
    return comicBatch(params.Cid, params.Skip, 13);
  });
  const result = await source.comic.loadEp("series", "7");
  holdBatch = true;
  calls.length = 0;

  const page7 = source.comic.onImageLoad(result.images[6], "series", "7");
  const page8 = source.comic.onImageLoad(result.images[7], "series", "7");
  await spinUntil(
    () => calls.filter((call) => call.Skip === 6).length === 1,
    "shared batch request did not start",
  );
  assert.equal(calls.filter((call) => call.Skip === 6).length, 1);

  gate.resolve();
  const configs = await Promise.all([page7, page8]);
  assert.deepEqual(
    plain(configs.map((config) => config.url)),
    [
      "https://api.lightnovel.life/images/7/6.jpg",
      "https://api.lightnovel.life/images/7/7.jpg",
    ],
  );
  assert.equal(calls.filter((call) => call.Skip === 6).length, 1);
});

test("non-placeholder image URLs preserve pass-through behavior", async () => {
  const source = createHarness();
  const config = await source.comic.onImageLoad(
    "https://cdn.example/page.jpg",
    "series",
    "7",
  );

  assert.equal(config.url, "https://cdn.example/page.jpg");
  assert.equal(config.headers["User-Agent"], source.userAgent);
  assert.equal(config.headers.Referer, "https://www.lightnovel.app/");
});
```

- [ ] **Step 3: 运行核心测试并确认 RED**

Run:

```bash
node --test test/lightnovelshelf-lazy-chapter-urls.test.cjs
```

Expected: FAIL。首个测试应观察到当前实现还请求 `Skip: 6`、`Skip: 12`；图片配置测试还没有虚拟键对应的 `url`。失败必须来自尚未实现的按需行为，而不是测试宿主语法或加载错误。

### Task 2: 实现虚拟键和核心按需批次

**Files:**
- Modify: `lightnovelshelf.js:23-34, 67-75, 1374-1421, 2125-2244, 2382-2389`
- Modify: `index.json:205-211`
- Test: `test/lightnovelshelf-lazy-chapter-urls.test.cjs`

- [ ] **Step 1: 增加发布版本、分页常量和核心状态**

在 `LightNovelShelf` 静态字段中加入：

```javascript
  static comicContentPageSize = 6;
  static comicPageKeyPrefix = "lightnovelshelf-page://";
```

把文件头和实例版本更新为：

```javascript
 * 版本：0.2.17
```

```javascript
  version = "0.2.17";
```

在 Hub 状态字段之后加入：

```javascript
  // 章节正文按章节和 6 页批次缓存共享 Promise。
  _comicContentStates = new Map();
```

同步 `index.json` 的轻书架条目：

```json
{
    "name": "轻书架",
    "fileName": "lightnovelshelf.js",
    "key": "LightNovelShelf",
    "version": "0.2.17",
    "description": "轻书架漫画源，支持邮箱密码与 RefreshToken+x-id Token 登录、每日自动/手动签到、后台预连接、15 秒共享 Hub 会话、单连接批量发现页、24 项分类分页、章节图片 URL 按需加载、漫画阅读历史及系列评论与回复"
}
```

- [ ] **Step 2: 增加虚拟键、批次解析和 Promise 去重方法**

紧接 `_value` 后加入以下完整方法：

```javascript
  _comicChapterId(value) {
    const chapterId = Number(value);
    return Number.isSafeInteger(chapterId) && chapterId > 0
      ? chapterId
      : null;
  }

  _encodeComicPageKey(chapterId, page) {
    if (
      this._comicChapterId(chapterId) === null ||
      !Number.isSafeInteger(page) ||
      page < 0
    ) {
      throw new Error("无效轻书架章节图片键");
    }
    return `${LightNovelShelf.comicPageKeyPrefix}${chapterId}/${page}`;
  }

  _parseComicPageKey(value) {
    if (
      typeof value !== "string" ||
      !value.startsWith(LightNovelShelf.comicPageKeyPrefix)
    ) {
      return null;
    }

    const match = value
      .slice(LightNovelShelf.comicPageKeyPrefix.length)
      .match(/^([1-9]\d*)\/(0|[1-9]\d*)$/);
    if (!match) {
      throw new Error("无效轻书架章节图片键");
    }

    const chapterId = Number(match[1]);
    const page = Number(match[2]);
    if (
      this._comicChapterId(chapterId) === null ||
      !Number.isSafeInteger(page)
    ) {
      throw new Error("无效轻书架章节图片键");
    }
    return { chapterId: chapterId, page: page };
  }

  _getComicContentState(chapterId) {
    let state = this._comicContentStates.get(chapterId);
    if (!state) {
      state = {
        chapterId: chapterId,
        total: null,
        batches: new Map(),
      };
      this._comicContentStates.set(chapterId, state);
    }
    return state;
  }

  _comicContentBatchFromResponse(data, requestedSkip) {
    const chapter = this._value(data, "chapter", "Chapter", null);
    if (!chapter || typeof chapter !== "object") {
      throw new Error("GetComicContent 未返回 chapter/Chapter");
    }

    const imagesRaw = this._value(chapter, "images", "Images", null);
    const total = Number(this._value(chapter, "total", "Total", NaN));
    const reportedSkip = this._value(chapter, "skip", "Skip", null);
    if (!Array.isArray(imagesRaw) || !Number.isSafeInteger(total) || total < 0) {
      throw new Error("章节分页响应格式异常");
    }
    if (
      !Number.isSafeInteger(requestedSkip) ||
      requestedSkip < 0 ||
      requestedSkip % LightNovelShelf.comicContentPageSize !== 0 ||
      (total === 0 ? requestedSkip !== 0 : requestedSkip >= total)
    ) {
      throw new Error(`章节分页位置异常: Skip ${requestedSkip}`);
    }
    if (
      reportedSkip !== null &&
      reportedSkip !== undefined &&
      Number(reportedSkip) !== requestedSkip
    ) {
      throw new Error(
        `章节分页位置不匹配: 请求 ${requestedSkip}，响应 ${reportedSkip}`,
      );
    }

    const expectedCount =
      total === 0
        ? 0
        : Math.min(LightNovelShelf.comicContentPageSize, total - requestedSkip);
    if (imagesRaw.length !== expectedCount) {
      throw new Error(
        `章节分页数据不完整: Skip ${requestedSkip}, 预期 ${expectedCount} 页，实际 ${imagesRaw.length} 页`,
      );
    }

    const images = imagesRaw.map((image) => {
      if (typeof image !== "string" || !image.trim()) {
        throw new Error(`章节分页包含无效图片: Skip ${requestedSkip}`);
      }
      return this._normalizeUrl(image.trim());
    });
    return { skip: requestedSkip, total: total, images: images };
  }

  async _loadComicContentBatch(chapterId, skip) {
    const state = this._getComicContentState(chapterId);
    const existing = state.batches.get(skip);
    if (existing) return await existing;

    let batchPromise;
    batchPromise = (async () => {
      const data = await this._hubCall(
        "GetComicContent",
        {
          Cid: chapterId,
          Skip: skip,
          Take: LightNovelShelf.comicContentPageSize,
        },
        { retryTransport: true },
      );
      const batch = this._comicContentBatchFromResponse(data, skip);
      if (state.total !== null && state.total !== batch.total) {
        throw new Error(
          `章节总页数发生变化: 原 ${state.total} 页，现 ${batch.total} 页`,
        );
      }
      state.total = batch.total;
      return batch;
    })();
    state.batches.set(skip, batchPromise);

    try {
      return await batchPromise;
    } catch (error) {
      if (state.batches.get(skip) === batchPromise) {
        state.batches.delete(skip);
      }
      throw error;
    }
  }
```

- [ ] **Step 3: 用首批探测和虚拟键替换完整章节加载**

用以下实现完整替换 `comic.loadEp`，删除原 `loadWholeChapter`、剩余批次数组和 `_hubInvokeMany` 调用：

```javascript
    loadEp: async (comicId, epId) => {
      const chapterId = this._comicChapterId(epId);
      if (chapterId === null) {
        throw new Error(`无效章节 ID: ${epId}`);
      }

      const firstBatch = await this._loadComicContentBatch(chapterId, 0);
      if (firstBatch.total === 0 || firstBatch.images.length === 0) {
        throw new Error("该章节未返回任何图片");
      }

      return {
        images: Array.from({ length: firstBatch.total }, (_, page) =>
          this._encodeComicPageKey(chapterId, page),
        ),
      };
    },
```

- [ ] **Step 4: 将 `onImageLoad` 改为异步按需解析**

用以下实现完整替换现有 `onImageLoad`：

```javascript
    onImageLoad: async (url, comicId, epId) => {
      const headers = {
        "User-Agent": this.userAgent,
        Referer: this.siteBase + "/",
      };
      const reference = this._parseComicPageKey(url);
      if (!reference) {
        return { url: url, headers: headers };
      }

      const chapterId = this._comicChapterId(epId);
      if (chapterId === null || chapterId !== reference.chapterId) {
        throw new Error("轻书架章节图片键与当前章节不匹配");
      }

      const state = this._getComicContentState(chapterId);
      if (state.total !== null && reference.page >= state.total) {
        throw new Error("轻书架章节图片页码越界");
      }

      const skip =
        Math.floor(reference.page / LightNovelShelf.comicContentPageSize) *
        LightNovelShelf.comicContentPageSize;
      const batch = await this._loadComicContentBatch(chapterId, skip);
      if (reference.page >= batch.total) {
        throw new Error("轻书架章节图片页码越界");
      }

      const actualUrl = batch.images[reference.page - skip];
      if (!actualUrl) {
        throw new Error("轻书架章节图片页码越界");
      }
      return { url: actualUrl, headers: headers };
    },
```

`onThumbnailLoad` 保持不变。不得从 `onImageLoad` 主动调用上一批或下一批；Venera 的实际图片键请求是唯一的正文批次触发器。

- [ ] **Step 5: 运行核心测试并确认 GREEN**

Run:

```bash
node --test test/lightnovelshelf-lazy-chapter-urls.test.cjs
node --check lightnovelshelf.js
```

Expected: 5 个测试全部 PASS；语法检查无输出并以 0 退出。

- [ ] **Step 6: 提交核心按需加载**

Run:

```bash
git add -- lightnovelshelf.js index.json
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: load lightnovelshelf chapter URLs on demand"
```

Expected: 提交只包含 `lightnovelshelf.js`、`index.json`；临时测试不在提交中。

### Task 3: 增加认证、线路、LRU 和失败隔离

**Files:**
- Modify: `lightnovelshelf.js:25-34, 44-75, 370-380` 及 Task 2 新增正文状态方法
- Modify temporarily: `test/lightnovelshelf-lazy-chapter-urls.test.cjs`

- [ ] **Step 1: 追加失效、边界和 LRU 测试**

把以下测试追加到临时测试文件：

```javascript
test("failed batches are removed so image retry sends a new request", async () => {
  const source = createHarness();
  let attempts = 0;
  attachContentHub(source, async (_target, params) => {
    if (params.Skip === 6 && attempts++ === 0) {
      throw new Error("temporary failure");
    }
    return comicBatch(params.Cid, params.Skip, 13);
  });
  const result = await source.comic.loadEp("series", "8");

  await assert.rejects(
    source.comic.onImageLoad(result.images[6], "series", "8"),
    /temporary failure/,
  );
  const config = await source.comic.onImageLoad(
    result.images[6],
    "series",
    "8",
  );

  assert.equal(attempts, 2);
  assert.equal(config.url, "https://api.lightnovel.life/images/8/6.jpg");
});

test("auth invalidation clears previously resolved chapter batches", async () => {
  const source = createHarness();
  const calls = [];
  attachContentHub(source, async (_target, params) => {
    calls.push(params);
    return comicBatch(params.Cid, params.Skip, 6);
  });
  const result = await source.comic.loadEp("series", "9");
  calls.length = 0;

  source._invalidateAuthState();
  const config = await source.comic.onImageLoad(
    result.images[0],
    "series",
    "9",
  );

  assert.deepEqual(calls, [{ Cid: 9, Skip: 0, Take: 6 }]);
  assert.equal(config.url, "https://api.lightnovel.life/images/9/0.jpg");
});

test("API line changes do not reuse old chapter batches", async () => {
  const source = createHarness();
  const calls = [];
  attachContentHub(source, async (_target, params) => {
    calls.push({ apiBase: source.apiBase, ...params });
    return comicBatch(params.Cid, params.Skip, 6);
  });
  const result = await source.comic.loadEp("series", "10");
  calls.length = 0;

  source.__settings.set("apiServer", "https://cf-api.lightnovel.life");
  const config = await source.comic.onImageLoad(
    result.images[0],
    "series",
    "10",
  );

  assert.deepEqual(calls, [
    {
      apiBase: "https://cf-api.lightnovel.life",
      Cid: 10,
      Skip: 0,
      Take: 6,
    },
  ]);
  assert.equal(
    config.url,
    "https://cf-api.lightnovel.life/images/10/0.jpg",
  );
});

test("chapter state cache keeps the three most recently used contexts", async () => {
  const source = createHarness();
  attachContentHub(source, async (_target, params) =>
    comicBatch(params.Cid, params.Skip, 6),
  );

  const chapter1 = await source.comic.loadEp("series", "1");
  await source.comic.loadEp("series", "2");
  await source.comic.loadEp("series", "3");
  await source.comic.onImageLoad(chapter1.images[0], "series", "1");
  await source.comic.loadEp("series", "4");

  assert.equal(source._comicContentStates.size, 3);
  assert.deepEqual(
    [...source._comicContentStates.values()]
      .map((state) => state.chapterId)
      .sort((left, right) => left - right),
    [1, 3, 4],
  );
});

test("placeholder validation rejects malformed or mismatched page keys", async () => {
  const source = createHarness();
  attachContentHub(source, async (_target, params) =>
    comicBatch(params.Cid, params.Skip, 6),
  );
  const result = await source.comic.loadEp("series", "11");

  await assert.rejects(
    source.comic.onImageLoad(
      "lightnovelshelf-page://bad/0",
      "series",
      "11",
    ),
    /无效轻书架章节图片键/,
  );
  await assert.rejects(
    source.comic.onImageLoad(result.images[0], "series", "12"),
    /与当前章节不匹配/,
  );
  await assert.rejects(
    source.comic.onImageLoad(expectedKey(11, 6), "series", "11"),
    /页码越界/,
  );
  await assert.rejects(source.comic.loadEp("series", "0"), /无效章节 ID/);
});

test("PascalCase batches work and empty chapters keep the existing error", async () => {
  const source = createHarness();
  attachContentHub(source, async (_target, params) => ({
    Chapter: {
      Id: params.Cid,
      Total: 1,
      Skip: params.Skip,
      Images: ["/images/pascal.jpg"],
    },
  }));
  const result = await source.comic.loadEp("series", "15");
  const config = await source.comic.onImageLoad(
    result.images[0],
    "series",
    "15",
  );
  assert.equal(
    config.url,
    "https://api.lightnovel.life/images/pascal.jpg",
  );

  const empty = createHarness();
  attachContentHub(empty, async (_target, params) => ({
    chapter: {
      id: params.Cid,
      total: 0,
      skip: 0,
      images: [],
    },
  }));
  await assert.rejects(
    empty.comic.loadEp("series", "16"),
    /该章节未返回任何图片/,
  );
});

test("incomplete and inconsistent batches fail without being cached", async () => {
  const source = createHarness();
  let incomplete = true;
  attachContentHub(source, async (_target, params) => {
    if (params.Skip === 6 && incomplete) {
      incomplete = false;
      return comicBatch(params.Cid, params.Skip, 13, { dropLast: true });
    }
    return comicBatch(params.Cid, params.Skip, 13);
  });
  const result = await source.comic.loadEp("series", "13");

  await assert.rejects(
    source.comic.onImageLoad(result.images[6], "series", "13"),
    /章节分页数据不完整/,
  );
  const recovered = await source.comic.onImageLoad(
    result.images[6],
    "series",
    "13",
  );
  assert.equal(
    recovered.url,
    "https://api.lightnovel.life/images/13/6.jpg",
  );

  source._comicContentStates.clear();
  attachContentHub(source, async (_target, params) =>
    params.Skip === 0
      ? comicBatch(params.Cid, params.Skip, 13)
      : comicBatch(params.Cid, params.Skip, 14),
  );
  const inconsistent = await source.comic.loadEp("series", "14");
  await assert.rejects(
    source.comic.onImageLoad(inconsistent.images[12], "series", "14"),
    /章节总页数发生变化/,
  );
});
```

- [ ] **Step 2: 运行扩展测试并确认 RED**

Run:

```bash
node --test test/lightnovelshelf-lazy-chapter-urls.test.cjs
```

Expected: 核心 5 项仍 PASS；认证失效、API 线路隔离或三上下文 LRU 至少一项 FAIL。失败不得来自已有按需 URL 主流程。

- [ ] **Step 3: 增加有界上下文状态和清理方法**

在静态字段加入：

```javascript
  static comicContentStateLimit = 3;
```

在 `_comicContentStates` 后加入：

```javascript
  _comicContentUseSequence = 0;
```

用以下完整实现替换 Task 2 的 `_getComicContentState`，并在它之前加入清理、键和 LRU 方法：

```javascript
  _clearComicContentStates() {
    this._comicContentStates.clear();
    this._comicContentUseSequence = 0;
  }

  _comicContentStateKey(chapterId) {
    return `${this.apiBase}\n${this._authGeneration}\n${chapterId}`;
  }

  _touchComicContentState(key, state) {
    state.lastUsed = ++this._comicContentUseSequence;
    this._comicContentStates.set(key, state);

    while (
      this._comicContentStates.size >
      LightNovelShelf.comicContentStateLimit
    ) {
      let oldestKey = null;
      let oldestUse = Infinity;
      for (const [candidateKey, candidate] of this._comicContentStates) {
        if (candidate.lastUsed < oldestUse) {
          oldestUse = candidate.lastUsed;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === null) break;
      this._comicContentStates.delete(oldestKey);
    }
  }

  _getComicContentState(chapterId) {
    const key = this._comicContentStateKey(chapterId);
    let state = this._comicContentStates.get(key);
    if (!state) {
      state = {
        apiBase: this.apiBase,
        authGeneration: this._authGeneration,
        chapterId: chapterId,
        total: null,
        batches: new Map(),
        lastUsed: 0,
      };
    }
    this._touchComicContentState(key, state);
    return state;
  }
```

- [ ] **Step 4: 在认证失效和批次完成时维护上下文所有权**

在 `_invalidateAuthState()` 推进认证代际并丢弃 Hub 后，加入章节状态清理：

```javascript
    this._clearComicContentStates();
```

在 `_loadComicContentBatch` 的异步 Promise 内，`await this._hubCall(...)` 返回后、解析响应前加入：

```javascript
      if (
        state.apiBase !== this.apiBase ||
        state.authGeneration !== this._authGeneration
      ) {
        throw new Error("轻书架章节图片请求已失效");
      }
```

在成功设置 `state.total` 后更新 LRU：

```javascript
      const stateKey = this._comicContentStateKey(chapterId);
      if (this._comicContentStates.get(stateKey) === state) {
        this._touchComicContentState(stateKey, state);
      }
```

保持失败 Promise 的条件删除逻辑不变。

- [ ] **Step 5: 运行全部按需加载测试并确认 GREEN**

Run:

```bash
node --test test/lightnovelshelf-lazy-chapter-urls.test.cjs
node --check lightnovelshelf.js
```

Expected: 12 个测试全部 PASS；语法检查通过。

- [ ] **Step 6: 提交上下文隔离**

Run:

```bash
git add -- lightnovelshelf.js
git diff --cached --check
git diff --cached --name-only
git commit -m "fix: isolate lightnovelshelf chapter URL batches"
```

Expected: 提交只包含 `lightnovelshelf.js`。

### Task 4: 发布校验与真实调用序列烟测

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Delete: `test/lightnovelshelf-lazy-chapter-urls.test.cjs`

- [ ] **Step 1: 增加版本和发布元数据断言**

把以下测试追加到临时测试文件：

```javascript
test("source and index publish matching version 0.2.17", () => {
  const source = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const entry = index.find((item) => item.key === "LightNovelShelf");

  assert.equal(source.version, "0.2.17");
  assert.equal(entry.version, "0.2.17");
  assert.match(entry.description, /章节图片 URL 按需加载/);
  for (const method of [
    source.comic.loadInfo,
    source.comic.loadEp,
    source.comic.onImageLoad,
    source.comic.loadComments,
    source.comic.sendComment,
  ]) {
    assert.equal(typeof method, "function");
  }
});
```

- [ ] **Step 2: 执行目标行为和发布校验**

Run:

```bash
node --test test/lightnovelshelf-lazy-chapter-urls.test.cjs
node --check lightnovelshelf.js
node -e "JSON.parse(require('node:fs').readFileSync('index.json','utf8')); console.log('index ok')"
node scripts/validate-pr-versions.js HEAD~2
```

Expected:

- 13 个 Node 测试全部 PASS；
- JavaScript 语法检查通过；
- 输出 `index ok`；
- 版本校验输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 3: 运行差异和行尾检查**

Run:

```bash
git diff --check
git ls-files --eol lightnovelshelf.js index.json
git status --short --branch
git log -3 --oneline
```

Expected: 无 whitespace 错误；正式变更仅为计划内提交；`lightnovelshelf.js` 工作区仍为 CRLF。最近提交包含核心按需加载和批次隔离，不包含临时测试。

- [ ] **Step 4: 删除临时测试并确认工作区清洁**

Run:

```bash
rm test/lightnovelshelf-lazy-chapter-urls.test.cjs
git status --short --branch
```

Expected: 临时测试已删除；工作区相对已完成提交无未提交正式改动。若用户原先有其他改动，它们保持原状且未被暂存。

- [ ] **Step 5: 记录无法自动化的实机检查边界**

在交付说明中准确记录：Node 宿主已验证 `loadEp -> 虚拟键 -> onImageLoad -> 单批实际 URL` 的完整脚本行为；若当前环境没有已登录的 Venera/VeneraNext 实例，则未声称完成真实账号网络或旧 Venera 实机检查。可用实机时执行：

1. 打开超过 12 页的章节；
2. 直接跳到最后一页；
3. 查看网络日志只有 `Skip: 0` 和末批 `Skip`，没有中间值；
4. 顺序跨越 6 页边界，确认每个新批次只请求一次；
5. 切换章节与瀑布流跨章，确认图片正常显示；
6. 切换 API 线路或重新登录，确认旧批次不复用。
