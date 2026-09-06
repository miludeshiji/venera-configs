/**
 * 轻书架 (LightNovelShelf) 只读真实 Smoke 验证脚本
 *
 * 运行方式:
 *   node scripts/_smoke_lightnovelshelf_real.js <RefreshToken|x-id>
 *   node scripts/_smoke_lightnovelshelf_real.js <RefreshToken> <x-id>
 * 或通过环境变量:
 *   LIGHTNOVELSHELF_REFRESH_TOKEN=... LIGHTNOVELSHELF_X_ID=... node scripts/_smoke_lightnovelshelf_real.js
 *
 * 严格只读，不发送任何状态修改调用（如 SaveReadPosition、SignIn、ReplyComment 等）。
 * 复用 lightnovelshelf.js 源实现，不复制 SignalR 客户端代码。
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

// 1. 解析 RefreshToken 与 x-id
function parseCredentials() {
  let token = process.env.LIGHTNOVELSHELF_REFRESH_TOKEN || process.env.REFRESH_TOKEN || "";
  let xId = process.env.LIGHTNOVELSHELF_X_ID || process.env.X_ID || "";

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" || arg === "--refresh-token") {
      token = args[++i] || "";
    } else if (arg === "--x-id" || arg === "-x") {
      xId = args[++i] || "";
    } else if (!token && !arg.startsWith("-")) {
      token = arg;
    } else if (!xId && !arg.startsWith("-")) {
      xId = arg;
    }
  }

  // 兼容单字符串分隔格式 (RefreshToken|x-id, 支持 , ; | ， ；)
  if (token && !xId) {
    const parts = token
      .split(/[,;|\uff0c\uff1b]/)
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      token = parts[0];
      xId = parts[1];
    }
  }

  token = String(token || "").trim();
  xId = String(xId || "").trim();

  return { token, xId };
}

const { token: refreshToken, xId: visitorId } = parseCredentials();

if (!refreshToken || !visitorId) {
  console.error("==================================================");
  console.error("【错误】缺少轻书架真实验证凭据 (RefreshToken 与 x-id)");
  console.error("==================================================");
  console.error("使用方法:");
  console.error("  1. 命令行参数 (支持以 '|' 分隔):");
  console.error("     node scripts/_smoke_lightnovelshelf_real.js \"<RefreshToken>|<x-id>\"");
  console.error("  2. 命令行两个参数:");
  console.error("     node scripts/_smoke_lightnovelshelf_real.js <RefreshToken> <x-id>");
  console.error("  3. 环境变量:");
  console.error("     LIGHTNOVELSHELF_REFRESH_TOKEN=... LIGHTNOVELSHELF_X_ID=... node scripts/_smoke_lightnovelshelf_real.js");
  console.error("==================================================");
  process.exit(1);
}

// 2. 获取可用 WebSocket 构造器
const WebSocketImpl =
  globalThis.WebSocket ||
  (() => {
    try {
      return require("undici").WebSocket;
    } catch (_e) {
      try {
        return require("ws");
      } catch (_e2) {
        return null;
      }
    }
  })();

if (!WebSocketImpl) {
  console.error("【错误】当前 Node.js 环境未找到可用 WebSocket 实现 (需要 Node 21+ 或内置 undici / ws)");
  process.exit(1);
}

class RealWebSocketWrapper {
  constructor(url, headers = {}, options = {}) {
    this.url = url;
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this._incomingQueue = [];
    this._pendingReceiver = null;
    this._hasActiveReceiver = false;

    const wsOptions = Object.keys(headers).length > 0 ? { headers } : undefined;
    const ws = new WebSocketImpl(url, wsOptions);
    this.ws = ws;

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("message", (event) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.isBuffer(event.data)
              ? event.data.toString("utf8")
              : String(event.data);
        this._push({ type: "message", data });
      });
      ws.addEventListener("close", (event) => {
        this.closed = true;
        this.closeCode = event.code;
        this.closeReason = event.reason;
        this._push({
          type: "close",
          code: event.code || 1000,
          reason: event.reason || "Closed",
        });
      });
      ws.addEventListener("error", (err) => {
        if (!this.closed) {
          this.closed = true;
          if (this._pendingReceiver) {
            const receiver = this._pendingReceiver;
            this._pendingReceiver = null;
            this._hasActiveReceiver = false;
            receiver.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    } else {
      // ws 库的 EventEmitter 风格接口
      ws.on("message", (data) => {
        const str = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        this._push({ type: "message", data: str });
      });
      ws.on("close", (code, reason) => {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = String(reason || "");
        this._push({
          type: "close",
          code: code || 1000,
          reason: String(reason || "Closed"),
        });
      });
      ws.on("error", (err) => {
        if (!this.closed) {
          this.closed = true;
          if (this._pendingReceiver) {
            const receiver = this._pendingReceiver;
            this._pendingReceiver = null;
            this._hasActiveReceiver = false;
            receiver.reject(err);
          }
        }
      });
    }
  }

  _push(event) {
    if (this._pendingReceiver) {
      const receiver = this._pendingReceiver;
      this._pendingReceiver = null;
      this._hasActiveReceiver = false;
      receiver.resolve(event);
    } else {
      this._incomingQueue.push(event);
    }
  }

  async send(data) {
    if (this.closed) {
      throw new Error("WebSocket is closed");
    }
    await new Promise((resolve, reject) => {
      try {
        if (typeof this.ws.send === "function") {
          const res = this.ws.send(data, (err) => (err ? reject(err) : resolve()));
          if (res && typeof res.then === "function") {
            res.then(resolve, reject);
          } else if (this.ws.send.length < 2) {
            resolve();
          }
        } else {
          reject(new Error("WebSocket send not supported"));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  async receive() {
    if (this.closed && this._incomingQueue.length === 0) {
      return {
        type: "close",
        code: this.closeCode || 1000,
        reason: this.closeReason || "Closed",
      };
    }
    if (this._hasActiveReceiver) {
      throw new Error("StateError: Only one WebSocket receiver is allowed");
    }
    this._hasActiveReceiver = true;

    if (this._incomingQueue.length > 0) {
      const item = this._incomingQueue.shift();
      this._hasActiveReceiver = false;
      return item;
    }

    return await new Promise((resolve, reject) => {
      this._pendingReceiver = { resolve, reject };
    });
  }

  async close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    try {
      this.ws.close(code, reason);
    } catch (_e) {}
    if (this._pendingReceiver) {
      const receiver = this._pendingReceiver;
      this._pendingReceiver = null;
      this._hasActiveReceiver = false;
      receiver.reject(new Error("StateError: WebSocket Closed Connection"));
    }
  }
}

// 3. 构建 Venera 运行环境并载入 lightnovelshelf.js
const dataStore = new Map([
  ["account", "token"],
  ["refreshToken", refreshToken],
  ["visitorId", visitorId],
]);
const settingsStore = new Map([
  ["apiServer", "https://api.lightnovel.life"],
]);

class MockComicSource {
  name = "";
  key = "";
  version = "";
  minAppVersion = "";
  url = "";
  get isLogged() {
    const account = this.loadData("account");
    const token = this.loadData("refreshToken");
    return Boolean((account && String(account).trim()) || (token && String(token).trim()));
  }
  loadData(key) {
    return dataStore.get(key);
  }
  saveData(key, value) {
    dataStore.set(key, value);
  }
  deleteData(key) {
    dataStore.delete(key);
  }
  loadSetting(key) {
    return settingsStore.get(key);
  }
  saveSetting(key, value) {
    settingsStore.set(key, value);
  }
}

const Convert = {
  encodeUtf8: (str) => Buffer.from(str, "utf8"),
  decodeUtf8: (buf) => Buffer.from(buf).toString("utf8"),
  hexEncode: (buf) => Buffer.from(buf).toString("hex"),
  sha256: (buf) => crypto.createHash("sha256").update(Buffer.from(buf)).digest(),
  decodeBase64: (str) => Buffer.from(str, "base64"),
  decodeGzip: (buf) => zlib.gunzipSync(Buffer.from(buf)),
};

const createUuid = () => crypto.randomUUID();

const Network = {
  post: async (url, headers, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: body,
    });
    const text = await res.text();
    return { status: res.status, body: text };
  },
  get: async (url, headers) => {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    return { status: res.status, body: text };
  },
  delete: async (url, headers) => {
    const res = await fetch(url, { method: "DELETE", headers });
    const text = await res.text();
    return { status: res.status, body: text };
  },
  WebSocket: {
    connect: async (url, headers, options) => {
      const ws = new RealWebSocketWrapper(url, headers, options);
      return ws;
    },
  },
};

class MockTimer {
  constructor(fn, ms) {
    this.cancelled = false;
    this._id = setInterval(() => {
      if (this.cancelled) {
        clearInterval(this._id);
        return;
      }
      fn();
    }, ms);
  }
  cancel() {
    this.cancelled = true;
    clearInterval(this._id);
  }
}

const sandbox = {
  ComicSource: MockComicSource,
  Convert,
  createUuid,
  Network,
  UI: { showMessage: (msg) => console.log(`[UI.showMessage] ${msg}`) },
  setTimeout: (fn, ms) => {
    setTimeout(fn, ms);
    return undefined;
  },
  setInterval: (fn, ms) => new MockTimer(fn, ms),
  console,
  Buffer,
  Date,
  Map,
  Set,
  Promise,
  Error,
  JSON,
  Math,
  String,
  Number,
  Array,
  Object,
};

const codePath = path.resolve(__dirname, "../lightnovelshelf.js");
const code = fs.readFileSync(codePath, "utf8");
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const LightNovelShelf = vm.runInContext("LightNovelShelf", sandbox);

const source = new LightNovelShelf();

// 4. 执行只读 Smoke 验证流程
async function runSmoke() {
  console.log("==================================================");
  console.log("轻书架 (LightNovelShelf) 真实网络只读 Smoke 测试");
  console.log(`源版本: ${source.version}, 目标 API: ${source.apiBase}`);
  console.log("==================================================");

  try {
    // 1. 测试 Token 刷新
    console.log("\n[1/8] 验证 refresh 接口...");
    const sessionToken = await source._ensureSessionToken(true);
    if (!sessionToken || typeof sessionToken !== "string") {
      throw new Error("refresh 响应未获取到有效 SessionToken");
    }
    console.log(`  ✓ refresh 成功, SessionToken 长度: ${sessionToken.length}`);

    // 2. 测试 latest / view 列表
    console.log("\n[2/8] 验证 GetComicList (latest & view)...");
    const [latest, view] = await Promise.all([
      source._loadComicList("latest", 1, 6),
      source._loadComicList("view", 1, 6),
    ]);
    if (!latest.comics || latest.comics.length === 0) {
      throw new Error("latest 列表为空");
    }
    if (!view.comics || view.comics.length === 0) {
      throw new Error("view 列表为空");
    }
    console.log(`  ✓ latest 漫画数量: ${latest.comics.length}, 样例: “${latest.comics[0].title}”`);
    console.log(`  ✓ view 漫画数量: ${view.comics.length}, 样例: “${view.comics[0].title}”`);

    const targetComic = latest.comics[0];
    const targetTitle = targetComic.title;

    // 3. 测试 exact 搜索解析
    console.log(`\n[3/8] 验证 SearchComicSeries (exact: “${targetTitle}”)...`);
    const resolvedBookId = await source._resolveRepresentativeBookId(targetTitle);
    if (!Number.isSafeInteger(resolvedBookId) || resolvedBookId <= 0) {
      throw new Error(`无法精确解析 “${targetTitle}” 对应的 Book.Id`);
    }
    console.log(`  ✓ exact 匹配成功, Book.Id: ${resolvedBookId}`);

    // 4. 测试 GetBookInfo
    console.log(`\n[4/8] 验证 GetBookInfo (BookId: ${resolvedBookId})...`);
    const details = await source.comic.loadInfo(targetTitle);
    if (!details || !details.title) {
      throw new Error("loadInfo 未返回有效漫画详情");
    }
    const chapterGroups = Array.from(details.chapters.entries());
    if (chapterGroups.length === 0) {
      throw new Error("漫画详情未包含任何上传源章节");
    }
    const firstGroup = chapterGroups[0];
    const firstChapterEntries = Array.from(firstGroup[1].entries());
    if (firstChapterEntries.length === 0) {
      throw new Error("分组内无章节条目");
    }
    const [sampleChapterIdStr, sampleChapterTitle] = firstChapterEntries[0];
    const sampleChapterId = Number(sampleChapterIdStr);
    console.log(`  ✓ GetBookInfo 成功, 标题: “${details.title}”, 分组数: ${chapterGroups.length}`);
    console.log(`  ✓ 选定章节 [${sampleChapterIdStr}] “${sampleChapterTitle}” 用于后续只读测试`);

    // 5. 测试 GetComicContent (只读第 1 批，验证 Chapter.Id 与 BookId 回填)
    console.log(`\n[5/8] 验证 GetComicContent (Cid: ${sampleChapterId})...`);
    const contentBatch = await source._loadComicContentBatch(targetTitle, sampleChapterId, 0);
    if (!contentBatch || !Array.isArray(contentBatch.images) || contentBatch.images.length === 0) {
      throw new Error("GetComicContent 未返回图片列表");
    }
    const backfilledBookId = source._comicChapterBookIds.get(
      source._comicChapterBookIdKey(targetTitle, sampleChapterId),
    );
    console.log(`  ✓ GetComicContent 成功, 总页数: ${contentBatch.total}, 本批页数: ${contentBatch.images.length}`);
    console.log(`  ✓ Chapter.BookId 回填检查: ${backfilledBookId ? `已回填 (BookId: ${backfilledBookId})` : "未回填 (章节无单独 BookId)"}`);

    // 6. 测试 GetReadHistory
    console.log("\n[6/8] 验证 GetReadHistory (只读拉取)...");
    const historyData = await source._hubCall("GetReadHistory", {}, { retryTransport: true });
    const historyIds = source._historyIdsFromResponse(historyData);
    console.log(`  ✓ GetReadHistory 成功, 历史记录 ID 数: ${historyIds.length}`);

    // 7. 测试 GetBookListByIds (Type=Comic)
    console.log(`\n[7/8] 验证 GetBookListByIds (Type: Comic, Id: ${resolvedBookId})...`);
    const bookListData = await source._hubCall(
      "GetBookListByIds",
      { Ids: [resolvedBookId], Type: "Comic" },
      { retryTransport: true },
    );
    const bookList = source._value(bookListData, "data", "Data", []);
    if (!Array.isArray(bookList) || bookList.length === 0) {
      throw new Error("GetBookListByIds 未返回对应漫画数据");
    }
    console.log(`  ✓ GetBookListByIds 成功, 返回条目数: ${bookList.length}`);

    // 8. 测试 GetComments (Type=Book)
    console.log(`\n[8/8] 验证 GetComments (Type: Book, Id: ${resolvedBookId})...`);
    const commentsResult = await source.comic.loadComments(targetTitle, String(resolvedBookId), 1, null);
    console.log(`  ✓ GetComments 成功, 评论数: ${commentsResult.comments.length}, 最大页: ${commentsResult.maxPage}`);

    console.log("\n==================================================");
    console.log("【全部 8 项真实只读 Smoke 验证通过！】");
    console.log("==================================================");
  } finally {
    await source._disconnectHub("Smoke test completed");
  }
}

runSmoke().catch((err) => {
  console.error("\n【Smoke 验证失败】:", err);
  process.exit(1);
});
