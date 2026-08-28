# 轻书架发现页整合与阅读历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将轻书架的三个发现页整合为一个包含“最近更新”“热门漫画”“阅读历史”的发现页，并为三个区块提供每页 12 项的“查看更多”分页。

**Architecture:** 保留现有 `GetComicList` 解析层，将榜单分页大小改为 12；新增 `GetReadHistory` → `GetBookListByIds` 两段式历史加载器及实例内连续分页去重状态。发现页改为唯一的 `multiPartPage`，三个原生 `viewMore` 均跳转至同源分类分页，由 `categoryComics.load` 在 `latest`、`view`、`history` 三种内部参数间路由。

**Tech Stack:** JavaScript ComicSource API、ASP.NET Core SignalR JSON Hub Protocol、Venera `multiPartPage`/`PageJumpTarget`/分类接口、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 12 项榜单分页、阅读历史状态与加载器、单一多区块发现页、分类及“查看更多”、版本和顶部说明。
- Modify: `index.json` — 将轻书架索引版本同步为 `0.2.10` 并补充整合发现页与阅读历史说明。
- Create temporarily: `test/lightnovelshelf-discovery-page.test.cjs` — 隔离式历史、发现页、分类、版本及既有接口回归测试；`test/` 已被 `.gitignore` 忽略，最终删除。
- Reference only: `jm.js` — `multiPartPage` 与 `viewMore` 结构。
- Reference only: `cache/web/src/services/user/index.ts`、`cache/web/src/services/book/index.ts`、`cache/web/src/pages/History.vue` — `GetReadHistory`、`GetBookListByIds` 及漫画历史去重流程。
- Reference only: `cache/Venera-Next/lib/features/comic_source/models.dart`、`source.dart`、`parser.dart`、`routing/page_jump_target.dart` — `PageJumpTarget` 与分类分页契约。

保持 `lightnovelshelf.js` 为 CRLF，`index.json` 为 LF。只暂存本计划明确列出的正式文件；工作区中用户已有的其他文件差异不得格式化、暂存或提交。

### Task 1: 阅读历史加载、分页状态与系列去重

**Files:**
- Create temporarily: `test/lightnovelshelf-discovery-page.test.cjs`
- Modify: `lightnovelshelf.js:21-36,326-331,995-1011,1018-1024`

- [ ] **Step 1: 确认目标正式文件起点及行尾**

Run:

```bash
git diff --exit-code -- lightnovelshelf.js index.json
git ls-files --eol lightnovelshelf.js index.json
git diff --cached --name-only
```

Expected: `lightnovelshelf.js` 与 `index.json` 相对 `HEAD` 无差异；行尾分别为 `i/crlf w/crlf` 与 `i/lf w/lf`；暂存区为空。用户已有的其他未暂存差异可以继续存在。

- [ ] **Step 2: 创建阅读历史失败测试**

创建 `test/lightnovelshelf-discovery-page.test.cjs`：

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

function createHarness(options = {}) {
  class ComicSource {
    constructor() {
      this.__data = new Map();
      this.__settings = new Map([
        ["apiServer", "https://api.lightnovel.life"],
        ["ignoreJapanese", false],
        ["ignoreAI", false],
        ["dailySignInTask", false],
      ]);
      this.__logged = options.logged ?? true;
    }

    get isLogged() {
      return this.__logged;
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
    Date,
    Map,
    Set,
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

function listItem(title, count = 1) {
  return {
    Title: title,
    OriginalTitle: "",
    Cover: `/covers/${encodeURIComponent(title)}.jpg`,
    Count: count,
    LastUpdatedAt: "2026-08-28T10:00:00Z",
  };
}

async function rejectionText(work) {
  let rejection;
  try {
    await work();
  } catch (error) {
    rejection = error;
  }
  assert.notEqual(rejection, undefined, "expected operation to reject");
  return String(rejection && rejection.message ? rejection.message : rejection);
}

test("阅读历史每页截取 12 个有效 ID，并在连续分页间按系列去重", async () => {
  const source = createHarness();
  const validIds = Array.from({ length: 14 }, (_, index) => index + 1);
  let historyCalls = 0;
  const batchCalls = [];

  source._hubCall = async (target, params) => {
    if (target === "GetReadHistory") {
      historyCalls += 1;
      return {
        Comic: [...validIds, 0, -1, Number.MAX_SAFE_INTEGER + 1, "15"],
      };
    }

    if (target === "GetBookListByIds") {
      batchCalls.push(plain(params));
      return {
        Data: params.Ids.map((id) =>
          listItem(id === 1 || id === 2 || id === 13 ? "共享系列" : `系列 ${id}`),
        ),
      };
    }

    throw new Error(`unexpected target: ${target}`);
  };

  const first = await source._loadReadingHistory(1);
  assert.deepEqual(batchCalls[0], {
    Ids: Array.from({ length: 12 }, (_, index) => index + 1),
    Type: "Comic",
  });
  assert.equal(first.maxPage, 2);
  assert.deepEqual(
    plain(first.comics.map((comic) => comic.id)),
    ["共享系列", ...Array.from({ length: 10 }, (_, index) => `系列 ${index + 3}`)],
  );

  const second = await source._loadReadingHistory(2);
  assert.deepEqual(batchCalls[1], { Ids: [13, 14], Type: "Comic" });
  assert.deepEqual(plain(second.comics.map((comic) => comic.id)), ["系列 14"]);
  assert.equal(second.maxPage, 2);
  assert.equal(historyCalls, 1, "连续第 2 页应复用第 1 页取得的历史快照");

  const refreshed = await source._loadReadingHistory(1);
  assert.equal(historyCalls, 2, "重新加载第 1 页必须刷新历史快照");
  assert.equal(refreshed.comics[0].id, "共享系列");
});

test("历史响应和批量结果兼容 camelCase", async () => {
  const source = createHarness();
  const calls = [];

  source._hubCall = async (target, params) => {
    calls.push({ target, params: plain(params) });
    if (target === "GetReadHistory") return { comic: [7] };
    return { data: [listItem("camel 系列", 2)] };
  };

  const result = await source._loadReadingHistory(1);

  assert.deepEqual(calls, [
    { target: "GetReadHistory", params: {} },
    {
      target: "GetBookListByIds",
      params: { Ids: [7], Type: "Comic" },
    },
  ]);
  assert.deepEqual(plain(result.comics.map((comic) => comic.id)), ["camel 系列"]);
  assert.equal(result.maxPage, 1);
});

test("空或异常历史不调用 GetBookListByIds", async () => {
  for (const history of [{}, { Comic: null }, { Comic: "invalid" }, { Comic: [0, -2, "3"] }]) {
    const source = createHarness();
    const targets = [];
    source._hubCall = async (target) => {
      targets.push(target);
      if (target === "GetReadHistory") return history;
      throw new Error("GetBookListByIds must not be called");
    };

    const result = await source._loadReadingHistory(1);
    assert.deepEqual(plain(result), { comics: [], maxPage: 1 });
    assert.deepEqual(targets, ["GetReadHistory"]);
  }
});

test("非连续分页重新读取历史并重置系列去重状态", async () => {
  const source = createHarness();
  let historyCalls = 0;

  source._hubCall = async (target, params) => {
    if (target === "GetReadHistory") {
      historyCalls += 1;
      return { Comic: Array.from({ length: 36 }, (_, index) => index + 1) };
    }
    return {
      Data: params.Ids.map((id, index) =>
        listItem(index === 0 ? "跨页共享系列" : `系列 ${id}`),
      ),
    };
  };

  await source._loadReadingHistory(1);
  const third = await source._loadReadingHistory(3);

  assert.equal(historyCalls, 2);
  assert.equal(third.comics[0].id, "跨页共享系列");
});

test("阅读历史拒绝非正整数页码且不发起 Hub 请求", async () => {
  for (const page of [0, -1, 1.5, "1", null]) {
    const source = createHarness();
    let requestCount = 0;
    source._hubCall = async () => {
      requestCount += 1;
      return {};
    };

    const error = await rejectionText(() => source._loadReadingHistory(page));
    assert.match(error, /无效阅读历史页码/);
    assert.equal(requestCount, 0);
  }
});

test("退出账号清空实例内阅读历史状态", () => {
  const source = createHarness();
  source._historyComicIds = [1, 2];
  source._historySeenSeries = new Set(["系列 A"]);
  source._historyNextPage = 3;

  source.account.logout();

  assert.equal(source._historyComicIds, null);
  assert.equal(source._historySeenSeries.size, 0);
  assert.equal(source._historyNextPage, 1);
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
```

Expected: 测试文件可加载 `lightnovelshelf.js`，前五项因 `source._loadReadingHistory is not a function` 失败，退出账号测试因历史状态未被清空而失败。

- [ ] **Step 4: 增加分页常量和阅读历史实例状态**

在 `lightnovelshelf.js` 的 `class LightNovelShelf extends ComicSource {` 后加入静态分页常量，并在 `_autoSignInAttemptDate` 后加入状态字段：

```javascript
class LightNovelShelf extends ComicSource {
  static discoveryPageSize = 12;

  name = "轻书架";
```

```javascript
  // 阅读历史仅缓存当前列表会话；第 1 页、非连续分页和退出账号时重置。
  _historyComicIds = null;
  _historySeenSeries = new Set();
  _historyNextPage = 1;
```

- [ ] **Step 5: 实现阅读历史状态重置和分页加载器**

在 `_loadComicList` 方法后、`account = {` 前加入：

```javascript
  _resetReadingHistoryState() {
    this._historyComicIds = null;
    this._historySeenSeries = new Set();
    this._historyNextPage = 1;
  }

  _historyIdsFromResponse(data) {
    const ids = this._value(data, "comic", "Comic", []);
    if (!Array.isArray(ids)) return [];

    return ids.filter((id) => Number.isSafeInteger(id) && id > 0);
  }

  async _loadReadingHistory(page) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("无效阅读历史页码");
    }

    const refreshHistory =
      page === 1 ||
      !Array.isArray(this._historyComicIds) ||
      page !== this._historyNextPage;

    if (refreshHistory) {
      const history = await this._hubCall("GetReadHistory", {});
      this._historyComicIds = this._historyIdsFromResponse(history);
      this._historySeenSeries = new Set();
    }

    const ids = this._historyComicIds;
    const size = LightNovelShelf.discoveryPageSize;
    const maxPage = Math.max(1, Math.ceil(ids.length / size));
    const pageIds = ids.slice((page - 1) * size, page * size);
    const comics = [];

    if (pageIds.length > 0) {
      const data = await this._hubCall("GetBookListByIds", {
        Ids: pageIds,
        Type: "Comic",
      });
      const list = this._value(data, "data", "Data", []);

      for (const item of Array.isArray(list) ? list : []) {
        const comic = this._comicFromListItem(item);
        if (!comic.id || this._historySeenSeries.has(comic.id)) continue;

        this._historySeenSeries.add(comic.id);
        comics.push(comic);
      }
    }

    this._historyNextPage = page + 1;

    return {
      comics: comics,
      maxPage: maxPage,
    };
  }
```

- [ ] **Step 6: 退出账号时清空历史状态**

将 `account.logout` 改为：

```javascript
    logout: () => {
      this.deleteData("refreshToken");
      this.deleteData("lastSignInUtcDate");
      this._autoSignInAttemptDate = "";
      this._sessionToken = "";
      this._sessionTokenAt = 0;
      this._resetReadingHistoryState();
    },
```

登录后的发现页总是从历史第 1 页开始，因此不需要改动 `_login`；退出时立即清除旧账号的内存快照，避免账号切换期间复用。

- [ ] **Step 7: 运行阅读历史测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 6 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 8: 检查并提交阅读历史加载器**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "feat: 增加轻书架阅读历史加载"
```

Expected: `lightnovelshelf.js` 保持 `w/crlf`；暂存和提交仅包含该文件；临时测试继续被 `.gitignore` 忽略。

### Task 2: 单一发现页、三个“查看更多”与分类分页

**Files:**
- Modify temporarily: `test/lightnovelshelf-discovery-page.test.cjs`
- Modify: `lightnovelshelf.js:997-1011,1081-1103`（Task 1 后行号会后移）

- [ ] **Step 1: 追加发现页、12 项榜单和分类失败测试**

向 `test/lightnovelshelf-discovery-page.test.cjs` 追加：

```javascript
test("漫画榜单每页请求 12 项，搜索仍请求 20 项", async () => {
  const source = createHarness();
  const calls = [];
  source._hubCall = async (target, params) => {
    calls.push({ target, params: plain(params) });
    return { Data: [listItem("系列 A")], TotalPages: 4 };
  };

  const list = await source._loadComicList("latest", 3);
  const search = await source.search.load("关键字", ["fuzzy"], 2);

  assert.deepEqual(calls, [
    {
      target: "GetComicList",
      params: { Page: 3, Size: 12, Order: "latest" },
    },
    {
      target: "SearchComicSeries",
      params: {
        KeyWords: "关键字",
        Mode: "fuzzy",
        Page: 2,
        Size: 20,
        IgnoreJapanese: false,
        IgnoreAI: false,
      },
    },
  ]);
  assert.equal(list.maxPage, 4);
  assert.equal(search.maxPage, 4);
});

test("发现页合并为轻书架并按指定顺序返回三个区块", async () => {
  const source = createHarness();
  const calls = [];
  source._loadComicList = async (order, page) => {
    calls.push({ loader: "list", order, page });
    return { comics: [{ id: order }], maxPage: 8 };
  };
  source._loadReadingHistory = async (page) => {
    calls.push({ loader: "history", page });
    return { comics: [{ id: "history" }], maxPage: 2 };
  };

  assert.equal(source.explore.length, 1);
  assert.equal(source.explore[0].title, "轻书架");
  assert.equal(source.explore[0].type, "multiPartPage");

  const parts = await source.explore[0].load(null);

  assert.deepEqual(calls, [
    { loader: "list", order: "latest", page: 1 },
    { loader: "list", order: "view", page: 1 },
    { loader: "history", page: 1 },
  ]);
  assert.deepEqual(plain(parts), [
    {
      title: "最近更新",
      comics: [{ id: "latest" }],
      viewMore: {
        page: "category",
        attributes: { category: "最近更新", param: "latest" },
      },
    },
    {
      title: "热门漫画",
      comics: [{ id: "view" }],
      viewMore: {
        page: "category",
        attributes: { category: "热门漫画", param: "view" },
      },
    },
    {
      title: "阅读历史",
      comics: [{ id: "history" }],
      viewMore: {
        page: "category",
        attributes: { category: "阅读历史", param: "history" },
      },
    },
  ]);
});

test("分类定义包含三个查看更多落点且顺序一致", () => {
  const source = createHarness();

  assert.deepEqual(plain(source.category), {
    title: "轻书架",
    parts: [
      {
        name: "分类",
        type: "fixed",
        categories: ["最近更新", "热门漫画", "阅读历史"],
        itemType: "category",
        categoryParams: ["latest", "view", "history"],
      },
    ],
  });
});

test("分类分页路由 latest、view 和 history", async () => {
  const source = createHarness();
  const calls = [];
  source._loadComicList = async (order, page) => {
    calls.push({ loader: "list", order, page });
    return { comics: [{ id: order }], maxPage: 5 };
  };
  source._loadReadingHistory = async (page) => {
    calls.push({ loader: "history", page });
    return { comics: [{ id: "history" }], maxPage: 3 };
  };

  const latest = await source.categoryComics.load(
    "最近更新",
    "latest",
    [],
    2,
  );
  const popular = await source.categoryComics.load(
    "热门漫画",
    "view",
    [],
    3,
  );
  const history = await source.categoryComics.load(
    "阅读历史",
    "history",
    [],
    4,
  );

  assert.deepEqual(calls, [
    { loader: "list", order: "latest", page: 2 },
    { loader: "list", order: "view", page: 3 },
    { loader: "history", page: 4 },
  ]);
  assert.equal(latest.comics[0].id, "latest");
  assert.equal(popular.comics[0].id, "view");
  assert.equal(history.comics[0].id, "history");
});

test("未知轻书架分类明确失败", async () => {
  const source = createHarness();
  let loaderCalls = 0;
  source._loadComicList = async () => {
    loaderCalls += 1;
    return { comics: [], maxPage: 1 };
  };
  source._loadReadingHistory = async () => {
    loaderCalls += 1;
    return { comics: [], maxPage: 1 };
  };

  const error = await rejectionText(() =>
    source.categoryComics.load("未知", "new", [], 1),
  );

  assert.match(error, /不支持的轻书架分类/);
  assert.equal(loaderCalls, 0);
});

test("发现页不再包含最新收录或 new 排序加载", () => {
  const source = createHarness();
  assert.deepEqual(plain(source.explore.map((page) => page.title)), ["轻书架"]);
  assert.doesNotMatch(SOURCE_TEXT, /_loadComicList\("new"/);
  assert.doesNotMatch(SOURCE_TEXT, /title:\s*"最新收录"/);
});
```

- [ ] **Step 2: 运行新增测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
```

Expected: Task 1 的 6 个测试 PASS；榜单测试因 `Size` 仍为 20 失败；发现页、分类与删除最新收录测试失败。

- [ ] **Step 3: 将榜单分页调整为 12 项**

将 `_loadComicList` 中的请求大小改为共享常量，完整方法为：

```javascript
  async _loadComicList(order, page) {
    const data = await this._hubCall("GetComicList", {
      Page: page,
      Size: LightNovelShelf.discoveryPageSize,
      Order: order,
    });

    const list = this._value(data, "data", "Data", []);
    const totalPages = this._value(data, "totalPages", "TotalPages", 1);

    return {
      comics: (Array.isArray(list) ? list : []).map((x) =>
        this._comicFromListItem(x),
      ),
      maxPage: Number(totalPages || 1),
    };
  }
```

不要修改 `search.load` 的 `Size: 20`。

- [ ] **Step 4: 用单一多区块发现页替换三个分页发现页**

用以下代码完整替换当前 `explore = [...]`：

```javascript
  explore = [
    {
      title: "轻书架",
      type: "multiPartPage",
      load: async () => {
        const latest = await this._loadComicList("latest", 1);
        const popular = await this._loadComicList("view", 1);
        const history = await this._loadReadingHistory(1);

        return [
          {
            title: "最近更新",
            comics: latest.comics,
            viewMore: {
              page: "category",
              attributes: {
                category: "最近更新",
                param: "latest",
              },
            },
          },
          {
            title: "热门漫画",
            comics: popular.comics,
            viewMore: {
              page: "category",
              attributes: {
                category: "热门漫画",
                param: "view",
              },
            },
          },
          {
            title: "阅读历史",
            comics: history.comics,
            viewMore: {
              page: "category",
              attributes: {
                category: "阅读历史",
                param: "history",
              },
            },
          },
        ];
      },
    },
  ];
```

三个加载调用保持顺序执行，避免首次并行请求同时刷新会话 Token；任一真实 Hub 请求失败时由现有异常路径使发现页显示加载失败。

- [ ] **Step 5: 增加分类定义与分页路由**

在 `explore` 后、`search` 前加入：

```javascript
  category = {
    title: "轻书架",
    parts: [
      {
        name: "分类",
        type: "fixed",
        categories: ["最近更新", "热门漫画", "阅读历史"],
        itemType: "category",
        categoryParams: ["latest", "view", "history"],
      },
    ],
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      if (param === "latest") {
        return await this._loadComicList("latest", page);
      }
      if (param === "view") {
        return await this._loadComicList("view", page);
      }
      if (param === "history") {
        return await this._loadReadingHistory(page);
      }

      throw new Error(`不支持的轻书架分类: ${category}`);
    },
  };
```

`options` 按 Venera 分类接口签名保留但不使用；不添加 `optionList`，Venera 会将其解析为空选项列表。

- [ ] **Step 6: 运行发现页和分类测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 12 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 7: 检查并提交发现页整合**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "feat: 整合轻书架发现页"
```

Expected: `lightnovelshelf.js` 保持 CRLF；提交只包含发现页、分类和 12 项榜单相关差异。

### Task 3: 版本、索引说明与既有功能回归

**Files:**
- Modify temporarily: `test/lightnovelshelf-discovery-page.test.cjs`
- Modify: `lightnovelshelf.js:1-26`
- Modify: `index.json:205-211`

- [ ] **Step 1: 追加版本和既有功能回归失败测试**

向 `test/lightnovelshelf-discovery-page.test.cjs` 追加：

```javascript
test("轻书架既有账号、搜索、详情、章节、评论和签到接口仍存在", () => {
  const source = createHarness();

  assert.equal(typeof source.account.login, "function");
  assert.equal(typeof source.account.logout, "function");
  assert.equal(typeof source.search.load, "function");
  assert.equal(typeof source.comic.loadInfo, "function");
  assert.equal(typeof source.comic.loadEp, "function");
  assert.equal(typeof source.comic.loadComments, "function");
  assert.equal(typeof source.comic.sendComment, "function");
  assert.equal(typeof source.dailySignIn, "function");
});

test("版本和发现页说明同步为 0.2.10", () => {
  const source = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.10");
  assert.match(SOURCE_TEXT, /版本：0\.2\.10/);
  assert.match(SOURCE_TEXT, /发现页/);
  assert.match(SOURCE_TEXT, /阅读历史/);
  assert.ok(entry);
  assert.equal(entry.name, "轻书架");
  assert.equal(entry.version, "0.2.10");
  assert.match(entry.description, /发现页/);
  assert.match(entry.description, /阅读历史/);
});
```

- [ ] **Step 2: 运行测试并确认版本测试 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
```

Expected: 前 13 个功能测试 PASS；版本测试因源和索引仍为 `0.2.9` 而 FAIL。

- [ ] **Step 3: 更新源版本与顶部功能说明**

将 `lightnovelshelf.js` 顶部改为：

```javascript
/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.2.10
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - HTTP Long Polling transport
 * - 邮箱密码登录并自动管理认证令牌
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - 每日自动/手动签到
 * - Long Polling 防缓存参数
 * - 整合发现页 / 漫画阅读历史 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
 *
 * 使用前：
 * 1. 在 Venera 的轻书架漫画源设置中打开账号登录。
 * 2. 使用轻书架注册邮箱和密码登录。
 * 3. x-id 与令牌由漫画源自动生成和管理。
 */
class LightNovelShelf extends ComicSource {
  static discoveryPageSize = 12;

  name = "轻书架";
  key = "LightNovelShelf";
  version = "0.2.10";
  minAppVersion = "1.0.0";
```

只替换文件顶部对应区块；保留 Task 1 已加入的静态分页常量。

- [ ] **Step 4: 同步 `index.json`**

将轻书架条目改为：

```json
    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.10",
        "description": "轻书架漫画源，支持邮箱密码登录、每日自动/手动签到、整合发现页、漫画阅读历史及系列评论与回复"
    }
```

- [ ] **Step 5: 运行完整专项与回归测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "const fs=require('fs');const index=JSON.parse(fs.readFileSync('F:/workspace/venera-configs/index.json','utf8'));const entry=index.find(x=>x.fileName==='lightnovelshelf.js');if(!entry||entry.version!=='0.2.10')process.exit(1);console.log('version_consistency=PASS')"
```

Expected: 14 个测试全部 PASS；语法检查退出码为 0；输出 `version_consistency=PASS`。

- [ ] **Step 6: 只暂存版本相关正式文件并提交**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js index.json
git ls-files --eol lightnovelshelf.js index.json
git add -- lightnovelshelf.js index.json
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "chore: 更新轻书架发现页版本"
```

Expected: 暂存和提交仅包含 `lightnovelshelf.js` 与 `index.json`；版本均为 `0.2.10`；行尾分别保持 CRLF 与 LF。

### Task 4: 完整验证、审查与临时测试清理

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Verify: `docs/superpowers/specs/2026-08-28-lightnovelshelf-discovery-page-design.md`
- Verify: `docs/superpowers/plans/2026-08-28-lightnovelshelf-discovery-page.md`
- Delete: `test/lightnovelshelf-discovery-page.test.cjs`

- [ ] **Step 1: 运行最终本地验证**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-page.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "JSON.parse(require('fs').readFileSync('F:/workspace/venera-configs/index.json','utf8'));console.log('index_json=PASS')"
/mnt/f/node/node.exe scripts/validate-pr-versions.js origin/main
git -c core.whitespace=cr-at-eol diff --check origin/main...HEAD
```

Expected: 14 个测试全部 PASS；语法、JSON、版本和 whitespace 检查通过；版本脚本输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 2: 审查结构、接口和敏感信息边界**

Run:

```bash
grep -nE 'discoveryPageSize|GetReadHistory|GetBookListByIds|_loadReadingHistory|multiPartPage|viewMore|categoryComics' lightnovelshelf.js
if grep -nE 'UI\.showMessage\([^)]*(RefreshToken|sessionToken|visitorId|x-id|password)' lightnovelshelf.js; then
  echo 'sensitive UI message found' >&2
  exit 1
fi
git diff --name-only origin/main...HEAD
git ls-files --eol lightnovelshelf.js index.json
```

Expected:

- 发现页只有一个 `multiPartPage`；
- 三个 `viewMore` 均指向分类页；
- 历史只调用 `GetReadHistory` 和 `GetBookListByIds`；
- 没有向 UI 输出认证信息；
- 功能差异仅包括设计、计划、`lightnovelshelf.js` 与 `index.json`；
- `lightnovelshelf.js` 为 CRLF，`index.json` 为 LF。

- [ ] **Step 3: 使用 Venera CLI 验证源**

Run:

```bash
python3 - <<'PY'
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path('/mnt/f/workspace/venera-configs')
validator = pathlib.Path(tempfile.mkdtemp(prefix='venera-cli-discovery-', dir='/mnt/f/workspace'))
dart = '/mnt/f/flutter-env/flutter/bin/cache/dart-sdk/bin/dart'
source = r'F:\workspace\venera-configs\lightnovelshelf.js'
env = os.environ.copy()
env['PUB_HOSTED_URL'] = 'https://pub.dev'
env['WSLENV'] = 'PUB_HOSTED_URL' + ((':' + env['WSLENV']) if env.get('WSLENV') else '')

try:
    commands = [
        (['git', 'clone', '--depth', '1', 'https://github.com/venera-app/venera_cli.git', str(validator)], repo),
        ([dart, 'pub', 'get'], validator),
        ([dart, 'run', 'bin/venera.dart', 'source', 'validate', source], validator),
    ]
    for command, cwd in commands:
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode:
            sys.exit(result.returncode)
finally:
    shutil.rmtree(validator, ignore_errors=True)
PY
```

Expected: 输出 `Valid LightNovelShelf (轻书架) 0.2.10`，退出码为 0；验证不使用真实账号。

- [ ] **Step 4: 按验收清单审查实现**

逐项确认：

- `explore` 只有标题为“轻书架”的一个条目；
- 区块顺序严格为“最近更新”“热门漫画”“阅读历史”；
- 不存在“最新收录”发现页或 `new` 榜单调用；
- 最近更新与热门漫画均向 `GetComicList` 发送 `Size: 12`；
- 搜索仍发送 `Size: 20`；
- 三个“查看更多”都能通过 `category` 和对应 `param` 路由；
- 历史 ID 每页最多 12 个，保持服务端顺序并过滤无效值；
- 空历史不会调用批量详情接口；
- 单页与连续分页均按系列标题去重；
- 第 1 页、非连续页与退出账号均重置历史状态；
- 历史认证错误继续复用 `_hubCall` 的 Token 刷新与单次重试；
- 没有新增历史持久化、清空历史或小说历史功能；
- 登录、签到、搜索、详情、章节和评论代码除明确插入点外没有行为变化。

若发现问题，先在临时测试中增加能够复现问题的失败用例，再做最小修复，重复 Task 4 Step 1-3，并用中文提交修复。

- [ ] **Step 5: 删除临时测试并确认最终工作区**

Run:

```bash
rm -f test/lightnovelshelf-discovery-page.test.cjs
rmdir test 2>/dev/null || true
test ! -e test/lightnovelshelf-discovery-page.test.cjs
test -z "$(git diff --cached --name-only)"
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: 临时测试已删除、暂存区为空；用户原有的无关工作区差异保持不变；功能提交依次包含设计、计划、阅读历史加载、发现页整合及版本更新。
