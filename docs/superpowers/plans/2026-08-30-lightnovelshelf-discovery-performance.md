# 轻书架发现页单连接加载优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将轻书架整合发现页的四次独立 SignalR 连接合并为一个可重试会话，并把三个“查看更多”分类页调整为每页 24 项，同时保持发现页 12 项、搜索 20 项。

**Architecture:** 新增支持不同 Hub target 的 `_hubInvokeBatch`，保留 `_hubInvokeMany` 兼容层，并用 `_runHubSession` 统一一次认证重试和连接关闭。发现页在同一会话内先批量请求最近更新、热门漫画和历史 ID，再按依赖关系请求历史详情；所有结果成功且请求代际仍有效后才提交历史状态并组装原 `multiPartPage`。

**Tech Stack:** JavaScript ComicSource API、ASP.NET Core SignalR JSON Hub Protocol、HTTP Long Polling、Venera `multiPartPage`/分类接口、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 混合 target 批量 Invocation、共享 Hub 会话、发现页加载器、12/24 分页、历史状态和 `0.2.11` 版本。
- Modify: `index.json` — 同步轻书架 `0.2.11` 版本和功能描述。
- Create: `docs/superpowers/specs/2026-08-30-lightnovelshelf-discovery-performance-design.md` — 已确认的性能与分页设计。
- Create: `docs/superpowers/plans/2026-08-30-lightnovelshelf-discovery-performance.md` — 本实施计划。
- Create temporarily: `test/lightnovelshelf-discovery-performance.test.cjs` — 隔离式协议、会话、发现页、分页和并发回归测试；完成后删除。
- Reference only: `cache/Venera-Next/lib/features/comic_source/parser.dart`、`source.dart`、`cache/Venera-Next/lib/features/discovery/explore_page.dart` — `multiPartPage` 一次性加载约束。
- Reference only: `cache/web/src/services/manga/index.ts`、`user/index.ts`、`book/index.ts`、`cache/web/src/pages/History.vue` — 轻书架网页端 Hub 方法和 24 ID 批量大小。

保持 `lightnovelshelf.js` 为 CRLF，`index.json` 与 Markdown 为 LF。只暂存本计划列出的正式文件；工作区已有的其他未暂存改动不得格式化、覆盖、暂存或提交。

### Task 1: 固化设计、基线和测试 harness

**Files:**
- Create: `docs/superpowers/specs/2026-08-30-lightnovelshelf-discovery-performance-design.md`
- Create: `docs/superpowers/plans/2026-08-30-lightnovelshelf-discovery-performance.md`
- Create temporarily: `test/lightnovelshelf-discovery-performance.test.cjs`

- [ ] **Step 1: 检查正式目标文件和暂存区基线**

Run:

```bash
git diff --exit-code -- lightnovelshelf.js index.json
git diff --cached --name-only
git ls-files --eol lightnovelshelf.js index.json
git status --short --branch
```

Expected: `lightnovelshelf.js` 与 `index.json` 相对 `HEAD` 无差异；暂存区为空；行尾分别为 `i/crlf w/crlf` 与 `i/lf w/lf`。其余用户已有未暂存差异继续保留。

- [ ] **Step 2: 强制暂存被 `.gitignore` 忽略的设计与计划文档**

Run:

```bash
git add -f -- \
  docs/superpowers/specs/2026-08-30-lightnovelshelf-discovery-performance-design.md \
  docs/superpowers/plans/2026-08-30-lightnovelshelf-discovery-performance.md
git diff --cached --name-status
git diff --cached --check
git commit -m "docs: 设计轻书架发现页加载优化"
```

Expected: 提交只包含两个新 Markdown 文件。

- [ ] **Step 3: 创建隔离式测试 harness 与协议测试**

创建 `test/lightnovelshelf-discovery-performance.test.cjs`：

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

  const network = options.network || {};
  const sandbox = {
    ComicSource,
    Network: network,
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

  return { source: new sandbox.__LightNovelShelf(), network };
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
    LastUpdatedAt: "2026-08-30T10:00:00Z",
  };
}

function completion(invocationId, response) {
  return (
    JSON.stringify({
      type: 3,
      invocationId: String(invocationId),
      result: { response },
    }) + "\x1e"
  );
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("混合 target Invocation 使用一个 POST 并按输入顺序映射乱序 Completion", async () => {
  const posts = [];
  const gets = [];
  const network = {
    async post(url, headers, body) {
      posts.push({ url, headers, body });
      return { status: 200, body: "" };
    },
    async get(url, headers) {
      gets.push({ url, headers });
      return {
        status: 200,
        body:
          completion(2, "popular") +
          completion(3, "history") +
          completion(1, "latest"),
      };
    },
  };
  const { source } = createHarness({ network });
  const session = {
    url: "https://api.lightnovel.life/hub/api?id=test",
    seq: 0,
    pollSeq: 0,
  };

  const result = await source._hubInvokeBatch(session, [
    { target: "GetComicList", params: { Order: "latest" } },
    { target: "GetComicList", params: { Order: "view" } },
    { target: "GetReadHistory", params: {} },
  ]);

  assert.deepEqual(plain(result), ["latest", "popular", "history"]);
  assert.equal(posts.length, 1);
  assert.equal(gets.length, 1);

  const frames = posts[0].body
    .split("\x1e")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame));
  assert.deepEqual(
    frames.map((frame) => ({
      type: frame.type,
      invocationId: frame.invocationId,
      target: frame.target,
      params: frame.arguments[0],
      gzip: frame.arguments[1],
    })),
    [
      {
        type: 1,
        invocationId: "1",
        target: "GetComicList",
        params: { Order: "latest" },
        gzip: { UseGzip: false },
      },
      {
        type: 1,
        invocationId: "2",
        target: "GetComicList",
        params: { Order: "view" },
        gzip: { UseGzip: false },
      },
      {
        type: 1,
        invocationId: "3",
        target: "GetReadHistory",
        params: {},
        gzip: { UseGzip: false },
      },
    ],
  );
});

test("同 target _hubInvokeMany 保留原签名和顺序", async () => {
  const { source } = createHarness();
  const session = { seq: 7 };
  let received;
  source._hubInvokeBatch = async (actualSession, calls) => {
    received = { actualSession, calls: plain(calls) };
    return ["first", "second"];
  };

  const result = await source._hubInvokeMany(session, "GetComicContent", [
    { Skip: 12 },
    { Skip: 24 },
  ]);

  assert.equal(received.actualSession, session);
  assert.deepEqual(received.calls, [
    { target: "GetComicContent", params: { Skip: 12 } },
    { target: "GetComicContent", params: { Skip: 24 } },
  ]);
  assert.deepEqual(plain(result), ["first", "second"]);
});

test("共享 Hub 会话在 unauthorized 后强制刷新并完整重试一次", async () => {
  const { source } = createHarness();
  const openFlags = [];
  const closed = [];
  let operationCalls = 0;
  let autoSignInCalls = 0;

  source._openHub = async (forceRefresh) => {
    openFlags.push(forceRefresh);
    return { id: forceRefresh ? "retry" : "first" };
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };
  source._tryAutoSignIn = () => {
    autoSignInCalls += 1;
  };
  source._sessionToken = "stale";
  source._sessionTokenAt = 123;

  const result = await source._runHubSession("LoadDiscovery", async (session) => {
    operationCalls += 1;
    if (session.id === "first") {
      throw new Error("User is unauthorized");
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(openFlags, [false, true]);
  assert.deepEqual(closed, ["first", "retry"]);
  assert.equal(operationCalls, 2);
  assert.equal(autoSignInCalls, 1);
});

test("_hubCall 通过共享会话执行单个 Invocation 且 SignIn 不递归签到", async () => {
  const { source } = createHarness();
  const session = { id: "single" };
  const invocations = [];
  const operationNames = [];

  source._runHubSession = async (name, operation) => {
    operationNames.push(name);
    return await operation(session);
  };
  source._hubInvoke = async (actualSession, target, params) => {
    invocations.push({ actualSession, target, params: plain(params) });
    return "value";
  };

  const result = await source._hubCall("SignIn", { A: 1 });

  assert.equal(result, "value");
  assert.deepEqual(operationNames, ["SignIn"]);
  assert.equal(invocations[0].actualSession, session);
  assert.deepEqual(
    { target: invocations[0].target, params: invocations[0].params },
    { target: "SignIn", params: { A: 1 } },
  );
});
```

- [ ] **Step 4: 运行协议测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
```

Expected: `_hubInvokeBatch is not a function`、`_runHubSession is not a function` 等失败；测试 harness 能正常载入源。

### Task 2: 实现混合 target 批量调用和共享会话

**Files:**
- Modify: `lightnovelshelf.js:695-821`
- Test: `test/lightnovelshelf-discovery-performance.test.cjs`

- [ ] **Step 1: 用通用批量实现替换 `_hubInvokeMany` 主体**

在 `_hubInvoke` 后加入 `_hubInvokeBatch`，并把 `_hubInvokeMany` 改为兼容委托：

```javascript
  /**
   * 在同一个 SignalR transport payload 中批量发送不同 Hub Method，
   * 再按 invocationId 收集可能乱序到达的 Completion。
   */
  async _hubInvokeBatch(session, calls) {
    if (!Array.isArray(calls) || calls.length === 0) {
      return [];
    }

    const invocations = calls.map((call, index) => {
      if (
        !call ||
        typeof call.target !== "string" ||
        !call.target.trim()
      ) {
        throw new Error(`无效 SignalR 批量调用: ${index}`);
      }

      const target = call.target.trim();
      const invocationId = String(++session.seq);
      const message =
        JSON.stringify({
          type: 1,
          invocationId: invocationId,
          target: target,
          // 官方 Web 默认 UseGzip=true；这里关闭 gzip，直接返回 JSON 对象。
          arguments: [call.params, { UseGzip: false }],
        }) + "\x1e";

      return {
        invocationId: invocationId,
        index: index,
        target: target,
        message: message,
      };
    });

    const pending = new Map(
      invocations.map((item) => [item.invocationId, item]),
    );
    const results = new Array(invocations.length);
    const payload = invocations.map((item) => item.message).join("");
    const targets = [...new Set(invocations.map((item) => item.target))];
    const label = targets.join(", ");

    const send = await Network.post(
      session.url,
      this._authTextHeaders(),
      payload,
    );

    this._assertStatus(send, 200, `SignalR invoke ${label}`);

    // 通常一次 poll 会携带多个 Completion；若服务端分批推送则继续轮询。
    const maxPolls = Math.max(20, invocations.length * 2);

    for (let i = 0; i < maxPolls; i++) {
      const poll = await Network.get(
        this._pollUrl(session),
        this._pollHeaders(),
      );

      if (poll.status === 204) {
        throw `SignalR 连接已关闭 (${label})`;
      }

      this._assertStatus(poll, 200, `SignalR poll ${label}`);

      for (const frame of this._frames(poll.body)) {
        // type 1 = 服务端 Invocation（例如 OnMessage 公告）；type 6 = Ping。
        if (frame.type === 1 || frame.type === 6) {
          continue;
        }

        if (frame.type === 7) {
          throw `SignalR 服务端关闭连接${
            frame.error ? `: ${frame.error}` : ""
          }`;
        }

        if (frame.type !== 3) {
          continue;
        }

        const invocationId = String(frame.invocationId);
        const invocation = pending.get(invocationId);
        if (!invocation) {
          continue;
        }

        if (frame.error) {
          throw `SignalR ${invocation.target} 调用失败: ${frame.error}`;
        }

        results[invocation.index] = this._unwrapHubResult(
          invocation.target,
          frame.result,
        );
        pending.delete(invocationId);
      }

      if (pending.size === 0) {
        return results;
      }
    }

    throw `等待 SignalR 批量调用返回结果超时（剩余 ${pending.size}/${invocations.length}）`;
  }

  /**
   * 在同一个 SignalR transport payload 中批量发送同一 Hub Method。
   */
  async _hubInvokeMany(session, target, paramsList) {
    if (!Array.isArray(paramsList) || paramsList.length === 0) {
      return [];
    }

    return await this._hubInvokeBatch(
      session,
      paramsList.map((params) => ({ target: target, params: params })),
    );
  }
```

删除旧 `_hubInvokeMany` 中自行创建 Invocation、POST 和轮询的重复实现。不要修改 `_hubInvoke` 或章节正文调用处的签名。

- [ ] **Step 2: 提取共享 Hub 生命周期并让 `_hubCall` 委托它**

用以下两个方法替换现有 `_hubCall`：

```javascript
  /**
   * 在一个 Hub 会话中执行完整操作；明确 unauthorized 时刷新 Token 并重试一次。
   */
  async _runHubSession(operationName, operation) {
    let session = null;
    let succeeded = false;

    const run = async (forceRefresh) => {
      session = await this._openHub(forceRefresh);
      return await operation(session);
    };

    try {
      try {
        const result = await run(false);
        succeeded = true;
        return result;
      } catch (error) {
        if (!this._isUnauthorizedError(error)) {
          throw error;
        }

        await this._closeHub(session);
        session = null;
        this._sessionToken = "";
        this._sessionTokenAt = 0;

        const result = await run(true);
        succeeded = true;
        return result;
      }
    } finally {
      // 关闭请求已发出即可返回数据，不再阻塞页面等待 DELETE 响应。
      this._closeHub(session);

      // 签到请求本身不递归触发；后台任务不被原请求等待。
      if (succeeded && operationName !== "SignIn") {
        this._tryAutoSignIn();
      }
    }
  }

  /**
   * 单次 Hub 调用。
   */
  async _hubCall(target, params) {
    return await this._runHubSession(target, async (session) => {
      return await this._hubInvoke(session, target, params);
    });
  }
```

- [ ] **Step 3: 运行协议与生命周期测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 4 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 4: 检查章节批量调用兼容性和 CRLF**

Run:

```bash
grep -nE '_hubInvokeBatch|_hubInvokeMany|GetComicContent' lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
```

Expected: `_hubInvokeMany` 原签名仍存在；`comic.loadEp` 仍通过它批量加载 `GetComicContent`；`lightnovelshelf.js` 保持 `w/crlf`；无 whitespace 错误。

- [ ] **Step 5: 提交批量协议与会话基础设施**

Run:

```bash
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "perf: 复用轻书架 Hub 会话"
```

Expected: 提交只包含 `lightnovelshelf.js` 的批量调用和会话生命周期改动；临时测试因 `.gitignore` 不进入提交。

### Task 3: 单连接发现页与 12/24/20 分页

**Files:**
- Modify temporarily: `test/lightnovelshelf-discovery-performance.test.cjs`
- Modify: `lightnovelshelf.js:21-40,1003-1178`（Task 2 后行号会变化）

- [ ] **Step 1: 追加发现页单连接、分页和并发失败测试**

向测试文件追加：

```javascript
test("发现页在一个会话中批量加载三项并复用该会话读取历史详情", async () => {
  const { source } = createHarness();
  const session = { id: "discovery", seq: 0, pollSeq: 0 };
  const openFlags = [];
  const closed = [];
  const batchCalls = [];
  const invokes = [];
  let autoSignInCalls = 0;

  source._openHub = async (forceRefresh) => {
    openFlags.push(forceRefresh);
    return session;
  };
  source._closeHub = async (actualSession) => {
    if (actualSession) closed.push(actualSession);
  };
  source._tryAutoSignIn = () => {
    autoSignInCalls += 1;
  };
  source._hubInvokeBatch = async (actualSession, calls) => {
    batchCalls.push({ actualSession, calls: plain(calls) });
    return [
      { Data: [listItem("最近 A")], TotalPages: 3 },
      { data: [listItem("热门 A")], totalPages: 4 },
      {
        Comic: [
          ...Array.from({ length: 13 }, (_, index) => index + 1),
          0,
          -1,
          "14",
        ],
      },
    ];
  };
  source._hubInvoke = async (actualSession, target, params) => {
    invokes.push({ actualSession, target, params: plain(params) });
    return {
      Data: params.Ids.map((id) =>
        listItem(id === 1 || id === 2 ? "共享历史系列" : `历史 ${id}`),
      ),
    };
  };

  const parts = await source.explore[0].load(null);

  assert.deepEqual(openFlags, [false]);
  assert.deepEqual(closed, [session]);
  assert.equal(autoSignInCalls, 1);
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].actualSession, session);
  assert.deepEqual(batchCalls[0].calls, [
    {
      target: "GetComicList",
      params: { Page: 1, Size: 12, Order: "latest" },
    },
    {
      target: "GetComicList",
      params: { Page: 1, Size: 12, Order: "view" },
    },
    { target: "GetReadHistory", params: {} },
  ]);
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].actualSession, session);
  assert.deepEqual(
    { target: invokes[0].target, params: invokes[0].params },
    {
      target: "GetBookListByIds",
      params: {
        Ids: Array.from({ length: 12 }, (_, index) => index + 1),
        Type: "Comic",
      },
    },
  );

  assert.deepEqual(plain(parts), [
    {
      title: "最近更新",
      comics: [plain(parts[0].comics[0])],
      viewMore: {
        page: "category",
        attributes: { category: "最近更新", param: "latest" },
      },
    },
    {
      title: "热门漫画",
      comics: [plain(parts[1].comics[0])],
      viewMore: {
        page: "category",
        attributes: { category: "热门漫画", param: "view" },
      },
    },
    {
      title: "阅读历史",
      comics: plain(parts[2].comics),
      viewMore: {
        page: "category",
        attributes: { category: "阅读历史", param: "history" },
      },
    },
  ]);
  assert.deepEqual(
    plain(parts.map((part) => part.title)),
    ["最近更新", "热门漫画", "阅读历史"],
  );
  assert.deepEqual(
    plain(parts[2].comics.map((comic) => comic.id)),
    ["共享历史系列", ...Array.from({ length: 10 }, (_, index) => `历史 ${index + 3}`)],
  );
  assert.equal(source._historyPageSize, 12);
  assert.equal(source._historyNextPage, 2);
  assert.deepEqual(plain(source._historyComicIds), Array.from({ length: 13 }, (_, index) => index + 1));
});

test("空发现页历史不调用详情接口", async () => {
  const { source } = createHarness();
  source._runHubSession = async (_name, operation) => {
    return await operation({ id: "empty" });
  };
  source._hubInvokeBatch = async () => [
    { Data: [] },
    { Data: [] },
    { Comic: [0, -1, "2"] },
  ];
  let detailCalls = 0;
  source._hubInvoke = async () => {
    detailCalls += 1;
    return { Data: [] };
  };

  const parts = await source.explore[0].load(null);

  assert.equal(detailCalls, 0);
  assert.deepEqual(plain(parts.map((part) => part.comics)), [[], [], []]);
});

test("发现页第二阶段 unauthorized 时整套重试且只提交重试结果", async () => {
  const { source } = createHarness();
  const opened = [];
  const closed = [];

  source._openHub = async (forceRefresh) => {
    const session = { id: forceRefresh ? "retry" : "first" };
    opened.push({ forceRefresh, session });
    return session;
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };
  source._tryAutoSignIn = () => {};
  source._hubInvokeBatch = async (session) => [
    { Data: [listItem(`${session.id} 最近`)] },
    { Data: [listItem(`${session.id} 热门`)] },
    { Comic: session.id === "first" ? [1] : [9] },
  ];
  source._hubInvoke = async (session, target, params) => {
    assert.equal(target, "GetBookListByIds");
    if (session.id === "first") {
      throw new Error("user is unauthorized");
    }
    return { Data: params.Ids.map((id) => listItem(`重试历史 ${id}`)) };
  };

  const parts = await source.explore[0].load(null);

  assert.deepEqual(
    opened.map((item) => item.forceRefresh),
    [false, true],
  );
  assert.deepEqual(closed, ["first", "retry"]);
  assert.equal(parts[0].comics[0].id, "retry 最近");
  assert.equal(parts[1].comics[0].id, "retry 热门");
  assert.equal(parts[2].comics[0].id, "重试历史 9");
  assert.deepEqual(plain(source._historyComicIds), [9]);
});

test("退出账号使尚未完成的发现页历史请求失效", async () => {
  const { source } = createHarness();
  const details = deferred();
  let detailStarted = false;

  source._runHubSession = async (_name, operation) => {
    return await operation({ id: "pending" });
  };
  source._hubInvokeBatch = async () => [
    { Data: [listItem("旧最近")] },
    { Data: [listItem("旧热门")] },
    { Comic: [1] },
  ];
  source._hubInvoke = async () => {
    detailStarted = true;
    return await details.promise;
  };

  const loading = source.explore[0].load(null);
  while (!detailStarted) {
    await Promise.resolve();
  }
  source.account.logout();
  details.resolve({ Data: [listItem("旧历史")] });

  const error = await rejectionText(() => loading);
  assert.match(error, /阅读历史请求已失效/);
  assert.equal(source._historyComicIds, null);
  assert.equal(source._historySeenSeries.size, 0);
  assert.equal(source._historyNextPage, 1);
  assert.equal(source._historyPageSize, 0);
});

test("最近更新、热门漫画和阅读历史分类页每页 24 项，搜索仍为 20 项", async () => {
  const { source } = createHarness();
  const calls = [];
  const historyIds = Array.from({ length: 25 }, (_, index) => index + 1);

  source._hubCall = async (target, params) => {
    calls.push({ target, params: plain(params) });
    if (target === "GetReadHistory") return { Comic: historyIds };
    if (target === "GetBookListByIds") {
      return { Data: params.Ids.map((id) => listItem(`历史 ${id}`)) };
    }
    return { Data: [listItem(target)], TotalPages: 5 };
  };

  const latest = await source.categoryComics.load("最近更新", "latest", [], 2);
  const popular = await source.categoryComics.load("热门漫画", "view", [], 3);
  const historyFirst = await source.categoryComics.load("阅读历史", "history", [], 1);
  const historySecond = await source.categoryComics.load("阅读历史", "history", [], 2);
  await source.search.load("关键字", ["fuzzy"], 4);

  assert.equal(latest.maxPage, 5);
  assert.equal(popular.maxPage, 5);
  assert.equal(historyFirst.maxPage, 2);
  assert.equal(historyFirst.comics.length, 24);
  assert.equal(historySecond.comics.length, 1);
  assert.deepEqual(calls, [
    {
      target: "GetComicList",
      params: { Page: 2, Size: 24, Order: "latest" },
    },
    {
      target: "GetComicList",
      params: { Page: 3, Size: 24, Order: "view" },
    },
    { target: "GetReadHistory", params: {} },
    {
      target: "GetBookListByIds",
      params: {
        Ids: Array.from({ length: 24 }, (_, index) => index + 1),
        Type: "Comic",
      },
    },
    {
      target: "GetBookListByIds",
      params: { Ids: [25], Type: "Comic" },
    },
    {
      target: "SearchComicSeries",
      params: {
        KeyWords: "关键字",
        Mode: "fuzzy",
        Page: 4,
        Size: 20,
        IgnoreJapanese: false,
        IgnoreAI: false,
      },
    },
  ]);
});

test("历史分页大小改变时重新读取快照，避免复用错误切片边界", async () => {
  const { source } = createHarness();
  let historyCalls = 0;
  const detailIds = [];

  source._historyComicIds = Array.from({ length: 40 }, (_, index) => index + 1);
  source._historySeenSeries = new Set(["旧系列"]);
  source._historyNextPage = 2;
  source._historyPageSize = 12;
  source._hubCall = async (target, params) => {
    if (target === "GetReadHistory") {
      historyCalls += 1;
      return { Comic: Array.from({ length: 50 }, (_, index) => index + 101) };
    }
    detailIds.push(...params.Ids);
    return { Data: params.Ids.map((id) => listItem(`系列 ${id}`)) };
  };

  const result = await source._loadReadingHistory(2, 24);

  assert.equal(historyCalls, 1);
  assert.deepEqual(detailIds, Array.from({ length: 24 }, (_, index) => index + 125));
  assert.equal(result.maxPage, 3);
  assert.equal(source._historyPageSize, 24);
});
```

- [ ] **Step 2: 运行新增测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
```

Expected: Task 2 的 4 个测试 PASS；新增测试因发现页仍串行建立连接、分类仍为 12 项、`_historyPageSize` 不存在而 FAIL。

- [ ] **Step 3: 增加分类分页常量和历史分页大小状态**

将类开头和历史状态改为：

```javascript
class LightNovelShelf extends ComicSource {
  static discoveryPageSize = 12;
  static categoryPageSize = 24;
```

```javascript
  // 阅读历史仅缓存当前列表会话；第 1 页、非连续分页、分页大小变化和退出账号时重置。
  _historyComicIds = null;
  _historySeenSeries = new Set();
  _historyNextPage = 1;
  _historyPageSize = 0;
  _historyRequestGeneration = 0;
```

将 `_resetReadingHistoryState` 完整改为：

```javascript
  _resetReadingHistoryState() {
    this._historyComicIds = null;
    this._historySeenSeries = new Set();
    this._historyNextPage = 1;
    this._historyPageSize = 0;
    this._historyRequestGeneration += 1;
  }
```

- [ ] **Step 4: 提取列表和历史详情解析辅助方法**

用以下代码替换 `_loadComicList`，并在 `_historyIdsFromResponse` 后加入历史详情解析方法：

```javascript
  _comicListFromResponse(data) {
    const list = this._value(data, "data", "Data", []);
    const totalPages = this._value(data, "totalPages", "TotalPages", 1);

    return {
      comics: (Array.isArray(list) ? list : []).map((item) =>
        this._comicFromListItem(item),
      ),
      maxPage: Number(totalPages || 1),
    };
  }

  async _loadComicList(
    order,
    page,
    pageSize = LightNovelShelf.categoryPageSize,
  ) {
    const data = await this._hubCall("GetComicList", {
      Page: page,
      Size: pageSize,
      Order: order,
    });

    return this._comicListFromResponse(data);
  }
```

```javascript
  _historyComicsFromResponse(data, seenSeries) {
    const list = this._value(data, "data", "Data", []);
    const comics = [];

    for (const item of Array.isArray(list) ? list : []) {
      const comic = this._comicFromListItem(item);
      if (!comic.id || seenSeries.has(comic.id)) continue;

      seenSeries.add(comic.id);
      comics.push(comic);
    }

    return comics;
  }
```

- [ ] **Step 5: 将阅读历史加载器参数化为 24 项分类分页**

用以下方法完整替换 `_loadReadingHistory`：

```javascript
  async _loadReadingHistory(
    page,
    pageSize = LightNovelShelf.categoryPageSize,
  ) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("无效阅读历史页码");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new Error("无效阅读历史分页大小");
    }

    const requestGeneration = ++this._historyRequestGeneration;
    const assertCurrentRequest = () => {
      if (requestGeneration !== this._historyRequestGeneration) {
        throw new Error("阅读历史请求已失效");
      }
    };

    const refreshHistory =
      page === 1 ||
      !Array.isArray(this._historyComicIds) ||
      page !== this._historyNextPage ||
      pageSize !== this._historyPageSize;

    if (refreshHistory) {
      const history = await this._hubCall("GetReadHistory", {});
      assertCurrentRequest();
      this._historyComicIds = this._historyIdsFromResponse(history);
      this._historySeenSeries = new Set();
      this._historyPageSize = pageSize;
    }

    const ids = this._historyComicIds;
    const maxPage = Math.max(1, Math.ceil(ids.length / pageSize));
    const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
    let comics = [];

    if (pageIds.length > 0) {
      const data = await this._hubCall("GetBookListByIds", {
        Ids: pageIds,
        Type: "Comic",
      });
      assertCurrentRequest();
      comics = this._historyComicsFromResponse(
        data,
        this._historySeenSeries,
      );
    }

    this._historyNextPage = page + 1;

    return {
      comics: comics,
      maxPage: maxPage,
    };
  }
```

- [ ] **Step 6: 实现单连接 `_loadDiscoveryPage`**

在 `_loadReadingHistory` 后、`account = {` 前加入：

```javascript
  async _loadDiscoveryPage() {
    const requestGeneration = ++this._historyRequestGeneration;
    const assertCurrentRequest = () => {
      if (requestGeneration !== this._historyRequestGeneration) {
        throw new Error("阅读历史请求已失效");
      }
    };

    const loaded = await this._runHubSession(
      "LoadDiscovery",
      async (session) => {
        const [latestData, popularData, historyData] =
          await this._hubInvokeBatch(session, [
            {
              target: "GetComicList",
              params: {
                Page: 1,
                Size: LightNovelShelf.discoveryPageSize,
                Order: "latest",
              },
            },
            {
              target: "GetComicList",
              params: {
                Page: 1,
                Size: LightNovelShelf.discoveryPageSize,
                Order: "view",
              },
            },
            { target: "GetReadHistory", params: {} },
          ]);

        assertCurrentRequest();
        const historyIds = this._historyIdsFromResponse(historyData);
        const pageIds = historyIds.slice(
          0,
          LightNovelShelf.discoveryPageSize,
        );
        let historyDetails = null;

        if (pageIds.length > 0) {
          historyDetails = await this._hubInvoke(
            session,
            "GetBookListByIds",
            { Ids: pageIds, Type: "Comic" },
          );
          assertCurrentRequest();
        }

        return {
          latestData: latestData,
          popularData: popularData,
          historyIds: historyIds,
          historyDetails: historyDetails,
        };
      },
    );

    assertCurrentRequest();
    const seenSeries = new Set();
    const latest = this._comicListFromResponse(loaded.latestData);
    const popular = this._comicListFromResponse(loaded.popularData);
    const historyComics = loaded.historyDetails
      ? this._historyComicsFromResponse(
          loaded.historyDetails,
          seenSeries,
        )
      : [];

    this._historyComicIds = loaded.historyIds;
    this._historySeenSeries = seenSeries;
    this._historyNextPage = 2;
    this._historyPageSize = LightNovelShelf.discoveryPageSize;

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
        comics: historyComics,
        viewMore: {
          page: "category",
          attributes: {
            category: "阅读历史",
            param: "history",
          },
        },
      },
    ];
  }
```

- [ ] **Step 7: 让发现页和三个分类路由使用新加载路径**

将唯一发现页的 `load` 简化为：

```javascript
      load: async () => {
        return await this._loadDiscoveryPage();
      },
```

将 `categoryComics.load` 三个分支改为：

```javascript
      if (param === "latest") {
        return await this._loadComicList(
          "latest",
          page,
          LightNovelShelf.categoryPageSize,
        );
      }
      if (param === "view") {
        return await this._loadComicList(
          "view",
          page,
          LightNovelShelf.categoryPageSize,
        );
      }
      if (param === "history") {
        return await this._loadReadingHistory(
          page,
          LightNovelShelf.categoryPageSize,
        );
      }
```

不要修改 `search.load` 的 `Size: 20`。

- [ ] **Step 8: 运行全部专项测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 10 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 9: 检查分页常量、单连接调用和行尾**

Run:

```bash
grep -nE 'discoveryPageSize|categoryPageSize|_loadDiscoveryPage|_hubInvokeBatch|Size: 20' lightnovelshelf.js
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
```

Expected: 发现页只使用 12，分类路由只使用 24，搜索仍为 20；CRLF 保持不变；无 whitespace 错误。

- [ ] **Step 10: 提交发现页与分类分页优化**

Run:

```bash
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "perf: 批量加载轻书架发现页"
```

Expected: 提交只包含 `lightnovelshelf.js` 的发现页、分页和历史状态改动。

### Task 4: 版本、索引和完整回归验证

**Files:**
- Modify temporarily: `test/lightnovelshelf-discovery-performance.test.cjs`
- Modify: `lightnovelshelf.js:1-27`
- Modify: `index.json:205-211`
- Delete: `test/lightnovelshelf-discovery-performance.test.cjs`

- [ ] **Step 1: 追加版本、结构和既有功能回归测试**

向测试文件追加：

```javascript
test("发现页结构、三个查看更多和分类顺序保持不变", () => {
  const { source } = createHarness();

  assert.equal(source.explore.length, 1);
  assert.equal(source.explore[0].title, "轻书架");
  assert.equal(source.explore[0].type, "multiPartPage");
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
  assert.doesNotMatch(SOURCE_TEXT, /_loadComicList\("new"/);
  assert.doesNotMatch(SOURCE_TEXT, /title:\s*"最新收录"/);
});

test("账号、搜索、详情、章节、评论和签到接口仍存在", () => {
  const { source } = createHarness();

  assert.equal(typeof source.account.login, "function");
  assert.equal(typeof source.account.logout, "function");
  assert.equal(typeof source.search.load, "function");
  assert.equal(typeof source.comic.loadInfo, "function");
  assert.equal(typeof source.comic.loadEp, "function");
  assert.equal(typeof source.comic.loadComments, "function");
  assert.equal(typeof source.comic.sendComment, "function");
  assert.equal(typeof source.dailySignIn, "function");
});

test("源和索引版本同步为 0.2.11", () => {
  const { source } = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.11");
  assert.match(SOURCE_TEXT, /版本：0\.2\.11/);
  assert.match(SOURCE_TEXT, /发现页/);
  assert.ok(entry);
  assert.equal(entry.name, "轻书架");
  assert.equal(entry.version, "0.2.11");
  assert.match(entry.description, /发现页/);
  assert.match(entry.description, /24/);
});
```

- [ ] **Step 2: 运行测试并确认版本测试 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
```

Expected: 功能测试 PASS；版本测试因源和索引仍为 `0.2.10` 而 FAIL。

- [ ] **Step 3: 更新源版本和顶部功能说明**

在 `lightnovelshelf.js` 中进行三处精确更新：

```javascript
 * 版本：0.2.11
```

```javascript
 * - 单连接批量发现页（12 项）/ 24 项分类分页 / 漫画阅读历史 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
```

```javascript
  version = "0.2.11";
```

- [ ] **Step 4: 同步 `index.json`**

将轻书架条目改为：

```json
    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.11",
        "description": "轻书架漫画源，支持邮箱密码登录、每日自动/手动签到、单连接批量发现页、24 项分类分页、漫画阅读历史及系列评论与回复"
    }
```

- [ ] **Step 5: 运行全部隔离测试、语法和 JSON 检查**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-discovery-performance.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "const fs=require('fs');const index=JSON.parse(fs.readFileSync('F:/workspace/venera-configs/index.json','utf8'));const entry=index.find(x=>x.fileName==='lightnovelshelf.js');if(!entry||entry.version!=='0.2.11')process.exit(1);console.log('version_consistency=PASS')"
```

Expected: 13 个测试全部 PASS；语法检查退出码为 0；输出 `version_consistency=PASS`。

- [ ] **Step 6: 审查敏感信息、调用数量和正式文件差异**

Run:

```bash
if grep -nE 'UI\.showMessage\([^)]*(RefreshToken|sessionToken|visitorId|x-id|password|Authorization)' lightnovelshelf.js; then
  echo 'sensitive UI message found' >&2
  exit 1
fi
grep -nE 'GetComicList|GetReadHistory|GetBookListByIds|_loadDiscoveryPage|categoryPageSize' lightnovelshelf.js
git diff --name-only origin/main...HEAD
git diff -- lightnovelshelf.js index.json
git ls-files --eol lightnovelshelf.js index.json
```

Expected: 没有向 UI 输出认证信息；发现页第一阶段包含两个 `GetComicList` 和一个 `GetReadHistory`，第二阶段仅一个 `GetBookListByIds`；目标文件行尾分别为 CRLF/LF；用户无关文件没有进入任务提交。

- [ ] **Step 7: 运行版本、whitespace 和 Venera CLI 验证**

Run:

```bash
/mnt/f/node/node.exe scripts/validate-pr-versions.js origin/main
git -c core.whitespace=cr-at-eol diff --check origin/main...HEAD
python3 - <<'PY'
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path('/mnt/f/workspace/venera-configs')
validator = pathlib.Path(tempfile.mkdtemp(prefix='venera-cli-discovery-performance-', dir='/mnt/f/workspace'))
dart = '/mnt/f/flutter-env/flutter/bin/cache/dart-sdk/bin/dart.exe'
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

Expected: 版本与 whitespace 检查通过；Venera CLI 输出 `Valid LightNovelShelf (轻书架) 0.2.11`。验证不使用真实账号或用户日志。

- [ ] **Step 8: 只暂存版本相关正式文件并提交**

Run:

```bash
git add -- lightnovelshelf.js index.json
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "chore: 更新轻书架发现页版本"
```

Expected: 提交仅包含 `lightnovelshelf.js` 与 `index.json`；版本均为 `0.2.11`。

- [ ] **Step 9: 删除临时测试并确认最终工作区**

Run:

```bash
rm -f test/lightnovelshelf-discovery-performance.test.cjs
rmdir test 2>/dev/null || true
test ! -e test/lightnovelshelf-discovery-performance.test.cjs
test -z "$(git diff --cached --name-only)"
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: 临时测试已删除、暂存区为空；目标提交包含文档、Hub 会话优化、发现页批量加载和版本更新；用户原有无关未暂存改动保持不变。

## 自审结果

- 规格覆盖：单连接、混合 target、同会话历史详情、unauthorized 完整重试、请求代际隔离、发现页 12、分类 24、搜索 20、三个 `viewMore`、版本和验证均有对应任务。
- 类型一致：统一使用 `_hubInvokeBatch(session, calls)`、`_runHubSession(operationName, operation)`、`_loadComicList(order, page, pageSize)`、`_loadReadingHistory(page, pageSize)` 和 `_historyPageSize`。
- 非目标边界：计划没有修改 VeneraNext、网页端、其他漫画源，也没有引入渐进渲染或持久缓存。
- 临时测试边界：测试位于已忽略的 `test/`，最终明确删除，不会污染正式提交。
