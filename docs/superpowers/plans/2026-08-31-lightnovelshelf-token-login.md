# 轻书架 Token 登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留轻书架邮箱密码登录，并允许用户在源设置中填写 RefreshToken 与 x-id，经服务端验证后直接建立 Venera 登录状态。

**Architecture:** 新增候选凭据校验与原子认证提交路径；Token 登录和正常会话刷新共用无状态的 RefreshToken 换取方法，只有验证成功且认证代际未变化时才替换当前账号。Token 输入通过设置 callback 提交，成功后清空；邮箱密码 `account.login`、SignalR 和内容接口保持原有契约。

**Tech Stack:** JavaScript ComicSource API、Venera `Network`/`UI`/源数据桥、Node.js `vm`/`node:test`、ASP.NET Core API envelope、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — x-id 规范化、无状态 RefreshToken 换取、Token 登录原子提交、设置入口、退出清理、版本与顶部说明。
- Modify: `index.json` — 同步 `0.2.14` 和双登录方式说明。
- Modify: `README.md` — 记录邮箱密码登录与 Token 登录步骤、设置项和敏感输入清理。
- Create temporarily: `test/lightnovelshelf-token-login.test.cjs` — 隔离式 Token 登录、错误原子性、并发、邮箱登录和刷新回归；验证后删除。
- Reference: `docs/superpowers/specs/2026-08-31-lightnovelshelf-token-login-design.md` — 已批准设计。
- Reference only: `cache/Venera-Next/lib/features/comic_source/js_bridge.dart`、`source.dart`、`comic_source_page.dart` — `account` 登录状态与设置 callback 行为依据。

保持 `lightnovelshelf.js` 的 CRLF、`index.json` 和 `README.md` 的既有行尾。只修改并提交本计划列出的正式文件，不处理相邻代码或其他工作区差异。

### Task 1: 建立 Token 登录行为测试

**Files:**
- Create temporarily: `test/lightnovelshelf-token-login.test.cjs`
- Test: `lightnovelshelf.js`
- Test: `index.json`
- Test: `README.md`

- [ ] **Step 1: 记录起点与行尾**

Run:

```bash
git status --short
git ls-files --eol lightnovelshelf.js index.json README.md
node --check lightnovelshelf.js
```

Expected: 除已提交的设计规格外没有未提交修改；JavaScript 语法检查退出码 0；后续编辑不得造成整文件行尾改写。

- [ ] **Step 2: 写入完整失败测试**

创建 `test/lightnovelshelf-token-login.test.cjs`：

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "lightnovelshelf.js");
const INDEX_PATH = path.join(ROOT, "index.json");
const README_PATH = path.join(ROOT, "README.md");
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function refreshSuccess(token = "session-new") {
  return {
    status: 200,
    body: JSON.stringify({
      Success: true,
      Response: token,
      Status: 200,
      Msg: "",
    }),
  };
}

function loginSuccess() {
  return {
    status: 200,
    body: JSON.stringify({
      Success: true,
      Response: {
        RefreshToken: "refresh-from-email",
        Token: "session-from-email",
      },
      Status: 200,
      Msg: "",
    }),
  };
}

function createHarness(options = {}) {
  const calls = { posts: [], deletes: [], messages: [] };

  class ComicSource {
    constructor() {
      this.__data = {
        settings: {
          apiServer: "https://api.lightnovel.life",
          ignoreJapanese: false,
          ignoreAI: false,
          dailySignInTask: false,
          tokenRefreshToken: "",
          tokenVisitorId: "",
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

    setSetting(key, value) {
      this.__data.settings[key] = value;
    }
  }

  const Network = {
    post: async (url, headers, body) => {
      const call = { url, headers, body };
      calls.posts.push(call);
      if (typeof options.postResponse === "function") {
        return await options.postResponse(call);
      }
      if (url.endsWith("/api/user/login")) return loginSuccess();
      return options.postResponse || refreshSuccess();
    },
    delete: async (url, headers) => {
      calls.deletes.push({ url, headers });
      return { status: 200, body: "" };
    },
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
      showMessage(message) {
        calls.messages.push(String(message));
      },
    },
    createUuid() {
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

function setOldAuth(source) {
  source.saveData("account", ["reader@example.com", "password"]);
  source.saveData("refreshToken", "refresh-old");
  source.saveData("visitorId", "ffeeddccbbaa99887766554433221100");
  source.saveData("lastSignInUtcDate", "2026-08-31");
  source._sessionToken = "session-old";
  source._sessionTokenAt = 123;
  source._sessionTokenGeneration = source._authGeneration;
  source._autoSignInAttemptDate = "2026-08-31";
}

function authSnapshot(source) {
  return {
    account: source.loadData("account"),
    refreshToken: source.loadData("refreshToken"),
    visitorId: source.loadData("visitorId"),
    lastSignInUtcDate: source.loadData("lastSignInUtcDate"),
    sessionToken: source._sessionToken,
    sessionTokenAt: source._sessionTokenAt,
    sessionTokenGeneration: source._sessionTokenGeneration,
    authGeneration: source._authGeneration,
    autoSignInAttemptDate: source._autoSignInAttemptDate,
  };
}

test("同时提供邮箱密码和 Token 登录入口", () => {
  const { source } = createHarness();

  assert.equal(typeof source.account.login, "function");
  assert.equal(source.settings.tokenRefreshToken.title, "RefreshToken");
  assert.equal(source.settings.tokenRefreshToken.type, "input");
  assert.equal(source.settings.tokenVisitorId.title, "x-id");
  assert.equal(source.settings.tokenVisitorId.type, "input");
  assert.equal(source.settings.tokenLogin.type, "callback");
  assert.equal(source.settings.tokenLogin.buttonText, "登录");
});

test("有效 RefreshToken 和 x-id 原子提交登录并清空输入", async () => {
  const { source, calls } = createHarness();
  setOldAuth(source);
  source.setSetting("tokenRefreshToken", "  refresh-new  ");
  source.setSetting(
    "tokenVisitorId",
    "00112233-4455-6677-8899-AABBCCDDEEFF",
  );
  source._sharedHubSession = {
    url: "https://api.lightnovel.life/hub/api?id=old",
    sessionToken: "session-old",
  };

  assert.equal(await source.settings.tokenLogin.callback(), "ok");

  assert.equal(calls.posts.length, 1);
  assert.equal(
    calls.posts[0].url,
    "https://api.lightnovel.life/api/user/refresh_token",
  );
  assert.equal(
    calls.posts[0].headers["x-id"],
    "00112233445566778899aabbccddeeff",
  );
  assert.deepEqual(JSON.parse(calls.posts[0].body), { token: "refresh-new" });
  assert.equal(source.loadData("refreshToken"), "refresh-new");
  assert.equal(
    source.loadData("visitorId"),
    "00112233445566778899aabbccddeeff",
  );
  assert.equal(source.loadData("account"), "token");
  assert.equal(source.isLogged, true);
  assert.equal(source._sessionToken, "session-new");
  assert.equal(source._sessionTokenGeneration, source._authGeneration);
  assert.ok(source._sessionTokenAt > 0);
  assert.equal(source._sharedHubSession, null);
  assert.equal(source.loadData("lastSignInUtcDate"), undefined);
  assert.equal(source._autoSignInAttemptDate, "");
  assert.equal(source.loadSetting("tokenRefreshToken"), "");
  assert.equal(source.loadSetting("tokenVisitorId"), "");
  assert.deepEqual(calls.messages, ["Token 登录成功"]);

  assert.equal(await source._refreshSessionToken(false), "session-new");
  assert.equal(calls.posts.length, 1, "fresh session token should be reused");
});

test("空输入和无效 x-id 在网络请求前失败且保留旧登录", async () => {
  const cases = [
    ["   ", "00112233445566778899aabbccddeeff"],
    ["refresh-new", "not-an-x-id"],
  ];

  for (const [refreshToken, visitorId] of cases) {
    const { source, calls } = createHarness();
    setOldAuth(source);
    source.setSetting("tokenRefreshToken", refreshToken);
    source.setSetting("tokenVisitorId", visitorId);
    const before = authSnapshot(source);

    assert.equal(await source.settings.tokenLogin.callback(), null);
    assert.deepEqual(authSnapshot(source), before);
    assert.equal(calls.posts.length, 0);
    assert.equal(source.loadSetting("tokenRefreshToken"), refreshToken);
    assert.equal(source.loadSetting("tokenVisitorId"), visitorId);
    assert.match(calls.messages.at(-1), /Token 登录失败/);
  }
});

test("服务端错误不覆盖旧认证且消息不泄露敏感值", async (t) => {
  const refreshToken = "refresh-secret-do-not-show";
  const visitorId = "00112233445566778899aabbccddeeff";
  const scenarios = [
    { name: "network", response: async () => { throw new Error(refreshToken); } },
    { name: "http", response: { status: 401, body: refreshToken } },
    { name: "json", response: { status: 200, body: refreshToken } },
    {
      name: "api",
      response: {
        status: 200,
        body: JSON.stringify({
          Success: false,
          Status: 401,
          Msg: refreshToken,
        }),
      },
    },
    {
      name: "missing token",
      response: {
        status: 200,
        body: JSON.stringify({ Success: true, Response: {} }),
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { source, calls } = createHarness({
        postResponse:
          typeof scenario.response === "function"
            ? scenario.response
            : async () => scenario.response,
      });
      setOldAuth(source);
      source.setSetting("tokenRefreshToken", refreshToken);
      source.setSetting("tokenVisitorId", visitorId);
      const before = authSnapshot(source);

      assert.equal(await source.settings.tokenLogin.callback(), null);
      assert.deepEqual(authSnapshot(source), before);
      assert.equal(source.loadSetting("tokenRefreshToken"), refreshToken);
      assert.equal(source.loadSetting("tokenVisitorId"), visitorId);
      assert.match(calls.messages.at(-1), /Token 登录失败/);
      assert.equal(calls.messages.at(-1).includes(refreshToken), false);
      assert.equal(calls.messages.at(-1).includes(visitorId), false);
    });
  }
});

test("校验期间退出账号使旧 Token 响应失效", async () => {
  const gate = deferred();
  const { source, calls } = createHarness({
    postResponse: async () => await gate.promise,
  });
  setOldAuth(source);
  source.setSetting("tokenRefreshToken", "refresh-new");
  source.setSetting("tokenVisitorId", "00112233445566778899aabbccddeeff");

  const pending = source.settings.tokenLogin.callback();
  while (calls.posts.length === 0) await Promise.resolve();
  source.account.logout();
  gate.resolve(refreshSuccess("session-stale"));

  assert.equal(await pending, null);
  assert.equal(source.loadData("account"), undefined);
  assert.equal(source.loadData("refreshToken"), undefined);
  assert.equal(source._sessionToken, "");
  assert.notEqual(source._sessionToken, "session-stale");
  assert.match(calls.messages.at(-1), /Token 登录失败/);
});

test("退出 Token 登录清理账号和敏感输入但保留 x-id", () => {
  const { source } = createHarness();
  setOldAuth(source);
  source.saveData("account", "token");
  source.setSetting("tokenRefreshToken", "leftover-refresh");
  source.setSetting("tokenVisitorId", "leftover-id");

  source.account.logout();

  assert.equal(source.loadData("account"), undefined);
  assert.equal(source.loadData("refreshToken"), undefined);
  assert.equal(source.loadData("lastSignInUtcDate"), undefined);
  assert.equal(
    source.loadData("visitorId"),
    "ffeeddccbbaa99887766554433221100",
  );
  assert.equal(source.loadSetting("tokenRefreshToken"), "");
  assert.equal(source.loadSetting("tokenVisitorId"), "");
  assert.equal(source._sessionToken, "");
});

test("邮箱密码登录与普通 RefreshToken 刷新保持可用", async () => {
  const { source, calls } = createHarness();

  assert.equal(
    await source.account.login("  reader@example.com  ", "password"),
    "reader@example.com",
  );
  assert.equal(source.loadData("refreshToken"), "refresh-from-email");
  assert.equal(source._sessionToken, "session-from-email");
  assert.equal(calls.posts[0].url.endsWith("/api/user/login"), true);

  source._sessionTokenAt = 0;
  assert.equal(await source._refreshSessionToken(true), "session-new");
  assert.equal(calls.posts[1].url.endsWith("/api/user/refresh_token"), true);
});

test("版本、索引与 README 同步说明双登录方式", () => {
  const { source } = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const readme = fs.readFileSync(README_PATH, "utf8");
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.14");
  assert.match(SOURCE_TEXT, /版本：0\.2\.14/);
  assert.ok(entry);
  assert.equal(entry.version, "0.2.14");
  assert.match(entry.description, /邮箱密码.*Token 登录/);
  assert.match(readme, /RefreshToken/);
  assert.match(readme, /x-id/);
  assert.match(readme, /Token 登录/);
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
node --test test/lightnovelshelf-token-login.test.cjs
```

Expected: FAIL；当前源没有 `settings.tokenRefreshToken`、`settings.tokenVisitorId`、`settings.tokenLogin`，版本仍为 `0.2.13`。

### Task 2: 实现候选 Token 校验与原子提交

**Files:**
- Modify: `lightnovelshelf.js:328-651`
- Modify: `lightnovelshelf.js:1791-1802`
- Modify: `lightnovelshelf.js:2347-2388`
- Test: `test/lightnovelshelf-token-login.test.cjs`

- [ ] **Step 1: 提取统一 x-id 规范化**

在 `_getVisitorId` 前新增规范化方法，并把 `_getVisitorId` 完整替换为：

```javascript
  _normalizeVisitorId(value) {
    return String(value == null ? "" : value)
      .trim()
      .replace(/-/g, "")
      .toLowerCase();
  }

  _getVisitorId() {
    const saved = this.loadData("visitorId");
    const normalizedSaved = this._normalizeVisitorId(saved);

    if (/^[0-9a-f]{32}$/.test(normalizedSaved)) {
      if (saved !== normalizedSaved) {
        this.saveData("visitorId", normalizedSaved);
      }
      return normalizedSaved;
    }

    const generated = this._normalizeVisitorId(createUuid());

    if (!/^[0-9a-f]{32}$/.test(generated)) {
      throw new Error("生成轻书架设备标识失败");
    }

    this.saveData("visitorId", generated);
    return generated;
  }
```

- [ ] **Step 2: 增加无状态 RefreshToken 换取方法**

在 `_login` 后、`_refreshSessionToken` 前新增：

```javascript
  async _requestSessionToken(refreshToken, visitorId, action) {
    let res;
    try {
      res = await Network.post(
        this.apiBase + "/api/user/refresh_token",
        this._jsonHeaders({
          "x-id": visitorId,
        }),
        JSON.stringify({
          token: refreshToken,
        }),
      );
    } catch (_) {
      throw new Error(`${action}失败：网络请求失败`);
    }

    if (!res || res.status !== 200) {
      const status = res && res.status !== undefined ? res.status : "未知";
      throw new Error(`${action}失败: HTTP ${status}`);
    }

    let envelope;
    try {
      envelope = JSON.parse(res.body);
    } catch (_) {
      throw new Error(`${action}失败：服务器返回了无效 JSON`);
    }

    if (
      envelope &&
      typeof envelope === "object" &&
      Object.prototype.hasOwnProperty.call(envelope, "Success")
    ) {
      if (!envelope.Success) {
        const status =
          envelope.Status !== undefined ? ` [${envelope.Status}]` : "";
        const message =
          typeof envelope.Msg === "string" && envelope.Msg.trim()
            ? `: ${envelope.Msg.trim()}`
            : "";
        throw new Error(`${action}失败${status}${message}`);
      }
      envelope = envelope.Response;
    }

    let token = envelope;
    if (token && typeof token === "object") {
      token =
        token.Token || token.token || token.AccessToken || token.accessToken;
    }

    if (typeof token !== "string" || !token.trim()) {
      throw new Error(`${action}失败：响应中没有可用的会话 Token`);
    }

    return token.trim();
  }
```

该方法不得读取或写入源认证状态，不得把响应 body 拼入错误。

- [ ] **Step 3: 让普通刷新复用无状态方法**

保留 `_refreshSessionToken` 的共享 Promise、15 秒缓存和认证代际外壳，把 `refreshPromise` 的主体替换为：

```javascript
    refreshPromise = (async () => {
      const assertCurrentAuth = () => {
        if (!this._authStateMatches(authGeneration, refreshToken)) {
          throw new Error("轻书架登录状态已变更，刷新结果已失效");
        }
      };

      try {
        const token = await this._requestSessionToken(
          refreshToken,
          visitorId,
          "刷新轻书架登录状态",
        );
        assertCurrentAuth();
        this._sessionToken = token;
        this._sessionTokenAt = Date.now();
        this._sessionTokenGeneration = authGeneration;
        return token;
      } catch (error) {
        assertCurrentAuth();
        this._clearSessionTokenIfOwned(
          authGeneration,
          refreshToken,
          ownedSessionToken,
        );
        const detail = String(
          error && error.message ? error.message : error || "未知错误",
        ).replace(/[。.]+$/, "");
        throw new Error(`${detail}。请在 Venera 中重新登录。`);
      }
    })();
```

删除原主体中的重复 POST、JSON 解包和 Token 提取代码；`url` 局部变量同时删除。

- [ ] **Step 4: 实现 Token 登录和敏感设置清理**

在 `_requestSessionToken` 后新增：

```javascript
  _clearTokenLoginSettings() {
    const settings = this.loadData("settings");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return;
    }

    const hasRefreshToken = Object.prototype.hasOwnProperty.call(
      settings,
      "tokenRefreshToken",
    );
    const hasVisitorId = Object.prototype.hasOwnProperty.call(
      settings,
      "tokenVisitorId",
    );
    if (!hasRefreshToken && !hasVisitorId) return;

    const cleared = Object.assign({}, settings);
    cleared.tokenRefreshToken = "";
    cleared.tokenVisitorId = "";
    this.saveData("settings", cleared);
  }

  async _loginWithToken(refreshTokenValue, visitorIdValue) {
    const refreshToken = String(
      refreshTokenValue == null ? "" : refreshTokenValue,
    ).trim();
    const visitorId = this._normalizeVisitorId(visitorIdValue);

    if (!refreshToken) {
      throw new Error("轻书架 Token 登录失败：RefreshToken 不能为空");
    }
    if (!/^[0-9a-f]{32}$/.test(visitorId)) {
      throw new Error("轻书架 Token 登录失败：x-id 必须为 32 位十六进制字符串");
    }

    const authGeneration = this._authGeneration;
    const sessionToken = await this._requestSessionToken(
      refreshToken,
      visitorId,
      "轻书架 Token 登录",
    );

    if (authGeneration !== this._authGeneration) {
      throw new Error("轻书架 Token 登录请求已失效");
    }

    const committedGeneration = this._invalidateAuthState();
    this.saveData("visitorId", visitorId);
    this.saveData("refreshToken", refreshToken);
    this.deleteData("lastSignInUtcDate");
    this._autoSignInAttemptDate = "";
    this._sessionToken = sessionToken;
    this._sessionTokenAt = Date.now();
    this._sessionTokenGeneration = committedGeneration;
    this.saveData("account", "token");
    this._clearTokenLoginSettings();
    return "ok";
  }

  async _loginWithTokenSettings() {
    try {
      const result = await this._loginWithToken(
        this.loadSetting("tokenRefreshToken"),
        this.loadSetting("tokenVisitorId"),
      );
      UI.showMessage("Token 登录成功");
      return result;
    } catch (_) {
      UI.showMessage("Token 登录失败，请检查 RefreshToken 和 x-id");
      return null;
    }
  }
```

未知网络异常和服务器消息不会直接显示，避免泄露候选 Token 或 x-id。

- [ ] **Step 5: 接入设置和退出清理**

把 `account.logout` 调整为：

```javascript
    logout: () => {
      this.deleteData("account");
      this.deleteData("refreshToken");
      this.deleteData("lastSignInUtcDate");
      this._clearTokenLoginSettings();
      this._autoSignInAttemptDate = "";
      this._invalidateAuthState();
    },
```

在 `settings` 的 `apiServer` 前新增：

```javascript
    tokenRefreshToken: {
      title: "RefreshToken",
      type: "input",
      validator: null,
      default: "",
    },

    tokenVisitorId: {
      title: "x-id",
      type: "input",
      validator: null,
      default: "",
    },

    tokenLogin: {
      title: "Token 登录",
      type: "callback",
      buttonText: "登录",
      callback: async () => await this._loginWithTokenSettings(),
    },
```

- [ ] **Step 6: 运行认证测试并确认实现 GREEN**

Run:

```bash
node --test --test-name-pattern="Token|x-id|邮箱密码|退出" test/lightnovelshelf-token-login.test.cjs
node --check lightnovelshelf.js
```

Expected: Token 成功、输入错误、服务端错误、并发退出、退出清理、邮箱登录和刷新测试 PASS；只有版本/文档测试仍因 `0.2.13` 失败或被过滤。

- [ ] **Step 7: 提交认证实现**

Run:

```bash
git diff --check -- lightnovelshelf.js
git add -- lightnovelshelf.js
git diff --cached --name-status
git commit -m "feat: add lightnovelshelf token login"
```

Expected: 提交只包含 `lightnovelshelf.js` 的认证方法、账号退出和设置入口；无整文件格式化。

### Task 3: 同步版本与用户说明

**Files:**
- Modify: `lightnovelshelf.js:1-35`
- Modify: `index.json:205-211`
- Modify: `README.md:1-52`
- Test: `test/lightnovelshelf-token-login.test.cjs`

- [ ] **Step 1: 更新源顶部说明与版本**

将文件头的版本改为 `0.2.14`，把认证能力写为：

```javascript
 * - 邮箱密码 / RefreshToken+x-id 登录并自动管理认证令牌
```

把“使用前”改为：

```javascript
 * 使用前：
 * 1. 邮箱登录：在 Venera 账号区域输入轻书架邮箱和密码。
 * 2. Token 登录：在源设置中填入 RefreshToken 和 x-id，点击“Token 登录”。
 * 3. Token 登录成功后，设置中的两个敏感输入会自动清空。
```

同步类字段：

```javascript
  version = "0.2.14";
```

- [ ] **Step 2: 更新索引元数据**

把轻书架索引条目改为：

```json
    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.14",
        "description": "轻书架漫画源，支持邮箱密码与 RefreshToken+x-id Token 登录、每日自动/手动签到、后台预连接、15 秒共享 Hub 会话、单连接批量发现页、24 项分类分页、漫画阅读历史及系列评论与回复"
    }
```

- [ ] **Step 3: 更新 README 登录和设置说明**

将账号能力改为：

```markdown
### 账号

- 支持轻书架注册邮箱和密码登录。
- 支持填写 RefreshToken 和 x-id 直接进行 Token 登录。
- 支持每日自动签到和手动签到。
```

将首次使用步骤中的登录部分改为：

```markdown
2. 选择一种登录方式：
   - 邮箱登录：打开账号登录，输入轻书架注册邮箱和密码。
   - Token 登录：在源设置中填写 `RefreshToken` 和 `x-id`，点击“Token 登录”。
3. Token 登录成功后，源会自动清空设置中的 `RefreshToken` 和 `x-id` 输入；认证数据仍保存在 Venera 源数据中供后续刷新使用。
```

在设置表中新增：

```markdown
| RefreshToken | Token 登录使用的长期令牌；成功后自动清空输入 | 空 |
| x-id | Token 登录使用的设备标识；成功后自动清空输入 | 空 |
| Token 登录 | 校验并保存 RefreshToken 与 x-id | 按需使用 |
```

- [ ] **Step 4: 运行完整专项测试并确认 GREEN**

Run:

```bash
node --test test/lightnovelshelf-token-login.test.cjs
node --check lightnovelshelf.js
node -e "JSON.parse(require('fs').readFileSync('index.json','utf8'));console.log('index_json=PASS')"
```

Expected: 所有测试 PASS；语法检查退出码 0；输出 `index_json=PASS`。

- [ ] **Step 5: 提交版本和文档**

Run:

```bash
git diff --check -- lightnovelshelf.js index.json README.md
git add -- lightnovelshelf.js index.json README.md
git diff --cached --name-status
git commit -m "docs: publish lightnovelshelf token login"
```

Expected: 提交仅包含三份正式文件的版本和用户说明变化。

### Task 4: 验证、审查与临时文件清理

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Verify: `README.md`
- Delete: `test/lightnovelshelf-token-login.test.cjs`

- [ ] **Step 1: 运行专项、语法和现有 Hub 回归**

Run:

```bash
node --test test/lightnovelshelf-token-login.test.cjs
node --test cache/plan-tests.cjs
node --check lightnovelshelf.js
node scripts/validate-pr-versions.js origin/main
```

Expected: 两组 Node 测试全部 PASS；语法检查退出码 0；版本脚本输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 2: 检查设置、版本和敏感信息边界**

Run:

```bash
rg -n "tokenRefreshToken|tokenVisitorId|tokenLogin|version = \"0.2.14\"" lightnovelshelf.js
rg -n "0.2.14|RefreshToken|x-id|Token 登录" index.json README.md
rg -n "console\.(log|error).*?(refreshToken|visitorId|sessionToken)|JSON\.stringify\([^)]*settings" lightnovelshelf.js
```

Expected: 第一、二条命令命中预期入口与说明；第三条命令无匹配，不存在敏感认证日志。

- [ ] **Step 3: 使用 Venera CLI 解析验证源**

在 PowerShell 中运行：

```powershell
$validator = Join-Path $env:TEMP "venera-cli-token-login"
Remove-Item -Recurse -Force $validator -ErrorAction SilentlyContinue
git clone --depth 1 https://github.com/venera-app/venera_cli.git $validator
Push-Location $validator
try {
    dart pub get
    dart run bin/venera.dart source validate "F:\workspace\venera-configs\lightnovelshelf.js"
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $validator -ErrorAction SilentlyContinue
}
```

Expected: 输出 `Valid LightNovelShelf (轻书架) 0.2.14`，退出码 0；命令和日志中不出现真实 RefreshToken 或 x-id。

- [ ] **Step 4: 针对差异做安全与并发审查**

逐项确认：

- 候选凭据验证前没有调用 `_invalidateAuthState` 或写持久化数据；
- `_requestSessionToken` 不依赖当前账号且不输出响应 body；
- Token 登录提交前检查起始认证代际；
- 提交后短期 Token 的 generation 等于新认证代际；
- callback 捕获所有错误且消息不拼接异常内容；
- 退出清理 `account`、RefreshToken、签到状态和敏感设置，但保留 `visitorId`；
- 现有邮箱登录、刷新共享 Promise 和 Hub 逻辑没有第二套实现。

发现问题时先在临时测试中增加可复现断言，再做最小修复并重跑 Task 4 Step 1-3；没有问题时不创建空提交。

- [ ] **Step 5: 删除临时测试并确认交付状态**

Run:

```bash
rm test/lightnovelshelf-token-login.test.cjs
git status --short
git log --oneline -4
```

Expected: 临时测试不存在且未被提交；工作区没有本功能遗留修改；最近提交包含设计规格、认证实现和版本/文档更新。
