# 轻书架后台预连接与共享 Hub 会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `lightnovelshelf.js` 增加后台 Hub 预连接、串行共享会话和 15 秒空闲复用，使发现页与紧随其后的“查看更多”避免重复 SignalR 建连。

**Architecture:** `init()` 通过现有认证流程后台建立一个绑定账号、短期 Token 和 API 地址的 Long Polling session；所有 Hub operation 经 Promise 队列串行租用该 session。成功请求只安排带代际检查的 15 秒延迟关闭，认证/配置/transport 失效则先淘汰 session；只有明确标记的幂等目录读取允许在 transport 失败后重建连接并重试一次。

**Tech Stack:** JavaScript ComicSource API、QuickJS Promise/`setTimeout`、ASP.NET Core SignalR JSON Hub Protocol、HTTP Long Polling、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 共享 session 状态、后台预热、操作队列、空闲关闭、transport 错误分类、安全重试和 `0.2.12` 版本。
- Modify: `index.json` — 同步 `0.2.12` 版本与后台预连接说明。
- Create temporarily: `test/lightnovelshelf-shared-hub-session.test.cjs` — 隔离式生命周期、队列、重试和回归测试；该目录被 `.gitignore` 忽略，最终删除。
- Existing spec: `docs/superpowers/specs/2026-08-30-lightnovelshelf-shared-hub-session-design.md` — 已确认设计，不再改变功能范围。
- Reference only: `cache/Venera-Next/lib/features/comic_source/parser.dart`、`cache/Venera-Next/lib/features/discovery/explore_page.dart`、`_venera_.js` — `init()`、`multiPartPage` 和 HTTP-only JS 桥接约束。
- Reference only: `cache/Flutter/lib/core/network/signalr_connection.dart`、`cache/Flutter/lib/data/app_runtime.dart` — 官方 App 后台连接和共享 WebSocket 行为。

保持 `lightnovelshelf.js` 为 CRLF，`index.json` 与 Markdown 为 LF。工作区已有大量无关未暂存改动；每次提交只暂存本计划列出的正式文件。

### Task 1: 固化基线并创建共享会话测试 harness

**Files:**
- Existing: `docs/superpowers/specs/2026-08-30-lightnovelshelf-shared-hub-session-design.md`
- Create temporarily: `test/lightnovelshelf-shared-hub-session.test.cjs`
- Inspect: `lightnovelshelf.js`
- Inspect: `index.json`

- [ ] **Step 1: 检查目标文件、文档提交、暂存区和行尾基线**

Run:

```bash
git diff --exit-code -- lightnovelshelf.js index.json
test -z "$(git diff --cached --name-only)"
git log --oneline --decorate -3
git ls-files --eol lightnovelshelf.js index.json \
  docs/superpowers/specs/2026-08-30-lightnovelshelf-shared-hub-session-design.md
git status --short --branch
```

Expected:

- `lightnovelshelf.js` 与 `index.json` 相对 `HEAD` 无差异；
- 暂存区为空；
- 最近提交包含 `2f2a74b` 与 `735aa45` 两个设计文档提交；
- `lightnovelshelf.js` 为 `i/crlf w/crlf`，其余两个目标文件为 LF；
- 无关未暂存改动保持原状。

- [ ] **Step 2: 创建隔离 harness 和首批失败测试**

创建 `test/lightnovelshelf-shared-hub-session.test.cjs`，完整内容如下：

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function spinUntil(predicate, message = "条件未满足") {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

function createHarness(options = {}) {
  class ComicSource {
    constructor() {
      this.__data = new Map();
      if (options.refreshToken !== false) {
        this.__data.set("refreshToken", options.refreshToken || "refresh-A");
      }
      this.__settings = new Map([
        ["apiServer", options.apiServer || "https://api.lightnovel.life"],
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

    setSetting(key, value) {
      this.__settings.set(key, value);
    }
  }

  const timers = [];
  const network = options.network || {};
  const sandbox = {
    ComicSource,
    Network: network,
    Convert: {},
    UI: { showMessage() {} },
    createUuid() {
      return "00112233-4455-6677-8899-aabbccddeeff";
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
    },
    Date,
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

  return {
    source: new sandbox.__LightNovelShelf(),
    network,
    timers,
  };
}

function ownedSession(source, id, apiBase = source.apiBase) {
  const sessionToken = `token-${id}`;
  source._sessionToken = sessionToken;
  source._sessionTokenAt = Date.now();
  source._sessionTokenGeneration = source._authGeneration;
  return {
    id,
    url: `${apiBase}/hub/api?id=${encodeURIComponent(id)}`,
    seq: 0,
    pollSeq: 0,
    apiBase,
    authGeneration: source._authGeneration,
    refreshToken: source.loadData("refreshToken"),
    sessionToken,
    createdAt: Date.now(),
  };
}

function plain(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}

test("init 预热与正式请求共享一个建连结果", async () => {
  const { source } = createHarness();
  const opened = deferred();
  const openFlags = [];
  const closed = [];

  source._tryAutoSignIn = () => {};
  source._openHub = async (forceRefresh) => {
    openFlags.push(forceRefresh);
    return await opened.promise;
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };

  source.init();
  await spinUntil(() => openFlags.length === 1, "预热没有开始建连");

  const loading = source._runHubSession(
    "GetComicList",
    async (session) => session.id,
  );
  const session = ownedSession(source, "warm");
  opened.resolve(session);

  assert.equal(await loading, "warm");
  assert.deepEqual(openFlags, [false]);
  assert.deepEqual(closed, []);
  assert.equal(source._sharedHubSession, session);
});

test("成功请求保留 session，旧计时器失效且最新计时器关闭一次", async () => {
  const { source, timers } = createHarness();
  const session = ownedSession(source, "shared");
  let openCalls = 0;
  const closed = [];

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    openCalls += 1;
    return session;
  };
  source._closeHub = async (actualSession) => {
    if (actualSession) {
      closed.push({
        id: actualSession.id,
        detached: source._sharedHubSession !== actualSession,
      });
    }
  };

  assert.equal(
    await source._runHubSession("first", async (actualSession) => actualSession.id),
    "shared",
  );
  assert.equal(
    await source._runHubSession("second", async (actualSession) => actualSession.id),
    "shared",
  );

  assert.equal(openCalls, 1);
  assert.equal(closed.length, 0);
  assert.equal(timers.length, 2);
  assert.deepEqual(timers.map((timer) => timer.delay), [15000, 15000]);

  timers[0].callback();
  await flushMicrotasks();
  assert.deepEqual(closed, []);
  assert.equal(source._sharedHubSession, session);

  timers[1].callback();
  await flushMicrotasks();
  assert.deepEqual(closed, [{ id: "shared", detached: true }]);
  assert.equal(source._sharedHubSession, null);
});

test("Hub operation 严格串行且前项失败不阻塞后项", async () => {
  const { source } = createHarness();
  const session = ownedSession(source, "queue");
  const gate = deferred();
  const events = [];
  let openCalls = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    openCalls += 1;
    return session;
  };
  source._closeHub = async () => {};

  const first = source._runHubSession("first", async () => {
    events.push("first:start");
    await gate.promise;
    events.push("first:end");
    throw new Error("first failed");
  });
  await spinUntil(() => events.includes("first:start"));

  const second = source._runHubSession("second", async () => {
    events.push("second:start");
    return "second ok";
  });
  await flushMicrotasks();
  assert.deepEqual(events, ["first:start"]);

  gate.resolve();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, "second ok");
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  assert.equal(openCalls, 1);
});

test("API 地址变化时淘汰旧 session 并连接新地址", async () => {
  const { source } = createHarness();
  const opened = [];
  const closed = [];

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    const session = ownedSession(source, `s${opened.length + 1}`);
    opened.push(session);
    return session;
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };

  await source._runHubSession("first", async (session) => session.id);
  source.setSetting("apiServer", "https://api2.lightnovel.life");
  const secondId = await source._runHubSession(
    "second",
    async (session) => session.id,
  );

  assert.equal(secondId, "s2");
  assert.equal(opened.length, 2);
  assert.equal(opened[1].apiBase, "https://api2.lightnovel.life");
  assert.deepEqual(closed, ["s1"]);
});

test("未登录时 init 不进行预热", async () => {
  const { source, timers } = createHarness({
    logged: false,
    refreshToken: false,
  });
  let openCalls = 0;
  source._openHub = async () => {
    openCalls += 1;
    return ownedSession(source, "unexpected");
  };

  source.init();
  await flushMicrotasks();

  assert.equal(openCalls, 0);
  assert.equal(timers.length, 0);
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
```

Expected: 测试文件能够载入源；测试因 `source.init is not a function`、共享状态不存在、请求未串行或请求后立即关闭而失败。

### Task 2: 实现后台预热、共享 session、队列和空闲关闭

**Files:**
- Modify: `lightnovelshelf.js:20-60,354-365,678-815,991-1053,1518-1534`
- Test: `test/lightnovelshelf-shared-hub-session.test.cjs`

- [ ] **Step 1: 增加共享会话常量和实例状态**

在类开头两个分页常量后加入空闲时限：

```javascript
  static discoveryPageSize = 12;
  static categoryPageSize = 24;
  static hubIdleTimeoutMs = 15000;
```

在发现页请求状态后加入：

```javascript
  // 单个 Long Polling session 由所有 Hub operation 串行租用。
  _sharedHubSession = null;
  _sharedHubOpenPromise = null;
  _sharedHubGeneration = 0;
  _hubOperationQueue = Promise.resolve();
  // 包含排队中和执行中的 operation，非零时不得空闲关闭。
  _hubOperationCount = 0;
  _hubIdleGeneration = 0;
```

- [ ] **Step 2: 认证失效时同步淘汰共享会话**

将 `_invalidateAuthState` 完整替换为：

```javascript
  _invalidateAuthState() {
    this._authGeneration += 1;
    this._discardSharedHubSession();
    this._sessionToken = "";
    this._sessionTokenAt = 0;
    this._sessionTokenGeneration = 0;
    this._refreshPromise = null;
    this._refreshPromiseGeneration = 0;
    this._refreshPromiseToken = "";
    this._resetReadingHistoryState();
    return this._authGeneration;
  }
```

`_discardSharedHubSession()` 在后续步骤定义；类方法可在定义位置之前调用。

- [ ] **Step 3: 让 `_openHub` 固定记录 API 地址和建立时间**

将 `_openHub` 开头改为：

```javascript
  async _openHub(forceRefresh) {
    const authGeneration = this._authGeneration;
    const refreshToken = this._getRefreshToken();
    const apiBase = this.apiBase;
    await this._refreshSessionToken(!!forceRefresh);
```

将 Hub URL 改为使用快照：

```javascript
    const hubUrl = apiBase + "/hub/api";
```

将 session 对象改为：

```javascript
    const session = {
      url: "",
      seq: 0,
      pollSeq: 0,
      apiBase: apiBase,
      authGeneration: authGeneration,
      refreshToken: refreshToken,
      // 会话创建后始终使用此 Token，不跟随全局 Token 变化。
      sessionToken: sessionToken,
      createdAt: 0,
    };
```

在 `_openHub` 最后的 `return session;` 前加入：

```javascript
    session.createdAt = Date.now();
```

- [ ] **Step 4: 在 `_closeHub` 后加入共享会话生命周期辅助方法**

插入以下完整方法：

```javascript
  _sharedHubSessionMatches(session) {
    if (!session || !session.url) return false;

    const currentRefreshToken = this.loadData("refreshToken");
    return (
      session.apiBase === this.apiBase &&
      session.authGeneration === this._authGeneration &&
      currentRefreshToken !== undefined &&
      currentRefreshToken !== null &&
      String(currentRefreshToken).trim() === session.refreshToken &&
      session.sessionToken === this._sessionToken &&
      this._sessionTokenGeneration === this._authGeneration
    );
  }

  _closeHubInBackground(session) {
    if (!session) return;
    const closing = this._closeHub(session);
    if (closing && typeof closing.catch === "function") {
      closing.catch(() => {});
    }
  }

  _discardSharedHubSession(expectedSession = null) {
    if (
      expectedSession &&
      this._sharedHubSession !== expectedSession
    ) {
      this._closeHubInBackground(expectedSession);
      return;
    }

    const session = this._sharedHubSession;
    this._sharedHubSession = null;
    this._sharedHubOpenPromise = null;
    this._sharedHubGeneration += 1;
    this._hubIdleGeneration += 1;
    this._closeHubInBackground(session);
  }

  _scheduleSharedHubClose(session) {
    if (!session || this._sharedHubSession !== session) return;

    const idleGeneration = ++this._hubIdleGeneration;
    setTimeout(() => {
      if (
        idleGeneration !== this._hubIdleGeneration ||
        this._sharedHubSession !== session ||
        this._hubOperationCount !== 0
      ) {
        return;
      }
      this._discardSharedHubSession(session);
    }, LightNovelShelf.hubIdleTimeoutMs);
  }

  async _ensureSharedHubSession(forceRefresh) {
    if (forceRefresh) {
      this._discardSharedHubSession();
    } else if (this._sharedHubSessionMatches(this._sharedHubSession)) {
      return this._sharedHubSession;
    } else if (this._sharedHubSession) {
      this._discardSharedHubSession(this._sharedHubSession);
    }

    if (!forceRefresh && this._sharedHubOpenPromise) {
      return await this._sharedHubOpenPromise;
    }

    const sharedGeneration = this._sharedHubGeneration;
    let openPromise;
    openPromise = (async () => {
      const session = await this._openHub(!!forceRefresh);
      if (
        sharedGeneration !== this._sharedHubGeneration ||
        !this._sharedHubSessionMatches(session)
      ) {
        this._closeHubInBackground(session);
        throw new Error("轻书架预连接已失效");
      }

      this._sharedHubSession = session;
      return session;
    })();
    this._sharedHubOpenPromise = openPromise;

    try {
      return await openPromise;
    } finally {
      if (this._sharedHubOpenPromise === openPromise) {
        this._sharedHubOpenPromise = null;
      }
    }
  }

  _enqueueHubOperation(operation) {
    const queued = this._hubOperationQueue.then(operation, operation);
    this._hubOperationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
```

- [ ] **Step 5: 用共享会话版本替换 `_runHubSession`**

完整替换现有方法：

```javascript
  /**
   * 串行租用共享 Hub 会话；明确 unauthorized 时刷新 Token 并重试一次。
   */
  async _runHubSession(operationName, operation) {
    const authGeneration = this._authGeneration;
    this._hubIdleGeneration += 1;
    this._hubOperationCount += 1;

    return await this._enqueueHubOperation(async () => {
      let session = null;
      let succeeded = false;

      const assertCurrentAuth = () => {
        if (this._authGeneration !== authGeneration) {
          throw new Error("轻书架登录状态已变更，请重试");
        }
      };

      const run = async (forceRefresh) => {
        assertCurrentAuth();
        session = await this._ensureSharedHubSession(forceRefresh);
        assertCurrentAuth();
        const result = await operation(session);
        assertCurrentAuth();
        return result;
      };

      try {
        try {
          const result = await run(false);
          succeeded = true;
          return result;
        } catch (error) {
          assertCurrentAuth();
          if (!this._isUnauthorizedError(error)) {
            throw error;
          }

          const failedSession = session;
          this._discardSharedHubSession(failedSession);
          session = null;
          this._clearSessionTokenIfOwned(
            authGeneration,
            failedSession && failedSession.refreshToken,
            failedSession && failedSession.sessionToken,
          );

          try {
            const result = await run(true);
            succeeded = true;
            return result;
          } catch (retryError) {
            if (this._isUnauthorizedError(retryError)) {
              const failedRetrySession = session;
              this._discardSharedHubSession(failedRetrySession);
              this._clearSessionTokenIfOwned(
                authGeneration,
                failedRetrySession && failedRetrySession.refreshToken,
                failedRetrySession && failedRetrySession.sessionToken,
              );
            }
            throw retryError;
          }
        }
      } finally {
        this._hubOperationCount -= 1;

        // 预热和签到本身都不能递归触发自动签到。
        if (
          succeeded &&
          operationName !== "SignIn" &&
          operationName !== "Prewarm"
        ) {
          this._tryAutoSignIn();
        }

        if (
          session &&
          this._sharedHubSession === session &&
          this._hubOperationCount === 0
        ) {
          this._scheduleSharedHubClose(session);
        }
      }
    });
  }
```

保留 `_hubCall(target, params)` 当前签名；Task 3 再增加安全重试选项。

- [ ] **Step 6: 增加不阻塞漫画源加载的 `init()`**

在 `_loadDiscoveryPageRequest` 结束后、`account = {` 前加入：

```javascript
  init() {
    if (!this.isLogged) return;

    const prewarm = this._runHubSession(
      "Prewarm",
      async () => null,
    );
    if (prewarm && typeof prewarm.catch === "function") {
      prewarm.catch(() => {});
    }
  }
```

- [ ] **Step 7: 运行共享生命周期测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
/mnt/f/node/node.exe --check \
  'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 5 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 8: 检查共享状态、空闲时限和 CRLF**

Run:

```bash
grep -nE 'hubIdleTimeoutMs|_sharedHubSession|_enqueueHubOperation|_ensureSharedHubSession|init\(\)' \
  lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
```

Expected: 共享方法只出现一次；空闲时限为 15000；`lightnovelshelf.js` 仍为 `w/crlf`；无 whitespace 错误。

- [ ] **Step 9: 只提交共享会话基础设施**

Run:

```bash
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "perf: 复用轻书架 Hub 会话"
```

Expected: 提交只包含 `lightnovelshelf.js`；临时测试因 `test/` 被忽略而不进入提交。

### Task 3: 增加 transport 分类和幂等目录读取重试

**Files:**
- Modify temporarily: `test/lightnovelshelf-shared-hub-session.test.cjs`
- Modify: `lightnovelshelf.js:670-1055,1235-1335,1441-1500`

- [ ] **Step 1: 追加预热恢复、认证淘汰和 transport 重试测试**

向临时测试文件追加：

```javascript
test("预热失败静默且正式请求可以重新建连", async () => {
  const { source } = createHarness();
  let attempts = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("prewarm failed");
    return ownedSession(source, "formal");
  };
  source._closeHub = async () => {};

  source.init();
  await spinUntil(() => attempts === 1);
  await flushMicrotasks(16);

  const result = await source._runHubSession(
    "GetComicList",
    async (session) => session.id,
  );
  assert.equal(result, "formal");
  assert.equal(attempts, 2);
});

test("认证失效立即移除并关闭旧共享 session", async () => {
  const { source } = createHarness();
  const session = ownedSession(source, "old-auth");
  const closed = [];

  source._tryAutoSignIn = () => {};
  source._openHub = async () => session;
  source._closeHub = async (actualSession) => {
    if (actualSession) closed.push(actualSession.id);
  };

  await source._runHubSession("read", async () => "ok");
  assert.equal(source._sharedHubSession, session);

  source._invalidateAuthState();
  await flushMicrotasks();

  assert.equal(source._sharedHubSession, null);
  assert.deepEqual(closed, ["old-auth"]);
  assert.equal(source._sessionToken, "");
});

test("unauthorized 只重试一次且第二次失败清除短期 Token", async () => {
  const { source } = createHarness();
  const openFlags = [];
  const closed = [];
  let operationCalls = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async (forceRefresh) => {
    openFlags.push(forceRefresh);
    return ownedSession(source, `auth-${openFlags.length}`);
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };

  await assert.rejects(
    source._runHubSession("GetComicList", async () => {
      operationCalls += 1;
      throw new Error("User is unauthorized");
    }),
    /unauthorized/,
  );

  assert.equal(operationCalls, 2);
  assert.deepEqual(openFlags, [false, true]);
  assert.deepEqual(closed, ["auth-1", "auth-2"]);
  assert.equal(source._sessionToken, "");
  assert.equal(source._sessionTokenGeneration, 0);
});

test("幂等目录读取在 transport 失效后换连接重试一次", async () => {
  const { source } = createHarness();
  const opened = [];
  const closed = [];
  let operationCalls = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    const session = ownedSession(source, `read-${opened.length + 1}`);
    opened.push(session.id);
    return session;
  };
  source._closeHub = async (session) => {
    if (session) closed.push(session.id);
  };

  const result = await source._runHubSession(
    "GetComicList",
    async () => {
      operationCalls += 1;
      if (operationCalls === 1) {
        throw source._hubTransportError("旧连接已关闭");
      }
      return "ok";
    },
    { retryTransport: true },
  );

  assert.equal(result, "ok");
  assert.equal(operationCalls, 2);
  assert.deepEqual(opened, ["read-1", "read-2"]);
  assert.deepEqual(closed, ["read-1"]);
});

test("不确定的章节 transport 结果不会自动重放", async () => {
  const { source } = createHarness();
  let operationCalls = 0;
  let openCalls = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    openCalls += 1;
    return ownedSession(source, `chapter-${openCalls}`);
  };
  source._closeHub = async () => {};

  await assert.rejects(
    source._runHubSession("GetComicContent", async () => {
      operationCalls += 1;
      throw source._hubTransportError("Completion 丢失");
    }),
    /Completion 丢失/,
  );

  assert.equal(operationCalls, 1);
  assert.equal(openCalls, 1);
});

test("发表评论 transport 结果不会自动重放", async () => {
  const { source } = createHarness();
  let invokeCalls = 0;
  let openCalls = 0;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => {
    openCalls += 1;
    return ownedSession(source, `write-${openCalls}`);
  };
  source._closeHub = async () => {};
  source._hubInvoke = async () => {
    invokeCalls += 1;
    throw source._hubTransportError("响应未知");
  };

  await assert.rejects(
    source._hubCall("PostComment", { Content: "test" }),
    /响应未知/,
  );
  assert.equal(invokeCalls, 1);
  assert.equal(openCalls, 1);
});

test("SignalR 204 poll 被标记为 transport 错误", async () => {
  const network = {
    async post() {
      return { status: 200, body: "" };
    },
    async get() {
      return { status: 204, body: "" };
    },
  };
  const { source } = createHarness({ network });
  const session = ownedSession(source, "poll-204");

  await assert.rejects(
    source._hubInvokeBatch(session, [
      { target: "GetComicList", params: { Page: 1 } },
    ]),
    (error) => source._isHubTransportError(error),
  );
});

test("发现页和历史目录显式启用 transport 安全重试", async () => {
  const { source } = createHarness();
  const hubCalls = [];

  source._hubCall = async (target, params, options) => {
    hubCalls.push({ target, params: plain(params), options: plain(options) });
    if (target === "GetReadHistory") return { Comic: [1] };
    if (target === "GetBookListByIds") return { Data: [] };
    return { Data: [], TotalPages: 1 };
  };

  await source._loadComicList("latest", 1, 24);
  await source._loadReadingHistory(1, 24);

  let discoveryOptions;
  source._runHubSession = async (_name, operation, options) => {
    discoveryOptions = plain(options);
    return await operation(ownedSession(source, "discovery"));
  };
  source._hubInvokeBatch = async () => [
    { Data: [] },
    { Data: [] },
    { Comic: [] },
  ];

  const generation = ++source._historyRequestGeneration;
  await source._loadDiscoveryPageRequest(generation);

  assert.deepEqual(
    hubCalls.map((call) => [call.target, call.options]),
    [
      ["GetComicList", { retryTransport: true }],
      ["GetReadHistory", { retryTransport: true }],
      ["GetBookListByIds", { retryTransport: true }],
    ],
  );
  assert.deepEqual(discoveryOptions, { retryTransport: true });
});

test("旧 session 的 unauthorized 不能清除新账号 Token", async () => {
  const { source } = createHarness();
  const oldSession = ownedSession(source, "old-account");
  const response = deferred();
  let operationStarted = false;

  source._tryAutoSignIn = () => {};
  source._openHub = async () => oldSession;
  source._closeHub = async () => {};

  const loading = source._runHubSession("GetComicList", async () => {
    operationStarted = true;
    return await response.promise;
  });
  await spinUntil(() => operationStarted);

  source.saveData("refreshToken", "refresh-B");
  source._invalidateAuthState();
  source._sessionToken = "token-new-account";
  source._sessionTokenAt = Date.now();
  source._sessionTokenGeneration = source._authGeneration;
  response.reject(new Error("User is unauthorized"));

  await assert.rejects(loading, /登录状态已变更/);
  assert.equal(source.loadData("refreshToken"), "refresh-B");
  assert.equal(source._sessionToken, "token-new-account");
  assert.equal(source._sessionTokenGeneration, source._authGeneration);
});
```

- [ ] **Step 2: 运行新增测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
```

Expected: Task 2 的 5 个测试 PASS；新增测试因 `_hubTransportError`/`_isHubTransportError` 不存在、第三个 options 参数尚未生效和读取调用点未标记而 FAIL。

- [ ] **Step 3: 增加明确的 Hub transport 错误与请求包装器**

在 `_pollHeaders` 后、`_openHub` 前加入：

```javascript
  _hubTransportError(message, cause) {
    const error = new Error(String(message));
    error.code = "LIGHTNOVELSHELF_HUB_TRANSPORT";
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  _isHubTransportError(error) {
    return !!(
      error &&
      typeof error === "object" &&
      error.code === "LIGHTNOVELSHELF_HUB_TRANSPORT"
    );
  }

  async _hubTransportRequest(action, request, expected = 200) {
    try {
      const response = await request();
      const accepted = Array.isArray(expected)
        ? expected.indexOf(response && response.status) >= 0
        : response && response.status === expected;

      if (!accepted) {
        const status =
          response && response.status !== undefined
            ? response.status
            : "未知";
        throw this._hubTransportError(`${action}失败: HTTP ${status}`);
      }

      return response;
    } catch (error) {
      if (this._isHubTransportError(error)) throw error;
      const detail = String(
        error && error.message ? error.message : error || "未知错误",
      );
      throw this._hubTransportError(`${action}失败: ${detail}`, error);
    }
  }
```

- [ ] **Step 4: 让 `_openHub` 的网络和协议失败使用 transport 分类**

把 negotiate 请求与状态检查替换为：

```javascript
    const negotiateRes = await this._hubTransportRequest(
      "SignalR negotiate",
      async () =>
        await Network.post(
          negotiateUrl,
          this._sessionAuthTextHeaders(session),
          "",
        ),
    );
```

把 negotiate JSON/协议检查替换为：

```javascript
    let negotiate;
    try {
      negotiate = JSON.parse(negotiateRes.body);
    } catch (error) {
      throw this._hubTransportError(
        "SignalR negotiate 返回了无效 JSON",
        error,
      );
    }

    if (negotiate.error) {
      throw this._hubTransportError(
        `SignalR negotiate 失败: ${negotiate.error}`,
      );
    }

    if (negotiate.url) {
      throw this._hubTransportError(
        "SignalR 返回了重定向地址，当前源暂未实现重定向协商: " +
          negotiate.url,
      );
    }

    const connectionToken = negotiate.connectionToken || negotiate.connectionId;

    if (!connectionToken) {
      throw this._hubTransportError(
        "SignalR negotiate 未返回 connectionToken/connectionId",
      );
    }

    const transports = negotiate.availableTransports || [];
    const longPolling = transports.find((x) => x.transport === "LongPolling");

    if (!longPolling) {
      throw this._hubTransportError(
        "服务端没有提供 SignalR LongPolling transport",
      );
    }

    if (
      Array.isArray(longPolling.transferFormats) &&
      longPolling.transferFormats.indexOf("Text") < 0
    ) {
      throw this._hubTransportError(
        "服务端 LongPolling 不支持 Text transfer format",
      );
    }
```

把 transport 初始化替换为：

```javascript
    await this._hubTransportRequest(
      "SignalR transport 初始化",
      async () =>
        await Network.get(
          this._pollUrl(session),
          this._pollHeaders(session),
        ),
    );
```

把 handshake POST 替换为：

```javascript
    await this._hubTransportRequest(
      "SignalR handshake 发送",
      async () =>
        await Network.post(
          session.url,
          this._sessionAuthTextHeaders(session),
          handshake,
        ),
    );
```

把 handshake 循环中的 GET、状态和 frame error 处理改为：

```javascript
      const poll = await this._hubTransportRequest(
        "SignalR handshake 接收",
        async () =>
          await Network.get(
            this._pollUrl(session),
            this._pollHeaders(session),
          ),
      );

      for (const frame of this._frames(poll.body)) {
        if (frame.error) {
          throw this._hubTransportError(
            `SignalR handshake 失败: ${frame.error}`,
          );
        }

        if (typeof frame === "object" && Object.keys(frame).length === 0) {
          handshakeDone = true;
          break;
        }
      }
```

把最终 handshake 超时改为：

```javascript
    if (!handshakeDone) {
      throw this._hubTransportError("SignalR handshake 未收到有效响应");
    }
```

- [ ] **Step 5: 让 `_hubInvokeBatch` 标记发送、轮询、关闭和超时错误**

把 Invocation POST 与状态检查替换为：

```javascript
    await this._hubTransportRequest(
      `SignalR invoke ${label}`,
      async () =>
        await Network.post(
          session.url,
          this._sessionAuthTextHeaders(session),
          payload,
        ),
    );
```

把 poll GET、204 和状态检查替换为：

```javascript
      const poll = await this._hubTransportRequest(
        `SignalR poll ${label}`,
        async () =>
          await Network.get(
            this._pollUrl(session),
            this._pollHeaders(session),
          ),
      );
```

把 frame type 7 分支替换为：

```javascript
        if (frame.type === 7) {
          throw this._hubTransportError(
            `SignalR 服务端关闭连接${
              frame.error ? `: ${frame.error}` : ""
            }`,
          );
        }
```

把方法末尾的超时改为：

```javascript
    throw this._hubTransportError(
      `等待 SignalR 批量调用返回结果超时（剩余 ${pending.size}/${invocations.length}）`,
    );
```

Completion 中的 `frame.error` 保持原有普通错误，不标记为 transport。

- [ ] **Step 6: 用统一“一次重试预算”替换 `_runHubSession` 并扩展 `_hubCall`**

完整替换两个方法：

```javascript
  /**
   * 串行租用共享 Hub 会话。Unauthorized 总是允许一次认证重试；
   * 只有显式幂等读取允许一次 transport 重试，两类重试共享同一预算。
   */
  async _runHubSession(operationName, operation, options = {}) {
    const authGeneration = this._authGeneration;
    const retryTransport = options.retryTransport === true;
    this._hubIdleGeneration += 1;
    this._hubOperationCount += 1;

    return await this._enqueueHubOperation(async () => {
      let session = null;
      let succeeded = false;
      let retryCount = 0;
      let forceRefresh = false;

      const assertCurrentAuth = () => {
        if (this._authGeneration !== authGeneration) {
          throw new Error("轻书架登录状态已变更，请重试");
        }
      };

      try {
        while (true) {
          try {
            assertCurrentAuth();
            session = null;
            session = await this._ensureSharedHubSession(forceRefresh);
            forceRefresh = false;
            assertCurrentAuth();
            const result = await operation(session);
            assertCurrentAuth();
            succeeded = true;
            return result;
          } catch (error) {
            assertCurrentAuth();
            const unauthorized = this._isUnauthorizedError(error);
            const transport = this._isHubTransportError(error);
            const failedSession = session;

            if (unauthorized || transport) {
              this._discardSharedHubSession(failedSession);
            }
            if (unauthorized) {
              this._clearSessionTokenIfOwned(
                authGeneration,
                failedSession && failedSession.refreshToken,
                failedSession && failedSession.sessionToken,
              );
            }

            const canRetry =
              retryCount === 0 &&
              (unauthorized || (transport && retryTransport));
            if (!canRetry) throw error;

            retryCount += 1;
            forceRefresh = unauthorized;
          }
        }
      } finally {
        this._hubOperationCount -= 1;

        if (
          succeeded &&
          operationName !== "SignIn" &&
          operationName !== "Prewarm"
        ) {
          this._tryAutoSignIn();
        }

        if (
          session &&
          this._sharedHubSession === session &&
          this._hubOperationCount === 0
        ) {
          this._scheduleSharedHubClose(session);
        }
      }
    });
  }

  async _hubCall(target, params, options = {}) {
    return await this._runHubSession(
      target,
      async (session) => await this._hubInvoke(session, target, params),
      options,
    );
  }
```

- [ ] **Step 7: 只为发现页和目录历史调用开启 transport 重试**

将 `_loadComicList` 中调用改为：

```javascript
    const data = await this._hubCall(
      "GetComicList",
      {
        Page: page,
        Size: pageSize,
        Order: order,
      },
      { retryTransport: true },
    );
```

将 `_loadReadingHistory` 中两个调用分别改为：

```javascript
      const history = await this._hubCall(
        "GetReadHistory",
        {},
        { retryTransport: true },
      );
```

```javascript
      const data = await this._hubCall(
        "GetBookListByIds",
        {
          Ids: pageIds,
          Type: "Comic",
        },
        { retryTransport: true },
      );
```

将 `_loadDiscoveryPageRequest` 的 `_runHubSession` 调用结尾改为：

```javascript
      },
      { retryTransport: true },
    );
```

不要为 `GetComicContent`、`SignIn`、`PostComment` 或 `ReplyComment` 增加 `retryTransport`。

- [ ] **Step 8: 运行全部专项测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
/mnt/f/node/node.exe --check \
  'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 14 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 9: 检查重试边界和正式差异**

Run:

```bash
grep -nE '_hubTransportError|retryTransport|GetComicContent|PostComment|ReplyComment' \
  lightnovelshelf.js
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git ls-files --eol lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
```

Expected:

- `retryTransport: true` 只出现在 `GetComicList`、历史列表/详情和发现页 operation；
- 章节与评论写入没有 transport 重试标记；
- CRLF 保持不变；
- 无 whitespace 错误。

- [ ] **Step 10: 只提交 transport 恢复改动**

Run:

```bash
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "fix: 恢复轻书架失效共享会话"
```

Expected: 提交只包含 `lightnovelshelf.js`。

### Task 4: 回归、版本、索引和完整验证

**Files:**
- Modify temporarily: `test/lightnovelshelf-shared-hub-session.test.cjs`
- Modify: `lightnovelshelf.js:1-30`
- Modify: `index.json:204-212`
- Delete: `test/lightnovelshelf-shared-hub-session.test.cjs`

- [ ] **Step 1: 追加队列签到、结构、版本和功能回归测试**

向临时测试文件追加：

```javascript
test("成功业务请求触发的签到排在当前 operation 之后", async () => {
  const { source } = createHarness();
  const session = ownedSession(source, "sign-queue");
  const events = [];
  let signInPromise;

  source._openHub = async () => session;
  source._closeHub = async () => {};
  source._tryAutoSignIn = () => {
    events.push("sign:queued");
    signInPromise = source._runHubSession("SignIn", async () => {
      events.push("sign:start");
      return null;
    });
  };

  await source._runHubSession("LoadDiscovery", async () => {
    events.push("discovery:start");
    events.push("discovery:end");
    return null;
  });
  await spinUntil(() => !!signInPromise);
  await signInPromise;

  assert.deepEqual(events, [
    "discovery:start",
    "discovery:end",
    "sign:queued",
    "sign:start",
  ]);
});

test("发现页、分类和搜索分页结构保持不变", () => {
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
  assert.match(SOURCE_TEXT, /static discoveryPageSize = 12/);
  assert.match(SOURCE_TEXT, /static categoryPageSize = 24/);
  assert.match(SOURCE_TEXT, /Size: 20/);
});

test("账号、搜索、详情、章节、评论、签到和 init 接口仍存在", () => {
  const { source } = createHarness();

  assert.equal(typeof source.init, "function");
  assert.equal(typeof source.account.login, "function");
  assert.equal(typeof source.account.logout, "function");
  assert.equal(typeof source.search.load, "function");
  assert.equal(typeof source.comic.loadInfo, "function");
  assert.equal(typeof source.comic.loadEp, "function");
  assert.equal(typeof source.comic.loadComments, "function");
  assert.equal(typeof source.comic.sendComment, "function");
  assert.equal(typeof source.dailySignIn, "function");
});

test("源和索引版本同步为 0.2.12", () => {
  const { source } = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.12");
  assert.match(SOURCE_TEXT, /版本：0\.2\.12/);
  assert.match(SOURCE_TEXT, /后台预连接/);
  assert.match(SOURCE_TEXT, /15 秒共享 Hub 会话/);
  assert.ok(entry);
  assert.equal(entry.name, "轻书架");
  assert.equal(entry.version, "0.2.12");
  assert.match(entry.description, /后台预连接/);
  assert.match(entry.description, /15 秒/);
});
```

- [ ] **Step 2: 运行测试并确认仅版本测试 RED**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
```

Expected: 前 17 个功能测试 PASS；版本测试因当前仍为 `0.2.11` 而 FAIL。

- [ ] **Step 3: 更新源版本和顶部功能说明**

在 `lightnovelshelf.js` 精确更新：

```javascript
 * 版本：0.2.12
```

```javascript
 * - 后台预连接 / 15 秒共享 Hub 会话 / 单连接批量发现页（12 项）/ 24 项分类分页
 * - 漫画阅读历史 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
```

```javascript
  version = "0.2.12";
```

- [ ] **Step 4: 同步 `index.json`**

将轻书架条目完整替换为：

```json
    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.12",
        "description": "轻书架漫画源，支持邮箱密码登录、每日自动/手动签到、后台预连接、15 秒共享 Hub 会话、单连接批量发现页、24 项分类分页、漫画阅读历史及系列评论与回复"
    }
```

- [ ] **Step 5: 运行全部隔离测试、语法和 JSON 检查**

Run:

```bash
/mnt/f/node/node.exe --test \
  'F:\workspace\venera-configs\test\lightnovelshelf-shared-hub-session.test.cjs'
/mnt/f/node/node.exe --check \
  'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "const fs=require('fs');const index=JSON.parse(fs.readFileSync('F:/workspace/venera-configs/index.json','utf8'));const entry=index.find(x=>x.fileName==='lightnovelshelf.js');if(!entry||entry.version!=='0.2.12')process.exit(1);console.log('version_consistency=PASS')"
```

Expected: 18 个测试全部 PASS；语法检查退出码为 0；输出 `version_consistency=PASS`。

- [ ] **Step 6: 审查敏感信息、调用边界和正式文件差异**

Run:

```bash
if grep -nE 'UI\.showMessage\([^)]*(RefreshToken|sessionToken|visitorId|x-id|password|Authorization)' lightnovelshelf.js; then
  echo 'sensitive UI message found' >&2
  exit 1
fi
grep -nE 'hubIdleTimeoutMs|_sharedHubSession|retryTransport|GetComicContent|PostComment|ReplyComment' \
  lightnovelshelf.js
git diff --name-only origin/main...HEAD
git diff -- lightnovelshelf.js index.json
git ls-files --eol lightnovelshelf.js index.json
```

Expected:

- 没有向 UI 输出认证信息；
- 15 秒空闲复用存在，章节与写入操作没有 transport 自动重放；
- 正式目标文件行尾分别为 CRLF/LF；
- 无关工作区文件没有进入任务提交。

- [ ] **Step 7: 运行版本、whitespace 和 Venera CLI 验证**

Run:

```bash
/mnt/f/node/node.exe scripts/validate-pr-versions.js origin/main
git -c core.whitespace=cr-at-eol diff --check origin/main -- \
  lightnovelshelf.js index.json \
  docs/superpowers/specs/2026-08-30-lightnovelshelf-shared-hub-session-design.md \
  docs/superpowers/plans/2026-08-30-lightnovelshelf-shared-hub-session.md
python3 - <<'PY'
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path('/mnt/f/workspace/venera-configs')
validator = pathlib.Path(
    tempfile.mkdtemp(
        prefix='venera-cli-shared-hub-',
        dir='/mnt/f/workspace',
    )
)
dart = '/mnt/f/flutter-env/flutter/bin/cache/dart-sdk/bin/dart.exe'
source = r'F:\workspace\venera-configs\lightnovelshelf.js'
env = os.environ.copy()
env['PUB_HOSTED_URL'] = 'https://pub.dev'
env['WSLENV'] = 'PUB_HOSTED_URL' + (
    (':' + env['WSLENV']) if env.get('WSLENV') else ''
)

try:
    commands = [
        (
            [
                'git',
                'clone',
                '--depth',
                '1',
                'https://github.com/venera-app/venera_cli.git',
                str(validator),
            ],
            repo,
        ),
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

Expected:

- 版本和 whitespace 检查通过；
- Venera CLI 输出 `Valid LightNovelShelf (轻书架) 0.2.12`；
- 验证不使用用户账号、RefreshToken 或原始日志。

- [ ] **Step 8: 只暂存版本相关正式文件并提交**

Run:

```bash
git add -- lightnovelshelf.js index.json
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "chore: 更新轻书架共享会话版本"
```

Expected: 提交只包含 `lightnovelshelf.js` 与 `index.json`，版本均为 `0.2.12`。

- [ ] **Step 9: 删除临时测试并确认最终工作区**

Run:

```bash
rm -f test/lightnovelshelf-shared-hub-session.test.cjs
rmdir test 2>/dev/null || true
test ! -e test/lightnovelshelf-shared-hub-session.test.cjs
test -z "$(git diff --cached --name-only)"
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected:

- 临时测试已删除、暂存区为空；
- 任务提交包含设计、共享会话基础设施、transport 恢复和版本更新；
- 用户已有的无关未暂存改动保持不变。

- [ ] **Step 10: 记录真实日志验收条件**

实现完成后请用户使用脱敏日志复测：登录状态下打开发现页，并在加载完成后 15 秒内点击任一“查看更多”。验收条件固定为：

```text
refresh_token / negotiate / handshake：整段流程最多各一次
发现页第一阶段：一个 POST 内含两个 GetComicList 和一个 GetReadHistory
历史详情：沿用同一 Hub connection URL
查看更多：沿用同一 Hub connection URL，不出现第二次 negotiate
DELETE：最后一个操作完成约 15 秒后出现一次
```

原始日志中的 RefreshToken、JWT、Cookie 和 Authorization 不得进入仓库、测试输出或提交信息。

## 自审结果

- **规格覆盖：** 后台预热、共享建连 Promise、串行 operation、15 秒代际关闭、认证/API 失效、unauthorized、幂等 transport 重试、写入/章节不重放、自动签到、版本和真实日志验收均有对应步骤。
- **占位符扫描：** 计划未保留待填写代码、模糊错误处理或无实现内容的测试步骤。
- **类型一致：** 最终统一使用 `_runHubSession(operationName, operation, options = {})`、`_hubCall(target, params, options = {})`、`{ retryTransport: true }`、`_hubTransportError` 和 `_sharedHubSession`；测试与实现签名一致。
- **范围检查：** 只修改一个漫画源和索引，不修改 VeneraNext、官方 Flutter App、其他漫画源或封面 URL。
