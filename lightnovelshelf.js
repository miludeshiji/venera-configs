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

  // 如果以后把本文件放到 GitHub，可改为 raw 文件地址用于在线更新。
  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";

  // 当前短期会话 Token，仅保存在当前 JS 运行实例中。
  _sessionToken = "";
  _sessionTokenAt = 0;

  // 每日签到状态：成功日期持久化，尝试日期只作用于当前 JS 实例。
  _signInInProgress = false;
  _autoSignInAttemptDate = "";

  // 阅读历史仅缓存当前列表会话；第 1 页、非连续分页和退出账号时重置。
  _historyComicIds = null;
  _historySeenSeries = new Set();
  _historyNextPage = 1;
  _historyRequestGeneration = 0;

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

  _utcDate() {
    return new Date().toISOString().slice(0, 10);
  }

  _isAlreadySignedError(error) {
    const text = String(error && error.message ? error.message : error)
      .toLowerCase();
    return (
      text.includes("已签到") ||
      text.includes("已经签到") ||
      text.includes("already signed") ||
      text.includes("already checked in")
    );
  }

  async _performDailySignIn() {
    const authSnapshot = this.loadData("refreshToken");
    this._signInInProgress = true;

    try {
      const data = await this._hubCall("SignIn", {});
      const streak = Number(this._value(data, "streak", "Streak", NaN));
      const reward = Number(this._value(data, "reward", "Reward", NaN));
      const coinReward = Number(
        this._value(data, "coinReward", "CoinReward", NaN),
      );

      if (
        !Number.isFinite(streak) ||
        !Number.isFinite(reward) ||
        !Number.isFinite(coinReward)
      ) {
        throw new Error("签到响应格式异常");
      }

      // 请求期间若退出或切换账号，不记录旧账号的结果。
      if (this.loadData("refreshToken") !== authSnapshot) {
        return null;
      }

      this.saveData("lastSignInUtcDate", this._utcDate());
      return {
        streak: streak,
        reward: reward,
        coinReward: coinReward,
      };
    } finally {
      this._signInInProgress = false;
    }
  }

  async dailySignIn(isTask = false) {
    const automatic = !!isTask;
    const today = this._utcDate();

    if (!this.isLogged) {
      if (!automatic) UI.showMessage("请先登录轻书架账号");
      return null;
    }

    if (this.loadData("lastSignInUtcDate") === today) {
      if (!automatic) UI.showMessage("今日已签到");
      return null;
    }

    if (this._signInInProgress) {
      if (!automatic) UI.showMessage("签到正在进行中");
      return null;
    }

    try {
      const result = await this._performDailySignIn();
      if (!result) return null;

      UI.showMessage(
        `签到成功：连续 ${result.streak} 天，经验 +${result.reward}，金币 +${result.coinReward}`,
      );
      return result;
    } catch (error) {
      if (!automatic) {
        UI.showMessage(
          this._isAlreadySignedError(error)
            ? "今日已签到"
            : "签到失败，请稍后重试",
        );
      }
      return null;
    }
  }

  _tryAutoSignIn() {
    try {
      if (!this.loadSetting("dailySignInTask")) return;
      if (!this.isLogged || this._signInInProgress) return;

      const today = this._utcDate();
      if (this.loadData("lastSignInUtcDate") === today) return;
      if (this._autoSignInAttemptDate === today) return;

      // 先记录尝试，防止紧邻的多个 Hub 请求同时启动签到。
      this._autoSignInAttemptDate = today;
      const task = this.dailySignIn(true);
      if (task && typeof task.catch === "function") {
        task.catch(() => {});
      }
    } catch (_) {
      // 自动签到不得影响原漫画请求。
    }
  }

  _getVisitorId() {
    const saved = this.loadData("visitorId");
    const normalizedSaved = String(saved == null ? "" : saved)
      .trim()
      .replace(/-/g, "")
      .toLowerCase();

    if (/^[0-9a-f]{32}$/.test(normalizedSaved)) {
      if (saved !== normalizedSaved) {
        this.saveData("visitorId", normalizedSaved);
      }
      return normalizedSaved;
    }

    const generated = String(createUuid())
      .trim()
      .replace(/-/g, "")
      .toLowerCase();

    if (!/^[0-9a-f]{32}$/.test(generated)) {
      throw new Error("生成轻书架设备标识失败");
    }

    this.saveData("visitorId", generated);
    return generated;
  }

  _getRefreshToken() {
    const value = this.loadData("refreshToken");

    if (!value || !String(value).trim()) {
      throw new Error(
        "轻书架需要登录。请在 Venera 漫画源设置的账号区域登录轻书架。",
      );
    }

    return String(value).trim();
  }

  _hashPassword(password) {
    const hash = Convert.hexEncode(
      Convert.sha256(Convert.encodeUtf8(password)),
    );
    const normalized = String(hash || "").toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error("生成轻书架密码摘要失败");
    }

    return normalized;
  }

  async _login(account, pwd) {
    const email = String(account == null ? "" : account).trim();
    const password = String(pwd == null ? "" : pwd);

    if (!email) {
      throw new Error("轻书架登录失败：邮箱不能为空");
    }
    if (!password) {
      throw new Error("轻书架登录失败：密码不能为空");
    }

    const visitorId = this._getVisitorId();
    const passwordHash = this._hashPassword(password);
    const res = await Network.post(
      this.apiBase + "/api/user/login",
      this._jsonHeaders({
        "x-id": visitorId,
      }),
      JSON.stringify({
        email: email,
        password: passwordHash,
      }),
    );

    if (!res || res.status !== 200) {
      const status = res && res.status !== undefined ? res.status : "未知";
      throw new Error(`轻书架登录失败: HTTP ${status}`);
    }

    let envelope;
    try {
      envelope = JSON.parse(res.body);
    } catch (_) {
      throw new Error("轻书架登录失败：服务器返回了无效 JSON");
    }

    if (
      !envelope ||
      typeof envelope !== "object" ||
      !Object.prototype.hasOwnProperty.call(envelope, "Success")
    ) {
      throw new Error("轻书架登录失败：服务器响应格式错误");
    }

    if (!envelope.Success) {
      const status =
        envelope.Status !== undefined ? ` [${envelope.Status}]` : "";
      const message =
        typeof envelope.Msg === "string" && envelope.Msg.trim()
          ? `: ${envelope.Msg.trim()}`
          : "";
      throw new Error(`轻书架登录失败${status}${message}`);
    }

    const result = envelope.Response;
    const refreshToken =
      result && typeof result.RefreshToken === "string"
        ? result.RefreshToken.trim()
        : "";
    const sessionToken =
      result && typeof result.Token === "string" ? result.Token.trim() : "";

    if (!refreshToken || !sessionToken) {
      throw new Error("轻书架登录失败：响应缺少 RefreshToken 或 Token");
    }

    this.saveData("refreshToken", refreshToken);
    this._sessionToken = sessionToken;
    this._sessionTokenAt = Date.now();

    return email;
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

    if (!res || res.status !== 200) {
      this._sessionToken = "";
      this._sessionTokenAt = 0;
      const status = res && res.status !== undefined ? res.status : "未知";
      throw new Error(
        `刷新轻书架登录状态失败: HTTP ${status}。请在 Venera 中重新登录。`,
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(res.body);
    } catch (_) {
      this._sessionToken = "";
      this._sessionTokenAt = 0;
      throw new Error(
        "刷新轻书架登录状态失败：服务器返回了无效 JSON。请在 Venera 中重新登录。",
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

        const status =
          envelope.Status !== undefined ? ` [${envelope.Status}]` : "";
        const message =
          typeof envelope.Msg === "string" && envelope.Msg.trim()
            ? `: ${envelope.Msg.trim()}`
            : "";
        throw new Error(
          `轻书架登录已失效${status}${message}。请在 Venera 中重新登录。`,
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
      throw new Error(
        "刷新轻书架登录状态失败：响应中没有可用的会话 Token。请在 Venera 中重新登录。",
      );
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

  _unwrapHubResult(target, envelope) {
    // 轻书架目前的 Hub JSON 使用 camelCase：{ response: ... }。
    // 旧实现/其他线路可能仍返回 PascalCase：
    // { Success, Response, Status, Msg }。
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
            envelope.Msg !== undefined ? envelope.Msg : envelope.msg;

          throw `${target} 失败${
            status !== undefined ? ` [${status}]` : ""
          }: ${msg || "Unknown error"}`;
        }
      }

      if (Object.prototype.hasOwnProperty.call(envelope, "response")) {
        return envelope.response;
      }

      if (Object.prototype.hasOwnProperty.call(envelope, "Response")) {
        return envelope.Response;
      }
    }

    return envelope;
  }

  /**
   * 在已建立的 SignalR 会话中调用单个 Hub Method。
   */
  async _hubInvoke(session, target, params) {
    const results = await this._hubInvokeMany(session, target, [params]);
    return results[0];
  }

  /**
   * 在同一个 SignalR transport payload 中批量发送多个 Invocation，
   * 再按 invocationId 收集可能乱序到达的 Completion。
   */
  async _hubInvokeMany(session, target, paramsList) {
    if (!Array.isArray(paramsList) || paramsList.length === 0) {
      return [];
    }

    const invocations = paramsList.map((params, index) => {
      const invocationId = String(++session.seq);
      const message =
        JSON.stringify({
          type: 1,
          invocationId: invocationId,
          target: target,
          // 官方 Web 默认 UseGzip=true；这里关闭 gzip，直接返回 JSON 对象。
          arguments: [params, { UseGzip: false }],
        }) + "\x1e";

      return { invocationId: invocationId, index: index, message: message };
    });

    const pending = new Map(
      invocations.map((item) => [item.invocationId, item.index]),
    );
    const results = new Array(invocations.length);
    const payload = invocations.map((item) => item.message).join("");

    const send = await Network.post(
      session.url,
      this._authTextHeaders(),
      payload,
    );

    this._assertStatus(send, 200, `SignalR invoke ${target}`);

    // 通常一次 poll 会携带多个 Completion；若服务端分批推送则继续轮询。
    const maxPolls = Math.max(20, invocations.length * 2);

    for (let i = 0; i < maxPolls; i++) {
      const poll = await Network.get(
        this._pollUrl(session),
        this._pollHeaders(),
      );

      if (poll.status === 204) {
        throw `SignalR 连接已关闭 (${target})`;
      }

      this._assertStatus(poll, 200, `SignalR poll ${target}`);

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
        if (!pending.has(invocationId)) {
          continue;
        }

        if (frame.error) {
          throw `SignalR ${target} 调用失败: ${frame.error}`;
        }

        const index = pending.get(invocationId);
        results[index] = this._unwrapHubResult(target, frame.result);
        pending.delete(invocationId);
      }

      if (pending.size === 0) {
        return results;
      }
    }

    throw `等待 SignalR ${target} 返回结果超时（剩余 ${pending.size}/${invocations.length}）`;
  }

  /**
   * 单次 Hub 调用。
   *
   * 如果服务端明确返回 unauthorized，则强制刷新一次 Token、
   * 新建 SignalR 连接并重试一次。
   */
  async _hubCall(target, params) {
    let session = null;
    let succeeded = false;

    try {
      session = await this._openHub(false);
      const result = await this._hubInvoke(session, target, params);
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

      session = await this._openHub(true);
      const result = await this._hubInvoke(session, target, params);
      succeeded = true;
      return result;
    } finally {
      // 关闭请求已发出即可返回数据，不再阻塞页面等待 DELETE 响应。
      this._closeHub(session);

      // 签到请求本身不递归触发；后台任务不被原请求等待。
      if (succeeded && target !== "SignIn") {
        this._tryAutoSignIn();
      }
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

  _resetReadingHistoryState() {
    this._historyComicIds = null;
    this._historySeenSeries = new Set();
    this._historyNextPage = 1;
    this._historyRequestGeneration += 1;
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

    const requestGeneration = ++this._historyRequestGeneration;
    const assertCurrentRequest = () => {
      if (requestGeneration !== this._historyRequestGeneration) {
        throw new Error("阅读历史请求已失效");
      }
    };

    const refreshHistory =
      page === 1 ||
      !Array.isArray(this._historyComicIds) ||
      page !== this._historyNextPage;

    if (refreshHistory) {
      const history = await this._hubCall("GetReadHistory", {});
      assertCurrentRequest();
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
      assertCurrentRequest();
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

  account = {
    login: async (account, pwd) => {
      return await this._login(account, pwd);
    },

    logout: () => {
      this.deleteData("refreshToken");
      this.deleteData("lastSignInUtcDate");
      this._autoSignInAttemptDate = "";
      this._sessionToken = "";
      this._sessionTokenAt = 0;
      this._resetReadingHistoryState();
    },
  };

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

  search = {
    load: async (keyword, options, page) => {
      const supportedModes = [
        "fuzzy",
        "exact",
        "title",
        "author",
        "name",
        "tags",
      ];
      const selectedMode = Array.isArray(options) ? options[0] : null;
      const mode = supportedModes.includes(selectedMode)
        ? selectedMode
        : "fuzzy";

      const data = await this._hubCall("SearchComicSeries", {
        KeyWords: keyword,
        Mode: mode,
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
    optionList: [
      {
        type: "select",
        label: "搜索类型",
        options: [
          "fuzzy-模糊搜索",
          "exact-精确搜索",
          "title-书名",
          "author-作者",
          "name-系列名",
          "tags-标签",
        ],
      },
    ],
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
      const authors = String(author)
        .split("、")
        .map((name) => name.trim())
        .filter(Boolean);
      const originalTitle =
        this._value(series, "originalTitle", "OriginalTitle", "") || "";
      const tags = this._value(classification, "tags", "Tags", []);

      if (authors.length) {
        tagMap["作者"] = authors;
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
      // 首批用于取得总页数；其余分页在同一个 SignalR payload 中批量发送。
      let session = null;

      const loadWholeChapter = async (forceRefresh) => {
        session = await this._openHub(forceRefresh);

        const take = 12;
        const images = [];
        let total = 0;

        const appendBatch = (data) => {
          const chapter = this._value(data, "chapter", "Chapter", null);

          if (!chapter) {
            throw "GetComicContent 未返回 chapter/Chapter";
          }

          const imagesRaw = this._value(chapter, "images", "Images", []);
          const batch = Array.isArray(imagesRaw) ? imagesRaw : [];
          const reportedTotal = Number(
            this._value(chapter, "total", "Total", 0) || 0,
          );

          if (reportedTotal > 0) {
            total = reportedTotal;
          }

          for (const image of batch) {
            images.push(this._normalizeUrl(image));
          }

          return batch;
        };

        let batch = appendBatch(
          await this._hubInvoke(session, "GetComicContent", {
            Cid: cid,
            Skip: 0,
            Take: take,
          }),
        );
        let skip = batch.length;
        const initialTotal = total;

        if (batch.length === take && initialTotal > skip) {
          const remainingBatchCount = Math.ceil(
            (initialTotal - skip) / take,
          );

          if (remainingBatchCount > 499) {
            throw `章节分页数量异常: ${remainingBatchCount} 批`;
          }

          const paramsList = [];

          for (
            let nextSkip = skip;
            nextSkip < initialTotal;
            nextSkip += take
          ) {
            paramsList.push({ Cid: cid, Skip: nextSkip, Take: take });
          }

          const remaining = await this._hubInvokeMany(
            session,
            "GetComicContent",
            paramsList,
          );

          for (let index = 0; index < remaining.length; index++) {
            const params = paramsList[index];
            const currentBatch = appendBatch(remaining[index]);
            const expectedCount = Math.min(
              take,
              initialTotal - params.Skip,
            );

            if (currentBatch.length !== expectedCount) {
              throw `章节分页数据不完整: Skip ${params.Skip}, 预期 ${expectedCount} 页，实际 ${currentBatch.length} 页`;
            }
          }
        } else {
          // 服务端未返回可靠总页数或首批不足 12 页时，保留串行兼容路径。
          for (let batchIndex = 1; batchIndex < 500; batchIndex++) {
            if (batch.length === 0) break;
            if (total > 0 && skip >= total) break;
            if (total <= 0 && batch.length < take) break;

            batch = appendBatch(
              await this._hubInvoke(session, "GetComicContent", {
                Cid: cid,
                Skip: skip,
                Take: take,
              }),
            );
            skip += batch.length;
          }
        }

        if (!images.length) {
          throw "该章节未返回任何图片";
        }

        const expectedTotal = initialTotal > 0 ? initialTotal : total;
        if (expectedTotal > 0 && images.length !== expectedTotal) {
          throw `章节图片数量不完整: 预期 ${expectedTotal} 页，实际 ${images.length} 页`;
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
        // 与详情页一致，后台关闭连接，不阻塞图片列表返回。
        this._closeHub(session);
      }
    },

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
    // 新版 Venera 自动选中对应搜索类型；旧式字段用于兼容旧版跳转。
    onClickTag: (namespace, tag) => {
      if (namespace === "作者" || namespace === "标签") {
        const keyword = String(tag);
        const mode = namespace === "作者" ? "author" : "tags";

        return {
          page: "search",
          attributes: {
            text: keyword,
            options: [mode],
          },
          action: "search",
          keyword: keyword,
          param: null,
        };
      }

      throw "未支持此类 Tag 检索";
    },
  };

  settings = {
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

    dailySignInTask: {
      title: "每日自动签到",
      type: "switch",
      default: false,
    },

    dailySignIn: {
      title: "手动签到",
      type: "callback",
      buttonText: "签到",
      callback: () => this.dailySignIn(false),
    },
  };
}
