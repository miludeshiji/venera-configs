# 轻书架 Token 登录弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除可见的 RefreshToken/x-id 设置输入，改为紧邻邮箱登录上方的 Token 登录按钮和单行分隔输入弹窗，并保证两种登录方式都能完整注销。

**Architecture:** `tokenLogin` 作为最后一个 setting，利用 Venera“设置在前、账号在后”的固定渲染顺序定位。弹窗文本由纯解析方法按五种分隔符拆成 RefreshToken/x-id，再复用已有 Token 服务端校验与原子提交；注销继续统一删除 account 和所有认证状态。

**Tech Stack:** JavaScript ComicSource API、Venera `UI.showInputDialog`/源数据桥、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 单行输入解析、弹窗登录、设置删除与排序、注销清理、`0.2.15` 元数据。
- Modify: `index.json` — 同步 `0.2.15`。
- Modify: `README.md` — 改为弹窗分隔输入说明，删除两个输入设置行。
- Create temporarily: `test/lightnovelshelf-token-login-dialog.test.cjs` — 弹窗、五种分隔符、取消、位置、双模式注销和回归测试；验证后删除。
- Reference: `docs/superpowers/specs/2026-08-31-lightnovelshelf-token-login-dialog-design.md`。
- Reference only: `cache/Venera-Next/lib/features/comic_source/comic_source_page.dart`、`lib/components/js_ui.dart`、`lib/components/message.dart` — 设置/账号渲染顺序和单行弹窗依据。

保持正式文件既有行尾。只修改本计划列出的正式文件，不修改 Venera 缓存源码或其他漫画源。

### Task 1: 建立弹窗登录失败测试

**Files:**
- Create temporarily: `test/lightnovelshelf-token-login-dialog.test.cjs`
- Test: `lightnovelshelf.js`
- Test: `index.json`
- Test: `README.md`

- [ ] **Step 1: 创建完整专项测试**

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_TEXT = fs.readFileSync(path.join(ROOT, "lightnovelshelf.js"), "utf8");
const FORMAT_ERROR =
  "请输入 RefreshToken 和 x-id，并用 ， , ； ; 或 | 分隔";

function refreshSuccess(token = "session-new") {
  return {
    status: 200,
    body: JSON.stringify({ Success: true, Response: token }),
  };
}

function loginSuccess() {
  return {
    status: 200,
    body: JSON.stringify({
      Success: true,
      Response: {
        RefreshToken: "refresh-email",
        Token: "session-email",
      },
    }),
  };
}

function createHarness(options = {}) {
  const calls = { posts: [], dialogs: [], messages: [], deletes: [] };

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
      const call = { url, headers, body };
      calls.posts.push(call);
      if (typeof options.postResponse === "function") {
        return await options.postResponse(call);
      }
      return url.endsWith("/api/user/login")
        ? loginSuccess()
        : refreshSuccess();
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

  const UI = {
    async showInputDialog(title, validator) {
      calls.dialogs.push({ title, validator });
      return options.dialogValue === undefined ? null : options.dialogValue;
    },
    showMessage(message) {
      calls.messages.push(String(message));
    },
  };

  const sandbox = {
    ComicSource,
    Network,
    Convert,
    UI,
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

test("Token 登录是最后一个设置且不再暴露两个输入设置", () => {
  const { source } = createHarness();
  const keys = Object.keys(source.settings);

  assert.equal(source.settings.tokenRefreshToken, undefined);
  assert.equal(source.settings.tokenVisitorId, undefined);
  assert.equal(keys.at(-1), "tokenLogin");
  assert.equal(source.settings.tokenLogin.type, "callback");
  assert.equal(typeof source.account.login, "function");
});

test("五种分隔符都通过单个弹窗完成 Token 登录", async (t) => {
  for (const separator of ["，", ",", "；", ";", "|"]) {
    await t.test(separator, async () => {
      const { source, calls } = createHarness({
        dialogValue:
          `  refresh-new  ${separator}  ` +
          "00112233-4455-6677-8899-AABBCCDDEEFF  ",
      });

      assert.equal(await source.settings.tokenLogin.callback(), "ok");
      assert.equal(calls.dialogs.length, 1);
      assert.match(calls.dialogs[0].title, /RefreshToken\|x-id/);
      assert.equal(calls.dialogs[0].validator("refresh-new"), FORMAT_ERROR);
      assert.equal(
        calls.dialogs[0].validator(
          `refresh-new${separator}00112233445566778899aabbccddeeff`,
        ),
        null,
      );
      assert.equal(calls.posts.length, 1);
      assert.deepEqual(JSON.parse(calls.posts[0].body), {
        token: "refresh-new",
      });
      assert.equal(
        calls.posts[0].headers["x-id"],
        "00112233445566778899aabbccddeeff",
      );
      assert.equal(source.loadData("account"), "token");
      assert.equal(source.loadData("refreshToken"), "refresh-new");
      assert.equal(source._sessionToken, "session-new");
      assert.deepEqual(calls.messages, ["Token 登录成功"]);
      assert.deepEqual(source.loadData("settings"), {
        apiServer: "https://api.lightnovel.life",
        ignoreJapanese: false,
        ignoreAI: false,
        dailySignInTask: false,
      });
    });
  }
});

test("格式解析拒绝缺失、多余分隔符和空值", () => {
  const { source } = createHarness();
  const invalid = [
    "refresh-only",
    "refresh|id|extra",
    "|00112233445566778899aabbccddeeff",
    "refresh|   ",
  ];

  for (const value of invalid) {
    assert.throws(() => source._parseTokenLoginInput(value), {
      message: FORMAT_ERROR,
    });
  }
});

test("取消弹窗不请求网络、不提示失败、不改变旧登录", async () => {
  const { source, calls } = createHarness({ dialogValue: null });
  setAuthenticatedState(source, "token");
  const generation = source._authGeneration;

  assert.equal(await source.settings.tokenLogin.callback(), null);
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.posts.length, 0);
  assert.deepEqual(calls.messages, []);
  assert.equal(source.loadData("refreshToken"), "refresh-old");
  assert.equal(source._sessionToken, "session-old");
  assert.equal(source._authGeneration, generation);
});

test("Token 与邮箱账号注销都清除认证并保留 visitorId", async (t) => {
  for (const account of ["token", ["reader@example.com", "password"]]) {
    await t.test(Array.isArray(account) ? "email" : "token", () => {
      const { source } = createHarness();
      setAuthenticatedState(source, account);

      source.account.logout();

      assert.equal(source.loadData("account"), undefined);
      assert.equal(source.loadData("refreshToken"), undefined);
      assert.equal(source.loadData("lastSignInUtcDate"), undefined);
      assert.equal(
        source.loadData("visitorId"),
        "ffeeddccbbaa99887766554433221100",
      );
      assert.equal(source._sessionToken, "");
      assert.equal(source._sharedHubSession, null);
      assert.equal(source._autoSignInAttemptDate, "");
    });
  }
});

test("邮箱密码登录与普通刷新继续可用", async () => {
  const { source, calls } = createHarness();

  assert.equal(
    await source.account.login(" reader@example.com ", "password"),
    "reader@example.com",
  );
  assert.equal(source.loadData("refreshToken"), "refresh-email");
  assert.equal(source._sessionToken, "session-email");

  source._sessionTokenAt = 0;
  assert.equal(await source._refreshSessionToken(true), "session-new");
  assert.equal(calls.posts.length, 2);
});

test("0.2.15 元数据与 README 描述弹窗分隔输入", () => {
  const { source } = createHarness();
  const index = JSON.parse(
    fs.readFileSync(path.join(ROOT, "index.json"), "utf8"),
  );
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.15");
  assert.match(SOURCE_TEXT, /版本：0\.2\.15/);
  assert.equal(entry.version, "0.2.15");
  assert.match(readme, /RefreshToken\|x-id/);
  for (const separator of ["，", ",", "；", ";", "|"]) {
    assert.equal(readme.includes(`\`${separator}\``), true);
  }
  assert.doesNotMatch(readme, /^\| RefreshToken \|/m);
  assert.doesNotMatch(readme, /^\| x-id \|/m);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
node --test test/lightnovelshelf-token-login-dialog.test.cjs
```

Expected: FAIL；当前源仍声明两个输入设置、没有 `_parseTokenLoginInput`，callback 不调用 `UI.showInputDialog`，版本仍为 `0.2.14`。

### Task 2: 实现单行分隔弹窗和统一注销

**Files:**
- Modify: `lightnovelshelf.js:23-28`
- Modify: `lightnovelshelf.js:562-633`
- Modify: `lightnovelshelf.js:1855-1868`
- Modify: `lightnovelshelf.js:2413-2475`
- Test: `test/lightnovelshelf-token-login-dialog.test.cjs`

- [ ] **Step 1: 增加固定格式错误和解析方法**

在静态常量区新增：

```javascript
  static tokenLoginFormatError =
    "请输入 RefreshToken 和 x-id，并用 ， , ； ; 或 | 分隔";
```

用以下方法替换 `_clearTokenLoginSettings`：

```javascript
  _parseTokenLoginInput(value) {
    const parts = String(value == null ? "" : value)
      .trim()
      .split(/[，,；;|]/)
      .map((part) => part.trim());

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(LightNovelShelf.tokenLoginFormatError);
    }

    return {
      refreshToken: parts[0],
      visitorId: parts[1],
    };
  }
```

- [ ] **Step 2: 替换设置读取登录为弹窗登录**

用以下完整方法替换 `_loginWithTokenSettings`：

```javascript
  async _loginWithTokenDialog() {
    const value = await UI.showInputDialog(
      "Token 登录：输入 RefreshToken|x-id",
      (input) => {
        try {
          this._parseTokenLoginInput(input);
          return null;
        } catch (_) {
          return LightNovelShelf.tokenLoginFormatError;
        }
      },
    );

    if (value === null) return null;

    try {
      const input = this._parseTokenLoginInput(value);
      const result = await this._loginWithToken(
        input.refreshToken,
        input.visitorId,
      );
      UI.showMessage("Token 登录成功");
      return result;
    } catch (_) {
      UI.showMessage("Token 登录失败，请检查 RefreshToken 和 x-id");
      return null;
    }
  }
```

`_loginWithToken` 和 `_requestSessionToken` 不改。

- [ ] **Step 3: 删除旧设置并把按钮移到最后**

删除 `tokenRefreshToken` 和 `tokenVisitorId`。删除设置对象开头的旧 `tokenLogin`，在 `dailySignIn` 后重新声明：

```javascript
    dailySignIn: {
      title: "手动签到",
      type: "callback",
      buttonText: "签到",
      callback: () => this.dailySignIn(false),
    },

    tokenLogin: {
      title: "Token 登录",
      type: "callback",
      buttonText: "登录",
      callback: async () => await this._loginWithTokenDialog(),
    },
```

- [ ] **Step 4: 删除注销中的旧设置清理**

将 `account.logout` 保持为统一注销，但删除已不存在的方法调用：

```javascript
    logout: () => {
      this.deleteData("account");
      this.deleteData("refreshToken");
      this.deleteData("lastSignInUtcDate");
      this._autoSignInAttemptDate = "";
      this._invalidateAuthState();
    },
```

- [ ] **Step 5: 运行弹窗与注销测试**

Run:

```bash
node --test --test-name-pattern="Token 登录|分隔符|格式解析|取消弹窗|注销|邮箱密码" test/lightnovelshelf-token-login-dialog.test.cjs
node --check lightnovelshelf.js
```

Expected: 弹窗、五种分隔符、取消、双模式注销、邮箱登录和刷新全部 PASS；仅版本文档测试尚未通过或被过滤。

- [ ] **Step 6: 提交行为实现**

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git add -- lightnovelshelf.js
git commit -m "feat: open token login dialog"
```

### Task 3: 升级版本并更新使用说明

**Files:**
- Modify: `lightnovelshelf.js:1-35`
- Modify: `index.json:205-211`
- Modify: `README.md:22-49`
- Test: `test/lightnovelshelf-token-login-dialog.test.cjs`

- [ ] **Step 1: 升级源版本和顶部说明**

把版本改为 `0.2.15`，并把 Token 使用步骤写为：

```javascript
 * 2. Token 登录：点击源设置底部的“Token 登录”，输入 RefreshToken|x-id。
 * 3. 支持使用 ， , ； ; 或 | 分隔 RefreshToken 和 x-id。
```

同步：

```javascript
  version = "0.2.15";
```

- [ ] **Step 2: 同步索引版本**

轻书架条目保留双登录能力描述，仅把版本改为：

```json
        "version": "0.2.15",
```

- [ ] **Step 3: 更新 README**

把 Token 登录步骤改为：

```markdown
   - Token 登录：点击源设置底部、邮箱登录上方的“Token 登录”，在弹窗中输入 `RefreshToken|x-id`。也可使用 `，`、`,`、`；` 或 `;` 分隔。
```

删除设置表中的 `RefreshToken` 和 `x-id` 两行，把 Token 登录行改为：

```markdown
| Token 登录 | 弹窗输入 RefreshToken 和 x-id，支持 `，`、`,`、`；`、`;`、`|` 分隔 | 按需使用 |
```

删除“成功后自动清空设置输入”的说明，因为输入不再持久化。

- [ ] **Step 4: 运行完整专项测试**

```bash
node --test test/lightnovelshelf-token-login-dialog.test.cjs
node --check lightnovelshelf.js
node scripts/validate-pr-versions.js origin/main
```

Expected: 专项测试全部 PASS；语法检查通过；版本脚本输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 5: 提交版本与文档**

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js index.json README.md
git add -- lightnovelshelf.js index.json README.md
git commit -m "docs: publish token login dialog"
```

### Task 4: 完整验证与清理

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Verify: `README.md`
- Delete: `test/lightnovelshelf-token-login-dialog.test.cjs`

- [ ] **Step 1: 运行专项和非过期 Hub 回归**

```bash
node --test test/lightnovelshelf-token-login-dialog.test.cjs
node --test --test-skip-pattern="不确定的章节 transport|发表评论 transport|源和索引版本" cache/plan-tests.cjs
node --check lightnovelshelf.js
```

Expected: 弹窗专项全部 PASS；非过期 Hub 回归 15/15 PASS；语法检查通过。缓存中的三个已知过期断言仍按用户批准的基线排除。

- [ ] **Step 2: 检查接口和敏感设置清理**

```bash
rg -n "_parseTokenLoginInput|showInputDialog|tokenLogin|version = \"0.2.15\"" lightnovelshelf.js
rg -n "tokenRefreshToken|tokenVisitorId|_clearTokenLoginSettings|_loginWithTokenSettings" lightnovelshelf.js
```

Expected: 第一条命中解析、弹窗、按钮和版本；第二条无匹配。

- [ ] **Step 3: 使用 Venera CLI 验证**

在临时克隆的 `venera_cli` 中设置 `PUB_HOSTED_URL=https://pub.dev` 和 `HOME` 后运行：

```bash
dart run bin/venera.dart source validate F:/workspace/venera-configs/lightnovelshelf.js
```

Expected: `Valid LightNovelShelf (轻书架) 0.2.15`。

- [ ] **Step 4: 删除临时文件并确认工作区**

```bash
rm -rf test cache/venera_cli_validator
git status --short
git log -5 --oneline
```

Expected: 临时文件删除；正式变更已提交；工作区干净且未推送。
