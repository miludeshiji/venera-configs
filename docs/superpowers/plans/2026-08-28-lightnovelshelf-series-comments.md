# 轻书架系列评论 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为轻书架漫画源增加按需加载的系列评论、分页、回复查看、发表评论和回复主评论能力。

**Architecture:** 评论请求复用现有 SignalR `_hubCall`，固定使用 `Type: "Series"`、`Id: 0` 和当前系列标题。顶层评论使用 `真实评论ID//页码` 作为 Venera 的不透明 ID，以便回复页无状态地重新获取父评论原始页并解析内嵌回复；详情页不预加载评论。

**Tech Stack:** JavaScript ComicSource API、ASP.NET Core SignalR JSON Hub Protocol、Venera `Comment` 数据契约、Node.js `vm`/`node:test`、Venera CLI、Git

---

## 文件结构

- Modify: `lightnovelshelf.js` — 评论响应解析、复合评论 ID、`comic.loadComments`、`comic.sendComment`、版本及功能说明。
- Modify: `index.json` — 将轻书架索引版本同步为 `0.2.9` 并补充系列评论说明。
- Create temporarily: `test/lightnovelshelf-series-comments.test.cjs` — 评论专项测试及登录、搜索、章节、签到回归；`test/` 已被 `.gitignore` 忽略，最终删除。
- Reference only: `jm.js`、`copy_manga_multi_accounts.js`、`manhuaren.js`、`_template_.js` — Venera 评论接口、回复页和复合评论 ID 模式。
- Reference only: `cache/Web/src/services/comment`、`cache/Web/src/components/Comment.vue`、`cache/Web/src/pages/Manga/Detail.vue` — 轻书架 Hub 方法、响应结构和系列评论参数。
- Reference only: `cache/Venera-Next/lib/features/comic_source`、`cache/Venera-Next/lib/features/comic_details/comments_page.dart` — Venera 评论解析、分页、回复和发送调用约定。

保持 `lightnovelshelf.js` 当前 CRLF 行尾与 `index.json` 当前 LF 行尾。只暂存计划明确列出的正式文件，不处理工作区中已有的其他换行符差异。

### Task 1: 系列评论与回复读取

**Files:**
- Create temporarily: `test/lightnovelshelf-series-comments.test.cjs`
- Modify: `lightnovelshelf.js:827-841,970-1295`

- [ ] **Step 1: 确认目标正式文件起点干净**

Run:

```bash
git diff --exit-code -- lightnovelshelf.js index.json
git ls-files --eol lightnovelshelf.js index.json
git diff --cached --name-only
```

Expected: `lightnovelshelf.js` 与 `index.json` 相对 `HEAD` 无差异；前者为 `i/crlf w/crlf`，后者为 `i/lf w/lf`；暂存区为空。

- [ ] **Step 2: 创建评论读取失败测试**

创建 `test/lightnovelshelf-series-comments.test.cjs`：

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
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, "utf8");
const DEFAULT_NOW = "2026-08-28T23:30:00.000Z";

function makeFakeDate(now) {
  const RealDate = Date;
  return class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(now);
      } else {
        super(...args);
      }
    }

    static now() {
      return new RealDate(now).getTime();
    }
  };
}

function loginResponse() {
  return {
    status: 200,
    body: JSON.stringify({
      Success: true,
      Response: {
        RefreshToken: "refresh-secret",
        Token: "session-secret",
      },
    }),
  };
}

function createHarness(options = {}) {
  const calls = {
    posts: [],
    messages: [],
  };

  class ComicSource {
    constructor() {
      this.__data = new Map();
      this.__settings = new Map([
        ["apiServer", "https://api.lightnovel.life"],
        ["ignoreJapanese", false],
        ["ignoreAI", false],
        ["dailySignInTask", false],
      ]);
      this.__logged = options.logged ?? false;
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

  const Network = {
    post: async (url, headers, body) => {
      const call = { url, headers, body };
      calls.posts.push(call);
      if (typeof options.postResponse === "function") {
        return await options.postResponse(call);
      }
      return options.postResponse || loginResponse();
    },
    get: async () => {
      throw new Error("unexpected Network.get");
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
      showMessage(message) {
        calls.messages.push(String(message));
      },
    },
    createUuid() {
      return "00112233-4455-6677-8899-aabbccddeeff";
    },
    Date: makeFakeDate(options.now || DEFAULT_NOW),
    APP: { version: "1.6.0" },
    console,
    Map,
    Set,
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `${SOURCE_TEXT}\n;globalThis.__LightNovelShelf = LightNovelShelf;`,
    sandbox,
  );

  return {
    source: new sandbox.__LightNovelShelf(),
    calls,
  };
}

function plain(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
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

test("加载系列顶层评论并映射分页、回复数和复合 ID", async () => {
  const { source } = createHarness({ logged: true });
  let invocation;
  source._hubCall = async (target, params) => {
    invocation = { target, params: plain(params) };
    return {
      TotalPages: 3,
      Users: {
        "7": {
          UserName: "Alice",
          Avatar: "/avatars/alice.png",
        },
      },
      Commentaries: {
        "101": {
          UserId: 7,
          Content: "第一条",
          CreatedAt: "2026-08-28T10:00:00Z",
        },
        "102": {
          UserId: 99,
          Content: "用户记录已缺失",
          CreatedAt: "2026-08-28T11:00:00Z",
        },
      },
      Data: [
        { Id: 101, Reply: [201, 202] },
        { Id: 999, Reply: [] },
        { Id: 102, Reply: null },
      ],
    };
  };

  const result = await source.comic.loadComments("系列 A", null, 2, null);

  assert.deepEqual(invocation, {
    target: "GetComments",
    params: {
      Type: "Series",
      Id: 0,
      SeriesTitle: "系列 A",
      Page: 2,
    },
  });
  assert.deepEqual(plain(result), {
    comments: [
      {
        userName: "Alice",
        avatar: "https://api.lightnovel.life/avatars/alice.png",
        content: "第一条",
        time: "2026-08-28T10:00:00Z",
        id: "101//2",
        replyCount: 2,
      },
      {
        userName: "未知用户",
        content: "用户记录已缺失",
        time: "2026-08-28T11:00:00Z",
        id: "102//2",
        replyCount: 0,
      },
    ],
    maxPage: 3,
  });
});

test("评论响应兼容 camelCase 且总页数最少为一页", async () => {
  const { source } = createHarness({ logged: true });
  source._hubCall = async () => ({
    totalPages: 0,
    users: {
      "3": { userName: "Bob", avatar: "https://img.example/bob.png" },
    },
    commentaries: {
      "11": {
        userId: 3,
        content: "camel",
        createdAt: "2026-08-28T12:00:00Z",
      },
    },
    data: [{ id: 11, reply: [] }],
  });

  const result = await source.comic.loadComments("系列 B", null, 1, null);

  assert.deepEqual(plain(result), {
    comments: [
      {
        userName: "Bob",
        avatar: "https://img.example/bob.png",
        content: "camel",
        time: "2026-08-28T12:00:00Z",
        id: "11//1",
        replyCount: 0,
      },
    ],
    maxPage: 1,
  });
});

test("加载父评论所在页的回复并保留回复目标", async () => {
  const { source } = createHarness({ logged: true });
  let invocation;
  source._hubCall = async (target, params) => {
    invocation = { target, params: plain(params) };
    return {
      TotalPages: 8,
      Users: {
        "1": { UserName: "楼主", Avatar: "" },
        "2": { UserName: "Bob", Avatar: "/avatars/bob.png" },
        "3": { UserName: "Carol", Avatar: "/avatars/carol.png" },
      },
      Commentaries: {
        "101": {
          UserId: 1,
          Content: "父评论",
          CreatedAt: "2026-08-28T09:00:00Z",
        },
        "201": {
          UserId: 2,
          Content: "直接回复",
          CreatedAt: "2026-08-28T10:00:00Z",
          ReplyId: null,
        },
        "202": {
          UserId: 3,
          Content: "回复 Bob 的内容",
          CreatedAt: "2026-08-28T11:00:00Z",
          ReplyId: 201,
        },
      },
      Data: [{ Id: 101, Reply: [201, 202, 999] }],
    };
  };

  const result = await source.comic.loadComments(
    "系列 A",
    null,
    1,
    "101//4",
  );

  assert.deepEqual(invocation, {
    target: "GetComments",
    params: {
      Type: "Series",
      Id: 0,
      SeriesTitle: "系列 A",
      Page: 4,
    },
  });
  assert.deepEqual(plain(result), {
    comments: [
      {
        userName: "Bob",
        avatar: "https://api.lightnovel.life/avatars/bob.png",
        content: "直接回复",
        time: "2026-08-28T10:00:00Z",
        id: "201",
      },
      {
        userName: "Carol",
        avatar: "https://api.lightnovel.life/avatars/carol.png",
        content: "回复 @Bob：回复 Bob 的内容",
        time: "2026-08-28T11:00:00Z",
        id: "202",
      },
    ],
    maxPage: 1,
  });
});

test("父评论不存在时返回空回复列表", async () => {
  const { source } = createHarness({ logged: true });
  source._hubCall = async () => ({
    TotalPages: 1,
    Users: {},
    Commentaries: {},
    Data: [{ Id: 1, Reply: [] }],
  });

  const result = await source.comic.loadComments(
    "系列 A",
    null,
    1,
    "404//1",
  );

  assert.deepEqual(plain(result), { comments: [], maxPage: 1 });
});

test("无效复合评论 ID 在发起 Hub 请求前失败", async () => {
  const { source } = createHarness({ logged: true });
  let requestCount = 0;
  source._hubCall = async () => {
    requestCount += 1;
    return {};
  };

  const error = await rejectionText(() =>
    source.comic.loadComments("系列 A", null, 1, "not-an-id"),
  );

  assert.match(error, /无效评论 ID/);
  assert.equal(requestCount, 0);
});

test("评论响应整体结构异常时明确失败", async () => {
  const invalidResponses = [
    { Data: null, Users: {}, Commentaries: {} },
    { Data: [], Users: [], Commentaries: {} },
    { Data: [], Users: {}, Commentaries: [] },
  ];

  for (const response of invalidResponses) {
    const { source } = createHarness({ logged: true });
    source._hubCall = async () => response;

    const error = await rejectionText(() =>
      source.comic.loadComments("系列 A", null, 1, null),
    );
    assert.match(error, /评论响应格式异常/);
  }
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
```

Expected: FAIL，首个失败表明 `source.comic.loadComments` 不存在；测试 harness 本身可以成功加载 `lightnovelshelf.js`。

- [ ] **Step 4: 增加评论解析和复合 ID 辅助方法**

在 `lightnovelshelf.js` 的 `_value` 后、`_comicFromListItem` 前加入：

```javascript
  _positiveCommentInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  _encodeCommentReference(id, page) {
    const commentId = this._positiveCommentInteger(id);
    const commentPage = this._positiveCommentInteger(page);

    if (commentId === null || commentPage === null) {
      return null;
    }

    return `${commentId}//${commentPage}`;
  }

  _parseCommentReference(value) {
    const match = String(value == null ? "" : value).match(
      /^([1-9]\d*)\/\/([1-9]\d*)$/,
    );

    if (!match) {
      throw new Error("无效评论 ID");
    }

    const id = this._positiveCommentInteger(match[1]);
    const page = this._positiveCommentInteger(match[2]);

    if (id === null || page === null) {
      throw new Error("无效评论 ID");
    }

    return { id: id, page: page };
  }

  _seriesCommentParams(comicId, page) {
    return {
      Type: "Series",
      Id: 0,
      SeriesTitle: String(comicId),
      Page: page,
    };
  }

  _commentResponseParts(data) {
    const entries = this._value(data, "data", "Data", null);
    const users = this._value(data, "users", "Users", null);
    const commentaries = this._value(
      data,
      "commentaries",
      "Commentaries",
      null,
    );
    const isRecord = (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value);

    if (!Array.isArray(entries) || !isRecord(users) || !isRecord(commentaries)) {
      throw new Error("评论响应格式异常");
    }

    return {
      entries: entries,
      users: users,
      commentaries: commentaries,
    };
  }

  _commentRecord(dictionary, id) {
    if (!dictionary || typeof dictionary !== "object") return null;

    const key = String(id);
    if (!Object.prototype.hasOwnProperty.call(dictionary, key)) return null;

    const value = dictionary[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  }

  _commentFromResponse(commentaries, users, id, options = {}) {
    const commentary = this._commentRecord(commentaries, id);
    if (!commentary) return null;

    const userId = this._value(commentary, "userId", "UserId", null);
    const user = this._commentRecord(users, userId);
    const rawUserName = this._value(
      user,
      "userName",
      "UserName",
      "未知用户",
    );
    const rawAvatar = this._value(user, "avatar", "Avatar", "");
    const rawContent = this._value(commentary, "content", "Content", "");
    const rawTime = this._value(
      commentary,
      "createdAt",
      "CreatedAt",
      this._value(commentary, "createdTime", "CreatedTime", null),
    );

    const comment = {
      userName: String(rawUserName || "未知用户"),
      content: String(rawContent == null ? "" : rawContent),
      id: String(options.id === undefined ? id : options.id),
    };

    if (rawAvatar) {
      comment.avatar = this._normalizeUrl(String(rawAvatar));
    }

    if (rawTime !== null && rawTime !== undefined && rawTime !== "") {
      comment.time = String(rawTime);
    }

    if (Object.prototype.hasOwnProperty.call(options, "replyCount")) {
      comment.replyCount = options.replyCount;
    }

    return comment;
  }

  _replyTargetUserName(commentaries, users, replyId) {
    const commentary = this._commentRecord(commentaries, replyId);
    if (!commentary) return "";

    const userId = this._value(commentary, "userId", "UserId", null);
    const user = this._commentRecord(users, userId);
    const userName = this._value(user, "userName", "UserName", "");
    return userName ? String(userName) : "";
  }
```

- [ ] **Step 5: 实现 `comic.loadComments`**

在 `comic` 对象中紧接 `loadEp` 后、`onImageLoad` 前加入：

```javascript
    loadComments: async (comicId, subId, page, replyTo) => {
      const reference = replyTo
        ? this._parseCommentReference(replyTo)
        : null;
      const requestPage = reference
        ? reference.page
        : this._positiveCommentInteger(page);

      if (requestPage === null) {
        throw new Error("无效评论页码");
      }

      const data = await this._hubCall(
        "GetComments",
        this._seriesCommentParams(comicId, requestPage),
      );
      const parts = this._commentResponseParts(data);

      if (reference) {
        const parent = parts.entries.find((entry) => {
          const id = this._positiveCommentInteger(
            this._value(entry, "id", "Id", null),
          );
          return id === reference.id;
        });

        if (!parent) {
          return { comments: [], maxPage: 1 };
        }

        const replyIds = this._value(parent, "reply", "Reply", []);
        const comments = [];

        for (const rawReplyId of Array.isArray(replyIds) ? replyIds : []) {
          const replyId = this._positiveCommentInteger(rawReplyId);
          if (replyId === null) continue;

          const comment = this._commentFromResponse(
            parts.commentaries,
            parts.users,
            replyId,
          );
          if (!comment) continue;

          const commentary = this._commentRecord(
            parts.commentaries,
            replyId,
          );
          const targetId = this._positiveCommentInteger(
            this._value(commentary, "replyId", "ReplyId", null),
          );

          if (targetId !== null) {
            const targetName = this._replyTargetUserName(
              parts.commentaries,
              parts.users,
              targetId,
            );
            if (targetName) {
              comment.content = `回复 @${targetName}：${comment.content}`;
            }
          }

          comments.push(comment);
        }

        return { comments: comments, maxPage: 1 };
      }

      const comments = [];

      for (const entry of parts.entries) {
        const commentId = this._positiveCommentInteger(
          this._value(entry, "id", "Id", null),
        );
        if (commentId === null) continue;

        const encodedId = this._encodeCommentReference(commentId, requestPage);
        if (!encodedId) continue;

        const replyIds = this._value(entry, "reply", "Reply", []);
        const comment = this._commentFromResponse(
          parts.commentaries,
          parts.users,
          commentId,
          {
            id: encodedId,
            replyCount: Array.isArray(replyIds) ? replyIds.length : 0,
          },
        );

        if (comment) comments.push(comment);
      }

      const rawTotalPages = Number(
        this._value(data, "totalPages", "TotalPages", 1),
      );
      const maxPage =
        Number.isFinite(rawTotalPages) && rawTotalPages > 0
          ? Math.floor(rawTotalPages)
          : 1;

      return {
        comments: comments,
        maxPage: maxPage,
      };
    },
```

`subId` 按 Venera 方法签名保留但不使用；系列标题由 `comicId` 提供。

- [ ] **Step 6: 运行评论读取测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 6 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 7: 检查并提交评论读取实现**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "feat: 增加轻书架系列评论读取"
```

Expected: 暂存和提交仅包含 `lightnovelshelf.js`；临时测试仍被 `.gitignore` 忽略。

### Task 2: 发表评论与回复主评论

**Files:**
- Modify temporarily: `test/lightnovelshelf-series-comments.test.cjs`
- Modify: `lightnovelshelf.js`（`comic.sendComment`）

- [ ] **Step 1: 追加发送评论失败测试**

向 `test/lightnovelshelf-series-comments.test.cjs` 追加：

```javascript
test("发表评论调用 PostComment 并保留正文", async () => {
  const { source } = createHarness({ logged: true });
  let invocation;
  source._hubCall = async (target, params) => {
    invocation = { target, params: plain(params) };
    return {};
  };

  const result = await source.comic.sendComment(
    "系列 A",
    null,
    " 发表评论内容 ",
    null,
  );

  assert.equal(result, "ok");
  assert.deepEqual(invocation, {
    target: "PostComment",
    params: {
      Type: "Series",
      Id: 0,
      SeriesTitle: "系列 A",
      Content: " 发表评论内容 ",
    },
  });
});

test("回复评论调用 ReplyComment 并只发送真实 ParentId", async () => {
  const { source } = createHarness({ logged: true });
  let invocation;
  source._hubCall = async (target, params) => {
    invocation = { target, params: plain(params) };
    return {};
  };

  const result = await source.comic.sendComment(
    "系列 A",
    null,
    "回复内容",
    "321//7",
  );

  assert.equal(result, "ok");
  assert.deepEqual(invocation, {
    target: "ReplyComment",
    params: {
      Type: "Series",
      Id: 0,
      SeriesTitle: "系列 A",
      Content: "回复内容",
      ParentId: 321,
    },
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(invocation.params, "ReplyId"),
    false,
  );
});

test("未登录、空正文和无效回复 ID 不发送 Hub 请求", async () => {
  const cases = [
    {
      name: "未登录",
      logged: false,
      content: "正文",
      replyTo: null,
      message: "请先登录轻书架账号",
    },
    {
      name: "空正文",
      logged: true,
      content: "   \n\t",
      replyTo: null,
      message: "评论内容不能为空",
    },
    {
      name: "无效回复 ID",
      logged: true,
      content: "正文",
      replyTo: "321",
      message: "无效评论 ID",
    },
  ];

  for (const item of cases) {
    const { source } = createHarness({ logged: item.logged });
    let requestCount = 0;
    source._hubCall = async () => {
      requestCount += 1;
      return {};
    };

    const error = await rejectionText(() =>
      source.comic.sendComment(
        "系列 A",
        null,
        item.content,
        item.replyTo,
      ),
    );

    assert.match(error, new RegExp(item.message), item.name);
    assert.equal(requestCount, 0, item.name);
  }
});
```

- [ ] **Step 2: 运行新增测试并确认 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
```

Expected: 原有 6 个读取测试 PASS；新增测试 FAIL，表明 `source.comic.sendComment` 不存在。

- [ ] **Step 3: 实现 `comic.sendComment`**

在 `comic.loadComments` 后、`onImageLoad` 前加入：

```javascript
    sendComment: async (comicId, subId, content, replyTo) => {
      if (!this.isLogged) {
        throw new Error("请先登录轻书架账号");
      }

      const text = String(content == null ? "" : content);
      if (!text.trim()) {
        throw new Error("评论内容不能为空");
      }

      const params = {
        Type: "Series",
        Id: 0,
        SeriesTitle: String(comicId),
        Content: text,
      };

      if (replyTo) {
        const reference = this._parseCommentReference(replyTo);
        params.ParentId = reference.id;
        await this._hubCall("ReplyComment", params);
      } else {
        await this._hubCall("PostComment", params);
      }

      return "ok";
    },
```

不要添加 `ReplyId`。Venera 的发送入口只表示回复当前主评论，不能选择回复页中的某条子回复。

- [ ] **Step 4: 运行完整评论测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
```

Expected: 9 个测试全部 PASS；语法检查退出码为 0。

- [ ] **Step 5: 检查并提交评论发送实现**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js
git diff --ignore-space-at-eol -- lightnovelshelf.js
git add -- lightnovelshelf.js
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "feat: 支持轻书架发表评论与回复"
```

Expected: 暂存和提交仅包含 `lightnovelshelf.js`。

### Task 3: 版本、说明与既有功能回归

**Files:**
- Modify temporarily: `test/lightnovelshelf-series-comments.test.cjs`
- Modify: `lightnovelshelf.js:1-24`
- Modify: `index.json:205-211`

- [ ] **Step 1: 追加版本、按需加载和回归测试**

向 `test/lightnovelshelf-series-comments.test.cjs` 追加：

```javascript
test("详情加载不预取评论", async () => {
  const { source } = createHarness({ logged: true });
  const targets = [];
  source._hubCall = async (target) => {
    targets.push(target);
    if (target !== "GetComicSeriesInfo") {
      throw new Error(`unexpected target: ${target}`);
    }
    return {
      Series: {
        Title: "系列 A",
        OriginalTitle: "Series A",
        Cover: "/covers/a.jpg",
        Author: "作者",
        Introduction: "简介",
        Extra: { Classification: { Tags: [] } },
      },
      Books: [],
    };
  };

  const result = await source.comic.loadInfo("系列 A");

  assert.equal(result.title, "系列 A");
  assert.deepEqual(targets, ["GetComicSeriesInfo"]);
});

test("账号密码登录回归仍保存 RefreshToken 和短期 Token", async () => {
  const { source, calls } = createHarness();

  const result = await source.account.login("reader@example.com", "password");

  assert.equal(result, "reader@example.com");
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].url, "https://api.lightnovel.life/api/user/login");
  assert.equal(source.loadData("refreshToken"), "refresh-secret");
  assert.equal(source._sessionToken, "session-secret");
});

test("六种搜索 Mode 回归保持不变", async () => {
  const { source } = createHarness();
  const modes = ["fuzzy", "exact", "title", "author", "name", "tags"];

  for (const mode of modes) {
    let invocation;
    source._hubCall = async (target, payload) => {
      invocation = { target, payload: plain(payload) };
      return { Data: [], TotalPages: 2 };
    };

    const result = await source.search.load("关键字", [mode], 2);

    assert.equal(invocation.target, "SearchComicSeries");
    assert.equal(invocation.payload.Mode, mode);
    assert.equal(result.maxPage, 2);
  }
});

test("225 页章节仍使用首批加单 payload 批量计划", async () => {
  const { source } = createHarness();
  let remainingParams;
  let closeCount = 0;

  function chapterBatch(skip, count) {
    return {
      Chapter: {
        Images: Array.from(
          { length: count },
          (_, index) => `/images/${skip + index}.jpg`,
        ),
        Total: 225,
      },
    };
  }

  source._openHub = async () => ({ id: "session" });
  source._hubInvoke = async (_session, target, params) => {
    assert.equal(target, "GetComicContent");
    assert.equal(params.Skip, 0);
    return chapterBatch(0, 12);
  };
  source._hubInvokeMany = async (_session, target, paramsList) => {
    assert.equal(target, "GetComicContent");
    remainingParams = Array.from(paramsList, (item) => ({ ...item }));
    return remainingParams.map((params) =>
      chapterBatch(params.Skip, Math.min(12, 225 - params.Skip)),
    );
  };
  source._closeHub = () => {
    closeCount += 1;
  };

  const result = await source.comic.loadEp("系列 A", "42");

  assert.equal(remainingParams.length, 18);
  assert.equal(result.images.length, 225);
  assert.equal(
    result.images[224],
    "https://api.lightnovel.life/images/224.jpg",
  );
  assert.equal(closeCount, 1);
});

test("每日签到回归仍保存 UTC 日期并显示奖励", async () => {
  const { source, calls } = createHarness({ logged: true });
  source.saveData("refreshToken", "account-a");
  let invocation;
  source._hubCall = async (target, params) => {
    invocation = { target, params: plain(params) };
    return { Reward: 5, CoinReward: 2, Streak: 4 };
  };

  const result = await source.dailySignIn(false);

  assert.deepEqual(invocation, { target: "SignIn", params: {} });
  assert.deepEqual(plain(result), {
    streak: 4,
    reward: 5,
    coinReward: 2,
  });
  assert.equal(source.loadData("lastSignInUtcDate"), "2026-08-28");
  assert.deepEqual(calls.messages, [
    "签到成功：连续 4 天，经验 +5，金币 +2",
  ]);
});

test("版本和系列评论说明同步为 0.2.9", () => {
  const { source } = createHarness();
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const entry = index.find((item) => item.fileName === "lightnovelshelf.js");

  assert.equal(source.version, "0.2.9");
  assert.match(SOURCE_TEXT, /版本：0\.2\.9/);
  assert.match(SOURCE_TEXT, /系列评论与回复/);
  assert.ok(entry);
  assert.equal(entry.version, "0.2.9");
  assert.match(entry.description, /系列评论与回复/);
});
```

- [ ] **Step 2: 运行测试并确认版本测试 RED**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
```

Expected: 评论、按需加载、登录、搜索、225 页章节和签到测试 PASS；最后的版本测试 FAIL，因为正式版本仍为 `0.2.8`。

- [ ] **Step 3: 更新源版本与顶部功能说明**

将 `lightnovelshelf.js` 顶部改为：

```javascript
/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.2.9
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - HTTP Long Polling transport
 * - 邮箱密码登录并自动管理认证令牌
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - 每日自动/手动签到
 * - Long Polling 防缓存参数
 * - 漫画列表 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
 *
 * 使用前：
 * 1. 在 Venera 的轻书架漫画源设置中打开账号登录。
 * 2. 使用轻书架注册邮箱和密码登录。
 * 3. x-id 与令牌由漫画源自动生成和管理。
 */
class LightNovelShelf extends ComicSource {
  name = "轻书架";
  key = "LightNovelShelf";
  version = "0.2.9";
  minAppVersion = "1.0.0";
```

只替换现有文件顶部对应区块，不改动后续代码。

- [ ] **Step 4: 同步 `index.json`**

将轻书架条目改为：

```json
    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.9",
        "description": "轻书架漫画源，支持邮箱密码登录、每日自动/手动签到及系列评论与回复"
    }
```

- [ ] **Step 5: 运行完整专项与回归测试并确认 GREEN**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "const fs=require('fs');const index=JSON.parse(fs.readFileSync('F:/workspace/venera-configs/index.json','utf8'));const entry=index.find(x=>x.fileName==='lightnovelshelf.js');if(!entry||entry.version!=='0.2.9')process.exit(1);console.log('version_consistency=PASS')"
```

Expected: 15 个测试全部 PASS；语法检查退出码为 0；输出 `version_consistency=PASS`。

- [ ] **Step 6: 只暂存版本相关正式文件并提交**

Run:

```bash
git -c core.whitespace=cr-at-eol diff --check -- lightnovelshelf.js index.json
git add -- lightnovelshelf.js index.json
git diff --cached --name-status
git -c core.whitespace=cr-at-eol diff --cached --check
git commit -m "chore: 更新轻书架评论说明与版本"
```

Expected: 暂存和提交仅包含 `lightnovelshelf.js`、`index.json`，两个文件中的版本均为 `0.2.9`。

### Task 4: 完整验证、审查与临时文件清理

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`
- Verify: `docs/superpowers/specs/2026-08-28-lightnovelshelf-series-comments-design.md`
- Verify: `docs/superpowers/plans/2026-08-28-lightnovelshelf-series-comments.md`
- Delete: `test/lightnovelshelf-series-comments.test.cjs`

- [ ] **Step 1: 运行最终本地验证**

Run:

```bash
/mnt/f/node/node.exe --test 'F:\workspace\venera-configs\test\lightnovelshelf-series-comments.test.cjs'
/mnt/f/node/node.exe --check 'F:\workspace\venera-configs\lightnovelshelf.js'
/mnt/f/node/node.exe -e "JSON.parse(require('fs').readFileSync('F:/workspace/venera-configs/index.json','utf8'));console.log('index_json=PASS')"
/mnt/f/node/node.exe scripts/validate-pr-versions.js origin/main
git -c core.whitespace=cr-at-eol diff --check origin/main...HEAD
```

Expected: 15 个测试全部 PASS；语法、JSON、版本和 whitespace 检查全部通过；版本脚本输出只检查轻书架配置。

- [ ] **Step 2: 检查实现边界、敏感信息和行尾**

Run:

```bash
/mnt/c/Users/miludeshiji/.pi/agent/bin/rg.exe -n 'GetComments|PostComment|ReplyComment|loadComments|sendComment|seriesComment|commentReference' lightnovelshelf.js
if /mnt/c/Users/miludeshiji/.pi/agent/bin/rg.exe -n 'UI\.showMessage\([^)]*(RefreshToken|sessionToken|visitorId|x-id|password)' lightnovelshelf.js; then
  echo 'sensitive comment message found' >&2
  exit 1
fi
git diff --name-only origin/main...HEAD
git ls-files --eol lightnovelshelf.js index.json
```

Expected:

- 评论 Hub 方法只出现在辅助逻辑和 `comic` 评论接口中；
- 没有向 UI 输出认证信息；
- 正式差异仅包含本功能设计、计划、`lightnovelshelf.js` 与 `index.json`；
- `lightnovelshelf.js` 仍为 CRLF，`index.json` 仍为 LF。

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
validator = pathlib.Path(tempfile.mkdtemp(prefix='venera-cli-comments-', dir='/mnt/f/workspace'))
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

Expected: 输出 `Valid LightNovelShelf (轻书架) 0.2.9`，退出码为 0；验证过程不使用真实账号。

- [ ] **Step 4: 按审查清单检查实现**

审查 `origin/main...HEAD`，逐项确认：

- 顶层请求固定使用 `Type: "Series"`、`Id: 0`、系列标题和调用页码；
- 回复请求使用复合 ID 中的原始页，不扫描其他页；
- 顶层评论 ID 可逆且严格校验正整数；
- 单条损坏评论被跳过，用户缺失时降级，不会让整页失败；
- 回复目标只影响显示前缀，不改变服务端正文；
- 发送主评论和回复使用不同 Hub target，回复不包含 `ReplyId`；
- 详情加载没有新增 `GetComments` 请求；
- 评论调用复用认证与自动签到，不新增 Token 日志或持久化；
- 登录、搜索、章节和签到代码除必要插入点外没有行为变化。

若发现问题，先在临时测试文件中增加可复现的失败测试，再做最小修复，重复 Task 4 Step 1-3，并用中文提交修复。

- [ ] **Step 5: 删除临时测试并确认最终工作区**

Run:

```bash
rm -f test/lightnovelshelf-series-comments.test.cjs
rmdir test 2>/dev/null || true
test ! -e test/lightnovelshelf-series-comments.test.cjs
test -z "$(git diff --cached --name-only)"
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: 临时测试已删除、暂存区为空；工作区中用户原有的无关换行符差异保持不变；提交历史包含设计、计划、评论读取、评论发送和版本更新提交。
