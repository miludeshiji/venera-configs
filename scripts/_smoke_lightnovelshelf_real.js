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

// 1. 解析 RefreshToken, x-id 与可选 legacy 漫画标题
function parseCredentials() {
  let token = process.env.LIGHTNOVELSHELF_REFRESH_TOKEN || process.env.REFRESH_TOKEN || "";
  let xId = process.env.LIGHTNOVELSHELF_X_ID || process.env.X_ID || "";
  let legacyTitle = process.env.LIGHTNOVELSHELF_LEGACY_TITLE || "寄宿学校的朱丽叶";

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" || arg === "--refresh-token") {
      token = args[++i] || "";
    } else if (arg === "--x-id" || arg === "-x") {
      xId = args[++i] || "";
    } else if (arg === "--legacy-title" || arg === "--title" || arg === "-t") {
      legacyTitle = args[++i] || legacyTitle;
    } else if (!token && !arg.startsWith("-")) {
      token = arg;
    } else if (!xId && !arg.startsWith("-")) {
      xId = arg;
    } else if (!arg.startsWith("-")) {
      legacyTitle = arg;
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
  legacyTitle = String(legacyTitle || "寄宿学校的朱丽叶").trim();

  return { token, xId, legacyTitle };
}

const { token: refreshToken, xId: visitorId, legacyTitle } = parseCredentials();

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
    console.log("\n[1/9] 验证 refresh 接口...");
    const sessionToken = await source._ensureSessionToken(true);
    if (!sessionToken || typeof sessionToken !== "string") {
      throw new Error("refresh 响应未获取到有效 SessionToken");
    }
    console.log(`  ✓ refresh 成功, SessionToken 长度: ${sessionToken.length}`);

    // 2. 测试 latest / view 列表与 book:<Id> 卡片格式
    console.log("\n[2/9] 验证 GetComicList (latest & view) 原始项与 book:<Id> 卡片身份...");
    const [rawLatestResp, rawViewResp] = await Promise.all([
      source._hubCall(
        "GetComicList",
        { Page: 1, Size: 6, Order: "latest" },
        { retryTransport: true },
      ),
      source._hubCall(
        "GetComicList",
        { Page: 1, Size: 6, Order: "view" },
        { retryTransport: true },
      ),
    ]);
    const rawLatestList = source._value(rawLatestResp, "data", "Data", []);
    if (!Array.isArray(rawLatestList) || rawLatestList.length === 0) {
      throw new Error("GetComicList latest 原始列表为空");
    }
    const rawFirstItem = rawLatestList[0];
    const rawFirstId = Number(source._value(rawFirstItem, "id", "Id", NaN));
    if (!Number.isSafeInteger(rawFirstId) || rawFirstId <= 0) {
      throw new Error(`GetComicList 返回了无效代表 Book.Id: ${rawFirstId}`);
    }
    const rawFirstTitle = String(
      source._value(rawFirstItem, "title", "Title", "") || "",
    ).trim();
    const expectedDirectId = `book:${rawFirstId}`;

    const latest = source._comicListFromResponse(rawLatestResp);
    const view = source._comicListFromResponse(rawViewResp);
    if (!latest.comics || latest.comics.length === 0) {
      throw new Error("latest 转换后列表为空");
    }
    if (!view.comics || view.comics.length === 0) {
      throw new Error("view 转换后列表为空");
    }
    if (latest.comics[0].id !== expectedDirectId) {
      throw new Error(
        `列表卡片 ID 格式异常: 实际 ${latest.comics[0].id}, 期望 ${expectedDirectId}`,
      );
    }
    console.log(
      `  ✓ latest 漫画数量: ${latest.comics.length}, 样例: “${latest.comics[0].title}” (卡片 ID: ${latest.comics[0].id})`,
    );
    console.log(
      `  ✓ view 漫画数量: ${view.comics.length}, 样例: “${view.comics[0].title}” (卡片 ID: ${view.comics[0].id})`,
    );

    // 3. direct ID 冷启动加载（清空标题映射后用 book:<Id> 加载，断言坚决不发起搜索）
    console.log(
      `\n[3/9] 验证 direct ID (${expectedDirectId}) 冷启动加载（断言坚决不发起搜索）...`,
    );
    source._deleteSeriesBookMapping(rawFirstTitle, rawFirstId);
    source._clearComicContentStates();

    let searchCalledDuringDirect = false;
    const originalHubCall = source._hubCall.bind(source);
    source._hubCall = async (target, params, options) => {
      if (target === "SearchComicSeries") {
        searchCalledDuringDirect = true;
        throw new Error(
          `direct ID 路径坚决禁止调用 SearchComicSeries: ${JSON.stringify(params)}`,
        );
      }
      return await originalHubCall(target, params, options);
    };

    let directDetails;
    try {
      directDetails = await source.comic.loadInfo(expectedDirectId);
    } finally {
      source._hubCall = originalHubCall;
    }
    if (searchCalledDuringDirect) {
      throw new Error("direct ID 加载违规触发了 SearchComicSeries 搜索");
    }
    if (!directDetails || !directDetails.title) {
      throw new Error("direct ID loadInfo 未返回有效漫画详情");
    }
    console.log(
      `  ✓ direct ID 加载成功: 标题 “${directDetails.title}”, subId: ${directDetails.subId}, 断言通过: 0 次搜索`,
    );

    // 4. legacy 标题安全恢复与有界搜索只读诊断（清空 legacy 缓存后诊断并验证复用）
    console.log(
      `\n[4/9] 验证 legacy 标题安全恢复与有界搜索诊断 (目标: “${legacyTitle}”)...`,
    );
    source._deleteSeriesBookMapping(legacyTitle);
    source._seriesRepresentativeBookIds.clear();
    source._seriesRepresentativeBookIdSources.clear();
    source._seriesNegativeCache.clear();
    source._seriesLoadPromises.clear();

    console.log("  [只读安全诊断]");
    console.log("    - 内存/持久缓存: 已清空冷启动");

    try {
      const hData = await source._hubCall(
        "GetReadHistory",
        {},
        { retryTransport: true },
      );
      const hIds = source._historyIdsFromResponse(hData);
      console.log(`    - 官方历史记录数: ${hIds.length} 本`);
      if (hIds.length > 0) {
        const chunk = hIds.slice(0, 24);
        const chunkData = await source._hubCall(
          "GetBookListByIds",
          { Ids: chunk, Type: "Comic" },
          { retryTransport: true },
        );
        const chunkItems = source._value(chunkData, "data", "Data", []);
        const matchInHist = (Array.isArray(chunkItems) ? chunkItems : []).find(
          (item) =>
            String(source._value(item, "title", "Title", "") || "").trim() ===
            legacyTitle,
        );
        console.log(
          `    - 官方历史前 24 本比对: ${matchInHist ? `命中候选 Book.Id=${source._value(matchInHist, "id", "Id", "")}` : "未在首批命中"}`,
        );
      }
    } catch (hErr) {
      console.log(`    - 官方历史诊断跳过: ${hErr.message}`);
    }

    for (const mode of ["title", "exact", "name", "fuzzy"]) {
      try {
        const sData = await source._hubCall(
          "SearchComicSeries",
          {
            KeyWords: legacyTitle,
            Mode: mode,
            Page: 1,
            Size: 10,
            IgnoreJapanese: false,
            IgnoreAI: false,
          },
          { retryTransport: true },
        );
        const sItems = source._value(sData, "data", "Data", []);
        const sPages =
          Number(source._value(sData, "totalPages", "TotalPages", 1)) || 1;
        const sMatch = (Array.isArray(sItems) ? sItems : []).find(
          (item) =>
            String(source._value(item, "title", "Title", "") || "").trim() ===
            legacyTitle,
        );
        console.log(
          `    - 模式 [${mode}]: 返回 ${Array.isArray(sItems) ? sItems.length : 0} 条, 总页数 ${sPages}, 严格匹配: ${sMatch ? `命中 Book.Id=${source._value(sMatch, "id", "Id", "")}` : "未命中"}`,
        );
      } catch (sErr) {
        console.log(`    - 模式 [${mode}] 探测异常: ${sErr.message}`);
      }
    }

    let legacyResolved = null;
    let legacyErr = null;
    try {
      legacyResolved = await source._resolveRepresentativeBookId(legacyTitle, {
        detailed: true,
      });
      console.log(
        `  ✓ legacy 标题成功恢复: Book.Id=${legacyResolved.id}, 来源: ${legacyResolved.source}`,
      );
    } catch (err) {
      legacyErr = err;
      console.log(`  ℹ legacy 标题有界检索结果: ${err.message}`);
    }

    // 验证重复调用复用结果（断言二次调用复用结果，不发起网络搜索）
    let repeatSearchCount = 0;
    const trackingHubCall = source._hubCall.bind(source);
    source._hubCall = async (target, params, options) => {
      if (target === "SearchComicSeries" || target === "GetReadHistory") {
        repeatSearchCount += 1;
      }
      return await trackingHubCall(target, params, options);
    };
    try {
      if (legacyResolved) {
        const repeatRes = await source._resolveRepresentativeBookId(legacyTitle, {
          detailed: true,
        });
        if (repeatRes.id !== legacyResolved.id) {
          throw new Error(
            `重复调用结果不一致: ${repeatRes.id} vs ${legacyResolved.id}`,
          );
        }
        if (repeatSearchCount > 0) {
          throw new Error(
            `重复调用违规发起 ${repeatSearchCount} 次网络检索，未复用已恢复映射`,
          );
        }
        console.log(
          `  ✓ 二次调用成功复用结果 (Book.Id: ${repeatRes.id})，网络检索增量: 0 次`,
        );
      } else if (legacyErr) {
        let secondErr = null;
        try {
          await source._resolveRepresentativeBookId(legacyTitle, {
            detailed: true,
          });
        } catch (e) {
          secondErr = e;
        }
        if (!secondErr) {
          throw new Error("预期二次调用命中负缓存并抛出相同错误");
        }
        if (repeatSearchCount > 0) {
          throw new Error(
            `重复调用违规发起 ${repeatSearchCount} 次网络检索，负缓存未生效`,
          );
        }
        console.log(`  ✓ 二次调用成功命中负缓存，网络检索增量: 0 次`);
      }
    } finally {
      source._hubCall = trackingHubCall;
    }

    // 5. 测试 exact 搜索解析（使用前面 latest 样本标题，保证真实有效）
    const targetTitle = rawFirstTitle;
    console.log(`\n[5/9] 验证 SearchComicSeries (exact: “${targetTitle}”)...`);
    const searchResult = await source._hubCall(
      "SearchComicSeries",
      {
        KeyWords: targetTitle,
        Mode: "exact",
        Page: 1,
        Size: 20,
        IgnoreJapanese: false,
        IgnoreAI: false,
      },
      { retryTransport: true },
    );
    const searchItems = source._value(searchResult, "data", "Data", []);
    const exactMatch = (Array.isArray(searchItems) ? searchItems : []).find(
      (item) =>
        String(source._value(item, "title", "Title", "") || "").trim() ===
        targetTitle,
    );
    if (!exactMatch) {
      throw new Error(
        `SearchComicSeries exact 搜索未找到严格匹配项: “${targetTitle}”`,
      );
    }
    const exactBookId = Number(source._value(exactMatch, "id", "Id", NaN));
    if (!Number.isSafeInteger(exactBookId) || exactBookId <= 0) {
      throw new Error(
        `SearchComicSeries exact 返回了无效的 Book.Id: ${exactBookId}`,
      );
    }
    const resolvedBookId = exactBookId;
    console.log(
      `  ✓ SearchComicSeries Mode=exact 成功, 返回 Book.Id: ${resolvedBookId}`,
    );

    // 6. 测试 GetBookInfo（只读获取原始响应形态并安全诊断，再通过 comic.loadInfo 校验完整详情）
    console.log(`\n[6/9] 验证 GetBookInfo (BookId: ${resolvedBookId})...`);
    const rawBookInfo = await source._hubCall(
      "GetBookInfo",
      { Id: resolvedBookId },
      { retryTransport: true },
    );
    let responseShape = "invalid";
    let returnedBookId = null;
    let respSeriesTitle = "";
    let seriesCount = 0;
    let chaptersCount = 0;

    if (
      rawBookInfo &&
      typeof rawBookInfo === "object" &&
      !Array.isArray(rawBookInfo)
    ) {
      respSeriesTitle = String(
        source._value(rawBookInfo, "seriesTitle", "SeriesTitle", "") || "",
      );
      const rawSeries = source._value(rawBookInfo, "series", "Series", null);
      seriesCount = Array.isArray(rawSeries) ? rawSeries.length : 0;

      const rawBook = source._value(rawBookInfo, "book", "Book", null);
      if (rawBook && typeof rawBook === "object" && !Array.isArray(rawBook)) {
        responseShape = "nested-book";
        returnedBookId = Number(source._value(rawBook, "id", "Id", NaN));
        const rawChapters = source._value(
          rawBook,
          "chapters",
          "Chapters",
          null,
        );
        chaptersCount = Array.isArray(rawChapters) ? rawChapters.length : 0;
      } else {
        const rootId = Number(source._value(rawBookInfo, "id", "Id", NaN));
        const rootChapters = source._value(
          rawBookInfo,
          "chapters",
          "Chapters",
          null,
        );
        if (Number.isSafeInteger(rootId) || Array.isArray(rootChapters)) {
          responseShape = "root-book";
          returnedBookId = rootId;
          chaptersCount = Array.isArray(rootChapters)
            ? rootChapters.length
            : 0;
        }
      }
    }
    console.log(
      `  ✓ GetBookInfo 安全形态诊断: shape=${responseShape}, 请求 Id=${resolvedBookId}, 返回 Id=${returnedBookId}, SeriesTitle=“${respSeriesTitle}”, Series数=${seriesCount}, 章节数=${chaptersCount}`,
    );

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
    console.log(
      `  ✓ loadInfo 详情解析成功, 标题: “${details.title}”, 分组数: ${chapterGroups.length}`,
    );
    console.log(
      `  ✓ 选定章节 [${sampleChapterIdStr}] “${sampleChapterTitle}” 用于后续只读测试`,
    );

    // 7. 测试 GetComicContent (只读第 1 批，验证 Chapter.Id 与 BookId 回填)
    console.log(`\n[7/9] 验证 GetComicContent (Cid: ${sampleChapterId})...`);
    const contentBatch = await source._loadComicContentBatch(
      targetTitle,
      sampleChapterId,
      0,
    );
    if (
      !contentBatch ||
      !Array.isArray(contentBatch.images) ||
      contentBatch.images.length === 0
    ) {
      throw new Error("GetComicContent 未返回图片列表");
    }
    const backfilledBookId = source._comicChapterBookIds.get(
      source._comicChapterBookIdKey(targetTitle, sampleChapterId),
    );
    console.log(
      `  ✓ GetComicContent 成功, 总页数: ${contentBatch.total}, 本批页数: ${contentBatch.images.length}`,
    );
    console.log(
      `  ✓ Chapter.BookId 回填检查: ${backfilledBookId ? `已回填 (BookId: ${backfilledBookId})` : "未回填 (章节无单独 BookId)"}`,
    );

    // 8. 测试 GetReadHistory & GetBookListByIds
    console.log("\n[8/9] 验证 GetReadHistory & GetBookListByIds (只读拉取)...");
    const historyData = await source._hubCall(
      "GetReadHistory",
      {},
      { retryTransport: true },
    );
    const historyIds = source._historyIdsFromResponse(historyData);
    console.log(`  ✓ GetReadHistory 成功, 历史记录 ID 数: ${historyIds.length}`);

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

    // 9. 测试 GetComments (Type=Book)
    console.log(`\n[9/9] 验证 GetComments (Type: Book, Id: ${resolvedBookId})...`);
    const commentsResult = await source.comic.loadComments(
      targetTitle,
      String(resolvedBookId),
      1,
      null,
    );
    console.log(
      `  ✓ GetComments 成功, 评论数: ${commentsResult.comments.length}, 最大页: ${commentsResult.maxPage}`,
    );

    console.log("\n==================================================");
    console.log("【全部 9 项真实只读 Smoke 验证通过！】");
    console.log("==================================================");
  } finally {
    await source._disconnectHub("Smoke test completed");
  }
}

runSmoke().catch((err) => {
  console.error("\n【Smoke 验证失败】:", err);
  process.exit(1);
});
