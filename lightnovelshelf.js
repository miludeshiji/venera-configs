/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.2.11
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - HTTP Long Polling transport
 * - 邮箱密码登录并自动管理认证令牌
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - 每日自动/手动签到
 * - Long Polling 防缓存参数
 * - 单连接批量发现页（12 项）/ 24 项分类分页 / 漫画阅读历史 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
 *
 * 使用前：
 * 1. 在 Venera 的轻书架漫画源设置中打开账号登录。
 * 2. 使用轻书架注册邮箱和密码登录。
 * 3. x-id 与令牌由漫画源自动生成和管理。
 */
class LightNovelShelf extends ComicSource {
  static discoveryPageSize = 12;
  static categoryPageSize = 24;
  static hubIdleTimeoutMs = 15000;

  name = "轻书架";
  key = "LightNovelShelf";
  version = "0.2.11";
  minAppVersion = "1.0.0";

  // 如果以后把本文件放到 GitHub，可改为 raw 文件地址用于在线更新。
  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";

  // 当前短期会话 Token，仅保存在当前 JS 运行实例中。
  _sessionToken = "";
  _sessionTokenAt = 0;
  _sessionTokenGeneration = 0;

  // 认证状态代际和共享刷新请求，防止旧账号响应覆盖当前会话。
  _authGeneration = 0;
  _refreshPromise = null;
  _refreshPromiseGeneration = 0;
  _refreshPromiseToken = "";

  // 每日签到状态：成功日期持久化，尝试日期只作用于当前 JS 实例。
  _signInInProgress = false;
  _autoSignInAttemptDate = "";

  // 阅读历史仅缓存当前列表会话；第 1 页、非连续分页、分页大小变化和退出账号时重置。
  _historyComicIds = null;
  _historySeenSeries = new Set();
  _historyNextPage = 1;
  _historyPageSize = 0;
  _historyRequestGeneration = 0;

  // 发现页刷新期间复用同一请求；失效请求只允许把替代请求的结果返回给 UI。
  _discoveryLoadPromise = null;
  _discoveryLoadAuthSnapshot = null;
  _discoveryLoadGeneration = 0;
  _discoveryLoadInFlight = false;

  // 单个 Long Polling session 由所有 Hub operation 串行租用。
  _sharedHubSession = null;
  _sharedHubOpenPromise = null;
  _sharedHubGeneration = 0;
  _hubOperationQueue = Promise.resolve();
  // 包含排队中和执行中的 operation，非零时不得空闲关闭。
  _hubOperationCount = 0;
  _hubIdleGeneration = 0;

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

  _authHeadersForToken(sessionToken, extra) {
    const headers = this._headers(extra);

    if (sessionToken) {
      headers.Authorization = "Bearer " + sessionToken;
    }

    return headers;
  }

  _authHeaders(extra) {
    return this._authHeadersForToken(this._sessionToken, extra);
  }

  _sessionAuthHeaders(session, extra) {
    return this._authHeadersForToken(
      session && session.sessionToken,
      extra,
    );
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

  _sessionAuthTextHeaders(session, extra) {
    return this._sessionAuthHeaders(
      session,
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
    const text = String(
      error && error.message ? error.message : error || "",
    ).toLowerCase();
    return (
      /\bhttp\s*(?:status\s*)?(?:401|403)\b/.test(text) ||
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

  _authStateMatches(authGeneration, refreshToken) {
    const currentRefreshToken = this.loadData("refreshToken");
    return (
      this._authGeneration === authGeneration &&
      currentRefreshToken !== undefined &&
      currentRefreshToken !== null &&
      String(currentRefreshToken).trim() === refreshToken
    );
  }

  _clearSessionTokenIfOwned(
    authGeneration,
    refreshToken,
    ownedSessionToken,
  ) {
    if (!this._authStateMatches(authGeneration, refreshToken)) return;
    if (
      ownedSessionToken === undefined ||
      this._sessionToken !== ownedSessionToken ||
      this._sessionTokenGeneration !== authGeneration
    ) {
      return;
    }

    this._sessionToken = "";
    this._sessionTokenAt = 0;
    this._sessionTokenGeneration = 0;
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

    const authGeneration = this._invalidateAuthState();
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

    if (authGeneration !== this._authGeneration) {
      throw new Error("轻书架登录请求已失效");
    }

    // 提交新账号前再次推进认证代际，令登录期间启动的旧请求失效。
    const committedGeneration = this._invalidateAuthState();
    this.saveData("refreshToken", refreshToken);
    this._sessionToken = sessionToken;
    this._sessionTokenAt = Date.now();
    this._sessionTokenGeneration = committedGeneration;

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
    const authGeneration = this._authGeneration;
    const refreshToken = this._getRefreshToken();
    const ownedSessionToken = this._sessionToken;

    // 同一认证代际和 RefreshToken 只允许一个刷新请求在途。
    if (
      this._refreshPromise &&
      this._refreshPromiseGeneration === authGeneration &&
      this._refreshPromiseToken === refreshToken
    ) {
      return await this._refreshPromise;
    }

    if (
      !force &&
      this._sessionToken &&
      this._sessionTokenGeneration === authGeneration &&
      this._authStateMatches(authGeneration, refreshToken) &&
      Date.now() - this._sessionTokenAt < 15000
    ) {
      return this._sessionToken;
    }

    const visitorId = this._getVisitorId();
    const url = this.apiBase + "/api/user/refresh_token";
    let refreshPromise;

    refreshPromise = (async () => {
      const assertCurrentAuth = () => {
        if (!this._authStateMatches(authGeneration, refreshToken)) {
          throw new Error("轻书架登录状态已变更，刷新结果已失效");
        }
      };

      const res = await Network.post(
        url,
        this._jsonHeaders({
          "x-id": visitorId,
        }),
        JSON.stringify({
          token: refreshToken,
        }),
      );
      assertCurrentAuth();

      if (!res || res.status !== 200) {
        this._clearSessionTokenIfOwned(
          authGeneration,
          refreshToken,
          ownedSessionToken,
        );
        const status = res && res.status !== undefined ? res.status : "未知";
        throw new Error(
          `刷新轻书架登录状态失败: HTTP ${status}。请在 Venera 中重新登录。`,
        );
      }

      let envelope;
      try {
        envelope = JSON.parse(res.body);
      } catch (_) {
        this._clearSessionTokenIfOwned(
          authGeneration,
          refreshToken,
          ownedSessionToken,
        );
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
          this._clearSessionTokenIfOwned(
            authGeneration,
            refreshToken,
            ownedSessionToken,
          );

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
        token =
          token.Token || token.token || token.AccessToken || token.accessToken;
      }

      if (!token || typeof token !== "string") {
        this._clearSessionTokenIfOwned(
          authGeneration,
          refreshToken,
          ownedSessionToken,
        );
        throw new Error(
          "刷新轻书架登录状态失败：响应中没有可用的会话 Token。请在 Venera 中重新登录。",
        );
      }

      assertCurrentAuth();
      this._sessionToken = token;
      this._sessionTokenAt = Date.now();
      this._sessionTokenGeneration = authGeneration;

      return token;
    })();

    this._refreshPromise = refreshPromise;
    this._refreshPromiseGeneration = authGeneration;
    this._refreshPromiseToken = refreshToken;

    try {
      return await refreshPromise;
    } finally {
      if (this._refreshPromise === refreshPromise) {
        this._refreshPromise = null;
        this._refreshPromiseGeneration = 0;
        this._refreshPromiseToken = "";
      }
    }
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

  _pollHeaders(session) {
    const headers = session
      ? this._sessionAuthHeaders(session)
      : this._authHeaders();
    return Object.assign(headers, {
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    });
  }

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
    const authGeneration = this._authGeneration;
    const refreshToken = this._getRefreshToken();
    const apiBase = this.apiBase;
    await this._refreshSessionToken(!!forceRefresh);

    if (
      !this._authStateMatches(authGeneration, refreshToken) ||
      this._sessionTokenGeneration !== authGeneration ||
      !this._sessionToken
    ) {
      throw new Error("轻书架登录状态已变更，无法建立会话");
    }

    const hubUrl = apiBase + "/hub/api";
    const negotiateUrl = hubUrl + "/negotiate?negotiateVersion=1";
    const sessionToken = this._sessionToken;
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

    const negotiateRes = await this._hubTransportRequest(
      "SignalR negotiate",
      async () =>
        await Network.post(
          negotiateUrl,
          this._sessionAuthTextHeaders(session),
          "",
        ),
    );

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

    session.url = hubUrl + "?id=" + encodeURIComponent(connectionToken);

    let established = false;

    try {
      // SignalR Long Polling 的第一次 GET 用于初始化 transport。
      await this._hubTransportRequest(
        "SignalR transport 初始化",
        async () =>
          await Network.get(
            this._pollUrl(session),
            this._pollHeaders(session),
          ),
      );

      // Hub handshake 固定为 JSON，并以 0x1e Record Separator 结束。
      const handshake = JSON.stringify({ protocol: "json", version: 1 }) + "\x1e";

      await this._hubTransportRequest(
        "SignalR handshake 发送",
        async () =>
          await Network.post(
            session.url,
            this._sessionAuthTextHeaders(session),
            handshake,
          ),
      );

      // 服务端通常在下一次 poll 返回：{}\x1e，并可能同时推送 OnMessage 公告。
      let handshakeDone = false;

      for (let i = 0; i < 6 && !handshakeDone; i++) {
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
      }

      if (!handshakeDone) {
        throw this._hubTransportError("SignalR handshake 未收到有效响应");
      }

      session.createdAt = Date.now();
      established = true;
      return session;
    } finally {
      if (!established) {
        await this._closeHub(session);
      }
    }
  }

  async _closeHub(session) {
    if (!session || !session.url) return;

    try {
      await Network.delete(session.url, this._sessionAuthHeaders(session));
    } catch (_) {
      // 关闭失败不影响已经取得的漫画数据。
    }
  }

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

    await this._hubTransportRequest(
      `SignalR invoke ${label}`,
      async () =>
        await Network.post(
          session.url,
          this._sessionAuthTextHeaders(session),
          payload,
        ),
    );

    // 通常一次 poll 会携带多个 Completion；若服务端分批推送则继续轮询。
    const maxPolls = Math.max(20, invocations.length * 2);

    for (let i = 0; i < maxPolls; i++) {
      const poll = await this._hubTransportRequest(
        `SignalR poll ${label}`,
        async () =>
          await Network.get(
            this._pollUrl(session),
            this._pollHeaders(session),
          ),
      );

      for (const frame of this._frames(poll.body)) {
        // type 1 = 服务端 Invocation（例如 OnMessage 公告）；type 6 = Ping。
        if (frame.type === 1 || frame.type === 6) {
          continue;
        }

        if (frame.type === 7) {
          throw this._hubTransportError(
            `SignalR 服务端关闭连接${
              frame.error ? `: ${frame.error}` : ""
            }`,
          );
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

    throw this._hubTransportError(
      `等待 SignalR 批量调用返回结果超时（剩余 ${pending.size}/${invocations.length}）`,
    );
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
    const data = await this._hubCall(
      "GetComicList",
      {
        Page: page,
        Size: pageSize,
        Order: order,
      },
      { retryTransport: true },
    );

    return this._comicListFromResponse(data);
  }

  _resetReadingHistoryState() {
    this._historyComicIds = null;
    this._historySeenSeries = new Set();
    this._historyNextPage = 1;
    this._historyPageSize = 0;
    this._historyRequestGeneration += 1;
    this._discoveryLoadPromise = null;
    this._discoveryLoadAuthSnapshot = null;
    this._discoveryLoadGeneration = 0;
    this._discoveryLoadInFlight = false;
  }

  _historyIdsFromResponse(data) {
    const ids = this._value(data, "comic", "Comic", []);
    if (!Array.isArray(ids)) return [];

    return ids.filter((id) => Number.isSafeInteger(id) && id > 0);
  }

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

    let ids = this._historyComicIds;
    let seenSeries = this._historySeenSeries;

    if (refreshHistory) {
      const history = await this._hubCall(
        "GetReadHistory",
        {},
        { retryTransport: true },
      );
      assertCurrentRequest();
      ids = this._historyIdsFromResponse(history);
      seenSeries = new Set();
    }

    const maxPage = Math.max(1, Math.ceil(ids.length / pageSize));
    const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
    let comics = [];

    if (pageIds.length > 0) {
      const data = await this._hubCall(
        "GetBookListByIds",
        {
          Ids: pageIds,
          Type: "Comic",
        },
        { retryTransport: true },
      );
      assertCurrentRequest();
      comics = this._historyComicsFromResponse(data, seenSeries);
    }

    assertCurrentRequest();
    this._historyComicIds = ids;
    this._historySeenSeries = seenSeries;
    this._historyPageSize = pageSize;
    this._historyNextPage = page + 1;

    return {
      comics: comics,
      maxPage: maxPage,
    };
  }

  _discoveryPageParts(latest, popular, history) {
    return [
      {
        title: "最近更新",
        comics: latest,
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
        comics: popular,
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
        comics: history,
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

  _emptyDiscoveryPage() {
    return this._discoveryPageParts([], [], []);
  }

  _loadDiscoveryPage() {
    const authSnapshot = this.loadData("refreshToken");
    if (
      this._discoveryLoadInFlight &&
      this._discoveryLoadGeneration === this._historyRequestGeneration &&
      this._discoveryLoadAuthSnapshot === authSnapshot
    ) {
      return this._discoveryLoadPromise;
    }

    const requestGeneration = ++this._historyRequestGeneration;
    const request = this._loadDiscoveryPageRequest(requestGeneration);
    let loadPromise;
    const staleResult = () => {
      const replacement = this._discoveryLoadPromise;
      const currentAuthSnapshot = this.loadData("refreshToken");
      if (
        replacement &&
        replacement !== loadPromise &&
        this._discoveryLoadGeneration === this._historyRequestGeneration &&
        this._discoveryLoadAuthSnapshot === currentAuthSnapshot
      ) {
        return replacement;
      }
      return this._emptyDiscoveryPage();
    };

    loadPromise = request.then(
      (result) => {
        if (requestGeneration !== this._historyRequestGeneration) {
          return staleResult();
        }
        return result;
      },
      (error) => {
        if (requestGeneration !== this._historyRequestGeneration) {
          return staleResult();
        }
        throw error;
      },
    );

    this._discoveryLoadPromise = loadPromise;
    this._discoveryLoadAuthSnapshot = authSnapshot;
    this._discoveryLoadGeneration = requestGeneration;
    this._discoveryLoadInFlight = true;

    const clearInFlight = () => {
      if (this._discoveryLoadPromise === loadPromise) {
        this._discoveryLoadInFlight = false;
      }
    };
    loadPromise.then(clearInFlight, clearInFlight);

    return loadPromise;
  }

  async _loadDiscoveryPageRequest(requestGeneration) {
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
      { retryTransport: true },
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

    return this._discoveryPageParts(
      latest.comics,
      popular.comics,
      historyComics,
    );
  }

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

  account = {
    login: async (account, pwd) => {
      return await this._login(account, pwd);
    },

    logout: () => {
      this.deleteData("refreshToken");
      this.deleteData("lastSignInUtcDate");
      this._autoSignInAttemptDate = "";
      this._invalidateAuthState();
    },
  };

  explore = [
    {
      title: "轻书架",
      type: "multiPartPage",
      load: async () => {
        return await this._loadDiscoveryPage();
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
      const loadWholeChapter = async (session) => {
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

      return await this._runHubSession(
        "GetComicContent",
        async (session) => await loadWholeChapter(session),
      );
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
