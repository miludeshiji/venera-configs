/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.2.2
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - HTTP Long Polling transport
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - Long Polling 防缓存参数
 * - 漫画列表 / 搜索 / 详情 / 章节 / 正文图片
 *
 * 使用前：
 * 1. 在轻书架官网正常登录。
 * 2. 从浏览器开发者工具中取得登录响应里的 RefreshToken。
 * 3. 从 HTTP 请求头中取得 x-id / Visitor ID。
 * 4. 在 Venera 的本漫画源设置中填入这两个值。
 */
class LightNovelShelf extends ComicSource {
  name = "轻书架";
  key = "LightNovelShelf";
  version = "0.2.3";
  minAppVersion = "1.0.0";

  // 如果以后把本文件放到 GitHub，可改为 raw 文件地址用于在线更新。
  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";

  // 当前短期会话 Token，仅保存在当前 JS 运行实例中。
  _sessionToken = "";
  _sessionTokenAt = 0;

  get apiBase() {
    return this.loadSetting("apiServer") || "https://api.lightnovel.life";
  }

  get siteBase() {
    return "https://www.lightnovel.app";
  }

  get userAgent() {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  }

  _headers(extra) {
    return Object.assign(
      {
        "User-Agent": this.userAgent,
        Accept: "*/*",
      },
      extra || {},
    );
  }

  _textHeaders() {
    return this._headers({
      "Content-Type": "text/plain;charset=UTF-8",
    });
  }

  _jsonHeaders(extra) {
    return this._headers(
      Object.assign(
        {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        extra || {},
      ),
    );
  }

  _authHeaders(extra) {
    const headers = this._headers(extra);

    if (this._sessionToken) {
      headers.Authorization = "Bearer " + this._sessionToken;
    }

    return headers;
  }

  _authTextHeaders(extra) {
    return this._authHeaders(
      Object.assign(
        {
          "Content-Type": "text/plain;charset=UTF-8",
        },
        extra || {},
      ),
    );
  }

  _assertStatus(res, expected, action) {
    const ok = Array.isArray(expected)
      ? expected.indexOf(res.status) >= 0
      : res.status === expected;

    if (!ok) {
      throw `${action || "请求"}失败: HTTP ${res.status}${
        res.body ? `\n${res.body}` : ""
      }`;
    }
  }

  _frames(body) {
    if (!body) return [];

    return body
      .split("\x1e")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch (_) {
          return null;
        }
      })
      .filter((x) => x !== null);
  }

  _normalizeUrl(url) {
    if (!url || typeof url !== "string") return url;

    if (url.startsWith("https://") || url.startsWith("http://")) {
      return url;
    }

    if (url.startsWith("//")) {
      return "https:" + url;
    }

    if (url.startsWith("/")) {
      return this.apiBase + url;
    }

    return this.apiBase + "/" + url;
  }

  _isUnauthorizedError(error) {
    const text = String(error || "").toLowerCase();
    return (
      text.includes("user is unauthorized") ||
      text.includes("unauthorized") ||
      text.includes("未授权") ||
      text.includes("未登录")
    );
  }

  _getVisitorId() {
    const value = this.loadSetting("visitorId");

    if (!value || !String(value).trim()) {
      throw (
        "轻书架需要 x-id / Visitor ID。\n" +
        "请在轻书架网页已登录状态下打开浏览器开发者工具，从请求头中复制 x-id，然后填入漫画源设置。"
      );
    }

    return String(value).trim();
  }

  _getRefreshToken() {
    const value = this.loadSetting("refreshToken");

    if (!value || !String(value).trim()) {
      throw (
        "轻书架需要登录。\n" +
        "请先在轻书架官网正常登录，再从登录响应中复制 RefreshToken，并填入漫画源设置。"
      );
    }

    return String(value).trim();
  }

  /**
   * 使用长期 RefreshToken 换取 SignalR 使用的短期会话 Token。
   *
   * 官方 Web 对应：
   * POST /api/user/refresh_token
   * body: { token: RefreshToken }
   * header: x-id: visitorId
   */
  async _refreshSessionToken(force) {
    // 避免短时间内多个首页区块同时创建连接时重复刷新。
    if (
      !force &&
      this._sessionToken &&
      Date.now() - this._sessionTokenAt < 15000
    ) {
      return this._sessionToken;
    }

    const refreshToken = this._getRefreshToken();
    const visitorId = this._getVisitorId();
    const url = this.apiBase + "/api/user/refresh_token";

    const res = await Network.post(
      url,
      this._jsonHeaders({
        "x-id": visitorId,
      }),
      JSON.stringify({
        token: refreshToken,
      }),
    );

    this._assertStatus(res, 200, "刷新轻书架登录状态");

    let envelope;
    try {
      envelope = JSON.parse(res.body);
    } catch (_) {
      throw (
        "刷新轻书架登录状态失败：服务器返回了无效 JSON\n" +
        (res.body || "")
      );
    }

    // 官方 requestWithFetch 会自动解包 Success/Response/Status/Msg；
    // Venera Network.post 返回原始响应，因此这里手动解包。
    if (
      envelope &&
      typeof envelope === "object" &&
      Object.prototype.hasOwnProperty.call(envelope, "Success")
    ) {
      if (!envelope.Success) {
        this._sessionToken = "";
        this._sessionTokenAt = 0;

        throw (
          "RefreshToken 无效、已过期或账号状态异常" +
          (envelope.Status !== undefined ? ` [${envelope.Status}]` : "") +
          (envelope.Msg ? `: ${envelope.Msg}` : "")
        );
      }

      envelope = envelope.Response;
    }

    let token = envelope;

    // 兼容服务端未来返回 { Token: "..." } 之类的对象。
    if (token && typeof token === "object") {
      token = token.Token || token.token || token.AccessToken || token.accessToken;
    }

    if (!token || typeof token !== "string") {
      this._sessionToken = "";
      this._sessionTokenAt = 0;
      throw "刷新轻书架登录状态失败：响应中没有可用的会话 Token";
    }

    this._sessionToken = token;
    this._sessionTokenAt = Date.now();

    return token;
  }

  /**
   * 给 Long Polling GET 添加唯一查询参数。
   *
   * VeneraNext 的 Network.get 对完全相同 URL 可能命中缓存；
   * 如果不改变 URL，会把旧的 handshake/公告响应重复返回，
   * 导致看不到 Hub Completion。
   */
  _pollUrl(session) {
    session.pollSeq = (session.pollSeq || 0) + 1;

    return (
      session.url +
      "&_venera_poll=" +
      Date.now() +
      "_" +
      session.pollSeq
    );
  }

  _pollHeaders() {
    return this._authHeaders({
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    });
  }

  /**
   * 建立一个已认证的 SignalR Long Polling 会话。
   *
   * 流程：
   * RefreshToken -> session Token
   * negotiate
   * -> 首次 GET 初始化 transport
   * -> JSON handshake
   * -> GET handshake response
   */
  async _openHub(forceRefresh) {
    await this._refreshSessionToken(!!forceRefresh);

    const hubUrl = this.apiBase + "/hub/api";
    const negotiateUrl = hubUrl + "/negotiate?negotiateVersion=1";

    const negotiateRes = await Network.post(
      negotiateUrl,
      this._authTextHeaders(),
      "",
    );

    this._assertStatus(negotiateRes, 200, "SignalR negotiate");

    let negotiate;
    try {
      negotiate = JSON.parse(negotiateRes.body);
    } catch (_) {
      throw "SignalR negotiate 返回了无效 JSON";
    }

    if (negotiate.error) {
      throw `SignalR negotiate 失败: ${negotiate.error}`;
    }

    // 当前轻书架是自托管 Hub；暂不处理 Azure SignalR 的二次 redirect negotiate。
    if (negotiate.url) {
      throw (
        "SignalR 返回了重定向地址，当前源暂未实现重定向协商: " +
        negotiate.url
      );
    }

    const connectionToken = negotiate.connectionToken || negotiate.connectionId;

    if (!connectionToken) {
      throw "SignalR negotiate 未返回 connectionToken/connectionId";
    }

    const transports = negotiate.availableTransports || [];
    const longPolling = transports.find((x) => x.transport === "LongPolling");

    if (!longPolling) {
      throw "服务端没有提供 SignalR LongPolling transport";
    }

    if (
      Array.isArray(longPolling.transferFormats) &&
      longPolling.transferFormats.indexOf("Text") < 0
    ) {
      throw "服务端 LongPolling 不支持 Text transfer format";
    }

    const session = {
      url: hubUrl + "?id=" + encodeURIComponent(connectionToken),
      seq: 0,
      pollSeq: 0,
    };

    // SignalR Long Polling 的第一次 GET 用于初始化 transport。
    const initRes = await Network.get(
      this._pollUrl(session),
      this._pollHeaders(),
    );

    this._assertStatus(initRes, 200, "SignalR transport 初始化");

    // Hub handshake 固定为 JSON，并以 0x1e Record Separator 结束。
    const handshake = JSON.stringify({ protocol: "json", version: 1 }) + "\x1e";

    const sendHandshakeRes = await Network.post(
      session.url,
      this._authTextHeaders(),
      handshake,
    );

    this._assertStatus(sendHandshakeRes, 200, "SignalR handshake 发送");

    // 服务端通常在下一次 poll 返回：{}\x1e，并可能同时推送 OnMessage 公告。
    let handshakeDone = false;

    for (let i = 0; i < 6 && !handshakeDone; i++) {
      const poll = await Network.get(
        this._pollUrl(session),
        this._pollHeaders(),
      );

      if (poll.status === 204) {
        throw "SignalR handshake 阶段连接已被服务端关闭";
      }

      this._assertStatus(poll, 200, "SignalR handshake 接收");

      for (const frame of this._frames(poll.body)) {
        if (frame.error) {
          throw `SignalR handshake 失败: ${frame.error}`;
        }

        if (typeof frame === "object" && Object.keys(frame).length === 0) {
          handshakeDone = true;
          break;
        }
      }
    }

    if (!handshakeDone) {
      throw "SignalR handshake 未收到有效响应";
    }

    return session;
  }

  async _closeHub(session) {
    if (!session || !session.url) return;

    try {
      await Network.delete(session.url, this._authHeaders());
    } catch (_) {
      // 关闭失败不影响已经取得的漫画数据。
    }
  }

  /**
   * 在已建立的 SignalR 会话中调用 Hub Method。
   */
  async _hubInvoke(session, target, params) {
    const invocationId = String(++session.seq);

    const message =
      JSON.stringify({
        type: 1,
        invocationId: invocationId,
        target: target,
        // 官方 Web 默认 UseGzip=true；这里关闭 gzip，直接让服务端返回 JSON 对象。
        arguments: [params, { UseGzip: false }],
      }) + "\x1e";

    const send = await Network.post(
      session.url,
      this._authTextHeaders(),
      message,
    );

    this._assertStatus(send, 200, `SignalR invoke ${target}`);

    // 正常调用通常在下一次 poll 就会收到 Completion；Ping/空轮询则继续。
    for (let i = 0; i < 20; i++) {
      const poll = await Network.get(
        this._pollUrl(session),
        this._pollHeaders(),
      );

      if (poll.status === 204) {
        throw `SignalR 连接已关闭 (${target})`;
      }

      this._assertStatus(poll, 200, `SignalR poll ${target}`);

      for (const frame of this._frames(poll.body)) {
        // type 1 = Invocation（例如服务器主动 OnMessage 公告），不是当前请求结果。
        if (frame.type === 1) {
          continue;
        }

        // type 6 = Ping
        if (frame.type === 6) {
          continue;
        }

        // type 7 = Close
        if (frame.type === 7) {
          throw `SignalR 服务端关闭连接${
            frame.error ? `: ${frame.error}` : ""
          }`;
        }

        // type 3 = Completion
        if (
          frame.type === 3 &&
          String(frame.invocationId) === invocationId
        ) {
          if (frame.error) {
            throw `SignalR ${target} 调用失败: ${frame.error}`;
          }

          let envelope = frame.result;

          // 轻书架目前的 Hub JSON 使用 camelCase：
          // { response: ... }
          // 旧实现/其他线路可能仍返回 PascalCase：
          // { Success, Response, Status, Msg }
          // 因此这里同时兼容两种字段风格。
          if (envelope && typeof envelope === "object") {
            const hasSuccess =
              Object.prototype.hasOwnProperty.call(envelope, "Success") ||
              Object.prototype.hasOwnProperty.call(envelope, "success");

            if (hasSuccess) {
              const success =
                envelope.Success !== undefined
                  ? envelope.Success
                  : envelope.success;

              if (!success) {
                const status =
                  envelope.Status !== undefined
                    ? envelope.Status
                    : envelope.status;
                const msg =
                  envelope.Msg !== undefined
                    ? envelope.Msg
                    : envelope.msg;

                throw `${target} 失败${
                  status !== undefined ? ` [${status}]` : ""
                }: ${msg || "Unknown error"}`;
              }
            }

            // 当前轻书架实际返回 { response: ... }。
            if (Object.prototype.hasOwnProperty.call(envelope, "response")) {
              return envelope.response;
            }

            if (Object.prototype.hasOwnProperty.call(envelope, "Response")) {
              return envelope.Response;
            }
          }

          return envelope;
        }
      }
    }

    throw `等待 SignalR ${target} 返回结果超时`;
  }

  /**
   * 单次 Hub 调用。
   *
   * 如果服务端明确返回 unauthorized，则强制刷新一次 Token、
   * 新建 SignalR 连接并重试一次。
   */
  async _hubCall(target, params) {
    let session = null;

    try {
      session = await this._openHub(false);
      return await this._hubInvoke(session, target, params);
    } catch (error) {
      if (!this._isUnauthorizedError(error)) {
        throw error;
      }

      await this._closeHub(session);
      session = null;

      this._sessionToken = "";
      this._sessionTokenAt = 0;

      session = await this._openHub(true);
      return await this._hubInvoke(session, target, params);
    } finally {
      await this._closeHub(session);
    }
  }

  _value(obj, lowerName, upperName, fallback) {
    if (!obj || typeof obj !== "object") return fallback;

    if (obj[lowerName] !== undefined && obj[lowerName] !== null) {
      return obj[lowerName];
    }

    if (upperName && obj[upperName] !== undefined && obj[upperName] !== null) {
      return obj[upperName];
    }

    return fallback;
  }

  _comicFromListItem(item) {
    const title = this._value(item, "title", "Title", "");
    const count = Number(this._value(item, "count", "Count", 0) || 0);
    const original = this._value(item, "originalTitle", "OriginalTitle", "") || "";
    const updated = this._value(item, "lastUpdatedAt", "LastUpdatedAt", "") || "";
    const cover = this._value(item, "cover", "Cover", "") || "";

    return {
      // GetComicSeriesInfo 使用 SeriesTitle 查询，所以仍以标题作为 comic id。
      id: String(title),
      title: String(title),
      subTitle: original || (count ? `${count} 本` : ""),
      cover: this._normalizeUrl(cover),
      tags: [],
      description: [
        count ? `共 ${count} 本` : "",
        updated ? `更新: ${updated}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  async _loadComicList(order, page) {
    const data = await this._hubCall("GetComicList", {
      Page: page,
      Size: 20,
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

  explore = [
    {
      title: "最近更新",
      type: "multiPageComicList",
      load: async (page) => {
        return await this._loadComicList("latest", page);
      },
    },
    {
      title: "热门漫画",
      type: "multiPageComicList",
      load: async (page) => {
        return await this._loadComicList("view", page);
      },
    },
    {
      title: "最新收录",
      type: "multiPageComicList",
      load: async (page) => {
        return await this._loadComicList("new", page);
      },
    },
  ];

  search = {
    load: async (keyword, options, page) => {
      const data = await this._hubCall("SearchComicSeries", {
        KeyWords: keyword,
        Mode: "fuzzy",
        Page: page,
        Size: 20,
        IgnoreJapanese: !!this.loadSetting("ignoreJapanese"),
        IgnoreAI: !!this.loadSetting("ignoreAI"),
      });

      const list = this._value(data, "data", "Data", []);
      const totalPages = this._value(data, "totalPages", "TotalPages", 1);

      return {
        comics: (Array.isArray(list) ? list : []).map((x) =>
          this._comicFromListItem(x),
        ),
        maxPage: Number(totalPages || 1),
      };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      const data = await this._hubCall("GetComicSeriesInfo", {
        SeriesTitle: id,
        Order: "latest",
      });

      const series = this._value(data, "series", "Series", null);
      const booksRaw = this._value(data, "books", "Books", []);
      const books = Array.isArray(booksRaw) ? booksRaw : [];

      if (!series) {
        throw "GetComicSeriesInfo 未返回 series/Series";
      }

      // Venera 1.3.0+ 支持章节分组：
      // Map<分组名, Map<章节ID, 章节名>>。
      // 轻书架中每个 books[] 项代表一份由某个上传者维护的漫画内容，
      // 因此每个 book 独立作为一个章节分组。
      const groupedChapters = new Map();
      const flatChapters = new Map();
      const usedGroupNames = new Set();

      // 预先统计 book.title，便于不同上传者使用同名 title 时同时标注上传者。
      const bookTitleCounts = {};
      for (const book of books) {
        const title = String(this._value(book, "title", "Title", "") || "").trim();
        if (title) {
          bookTitleCounts[title] = (bookTitleCounts[title] || 0) + 1;
        }
      }

      for (let bookIndex = 0; bookIndex < books.length; bookIndex++) {
        const book = books[bookIndex];
        const chaptersRaw = this._value(book, "chapters", "Chapters", []);
        const list = (Array.isArray(chaptersRaw) ? chaptersRaw : [])
          .slice()
          .sort((a, b) => {
            const aSort = Number(this._value(a, "sortNum", "SortNum", 0) || 0);
            const bSort = Number(this._value(b, "sortNum", "SortNum", 0) || 0);
            return aSort - bSort;
          });

        const uploader = this._value(book, "uploader", "Uploader", {}) || {};
        const uploaderName =
          this._value(uploader, "userName", "UserName", "") ||
          this._value(uploader, "username", "Username", "") ||
          "";

        // 按轻书架返回的 book.title 作为章节分组名。
        // 若不同上传者恰好使用了完全相同的 title，Map 的 key 会冲突，
        // 此时追加上传者名称，仅用于保证不同上传者的分组不会互相覆盖。
        const rawBookTitle =
          String(this._value(book, "title", "Title", "") || "").trim();

        let groupName =
          rawBookTitle ||
          String(uploaderName || "").trim() ||
          `上传源 ${bookIndex + 1}`;

        // 正常情况下严格使用上传者为该 book 设置的 title。
        // 若多个上传者设置了完全相同的 title，则同时追加上传者名，
        // 既保留原 title，又避免外层 Map 因同名 key 覆盖掉其中一个上传源。
        if (rawBookTitle && bookTitleCounts[rawBookTitle] > 1 && uploaderName) {
          groupName = `${rawBookTitle}（${uploaderName}）`;
        }

        if (usedGroupNames.has(groupName)) {
          const candidateBase = groupName;
          let suffix = 2;
          while (usedGroupNames.has(groupName)) {
            groupName = `${candidateBase} #${suffix++}`;
          }
        }
        usedGroupNames.add(groupName);

        const group = new Map();

        for (const chapter of list) {
          const chapterId = this._value(chapter, "id", "Id", "");
          const sortNum = this._value(chapter, "sortNum", "SortNum", "");
          const chapterTitle = this._value(chapter, "title", "Title", "");
          const chapterName = chapterTitle || `第 ${sortNum} 话`;

          if (chapterId !== "" && chapterId !== null && chapterId !== undefined) {
            const id = String(chapterId);
            group.set(id, chapterName);

            // 兼容 Venera 1.3.0 之前不支持章节分组的版本。
            flatChapters.set(id, `${groupName} · ${chapterName}`);
          }
        }

        // 即使某个上传源暂时没有章节，也不加入空分组。
        if (group.size > 0) {
          groupedChapters.set(groupName, group);
        }
      }

      // VeneraNext 当前版本已原生支持多章节分组，直接返回嵌套 Map。
      // 不再调用 isAppVersionAfter()，避免因源中缺少该辅助方法导致详情页报错。
      const chapters = groupedChapters;

      const extra = this._value(series, "extra", "Extra", {}) || {};
      const classification =
        this._value(extra, "classification", "Classification", {}) || {};

      const tagMap = {};
      const author = this._value(series, "author", "Author", "") || "";
      const originalTitle =
        this._value(series, "originalTitle", "OriginalTitle", "") || "";
      const tags = this._value(classification, "tags", "Tags", []);

      if (author) {
        tagMap["作者"] = [String(author)];
      }

      if (Array.isArray(tags) && tags.length) {
        tagMap["标签"] = tags.map(String);
      }

      if (originalTitle) {
        tagMap["原名"] = [String(originalTitle)];
      }

      return {
        title: String(this._value(series, "title", "Title", id) || id),
        subTitle: originalTitle || author || "",
        cover: this._normalizeUrl(
          this._value(series, "cover", "Cover", "") || "",
        ),
        description:
          this._value(series, "introduction", "Introduction", "") || "",
        tags: tagMap,
        chapters: chapters,
        updateTime:
          this._value(series, "lastUpdatedAt", "LastUpdatedAt", null),
        uploadTime: this._value(series, "createdAt", "CreatedAt", null),
      };
    },

    loadEp: async (comicId, epId) => {
      const cid = Number(epId);

      if (!Number.isFinite(cid)) {
        throw `无效章节 ID: ${epId}`;
      }

      // GetComicContent 一次最多读取 12 页。
      // 同一 SignalR session 内循环读取整章，减少 negotiate/handshake 次数。
      let session = null;

      const loadWholeChapter = async (forceRefresh) => {
        session = await this._openHub(forceRefresh);

        const images = [];
        let skip = 0;
        let total = 0;

        for (let batchIndex = 0; batchIndex < 500; batchIndex++) {
          const data = await this._hubInvoke(session, "GetComicContent", {
            Cid: cid,
            Skip: skip,
            Take: 12,
          });

          const chapter = this._value(data, "chapter", "Chapter", null);

          if (!chapter) {
            throw "GetComicContent 未返回 chapter/Chapter";
          }

          const imagesRaw = this._value(chapter, "images", "Images", []);
          const batch = Array.isArray(imagesRaw) ? imagesRaw : [];
          total = Number(this._value(chapter, "total", "Total", 0) || 0);

          for (const image of batch) {
            images.push(this._normalizeUrl(image));
          }

          if (batch.length === 0) break;

          skip += batch.length;

          if (total > 0 && skip >= total) break;
          if (total <= 0 && batch.length < 12) break;
        }

        if (!images.length) {
          throw "该章节未返回任何图片";
        }

        return { images: images };
      };

      try {
        try {
          return await loadWholeChapter(false);
        } catch (error) {
          if (!this._isUnauthorizedError(error)) {
            throw error;
          }

          await this._closeHub(session);
          session = null;

          this._sessionToken = "";
          this._sessionTokenAt = 0;

          return await loadWholeChapter(true);
        }
      } finally {
        await this._closeHub(session);
      }
    },

    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          "User-Agent": this.userAgent,
          Referer: this.siteBase + "/",
        },
      };
    },

    onThumbnailLoad: (url) => {
      return {
        headers: {
          "User-Agent": this.userAgent,
          Referer: this.siteBase + "/",
        },
      };
    },

    // 详情页标签点击行为。
    // 作者和普通标签均直接跳转到轻书架搜索。
    onClickTag: (namespace, tag) => {
      if (namespace === "作者" || namespace === "标签") {
        return {
          action: "search",
          keyword: String(tag),
          param: null,
        };
      }

      throw "未支持此类 Tag 检索";
    },
  };

  settings = {
    refreshToken: {
      title: "RefreshToken",
      type: "input",
      validator: null,
      default: "",
    },

    visitorId: {
      title: "x-id / Visitor ID",
      type: "input",
      validator: null,
      default: "",
    },

    apiServer: {
      title: "API 线路",
      type: "select",
      options: [
        {
          value: "https://api.lightnovel.life",
          text: "HK / 默认",
        },
        {
          value: "https://cf-api.lightnovel.life",
          text: "Cloudflare",
        },
      ],
      default: "https://api.lightnovel.life",
    },

    ignoreJapanese: {
      title: "搜索时忽略日文原文",
      type: "switch",
      default: false,
    },

    ignoreAI: {
      title: "搜索时忽略 AI 内容",
      type: "switch",
      default: false,
    },
  };
}
