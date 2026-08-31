# 轻书架注销清理 x-id Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Token 登录和邮箱密码登录在注销时都删除持久化 `visitorId`/x-id，同时保持登录期间的 RefreshToken 刷新和下次登录行为正确。

**Architecture:** 只在 `account.logout` 增加 `deleteData("visitorId")`，不改变 `_invalidateAuthState()`，避免非注销认证切换误删 x-id。邮箱注销后下一次邮箱登录沿用 `_getVisitorId()` 自动生成新值；Token 登录仍保存用户提供的 x-id。

**Tech Stack:** JavaScript ComicSource API、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 注销删除 `visitorId`，版本升级到 `0.2.16`。
- Modify: `index.json` — 轻书架索引版本同步到 `0.2.16`。
- Create temporarily: `test/lightnovelshelf-xid-logout.test.cjs` — 双登录注销、认证失效边界、重新生成 x-id、刷新回归和版本测试；验证后删除。
- Reference: `docs/superpowers/specs/2026-08-31-lightnovelshelf-xid-logout-design.md`。

`README.md` 无需修改：当前文档没有声称注销后保留 x-id。保持正式文件既有行尾，只提交计划列出的正式文件。

### Task 1: 建立 x-id 注销行为测试

**Files:**
- Create temporarily: `test/lightnovelshelf-xid-logout.test.cjs`
- Test: `lightnovelshelf.js`
- Test: `index.json`

- [ ] **Step 1: 创建失败测试**

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_TEXT = fs.readFileSync(
  path.join(ROOT, "lightnovelshelf.js"),
  "utf8",
);

function loginSuccess() {
  return {
    status: 200,
    body: JSON.stringify({
      Success: true,
      Response: {
        RefreshToken: "refresh-new",
        Token: "session-new",
      },
    }),
  };
}

function refreshSuccess() {
  return {
    status: 200,
    body: JSON.stringify({ Success: true, Response: "session-refreshed" }),
  };
}

function createHarness() {
  const calls = { posts: [], uuidCount: 0 };

  class ComicSource {
    constructor() {
      this.__data = {
        settings: {
          apiServer: "https://api.lightnovel.life",
          ignoreJapanese: false,
          ignoreAI: false,
          dailySignInTask: false,
        },
      };
    }

    get isLogged() {
      return this.__data.account !== undefined && this.__data.account !== null;
    }

    loadData(key) {
      return this.__data[key];
    }

    saveData(key, value) {
      this.__data[key] = value;
    }

    deleteData(key) {
      delete this.__data[key];
    }

    loadSetting(key) {
      return this.__data.settings[key];
    }
  }

  const Network = {
    post: async (url, headers, body) => {
      calls.posts.push({ url, headers, body });
      return url.endsWith("/api/user/login")
        ? loginSuccess()
        : refreshSuccess();
    },
    delete: async () => ({ status: 200, body: "" }),
  };

  const Convert = {
    encodeUtf8(value) {
      return Buffer.from(String(value), "utf8");
    },
    sha256(value) {
      return crypto.createHash("sha256").update(Buffer.from(value)).digest();
    },
    hexEncode(value) {
      return Buffer.from(value).toString("hex");
    },
  };

  const sandbox = {
    ComicSource,
    Network,
    Convert,
    UI: {
      showMessage() {},
      async showInputDialog() {
        return null;
      },
    },
    createUuid() {
      calls.uuidCount += 1;
      return "00112233-4455-6677-8899-AABBCCDDEEFF";
    },
    setTimeout() {},
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

  return { source: new sandbox.__LightNovelShelf(), calls };
}

function setAuthenticatedState(source, account) {
  source.saveData("account", account);
  source.saveData("refreshToken", "refresh-old");
  source.saveData("visitorId", "ffeeddccbbaa99887766554433221100");
  source.saveData("lastSignInUtcDate", "2026-08-31");
  source._sessionToken = "session-old";
  source._sessionTokenAt = 123;
  source._sessionTokenGeneration = source._authGeneration;
  source._autoSignInAttemptDate = "2026-08-31";
  source._sharedHubSession = {
    url: "https://api.lightnovel.life/hub/api?id=old",
    sessionToken: "session-old",
  };
}

test("Token 与邮箱登录注销都删除 visitorId/x-id", async (t) => {
  for (const account of ["token", ["reader@example.com", "password"]]) {
    await t.test(Array.isArray(account) ? "email" : "token", () => {
      const { source } = createHarness();
      setAuthenticatedState(source, account);

      source.account.logout();

      assert.equal(source.loadData("account"), undefined);
      assert.equal(source.loadData("refreshToken"), undefined);
      assert.equal(source.loadData("visitorId"), undefined);
      assert.equal(source.loadData("lastSignInUtcDate"), undefined);
      assert.equal(source._sessionToken, "");
      assert.equal(source._sharedHubSession, null);
      assert.equal(source._autoSignInAttemptDate, "");
    });
  }
});

test("普通认证失效不删除 visitorId", () => {
  const { source } = createHarness();
  source.saveData("visitorId", "ffeeddccbbaa99887766554433221100");

  source._invalidateAuthState();

  assert.equal(
    source.loadData("visitorId"),
    "ffeeddccbbaa99887766554433221100",
  );
});

test("邮箱注销后再次登录生成新的 x-id", async () => {
  const { source, calls } = createHarness();
  setAuthenticatedState(source, ["old@example.com", "old-password"]);

  source.account.logout();
  assert.equal(source.loadData("visitorId"), undefined);

  assert.equal(
    await source.account.login("new@example.com", "new-password"),
    "new@example.com",
  );
  assert.equal(calls.uuidCount, 1);
  assert.equal(
    source.loadData("visitorId"),
    "00112233445566778899aabbccddeeff",
  );
  assert.equal(
    calls.posts[0].headers["x-id"],
    "00112233445566778899aabbccddeeff",
  );
});

test("未注销的 RefreshToken 刷新继续复用 visitorId", async () => {
  const { source, calls } = createHarness();
  source.saveData("account", "token");
  source.saveData("refreshToken", "refresh-current");
  source.saveData("visitorId", "ffeeddccbbaa99887766554433221100");

  assert.equal(await source._refreshSessionToken(true), "session-refreshed");
  assert.equal(calls.uuidCount, 0);
  assert.equal(
    calls.posts[0].headers["x-id"],
    "ffeeddccbbaa99887766554433221100",
  );
});

test("源和索引版本同步为 0.2.16", () => {
  const { source } = createHarness();
  const index = JSON.parse(
    fs.readFileSync(path.join(ROOT, "index.json"), "utf8"),
  );
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.16");
  assert.match(SOURCE_TEXT, /版本：0\.2\.16/);
  assert.ok(entry);
  assert.equal(entry.version, "0.2.16");
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test test/lightnovelshelf-xid-logout.test.cjs
```

Expected: 注销测试失败，因为当前 `account.logout` 仍保留 `visitorId`；版本测试失败，因为当前版本是 `0.2.15`。认证失效和刷新边界测试应通过。

### Task 2: 实现注销清理并发布 0.2.16

**Files:**
- Modify: `lightnovelshelf.js:1-35`
- Modify: `lightnovelshelf.js:1865-1877`
- Modify: `index.json:205-211`
- Test: `test/lightnovelshelf-xid-logout.test.cjs`

- [ ] **Step 1: 注销时删除 visitorId**

把 `account.logout` 改为：

```javascript
    logout: () => {
      this.deleteData("account");
      this.deleteData("refreshToken");
      this.deleteData("visitorId");
      this.deleteData("lastSignInUtcDate");
      this._autoSignInAttemptDate = "";
      this._invalidateAuthState();
    },
```

不修改 `_invalidateAuthState()`。

- [ ] **Step 2: 升级源版本**

把顶部版本和类字段同步为：

```javascript
 * 版本：0.2.16
```

```javascript
  version = "0.2.16";
```

其他登录说明保持不变。

- [ ] **Step 3: 同步索引版本**

把轻书架条目的版本改为：

```json
        "version": "0.2.16",
```

描述保持不变。

- [ ] **Step 4: 运行专项测试和语法检查**

Run:

```bash
node --test test/lightnovelshelf-xid-logout.test.cjs
node --check lightnovelshelf.js
node scripts/validate-pr-versions.js origin/main
```

Expected: 专项测试全部 PASS；语法检查通过；版本脚本输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 5: 提交实现**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js index.json
git add -- lightnovelshelf.js index.json
git commit -m "fix: clear x-id on lightnovelshelf logout"
```

Expected: 提交只包含注销清理和 `0.2.16` 版本同步。

### Task 3: 完整验证与清理

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Delete: `test/lightnovelshelf-xid-logout.test.cjs`

- [ ] **Step 1: 运行专项及非过期 Hub 回归**

```bash
node --test test/lightnovelshelf-xid-logout.test.cjs
node --test --test-skip-pattern="不确定的章节 transport|发表评论 transport|源和索引版本" cache/plan-tests.cjs
node --check lightnovelshelf.js
```

Expected: x-id 专项全部 PASS；非过期 Hub 回归 15/15 PASS；语法检查通过。三个已知过期缓存断言继续按已批准基线排除。

- [ ] **Step 2: 验证 Venera CLI**

在临时 `venera_cli` 克隆中设置 `PUB_HOSTED_URL=https://pub.dev` 和 `HOME` 后运行：

```bash
dart run bin/venera.dart source validate F:/workspace/venera-configs/lightnovelshelf.js
```

Expected: `Valid LightNovelShelf (轻书架) 0.2.16`。

- [ ] **Step 3: 删除临时文件并确认状态**

```bash
rm -rf test cache/venera_cli_validator
git status --short
git log -5 --oneline
```

Expected: 临时文件删除，工作区干净，提交保留在本地 `main` 且未推送。
