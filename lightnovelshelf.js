/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.4.0
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - WebSocket transport (skipNegotiation)
 * - 邮箱密码 / RefreshToken+x-id 登录并自动管理认证令牌
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - 每日自动/手动签到
 * - 后台预连接 / WebSocket 长期连接与自动重连 / 单连接批量发现页（12 项）/ 24 项分类分页
 * - 9 次/5.5 秒请求调度器 / Gzip 响应解码
 * - 漫画阅读进度单向同步（Venera → 轻书架）
 * - 新版 GetBookInfo 单书漫画详情（每个 Book.Id 独立、同系列其他书位于详情“相关”、单层章节不跨书合并） / Book 评论与楼中楼回复
 * - 稳定 book:<id> 漫画身份模型 / 旧 SeriesTitle 通过官方历史与有界搜索安全恢复 / direct ID 直连跳过搜索
 * - 发现页多区块容错独立 settle / 正文 BookId 回填与阅读进度同步
 * - BookInfo TTL (60s) 缓存与容量淘汰 (64)
 * 使用前：
 * 1. 邮箱登录：在 Venera 账号区域输入轻书架邮箱和密码。
 * 2. Token 登录：点击源设置底部的“Token 登录”，输入 RefreshToken|x-id。
 * 3. 支持使用 ， , ； ; 或 | 分隔 RefreshToken 和 x-id。
 */
class LightNovelShelf extends ComicSource {
  static discoveryPageSize = 12;
  static categoryPageSize = 24;
  static comicContentPageSize = 6;
  static comicPageKeyPrefix = "lightnovelshelf-page://";
  static comicContentStateLimit = 3;
  static comicMetadataCacheLimit = 8;
  static bookInfoCacheLimit = 64;
  static bookInfoCacheTtlMs = 60 * 1000;
  static seriesBookMapLimit = 256;
  static seriesNegativeCacheTtlMs = 30 * 1000;
  static legacySearchMaxPagesPerMode = 3;
  static legacyHistoryChunkSize = 24;
  static hubPingIntervalMs = 15000;
  static hubInvocationTimeoutMs = 30000;
  static hubConnectTimeoutMs = 30000;
  static hubHandshakeTimeoutMs = 30000;
  static hubReconnectDelays = [0, 5000, 10000, 20000, 30000];
  static hubRateLimitMax = 9;
  static hubRateLimitWindowMs = 5500;
  static hubNoReplayMessage =
    "轻书架连接结果不确定，为避免重复操作，本次请求不会自动重放";
  static tokenLoginFormatError =
    "请输入 RefreshToken 和 x-id，并用 ， , ； ; 或 | 分隔";

  name = "轻书架";
  key = "LightNovelShelf";
  version = "0.4.0";
  minAppVersion = "2.0.2";
  // 如果以后把本文件放到 GitHub，可改为 raw 文件地址用于在线更新。
  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";

  // 当前短期会话 Token，仅保存在当前 JS 运行实例中。
  _sessionToken = "";
  _sessionTokenAt = 0;
  _sessionTokenGeneration = 0;
  _sessionTokenApiBase = "";
  // 认证状态代际和共享刷新请求，防止旧账号响应覆盖当前会话。
  _authGeneration = 0;
  _refreshPromise = null;
  _refreshPromiseGeneration = 0;
  _refreshPromiseToken = "";
  _refreshPromiseApiBase = "";
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

  // 单一长期 WebSocket 状态机
  _hubSocket = null;
  _hubState = "disconnected";
  _hubConnectPromise = null;
  _hubConnectPromiseApiBase = "";
  _hubConnectPromiseAuthGen = 0;
  _hubReceiveLoopPromise = null;
  _hubGeneration = 0;
  _hubDesiredConnected = false;
  _hubReconnectCount = 0;
  _hubReconnectTimer = null;
  _hubReconnectToken = 0;
  _hubDisconnectedGeneration = 0;
  _hubApiBase = "";
  _hubAuthGeneration = 0;
  _hubPingTimer = null;
  _hubLastReceivedAt = 0;
  _hubInvocationId = 0;
  _hubPending = new Map();
  _hubReceiveBuffer = "";
  _hubRateTimestamps = [];
  _hubRateWaiters = [];
  _hubRateProcessing = false;
  _hubRateProcessToken = 0;
  // 章节正文按章节和 6 页批次缓存共享 Promise。
  _comicContentStates = new Map();
  _comicChapterPageCounts = new Map();
  _comicChapterBookIds = new Map();
  _comicMetadataKeys = new Map();
  _lastSubmittedReadProgress = "";
  _comicContentUseSequence = 0;
  // 稳定 book:<id> 漫画身份模型；对旧 SeriesTitle 提供安全恢复。
  _seriesRepresentativeBookIds = new Map();
  _seriesRepresentativeBookIdSources = new Map();
  _seriesListMetadata = new Map();
  _seriesNegativeCache = new Map();
  _bookInfoCache = new Map();
  _bookInfoPromises = new Map();
  _seriesLoadPromises = new Map();

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
  _buildHubWebSocketUrl(sessionToken) {
    let url = this.apiBase
      .replace(/^https:/i, "wss:")
      .replace(/^http:/i, "ws:");
    url =
      url.replace(/\/+$/, "") +
      "/hub/api?access_token=" +
      encodeURIComponent(sessionToken);
    return url;
  }

  _buildHubWebSocketHeaders(sessionToken) {
    return this._headers({
      "x-id": this._getVisitorId(),
      Authorization: "Bearer " + sessionToken,
    });
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
    if (error && typeof error === "object") {
      const status =
        error.status !== undefined ? error.status : error.statusCode;
      const numericStatus =
        typeof status === "number"
          ? status
          : typeof status === "string" && /^-?\d+$/.test(status.trim())
          ? parseInt(status.trim(), 10)
          : null;
      if (numericStatus === 401 || numericStatus === -100) {
        return true;
      }
      if (error.envelope && typeof error.envelope === "object") {
        const envStatus =
          error.envelope.Status !== undefined
            ? error.envelope.Status
            : error.envelope.status;
        const envNum =
          typeof envStatus === "number"
            ? envStatus
            : typeof envStatus === "string" && /^-?\d+$/.test(envStatus.trim())
            ? parseInt(envStatus.trim(), 10)
            : null;
        if (envNum === 401 || envNum === -100) {
          return true;
        }
      }
      if (error.cause) {
        return this._isUnauthorizedError(error.cause);
      }
    }
    const text = String(
      error && error.message ? error.message : error || "",
    ).toLowerCase();
    return (
      /\bhttp\s*(?:status\s*)?(?:401|403)\b/.test(text) ||
      /\b(?:status\s*)?\[\s*(?:401|-100)\s*\]/.test(text) ||
      text.includes("user is unauthorized") ||
      text.includes("unauthorized") ||
      text.includes("未授权") ||
      text.includes("未登录")
    );
  }

  _isOperationalError(error) {
    if (!error) return false;
    if (this._isUnauthorizedError(error)) return true;
    if (this._isHubTransportError(error)) return true;
    if (this._isHubTimeoutError(error)) return true;
    if (this._isHubNoReplayError(error)) return true;
    if (this._isTerminalRefreshError(error)) return true;
    const text = String(
      error && error.message ? error.message : error,
    ).toLowerCase();
    return (
      text.includes("timeout") ||
      text.includes("timed out") ||
      text.includes("超时") ||
      text.includes("unauthorized") ||
      text.includes("401") ||
      text.includes("403") ||
      text.includes("429") ||
      text.includes("rate limit") ||
      text.includes("限流") ||
      text.includes("websocket") ||
      text.includes("connection closed") ||
      text.includes("network") ||
      text.includes("fetch")
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

  _normalizeVisitorId(value) {
    return String(value == null ? "" : value)
      .trim()
      .replace(/-/g, "")
      .toLowerCase();
  }

  _getVisitorId() {
    const saved = this.loadData("visitorId");

    if (
      saved !== undefined &&
      saved !== null &&
      String(saved).trim()
    ) {
      return String(saved).trim();
    }

    const generated = this._normalizeVisitorId(createUuid());

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
    this._hubDesiredConnected = false;
    this._disconnectHub("Auth state invalidated");
    this._clearComicContentStates();
    this._resetReadingHistoryState();
    this._sessionToken = "";
    this._sessionTokenAt = 0;
    this._sessionTokenGeneration = 0;
    this._sessionTokenApiBase = "";
    this._refreshPromise = null;
    this._refreshPromiseGeneration = 0;
    this._refreshPromiseToken = "";
    this._refreshPromiseApiBase = "";
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
    this._sessionTokenApiBase = "";
  }

  _isTerminalRefreshStatus(error) {
    if (error && typeof error === "object") {
      const status =
        error.status !== undefined ? error.status : error.statusCode;
      const numericStatus =
        typeof status === "number"
          ? status
          : typeof status === "string" && /^-?\d+$/.test(status.trim())
          ? parseInt(status.trim(), 10)
          : null;
      if (
        numericStatus === 401 ||
        numericStatus === 404 ||
        numericStatus === -100
      ) {
        return true;
      }
      if (error.envelope && typeof error.envelope === "object") {
        const envStatus =
          error.envelope.Status !== undefined
            ? error.envelope.Status
            : error.envelope.status;
        const envNum =
          typeof envStatus === "number"
            ? envStatus
            : typeof envStatus === "string" && /^-?\d+$/.test(envStatus.trim())
            ? parseInt(envStatus.trim(), 10)
            : null;
        if (envNum === 401 || envNum === 404 || envNum === -100) {
          return true;
        }
      }
      if (error.cause) {
        return this._isTerminalRefreshStatus(error.cause);
      }
    }
    const text = String(
      error && error.message ? error.message : error || "",
    ).toLowerCase();
    return (
      /\bhttp\s*(?:status\s*)?(?:401|404)\b/.test(text) ||
      /\b(?:status\s*)?\[\s*(?:401|404|-100)\s*\]/.test(text)
    );
  }

  _isTerminalRefreshError(error) {
    if (!error || typeof error !== "object") return false;
    if (error.code === "LIGHTNOVELSHELF_TERMINAL_REFRESH") return true;
    if (error.cause) return this._isTerminalRefreshError(error.cause);
    return false;
  }

  _clearAuthCredentials(reason = "Credentials invalidated") {
    this.deleteData("account");
    this.deleteData("refreshToken");
    this.deleteData("visitorId");
    this.deleteData("lastSignInUtcDate");
    this._autoSignInAttemptDate = "";
    this._invalidateAuthState();
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
    this._sessionTokenApiBase = this.apiBase;

    return email;
  }

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
      const err = new Error(`${action}失败: HTTP ${status}`);
      if (res && res.status !== undefined) {
        err.status =
          typeof res.status === "number"
            ? res.status
            : parseInt(res.status, 10);
        err.statusCode = err.status;
      }
      throw err;
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
        const rawStatus =
          envelope.Status !== undefined
            ? envelope.Status
            : envelope.status;
        const status =
          rawStatus !== undefined ? ` [${rawStatus}]` : "";
        const message =
          typeof envelope.Msg === "string" && envelope.Msg.trim()
            ? `: ${envelope.Msg.trim()}`
            : "";
        const err = new Error(`${action}失败${status}${message}`);
        if (rawStatus !== undefined) {
          err.status =
            typeof rawStatus === "number"
              ? rawStatus
              : typeof rawStatus === "string" &&
                  /^-?\d+$/.test(rawStatus.trim())
                ? parseInt(rawStatus.trim(), 10)
                : rawStatus;
          err.statusCode = err.status;
        }
        err.envelope = envelope;
        throw err;
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

  async _loginWithToken(refreshTokenValue, visitorIdValue) {
    const refreshToken = String(
      refreshTokenValue == null ? "" : refreshTokenValue,
    ).trim();
    const visitorId = String(
      visitorIdValue == null ? "" : visitorIdValue,
    ).trim();

    if (!refreshToken) {
      throw new Error("轻书架 Token 登录失败：RefreshToken 不能为空");
    }
    if (!visitorId) {
      throw new Error("轻书架 Token 登录失败：x-id 不能为空");
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
    this._sessionTokenApiBase = this.apiBase;
    this.saveData("account", "token");
    return "ok";
  }

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
    const currentApiBase = this.apiBase;
    const ownedSessionToken = this._sessionToken;

    // 同一认证代际、RefreshToken 与 API 线路只允许一个刷新请求在途。
    if (
      this._refreshPromise &&
      this._refreshPromiseGeneration === authGeneration &&
      this._refreshPromiseToken === refreshToken &&
      this._refreshPromiseApiBase === currentApiBase
    ) {
      return await this._refreshPromise;
    }

    if (
      !force &&
      this._sessionToken &&
      this._sessionTokenGeneration === authGeneration &&
      this._sessionTokenApiBase === currentApiBase &&
      this._authStateMatches(authGeneration, refreshToken) &&
      Date.now() - this._sessionTokenAt < 15000
    ) {
      return this._sessionToken;
    }

    const visitorId = this._getVisitorId();
    let refreshPromise;

    refreshPromise = (async () => {
      const isOwned = () => {
        return (
          this._authStateMatches(authGeneration, refreshToken) &&
          this.apiBase === currentApiBase
        );
      };

      try {
        const token = await this._requestSessionToken(
          refreshToken,
          visitorId,
          "刷新轻书架登录状态",
        );
        if (!isOwned()) {
          throw new Error("轻书架登录状态或线路已变更，刷新结果已失效");
        }
        this._sessionToken = token;
        this._sessionTokenAt = Date.now();
        this._sessionTokenGeneration = authGeneration;
        this._sessionTokenApiBase = currentApiBase;
        return token;
      } catch (error) {
        if (!isOwned()) {
          // 切换线路或登出后，旧线路晚到失败绝不得清除新线路状态或凭据
          throw error;
        }
        const isTerminal = this._isTerminalRefreshStatus(error);
        if (isTerminal) {
          this._clearAuthCredentials("Terminal refresh credential failure");
        } else {
          this._clearSessionTokenIfOwned(
            authGeneration,
            refreshToken,
            ownedSessionToken,
          );
        }
        const detail = String(
          error && error.message ? error.message : error || "未知错误",
        ).replace(/[。.]+$/, "");
        const wrappedErr = new Error(`${detail}。请在 Venera 中重新登录。`);
        if (isTerminal) {
          wrappedErr.code = "LIGHTNOVELSHELF_TERMINAL_REFRESH";
        }
        if (error && typeof error === "object") {
          if (error.status !== undefined) {
            wrappedErr.status = error.status;
            wrappedErr.statusCode = error.status;
          }
          if (error.cause !== undefined) {
            wrappedErr.cause = error.cause;
          } else {
            wrappedErr.cause = error;
          }
        }
        throw wrappedErr;
      }
    })();

    this._refreshPromise = refreshPromise;
    this._refreshPromiseGeneration = authGeneration;
    this._refreshPromiseToken = refreshToken;
    this._refreshPromiseApiBase = currentApiBase;

    try {
      return await refreshPromise;
    } finally {
      if (
        this._refreshPromise === refreshPromise &&
        this._refreshPromiseGeneration === authGeneration &&
        this._refreshPromiseToken === refreshToken &&
        this._refreshPromiseApiBase === currentApiBase
      ) {
        this._refreshPromise = null;
        this._refreshPromiseGeneration = 0;
        this._refreshPromiseToken = "";
        this._refreshPromiseApiBase = "";
      }
    }
  }

  _hubTransportError(message, cause) {
    const error = new Error(String(message));
    error.code = "LIGHTNOVELSHELF_HUB_TRANSPORT";
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  _hubPreSendTransportError(message, cause) {
    const error = this._hubTransportError(message, cause);
    error.safeToRetry = true;
    return error;
  }

  _isHubTransportError(error) {
    return !!(
      error &&
      typeof error === "object" &&
      error.code === "LIGHTNOVELSHELF_HUB_TRANSPORT"
    );
  }

  _hubNoReplayError(cause) {
    const error = new Error(LightNovelShelf.hubNoReplayMessage);
    error.code = "LIGHTNOVELSHELF_HUB_NO_REPLAY";
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  _isHubNoReplayError(error) {
    if (!error || typeof error !== "object") return false;
    if (error.code === "LIGHTNOVELSHELF_HUB_NO_REPLAY") return true;
    if (error.cause) return this._isHubNoReplayError(error.cause);
    return false;
  }

  _hubTimeoutError(message, cause) {
    const error = new Error(String(message));
    error.code = "LIGHTNOVELSHELF_HUB_TIMEOUT";
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  _isHubTimeoutError(error) {
    return !!(
      error &&
      typeof error === "object" &&
      error.code === "LIGHTNOVELSHELF_HUB_TIMEOUT"
    );
  }

  async _closeSocketSafely(socket, code = 1000, reason = "") {
    if (!socket || socket.closed) return;
    try {
      const safeReason = String(reason || "").slice(0, 30);
      const closePromise = socket.close(code, safeReason);
      if (closePromise && typeof closePromise.catch === "function") {
        closePromise.catch(() => {});
      }
      await closePromise;
    } catch (_) {
      // 忽略关闭异常
    }
  }

  /**
   * 保证单个长期 WebSocket 连接已建立并处于 connected 状态。
   * 若当前处于 connecting 状态，并发请求复用同一个 _hubConnectPromise。
   */
  async _ensureHubConnected(forceRefresh = false) {
    const currentApiBase = this.apiBase;
    const currentAuthGen = this._authGeneration;
    const isReusable =
      !forceRefresh &&
      this._hubState === "connected" &&
      this._hubSocket &&
      !this._hubSocket.closed &&
      this._hubApiBase === currentApiBase &&
      this._hubAuthGeneration === currentAuthGen;

    if (isReusable) {
      return this._hubSocket;
    }

    if (
      forceRefresh ||
      (this._hubSocket &&
        (this._hubApiBase !== currentApiBase ||
          this._hubAuthGeneration !== currentAuthGen))
    ) {
      this._disconnectHub("Recreating connection");
    }

    if (
      this._hubConnectPromise &&
      !forceRefresh &&
      this._hubConnectPromiseApiBase === currentApiBase &&
      this._hubConnectPromiseAuthGen === currentAuthGen
    ) {
      return await this._hubConnectPromise;
    }

    if (this._hubConnectPromise) {
      this._disconnectHub("Route or auth changed during in-flight connect");
    }

    const connectPromise = this._openHubWebSocket(forceRefresh);
    this._hubConnectPromise = connectPromise;
    this._hubConnectPromiseApiBase = currentApiBase;
    this._hubConnectPromiseAuthGen = currentAuthGen;

    try {
      return await connectPromise;
    } finally {
      if (this._hubConnectPromise === connectPromise) {
        this._hubConnectPromise = null;
        this._hubConnectPromiseApiBase = "";
        this._hubConnectPromiseAuthGen = 0;
      }
    }
  }

  /**
   * 建立 SignalR WebSocket 连接：
   * 1. 获取有效 Session Token；
   * 2. 直连 /hub/api?access_token= 并附带认证与设备头；
   * 3. 发送 SignalR JSON Handshake，并在 30 秒内等待响应；
   * 4. 启动唯一的后台 Receive Loop 与 Ping 保活。
   */
  async _openHubWebSocket(forceRefresh = false) {
    const authGeneration = this._authGeneration;
    const refreshToken = this._getRefreshToken();
    const wsApiBase = this.apiBase;

    this._hubGeneration += 1;
    const generation = this._hubGeneration;
    this._hubDesiredConnected = true;
    this._hubState = "connecting";
    this._hubReceiveBuffer = "";
    this._clearHubReconnectTimer();

    let sessionToken = "";
    try {
      await this._refreshSessionToken(!!forceRefresh);

      if (
        !this._authStateMatches(authGeneration, refreshToken) ||
        this._sessionTokenGeneration !== authGeneration ||
        !this._sessionToken
      ) {
        throw new Error("轻书架登录状态已变更，无法建立连接");
      }
      sessionToken = this._sessionToken;
    } catch (refreshErr) {
      const isCurrentRouteAndAuth =
        this.apiBase === wsApiBase &&
        generation === this._hubGeneration &&
        this._authGeneration === authGeneration;
      if (this._isTerminalRefreshError(refreshErr)) {
        if (isCurrentRouteAndAuth) {
          this._clearAuthCredentials("Terminal refresh credential failure");
        }
      } else {
        if (generation === this._hubGeneration) {
          if (this._isUnauthorizedError(refreshErr)) {
            this._clearSessionTokenIfOwned(
              authGeneration,
              refreshToken,
              sessionToken,
            );
          }
          this._handleHubDisconnected(null, generation, refreshErr);
        }
      }
      throw refreshErr;
    }

    if (
      generation !== this._hubGeneration ||
      !this._hubDesiredConnected ||
      this.apiBase !== wsApiBase ||
      this._authGeneration !== authGeneration
    ) {
      throw new Error("轻书架连接已取消");
    }

    const wsUrl = this._buildHubWebSocketUrl(sessionToken);
    const headers = this._buildHubWebSocketHeaders(sessionToken);
    const connectTimeoutMs = this.constructor.hubConnectTimeoutMs || 30000;

    let socket = null;
    try {
      socket = await Network.WebSocket.connect(wsUrl, headers, {
        connectTimeoutMs: connectTimeoutMs,
      });
    } catch (error) {
      if (generation === this._hubGeneration) {
        if (this._isUnauthorizedError(error)) {
          this._clearSessionTokenIfOwned(
            authGeneration,
            refreshToken,
            sessionToken,
          );
        }
        this._handleHubDisconnected(null, generation, error);
      }
      throw this._hubPreSendTransportError(
        `轻书架 WebSocket 建连失败: ${error && error.message ? error.message : error}`,
        error,
      );
    }

    if (
      generation !== this._hubGeneration ||
      !this._hubDesiredConnected ||
      this.apiBase !== wsApiBase ||
      this._authGeneration !== authGeneration
    ) {
      this._closeSocketSafely(socket, 1000, "Connect superseded");
      throw new Error("轻书架连接已取消");
    }

    this._hubSocket = socket;

    let handshakeDone = false;
    let handshakeResolve = null;
    let handshakeReject = null;
    const handshakePromise = new Promise((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
    });
    handshakePromise.catch(() => {});

    const handshakeTimeoutMs = this.constructor.hubHandshakeTimeoutMs || 30000;
    setTimeout(() => {
      if (!handshakeDone) {
        handshakeDone = true;
        const timeoutErr = this._hubPreSendTransportError(
          `SignalR 握手超时 (${Math.round(handshakeTimeoutMs / 1000)}秒)`,
        );
        handshakeReject(timeoutErr);
      }
    }, handshakeTimeoutMs);

    const handshakeHooks = {
      isHandshakeDone: false,
      onHandshakeSuccess: () => {
        if (handshakeDone) return;
        handshakeDone = true;
        handshakeHooks.isHandshakeDone = true;
        handshakeResolve();
      },
      onHandshakeError: (err) => {
        if (handshakeDone) return;
        handshakeDone = true;
        handshakeHooks.isHandshakeDone = true;
        if (this._isUnauthorizedError(err)) {
          this._clearSessionTokenIfOwned(
            authGeneration,
            refreshToken,
            sessionToken,
          );
        }
        handshakeReject(err);
      },
    };

    this._hubReceiveLoopPromise = this._startHubReceiveLoop(
      socket,
      generation,
      handshakeHooks,
    );

    try {
      await socket.send(
        JSON.stringify({ protocol: "json", version: 1 }) + "\x1e",
      );
    } catch (sendErr) {
      handshakeHooks.onHandshakeError(
        this._hubPreSendTransportError(
          `发送 SignalR 握手消息失败: ${sendErr && sendErr.message ? sendErr.message : sendErr}`,
          sendErr,
        ),
      );
    }

    try {
      await handshakePromise;
    } catch (handshakeErr) {
      this._closeSocketSafely(socket, 1000, "Handshake failed");
      if (generation === this._hubGeneration) {
        this._handleHubDisconnected(socket, generation, handshakeErr);
      }
      throw handshakeErr;
    }

    if (
      generation !== this._hubGeneration ||
      !this._hubDesiredConnected ||
      this.apiBase !== wsApiBase ||
      this._authGeneration !== authGeneration
    ) {
      this._closeSocketSafely(socket, 1000, "Connected superseded");
      throw new Error("轻书架连接已取消");
    }

    if (
      this._hubSocket !== socket ||
      socket.closed ||
      this._hubDisconnectedGeneration === generation
    ) {
      this._closeSocketSafely(socket, 1000, "Socket closed during handshake");
      const err = this._hubTransportError("轻书架 WebSocket 在握手完成时已断开");
      if (
        this._hubDisconnectedGeneration !== generation &&
        generation === this._hubGeneration
      ) {
        this._handleHubDisconnected(socket, generation, err);
      }
      throw err;
    }
    this._hubSocket = socket;
    this._hubApiBase = wsApiBase;
    this._hubAuthGeneration = authGeneration;
    this._hubState = "connected";
    this._hubReconnectCount = 0;
    this._hubLastReceivedAt = Date.now();
    this._startHubPing(socket, generation);
    return socket;
  }

  /**
   * 唯一的后台 Receive Loop，负责持续从 socket.receive() 拉取消息。
   * 严禁在调用方并发调用 socket.receive()。
   */
  async _startHubReceiveLoop(socket, generation, handshakeHooks) {
    let loopError = null;
    try {
      while (
        generation === this._hubGeneration &&
        this._hubSocket === socket &&
        !socket.closed
      ) {
        let event = null;
        try {
          event = await socket.receive();
        } catch (recvErr) {
          loopError = recvErr;
          break;
        }

        if (generation !== this._hubGeneration || this._hubSocket !== socket) {
          break;
        }

        if (!event || event.type === "close") {
          const code = event && event.code != null ? event.code : "未知";
          const reason = event && event.reason ? event.reason : "none";
          loopError = this._hubTransportError(
            `轻书架 WebSocket 通道已关闭 (code: ${code}, reason: ${reason})`,
          );
          break;
        }

        if (event.type === "message") {
          this._hubLastReceivedAt = Date.now();
          this._handleHubMessage(
            event.data,
            socket,
            generation,
            handshakeHooks,
          );
        }
      }
    } catch (err) {
      loopError = err;
    } finally {
      if (handshakeHooks && !handshakeHooks.isHandshakeDone) {
        handshakeHooks.onHandshakeError(
          loopError || this._hubTransportError("WebSocket 在完成握手前已断开"),
        );
      }
      this._handleHubDisconnected(socket, generation, loopError);
    }
  }

  /**
   * 处理接收到的 WebSocket 文本帧数据。支持单条消息中包含多个 0x1E Record Separator 帧，
   * 并正确处理握手帧后紧随的业务帧。
   */
  _handleHubMessage(data, socket, generation, handshakeHooks) {
    if (generation !== this._hubGeneration || this._hubSocket !== socket) {
      return;
    }

    let text = data;
    if (typeof text !== "string") {
      try {
        text = Convert.decodeUtf8(text);
      } catch (_) {
        return;
      }
    }

    this._hubReceiveBuffer = (this._hubReceiveBuffer || "") + (text || "");
    const parts = this._hubReceiveBuffer.split("\x1e");
    this._hubReceiveBuffer = parts.pop() || "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      let frame = null;
      try {
        frame = JSON.parse(trimmed);
      } catch (_) {
        continue;
      }

      if (!frame || typeof frame !== "object") continue;

      // 1. 若握手尚未标记完成，优先检查是否为握手响应帧
      if (handshakeHooks && !handshakeHooks.isHandshakeDone) {
        if (frame.error) {
          handshakeHooks.onHandshakeError(
            this._hubTransportError(`SignalR 握手失败: ${frame.error}`),
          );
          return;
        }

        if (
          (frame.type === undefined && Object.keys(frame).length === 0) ||
          frame.type === undefined
        ) {
          handshakeHooks.onHandshakeSuccess();
          continue;
        }
      }

      // 2. 握手已完成，分发各 SignalR 帧
      const frameType = frame.type;

      if (frameType === 1) {
        // 服务端主动 Invocation（如 OnMessage 公告），忽略未知 target，绝不断开连接
        continue;
      }

      if (frameType === 3) {
        // Invocation Completion 帧
        const invocationId = String(frame.invocationId);
        const pending = this._hubPending.get(invocationId);
        if (pending) {
          this._hubPending.delete(invocationId);
          if (frame.error) {
            pending.reject(
              new Error(`SignalR ${pending.target} 调用失败: ${frame.error}`),
            );
          } else {
            try {
              const unwrapped = this._unwrapHubResult(
                pending.target,
                frame.result,
              );
              pending.resolve(unwrapped);
            } catch (unwrapErr) {
              pending.reject(unwrapErr);
            }
          }
        }
        continue;
      }

      if (frameType === 6) {
        // Ping 帧，刷新连接活跃时间
        this._hubLastReceivedAt = Date.now();
        continue;
      }

      if (frameType === 7) {
        // 服务端主动 Close 帧
        const reason = frame.error
          ? `服务端关闭连接: ${frame.error}`
          : "服务端关闭连接";
        this._closeSocketSafely(socket, 1000, reason);
        this._handleHubDisconnected(
          socket,
          generation,
          this._hubTransportError(reason),
        );
        return;
      }
    }
  }

  _startHubPing(socket, generation) {
    this._stopHubPing();
    const intervalMs = this.constructor.hubPingIntervalMs || 15000;
    this._hubPingTimer = setInterval(async () => {
      if (
        generation !== this._hubGeneration ||
        this._hubSocket !== socket ||
        this._hubState !== "connected" ||
        socket.closed
      ) {
        this._stopHubPing();
        return;
      }
      try {
        await socket.send(JSON.stringify({ type: 6 }) + "\x1e");
      } catch (pingErr) {
        this._stopHubPing();
        if (generation === this._hubGeneration && this._hubSocket === socket) {
          this._closeSocketSafely(socket, 1000, "Ping failed");
          this._handleHubDisconnected(
            socket,
            generation,
            this._hubTransportError(
              `发送 SignalR 保活 Ping 失败: ${pingErr && pingErr.message ? pingErr.message : pingErr}`,
              pingErr,
            ),
          );
        }
      }
    }, intervalMs);
  }

  _stopHubPing() {
    if (this._hubPingTimer) {
      try {
        if (typeof this._hubPingTimer.cancel === "function") {
          this._hubPingTimer.cancel();
        }
      } catch (_) {}
      this._hubPingTimer = null;
    }
  }

  _clearHubReconnectTimer() {
    this._hubReconnectToken += 1;
    this._hubReconnectTimer = null;
  }

  _getHubReconnectDelay() {
    const delays = this.constructor.hubReconnectDelays || [
      0, 5000, 10000, 20000, 30000,
    ];
    const index = Math.min(this._hubReconnectCount, delays.length - 1);
    return delays[index];
  }

  /**
   * 连接断开后统一处理：
   * 1. 确认代际并清理当前 Socket；
   * 2. 停止 Ping；
   * 3. 拒绝待处理请求（根据 retryTransport / sent 区分状态修改的 NO_REPLAY 与幂等读取重试）；
   * 4. 若 desiredConnected 为 true，按退避策略调度自动重连。
   */
  _handleHubDisconnected(socket, generation, error) {
    if (generation !== this._hubGeneration) return;
    if (socket && this._hubSocket && this._hubSocket !== socket) return;
    if (this._hubDisconnectedGeneration === generation) return;
    this._hubDisconnectedGeneration = generation;

    this._stopHubPing();
    this._hubReceiveBuffer = "";
    const activeSocket = this._hubSocket || socket;
    this._hubSocket = null;
    if (activeSocket) {
      this._closeSocketSafely(activeSocket, 1000, "Disconnected");
    }

    if (this._hubState !== "closing") {
      this._hubState = "disconnected";
    }

    if (this._hubPending.size > 0) {
      for (const [, item] of this._hubPending) {
        if (item.sent) {
          if (item.retryTransport) {
            item.reject(
              this._hubTransportError("轻书架网络通道已断开", error),
            );
          } else {
            item.reject(this._hubNoReplayError(error));
          }
        } else {
          item.reject(
            this._hubPreSendTransportError(
              "轻书架网络通道在发送前已断开",
              error,
            ),
          );
        }
      }
      this._hubPending.clear();
    }

    if (!this._hubDesiredConnected) {
      return;
    }

    this._hubState = "reconnecting";
    const delay = this._getHubReconnectDelay();
    this._hubReconnectCount += 1;

    this._clearHubReconnectTimer();
    const scheduledToken = ++this._hubReconnectToken;
    this._hubReconnectTimer = scheduledToken;
    setTimeout(async () => {
      if (
        scheduledToken !== this._hubReconnectToken ||
        !this._hubDesiredConnected ||
        generation !== this._hubGeneration
      ) {
        return;
      }
      this._hubReconnectTimer = null;
      try {
        await this._ensureHubConnected(false);
      } catch (_) {
        // 重连失败后已由 _openHubWebSocket 内部调度下一次退避
      }
    }, delay);
  }

  /**
   * 主动关闭 Hub 连接并复位状态机（登出或认证失效时调用）。
   */
  _disconnectHub(reason = "Disconnected") {
    this._hubDesiredConnected = false;
    this._hubGeneration += 1;
    this._cancelHubRateWaiters(`轻书架请求已取消 (${reason})`);
    this._clearHubReconnectTimer();
    this._stopHubPing();
    this._hubState = "disconnected";
    this._hubReceiveBuffer = "";
    this._hubReconnectCount = 0;

    if (this._hubPending.size > 0) {
      const err = this._hubTransportError(`轻书架连接已关闭 (${reason})`);
      for (const [, item] of this._hubPending) {
        item.reject(err);
      }
      this._hubPending.clear();
    }

    const socket = this._hubSocket;
    this._hubSocket = null;
    this._hubConnectPromise = null;
    this._hubConnectPromiseApiBase = "";
    this._hubConnectPromiseAuthGen = 0;
    if (socket) {
      this._closeSocketSafely(socket, 1000, reason);
    }
  }
  async _acquireHubRateSlots(count) {
    const max = this.constructor.hubRateLimitMax;
    if (!Number.isSafeInteger(count) || count < 1 || count > max) {
      throw new Error(`无效 SignalR 限流额度: ${count}`);
    }

    return await new Promise((resolve, reject) => {
      this._hubRateWaiters.push({
        count: count,
        resolve: resolve,
        reject: reject,
        authGeneration: this._authGeneration,
        hubGeneration: this._hubGeneration,
      });
      this._processHubRateWaiters();
    });
  }

  _cancelHubRateWaiters(reason) {
    if (this._hubRateWaiters.length === 0) return;
    const error = this._hubPreSendTransportError(reason);
    const waiters = this._hubRateWaiters;
    this._hubRateWaiters = [];
    this._hubRateProcessToken += 1;
    this._hubRateProcessing = false;
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  _processHubRateWaiters() {
    if (this._hubRateProcessing) return;
    this._hubRateProcessing = true;
    const token = ++this._hubRateProcessToken;

    const process = () => {
      if (token !== this._hubRateProcessToken) return;
      const now = Date.now();
      const windowMs = this.constructor.hubRateLimitWindowMs;
      while (
        this._hubRateTimestamps.length > 0 &&
        now - this._hubRateTimestamps[0] >= windowMs
      ) {
        this._hubRateTimestamps.shift();
      }

      const waiter = this._hubRateWaiters[0];
      if (!waiter) {
        this._hubRateProcessing = false;
        return;
      }
      if (
        waiter.authGeneration !== this._authGeneration ||
        waiter.hubGeneration !== this._hubGeneration
      ) {
        this._hubRateWaiters.shift();
        waiter.reject(
          this._hubPreSendTransportError("轻书架连接状态已变更，请重试"),
        );
        process();
        return;
      }

      if (
        this._hubRateTimestamps.length + waiter.count <=
        this.constructor.hubRateLimitMax
      ) {
        this._hubRateWaiters.shift();
        for (let i = 0; i < waiter.count; i++) {
          this._hubRateTimestamps.push(now);
        }
        waiter.resolve();
        process();
        return;
      }

      const delay = Math.max(
        1,
        windowMs - (now - this._hubRateTimestamps[0]),
      );
      setTimeout(process, delay);
    };

    process();
  }

  _decodeHubResponse(value) {
    if (typeof value !== "string") return value;

    let bytes;
    try {
      bytes = Convert.decodeBase64(value);
    } catch (_) {
      return value;
    }
    if (
      !bytes ||
      bytes.length < 2 ||
      bytes[0] !== 0x1f ||
      bytes[1] !== 0x8b
    ) {
      return value;
    }
    if (typeof Convert.decodeGzip !== "function") {
      throw new Error("当前 Venera 版本不支持轻书架 Gzip 响应");
    }

    try {
      return JSON.parse(Convert.decodeUtf8(Convert.decodeGzip(bytes)));
    } catch (error) {
      throw new Error("轻书架返回了无效的 Gzip 响应");
    }
  }

  _unwrapHubResult(target, envelope) {
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
          const rawStatus =
            envelope.Status !== undefined
              ? envelope.Status
              : envelope.status;
          const status =
            rawStatus !== undefined ? ` [${rawStatus}]` : "";
          const msg =
            envelope.Msg !== undefined ? envelope.Msg : envelope.msg;

          const err = new Error(
            `${target} 失败${status}: ${msg || "Unknown error"}`,
          );
          if (rawStatus !== undefined) {
            err.status =
              typeof rawStatus === "number"
                ? rawStatus
                : typeof rawStatus === "string" &&
                    /^-?\d+$/.test(rawStatus.trim())
                  ? parseInt(rawStatus.trim(), 10)
                  : rawStatus;
            err.statusCode = err.status;
          }
          err.envelope = envelope;
          err.target = target;
          throw err;
        }
      }
      const response = Object.prototype.hasOwnProperty.call(envelope, "response")
        ? envelope.response
        : envelope.Response;
      if (
        Object.prototype.hasOwnProperty.call(envelope, "response") ||
        Object.prototype.hasOwnProperty.call(envelope, "Response")
      ) {
        return this._decodeHubResponse(response);
      }
    }

    return envelope;
  }

  /**
   * 在同一个 WebSocket payload 中批量发送不同 Hub Method，
   * 独立分配 invocationId，由 Receive Loop 统一按 invocationId 分发乱序到达的 Completion。
   */
  async _hubInvokeBatch(socket, calls, options = {}) {
    if (!Array.isArray(calls) || calls.length === 0) {
      return [];
    }

    const max = this.constructor.hubRateLimitMax;
    if (calls.length > max) {
      const results = [];
      for (let start = 0; start < calls.length; start += max) {
        results.push(
          ...(await this._hubInvokeBatch(
            socket,
            calls.slice(start, start + max),
            options,
          )),
        );
      }
      return results;
    }

    await this._acquireHubRateSlots(calls.length);

    const activeSocket = socket || this._hubSocket;
    if (
      !activeSocket ||
      activeSocket.closed ||
      activeSocket !== this._hubSocket ||
      this._hubState !== "connected"
    ) {
      throw this._hubPreSendTransportError(
        "轻书架网络通道在发送请求前已失效",
      );
    }

    const defaultRetryTransport = options.retryTransport === true;
    const timeoutMs = this.constructor.hubInvocationTimeoutMs || 30000;
    const itemGeneration = this._hubGeneration;
    const useGzip = typeof Convert.decodeGzip === "function";

    const invocations = calls.map((call, index) => {
      if (!call || typeof call.target !== "string" || !call.target.trim()) {
        throw new Error(`无效 SignalR 批量调用: ${index}`);
      }
      const target = call.target.trim();
      const invocationId = String(++this._hubInvocationId);
      const message =
        JSON.stringify({
          type: 1,
          invocationId: invocationId,
          target: target,
          arguments: [call.params, { UseGzip: useGzip }],
        }) + "\x1e";

      return {
        invocationId: invocationId,
        target: target,
        message: message,
        retryTransport:
          call.retryTransport !== undefined
            ? call.retryTransport === true
            : defaultRetryTransport,
      };
    });

    const promises = invocations.map((item) => {
      return new Promise((resolve, reject) => {
        const pendingItem = {
          invocationId: item.invocationId,
          target: item.target,
          retryTransport: item.retryTransport,
          generation: itemGeneration,
          sent: false,
          settled: false,
          resolve: (val) => {
            if (!pendingItem.settled) {
              pendingItem.settled = true;
              resolve(val);
            }
          },
          reject: (err) => {
            if (!pendingItem.settled) {
              pendingItem.settled = true;
              reject(err);
            }
          },
        };

        this._hubPending.set(item.invocationId, pendingItem);
        if (timeoutMs > 0) {
          setTimeout(() => {
            if (
              !pendingItem.settled &&
              itemGeneration === this._hubGeneration &&
              this._hubPending.get(item.invocationId) === pendingItem
            ) {
              this._hubPending.delete(item.invocationId);
              pendingItem.reject(
                this._hubTimeoutError(
                  `SignalR ${item.target} 调用响应超时 (${Math.round(timeoutMs / 1000)}秒)`,
                ),
              );
            }
          }, timeoutMs);
        }
      });
    });

    for (const promise of promises) promise.catch(() => {});
    const batchPromise =
      options.settled === true
        ? Promise.allSettled(promises)
        : Promise.all(promises);
    batchPromise.catch(() => {});
    const payload = invocations.map((item) => item.message).join("");

    try {
      await activeSocket.send(payload);
      for (const item of invocations) {
        const pending = this._hubPending.get(item.invocationId);
        if (pending) pending.sent = true;
      }
    } catch (sendErr) {
      const transportError = this._hubPreSendTransportError(
        `发送 SignalR 请求失败: ${sendErr && sendErr.message ? sendErr.message : sendErr}`,
        sendErr,
      );
      for (const item of invocations) {
        const pending = this._hubPending.get(item.invocationId);
        if (pending) {
          this._hubPending.delete(item.invocationId);
          pending.reject(transportError);
        }
      }
      await batchPromise.catch(() => {});
      throw transportError;
    }

    return await batchPromise;
  }

  async _hubInvoke(socket, target, params, options = {}) {
    const results = await this._hubInvokeBatch(
      socket,
      [
        {
          target: target,
          params: params,
          retryTransport: options.retryTransport,
        },
      ],
      options,
    );
    return results[0];
  }

  async _hubInvokeMany(socket, target, paramsList, options = {}) {
    if (!Array.isArray(paramsList) || paramsList.length === 0) {
      return [];
    }
    return await this._hubInvokeBatch(
      socket,
      paramsList.map((params) => ({
        target: target,
        params: params,
        retryTransport: options.retryTransport,
      })),
      options,
    );
  }

  /**
   * 并发复用长期 WebSocket 会话。Unauthorized 触发一次令牌刷新重试；
   * 仅当 retryTransport === true 的幂等读取允许在建连断开后安全重试一次。
   * 非幂等状态修改在已发送未完成时断开，坚决抛出 LIGHTNOVELSHELF_HUB_NO_REPLAY。
   */
  async _runHubSession(operationName, operation, options = {}) {
    const authGeneration = this._authGeneration;
    const retryTransport = options.retryTransport === true;

    return await (async () => {
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
          let socket = null;
          try {
            assertCurrentAuth();
            socket = await this._ensureHubConnected(forceRefresh);
            forceRefresh = false;
            assertCurrentAuth();
            const result = await operation(socket);
            assertCurrentAuth();
            succeeded = true;
            return result;
          } catch (error) {
            if (this._isHubNoReplayError(error)) {
              throw error;
            }
            if (this._isTerminalRefreshError(error)) {
              throw error;
            }
            assertCurrentAuth();
            const unauthorized = this._isUnauthorizedError(error);
            const transport = this._isHubTransportError(error);
            const safePreSendRetry =
              transport && error && error.safeToRetry === true;

            if (unauthorized) {
              this._clearSessionTokenIfOwned(
                authGeneration,
                this.loadData("refreshToken"),
                this._sessionToken,
              );
              this._disconnectHub("Unauthorized 401");
            } else if (transport) {
              if (socket && this._hubSocket === socket) {
                this._disconnectHub("Transport error");
              }
            }

            const canRetry =
              retryCount === 0 &&
              (unauthorized || safePreSendRetry || (transport && retryTransport));
            if (!canRetry) {
              if (transport && !safePreSendRetry) {
                throw this._hubNoReplayError(error);
              }
              throw error;
            }

            retryCount += 1;
            forceRefresh = unauthorized;
          }
        }
      } finally {
        if (
          succeeded &&
          operationName !== "SignIn" &&
          operationName !== "Prewarm"
        ) {
          this._tryAutoSignIn();
        }
      }
    })();
  }

  async _hubCall(target, params, options = {}) {
    return await this._runHubSession(
      target,
      async (socket) => await this._hubInvoke(socket, target, params, options),
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

  _comicChapterId(value) {
    const chapterId = Number(value);
    return Number.isSafeInteger(chapterId) && chapterId > 0
      ? chapterId
      : null;
  }

  _encodeComicPageKey(chapterId, page) {
    if (
      this._comicChapterId(chapterId) === null ||
      !Number.isSafeInteger(page) ||
      page < 0
    ) {
      throw new Error("无效轻书架章节图片键");
    }
    return `${LightNovelShelf.comicPageKeyPrefix}${chapterId}/${page}`;
  }

  _parseComicPageKey(value) {
    if (
      typeof value !== "string" ||
      !value.startsWith(LightNovelShelf.comicPageKeyPrefix)
    ) {
      return null;
    }

    const match = value
      .slice(LightNovelShelf.comicPageKeyPrefix.length)
      .match(/^([1-9]\d*)\/(0|[1-9]\d*)$/);
    if (!match) {
      throw new Error("无效轻书架章节图片键");
    }

    const chapterId = Number(match[1]);
    const page = Number(match[2]);
    if (
      this._comicChapterId(chapterId) === null ||
      !Number.isSafeInteger(page)
    ) {
      throw new Error("无效轻书架章节图片键");
    }
    return { chapterId: chapterId, page: page };
  }

  _clearComicContentStates() {
    this._comicContentStates.clear();
    this._comicChapterPageCounts.clear();
    this._comicChapterBookIds.clear();
    this._comicMetadataKeys.clear();
    this._seriesRepresentativeBookIds.clear();
    this._seriesRepresentativeBookIdSources.clear();
    this._seriesListMetadata.clear();
    this._seriesNegativeCache.clear();
    this._bookInfoCache.clear();
    this._bookInfoPromises.clear();
    this._seriesLoadPromises.clear();
    this._lastSubmittedReadProgress = "";
    this._comicContentUseSequence = 0;
  }

  _comicContentStateKey(
    comicId,
    chapterId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${String(comicId)}\n${chapterId}`;
  }

  _touchComicContentState(key, state) {
    state.lastUsed = ++this._comicContentUseSequence;
    this._comicContentStates.set(key, state);

    while (
      this._comicContentStates.size >
      LightNovelShelf.comicContentStateLimit
    ) {
      let oldestKey = null;
      let oldestUse = Infinity;
      for (const [candidateKey, candidate] of this._comicContentStates) {
        if (candidate.lastUsed < oldestUse) {
          oldestUse = candidate.lastUsed;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === null) break;
      this._comicContentStates.delete(oldestKey);
    }
  }

  _comicChapterBookIdKey(
    comicId,
    chapterId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${String(comicId)}\n${chapterId}`;
  }

  _comicMetadataCacheKey(
    comicId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${String(comicId)}`;
  }

  _mergeComicMetadataCache(
    comicId,
    chapterBookIds,
    chapterPageCounts,
    apiBase,
    authGeneration,
  ) {
    const cacheKey = this._comicMetadataCacheKey(
      comicId,
      apiBase,
      authGeneration,
    );
    const previous = this._comicMetadataKeys.get(cacheKey);
    if (previous) {
      for (const key of previous.pageKeys) {
        const oldPageCount = this._comicChapterPageCounts.get(key);
        const hasNewPageCount = chapterPageCounts.has(key);
        const newPageCount = hasNewPageCount
          ? chapterPageCounts.get(key)
          : null;
        if (!hasNewPageCount || oldPageCount !== newPageCount) {
          this._comicContentStates.delete(key);
        }
      }
      for (const key of previous.bookKeys) this._comicChapterBookIds.delete(key);
      for (const key of previous.pageKeys) {
        this._comicChapterPageCounts.delete(key);
      }
      this._comicMetadataKeys.delete(cacheKey);
    }

    for (const [key, value] of chapterBookIds) {
      this._comicChapterBookIds.set(key, value);
    }
    for (const [key, value] of chapterPageCounts) {
      this._comicChapterPageCounts.set(key, value);
    }
    this._comicMetadataKeys.set(cacheKey, {
      bookKeys: new Set(chapterBookIds.keys()),
      pageKeys: new Set(chapterPageCounts.keys()),
    });

    while (
      this._comicMetadataKeys.size >
      this.constructor.comicMetadataCacheLimit
    ) {
      const oldestKey = this._comicMetadataKeys.keys().next().value;
      const oldest = this._comicMetadataKeys.get(oldestKey);
      this._comicMetadataKeys.delete(oldestKey);
      if (!oldest) continue;
      for (const key of oldest.bookKeys) this._comicChapterBookIds.delete(key);
      for (const key of oldest.pageKeys) {
        this._comicChapterPageCounts.delete(key);
      }
    }
  }

  _getComicContentState(comicId, chapterId) {
    const key = this._comicContentStateKey(comicId, chapterId);
    let state = this._comicContentStates.get(key);
    if (!state) {
      state = {
        apiBase: this.apiBase,
        authGeneration: this._authGeneration,
        comicId: String(comicId),
        chapterId: chapterId,
        total: null,
        batches: new Map(),
        lastUsed: 0,
      };
    }
    this._touchComicContentState(key, state);
    return state;
  }

  _knownComicPageCount(comicId, chapterId) {
    const state = this._getComicContentState(comicId, chapterId);
    if (state.total !== null) return state.total;

    const pageCount = this._comicChapterPageCounts.get(
      this._comicContentStateKey(comicId, chapterId),
    );
    if (Number.isSafeInteger(pageCount) && pageCount >= 0) {
      state.total = pageCount;
      return pageCount;
    }
    return null;
  }

  _comicContentBatchFromResponse(data, requestedSkip, requestedChapterId) {
    const chapter = this._value(data, "chapter", "Chapter", null);
    if (!chapter || typeof chapter !== "object") {
      throw new Error("GetComicContent 未返回 chapter/Chapter");
    }

    if (requestedChapterId !== undefined && requestedChapterId !== null) {
      const responseChapterId = this._comicChapterId(
        this._value(chapter, "id", "Id", null),
      );
      if (
        responseChapterId === null ||
        responseChapterId !== requestedChapterId
      ) {
        throw new Error(
          `章节 ID 不匹配: 请求 ${requestedChapterId}，响应 ${responseChapterId}`,
        );
      }
    }

    const rawBookId = this._value(chapter, "bookId", "BookId", null);
    const parsedBookId = Number(rawBookId);
    const validBookId =
      Number.isSafeInteger(parsedBookId) && parsedBookId > 0
        ? parsedBookId
        : null;

    const imagesRaw = this._value(chapter, "images", "Images", null);
    const total = Number(this._value(chapter, "total", "Total", NaN));
    const reportedSkip = this._value(chapter, "skip", "Skip", null);
    if (!Array.isArray(imagesRaw) || !Number.isSafeInteger(total) || total < 0) {
      throw new Error("章节分页响应格式异常");
    }
    if (
      !Number.isSafeInteger(requestedSkip) ||
      requestedSkip < 0 ||
      requestedSkip % LightNovelShelf.comicContentPageSize !== 0 ||
      (total === 0 ? requestedSkip !== 0 : requestedSkip >= total)
    ) {
      throw new Error(`章节分页位置异常: Skip ${requestedSkip}`);
    }
    if (
      reportedSkip !== null &&
      reportedSkip !== undefined &&
      Number(reportedSkip) !== requestedSkip
    ) {
      throw new Error(
        `章节分页位置不匹配: 请求 ${requestedSkip}，响应 ${reportedSkip}`,
      );
    }

    const expectedCount =
      total === 0
        ? 0
        : Math.min(LightNovelShelf.comicContentPageSize, total - requestedSkip);
    if (imagesRaw.length !== expectedCount) {
      throw new Error(
        `章节分页数据不完整: Skip ${requestedSkip}, 预期 ${expectedCount} 页，实际 ${imagesRaw.length} 页`,
      );
    }

    const images = imagesRaw.map((image) => {
      if (typeof image !== "string" || !image.trim()) {
        throw new Error(`章节分页包含无效图片: Skip ${requestedSkip}`);
      }
      return this._normalizeUrl(image.trim());
    });
    return {
      skip: requestedSkip,
      total: total,
      images: images,
      bookId: validBookId,
    };
  }

  async _loadComicContentBatch(comicId, chapterId, skip) {
    const state = this._getComicContentState(comicId, chapterId);
    const existing = state.batches.get(skip);
    if (existing) return await existing;

    let batchPromise;
    batchPromise = (async () => {
      const data = await this._hubCall(
        "GetComicContent",
        {
          Cid: chapterId,
          Skip: skip,
          Take: LightNovelShelf.comicContentPageSize,
        },
        { retryTransport: true },
      );
      if (
        state.apiBase !== this.apiBase ||
        state.authGeneration !== this._authGeneration
      ) {
        throw new Error("轻书架章节图片请求已失效");
      }
      const batch = this._comicContentBatchFromResponse(data, skip, chapterId);
      if (batch.bookId !== null) {
        const bookKey = this._comicChapterBookIdKey(
          comicId,
          chapterId,
          state.apiBase,
          state.authGeneration,
        );
        this._comicChapterBookIds.set(bookKey, batch.bookId);
        const metaKey = this._comicMetadataCacheKey(
          comicId,
          state.apiBase,
          state.authGeneration,
        );
        const meta = this._comicMetadataKeys.get(metaKey);
        if (meta) {
          meta.bookKeys.add(bookKey);
        }
      }
      if (state.total !== null && state.total !== batch.total) {
        throw new Error(
          `章节总页数发生变化: 原 ${state.total} 页，现 ${batch.total} 页`,
        );
      }
      state.total = batch.total;
      const stateKey = this._comicContentStateKey(comicId, chapterId);
      if (this._comicContentStates.get(stateKey) === state) {
        this._touchComicContentState(stateKey, state);
      }
      return batch;
    })();
    state.batches.set(skip, batchPromise);

    try {
      return await batchPromise;
    } catch (error) {
      if (state.batches.get(skip) === batchPromise) {
        state.batches.delete(skip);
      }
      throw error;
    }
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

  _seriesCacheKey(
    seriesTitle,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${String(seriesTitle)}`;
  }

  _seriesBookMapStorageKey(apiBase = this.apiBase) {
    return `seriesBookMap:${apiBase}`;
  }

  _getPersistentSeriesBookMap(apiBase = this.apiBase) {
    const raw = this.loadData(this._seriesBookMapStorageKey(apiBase));
    if (!raw) return new Map();
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (_e) {
        return new Map();
      }
    }
    if (!parsed || typeof parsed !== "object") {
      return new Map();
    }
    const map = new Map();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const title = String(entry[0] == null ? "" : entry[0]).trim();
          const id = Number(entry[1]);
          if (title && Number.isSafeInteger(id) && id > 0) {
            map.set(title, id);
          }
        } else if (entry && typeof entry === "object") {
          const title = String(
            this._value(entry, "title", "Title", "") || "",
          ).trim();
          const id = Number(this._value(entry, "id", "Id", NaN));
          if (title && Number.isSafeInteger(id) && id > 0) {
            map.set(title, id);
          }
        }
      }
    } else {
      for (const [key, val] of Object.entries(parsed)) {
        const title = String(key == null ? "" : key).trim();
        const id = Number(val);
        if (title && Number.isSafeInteger(id) && id > 0) {
          map.set(title, id);
        }
      }
    }
    return map;
  }

  _savePersistentSeriesBookMap(map, apiBase = this.apiBase) {
    while (map.size > this.constructor.seriesBookMapLimit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    const obj = Object.create(null);
    for (const [title, id] of map) {
      obj[title] = id;
    }
    this.saveData(this._seriesBookMapStorageKey(apiBase), JSON.stringify(obj));
  }

  _getPersistentSeriesBookId(title, apiBase = this.apiBase) {
    const normalizedTitle = String(title == null ? "" : title).trim();
    if (!normalizedTitle) return null;
    const map = this._getPersistentSeriesBookMap(apiBase);
    const id = map.get(normalizedTitle);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  _setPersistentSeriesBookId(title, bookId, apiBase = this.apiBase) {
    const normalizedTitle = String(title == null ? "" : title).trim();
    const normalizedId = Number(bookId);
    if (
      !normalizedTitle ||
      !Number.isSafeInteger(normalizedId) ||
      normalizedId <= 0
    ) {
      return;
    }
    const map = this._getPersistentSeriesBookMap(apiBase);
    if (map.has(normalizedTitle)) {
      map.delete(normalizedTitle);
    }
    map.set(normalizedTitle, normalizedId);
    this._savePersistentSeriesBookMap(map, apiBase);
  }

  _parseDirectBookId(id) {
    const raw = String(id == null ? "" : id).trim();
    if (!raw) return null;
    const match = raw.match(/^(?:book:)?([1-9]\d*)$/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  _deleteSeriesBookMapping(seriesTitle, bookId = null, apiBase = this.apiBase) {
    const title = String(seriesTitle == null ? "" : seriesTitle).trim();
    if (!title) return;

    for (const key of Array.from(this._seriesRepresentativeBookIds.keys())) {
      if (key.startsWith(`${apiBase}\n`) && key.endsWith(`\n${title}`)) {
        this._seriesRepresentativeBookIds.delete(key);
        this._seriesRepresentativeBookIdSources.delete(key);
      }
    }

    for (const key of Array.from(this._seriesListMetadata.keys())) {
      if (key.startsWith(`${apiBase}\n`) && key.endsWith(`\n${title}`)) {
        this._seriesListMetadata.delete(key);
      }
    }

    for (const key of Array.from(this._seriesNegativeCache.keys())) {
      if (key.startsWith(`${apiBase}\n`) && key.endsWith(`\n${title}`)) {
        this._seriesNegativeCache.delete(key);
      }
    }

    for (const key of Array.from(this._seriesLoadPromises.keys())) {
      if (
        key.startsWith(`${apiBase}\n`) &&
        (key.endsWith(`\n${title}`) ||
          key.includes(`\n${title}\n`) ||
          key.endsWith(`\n${title}\nresolve`))
      ) {
        this._seriesLoadPromises.delete(key);
      }
    }

    const persistentMap = this._getPersistentSeriesBookMap(apiBase);
    if (persistentMap.has(title)) {
      persistentMap.delete(title);
      this._savePersistentSeriesBookMap(persistentMap, apiBase);
    }

    const normalizedBadBookId = Number(bookId);
    if (Number.isSafeInteger(normalizedBadBookId) && normalizedBadBookId > 0) {
      for (const key of Array.from(this._bookInfoCache.keys())) {
        if (
          key.startsWith(`${apiBase}\n`) &&
          key.endsWith(`\n${normalizedBadBookId}`)
        ) {
          this._bookInfoCache.delete(key);
        }
      }
      for (const key of Array.from(this._bookInfoPromises.keys())) {
        if (
          key.startsWith(`${apiBase}\n`) &&
          key.endsWith(`\n${normalizedBadBookId}`)
        ) {
          this._bookInfoPromises.delete(key);
        }
      }
    }
  }

  _rememberRepresentativeBookId(
    seriesTitle,
    bookId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
    source = "memory",
  ) {
    const normalizedId = Number(bookId);
    const title = String(seriesTitle == null ? "" : seriesTitle).trim();
    if (
      !title ||
      !Number.isSafeInteger(normalizedId) ||
      normalizedId <= 0
    ) {
      return;
    }
    const key = this._seriesCacheKey(title, apiBase, authGeneration);
    this._seriesRepresentativeBookIds.set(key, normalizedId);
    this._seriesRepresentativeBookIdSources.set(key, source);
    this._setPersistentSeriesBookId(title, normalizedId, apiBase);
  }

  _rememberSeriesListMetadata(
    item,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
    source = "memory",
  ) {
    const title = String(this._value(item, "title", "Title", "") || "").trim();
    const rawId = this._value(item, "id", "Id", NaN);
    const representativeBookId = Number(rawId);
    if (
      !title &&
      (!Number.isSafeInteger(representativeBookId) || representativeBookId <= 0)
    ) {
      return;
    }
    const metadata = {
      title: title,
      originalTitle: String(
        this._value(item, "originalTitle", "OriginalTitle", "") || "",
      ),
      cover: String(this._value(item, "cover", "Cover", "") || ""),
      count: Number(this._value(item, "count", "Count", 0) || 0),
      lastUpdatedAt:
        this._value(item, "lastUpdatedAt", "LastUpdatedAt", null),
      representativeBookId: representativeBookId,
    };
    if (title) {
      this._seriesListMetadata.set(
        this._seriesCacheKey(title, apiBase, authGeneration),
        metadata,
      );
      if (Number.isSafeInteger(representativeBookId) && representativeBookId > 0) {
        this._rememberRepresentativeBookId(
          title,
          representativeBookId,
          apiBase,
          authGeneration,
          source,
        );
      }
    }
    if (Number.isSafeInteger(representativeBookId) && representativeBookId > 0) {
      this._seriesListMetadata.set(
        this._seriesCacheKey(
          `book:${representativeBookId}`,
          apiBase,
          authGeneration,
        ),
        metadata,
      );
      this._seriesListMetadata.set(
        this._seriesCacheKey(
          representativeBookId,
          apiBase,
          authGeneration,
        ),
        metadata,
      );
    }
  }

  async _verifyCandidate(candidateBookId, expectedTitle) {
    const bookId = Number(candidateBookId);
    if (!Number.isSafeInteger(bookId) || bookId <= 0) return null;
    const normalizedExpectedTitle = String(
      expectedTitle == null ? "" : expectedTitle,
    ).trim();
    if (!normalizedExpectedTitle) return null;

    try {
      const info = await this._getBookInfo(bookId, "verify");
      const bookObj = this._value(info, "book", "Book", info);
      const type = String(this._value(bookObj, "type", "Type", ""));
      const resolvedSeriesTitle = String(
        this._value(info, "seriesTitle", "SeriesTitle", "") || "",
      ).trim();
      const verifiedBookId = Number(this._value(bookObj, "id", "Id", NaN));

      if (
        verifiedBookId === bookId &&
        type === "Comic" &&
        resolvedSeriesTitle === normalizedExpectedTitle
      ) {
        return { bookId: bookId, info: info };
      }
    } catch (err) {
      if (this._isOperationalError(err)) {
        throw err;
      }
      // 非运行故障（如 404、类型不符、契约错误、标题不匹配）判定为无效候选
    }
    return null;
  }

  async _resolveFromHistory(title, apiBase, authGeneration) {
    const historyData = await this._hubCall(
      "GetReadHistory",
      {},
      { retryTransport: true },
    );
    const historyIds = this._historyIdsFromResponse(historyData);
    if (!Array.isArray(historyIds) || historyIds.length === 0) {
      return null;
    }

    const chunkSize = this.constructor.legacyHistoryChunkSize || 24;
    for (let i = 0; i < historyIds.length; i += chunkSize) {
      const chunk = historyIds.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;

      const data = await this._hubCall(
        "GetBookListByIds",
        {
          Ids: chunk,
          Type: "Comic",
        },
        { retryTransport: true },
      );
      const items = this._value(data, "data", "Data", []);
      for (const item of Array.isArray(items) ? items : []) {
        const itemTitle = String(
          this._value(item, "title", "Title", "") || "",
        ).trim();
        if (itemTitle === title) {
          const candidateId = Number(this._value(item, "id", "Id", NaN));
          if (Number.isSafeInteger(candidateId) && candidateId > 0) {
            const verified = await this._verifyCandidate(candidateId, title);
            if (verified) {
              return {
                bookId: candidateId,
                item: item,
                info: verified.info,
              };
            }
          }
        }
      }
    }
    return null;
  }

  async _resolveFromSearch(title, apiBase, authGeneration) {
    const modes = ["title", "exact", "name", "fuzzy"];
    const maxPages = this.constructor.legacySearchMaxPagesPerMode || 3;

    for (const mode of modes) {
      let page = 1;
      let totalPages = 1;

      while (page <= Math.min(totalPages, maxPages)) {
        const data = await this._hubCall(
          "SearchComicSeries",
          {
            KeyWords: title,
            Mode: mode,
            Page: page,
            Size: 20,
            IgnoreJapanese: false, // 强制不过滤
            IgnoreAI: false,       // 强制不过滤
          },
          { retryTransport: true },
        );

        const rawTotalPages = Number(
          this._value(data, "totalPages", "TotalPages", 1),
        );
        totalPages =
          Number.isSafeInteger(rawTotalPages) && rawTotalPages > 0
            ? rawTotalPages
            : 1;

        const items = this._value(data, "data", "Data", []);
        for (const item of Array.isArray(items) ? items : []) {
          const itemTitle = String(
            this._value(item, "title", "Title", "") || "",
          ).trim();
          if (itemTitle === title) {
            const candidateId = Number(this._value(item, "id", "Id", NaN));
            if (Number.isSafeInteger(candidateId) && candidateId > 0) {
              const verified = await this._verifyCandidate(candidateId, title);
              if (verified) {
                return {
                  bookId: candidateId,
                  item: item,
                  mode: mode,
                  info: verified.info,
                };
              }
            }
          }
        }

        page += 1;
      }
    }
    return null;
  }

  async _resolveRepresentativeBookIdInternal(title, key, apiBase, authGen) {
    // 1. 内存缓存快速恢复（当前会话已建立或已核验的代表 ID，零额外网络开销）
    const memoryId = this._seriesRepresentativeBookIds.get(key);
    if (Number.isSafeInteger(memoryId) && memoryId > 0) {
      return memoryId;
    }

    // 2. 持久映射恢复并严格校验
    let badPersistentId = null;
    const persistentId = this._getPersistentSeriesBookId(title, apiBase);
    if (Number.isSafeInteger(persistentId) && persistentId > 0) {
      const verified = await this._verifyCandidate(persistentId, title);
      if (verified) {
        this._rememberRepresentativeBookId(
          title,
          persistentId,
          apiBase,
          authGen,
          "persistent",
        );
        return persistentId;
      }
      // 坏持久映射先保留，只有新候选验证成功后才原子替换
      badPersistentId = persistentId;
    }

    // 3. 官方阅读历史主动拉取恢复
    try {
      const historyResult = await this._resolveFromHistory(
        title,
        apiBase,
        authGen,
      );
      if (historyResult) {
        const newBookId = historyResult.bookId;
        this._rememberSeriesListMetadata(
          historyResult.item,
          apiBase,
          authGen,
          "history",
        );
        this._setPersistentSeriesBookId(title, newBookId, apiBase);
        this._rememberRepresentativeBookId(
          title,
          newBookId,
          apiBase,
          authGen,
          "history",
        );
        return newBookId;
      }
    } catch (err) {
      if (this._isOperationalError(err)) {
        throw err;
      }
    }

    // 4. 有界检索恢复：title -> exact -> name -> fuzzy
    try {
      const searchResult = await this._resolveFromSearch(
        title,
        apiBase,
        authGen,
      );
      if (searchResult) {
        const newBookId = searchResult.bookId;
        this._rememberSeriesListMetadata(
          searchResult.item,
          apiBase,
          authGen,
          searchResult.mode,
        );
        this._setPersistentSeriesBookId(title, newBookId, apiBase);
        this._rememberRepresentativeBookId(
          title,
          newBookId,
          apiBase,
          authGen,
          searchResult.mode,
        );
        return newBookId;
      }
    } catch (err) {
      if (this._isOperationalError(err)) {
        throw err;
      }
    }

    // 5. 确定性无结果：坏持久映射继续保留，建立短时负缓存并抛出可操作诊断
    const diagMsg =
      badPersistentId !== null
        ? `无法解析漫画“${title}”对应的 Book.Id（已保留旧持久映射 ${badPersistentId}，但其 GetBookInfo 校验未通过，且官方历史与有界搜索未发现严格匹配漫画）`
        : `无法解析漫画“${title}”对应的 Book.Id（官方历史与有界搜索未发现严格匹配漫画）`;
    const notFoundError = new Error(diagMsg);
    notFoundError.code = "LIGHTNOVELSHELF_COMIC_NOT_FOUND";
    notFoundError.isDeterministicNotFound = true;
    notFoundError.title = title;
    if (badPersistentId !== null) {
      notFoundError.retainedPersistentId = badPersistentId;
    }

    this._seriesNegativeCache.set(key, {
      timestamp: Date.now(),
      error: notFoundError,
    });

    throw notFoundError;
  }

  async _resolveRepresentativeBookId(seriesTitle, options = {}) {
    const detailed = !!(options && (options.detailed || options.withSource));
    const directId = this._parseDirectBookId(seriesTitle);
    if (directId !== null) {
      if (detailed) {
        return { id: directId, bookId: directId, source: "direct" };
      }
      return directId;
    }
    const title = String(seriesTitle == null ? "" : seriesTitle).trim();
    if (!title) {
      throw new Error("无效漫画标识");
    }
    const apiBase = this.apiBase;
    const authGen = this._authGeneration;
    const key = this._seriesCacheKey(title, apiBase, authGen);

    // 负缓存拦截，防止连续重复请求
    const neg = this._seriesNegativeCache.get(key);
    if (neg) {
      const age = Date.now() - neg.timestamp;
      if (
        Number.isFinite(age) &&
        age >= 0 &&
        age < this.constructor.seriesNegativeCacheTtlMs
      ) {
        throw neg.error;
      }
      this._seriesNegativeCache.delete(key);
    }

    // 同标题并发共享 Promise
    const pendingKey = `${key}\nresolve`;
    const pending = this._seriesLoadPromises.get(pendingKey);
    if (pending) {
      const resolved = await pending;
      if (detailed) {
        const source =
          this._seriesRepresentativeBookIdSources.get(key) || "recovered";
        return { id: resolved, bookId: resolved, source: source };
      }
      return resolved;
    }

    const request = this._resolveRepresentativeBookIdInternal(
      title,
      key,
      apiBase,
      authGen,
    );
    this._seriesLoadPromises.set(pendingKey, request);
    const clear = () => {
      if (this._seriesLoadPromises.get(pendingKey) === request) {
        this._seriesLoadPromises.delete(pendingKey);
      }
    };
    request.then(clear, clear);

    const resolved = await request;
    if (detailed) {
      const source =
        this._seriesRepresentativeBookIdSources.get(key) || "recovered";
      return { id: resolved, bookId: resolved, source: source };
    }
    return resolved;
  }

  async _resolveRepresentativeBookIdDetailed(seriesTitle) {
    return await this._resolveRepresentativeBookId(seriesTitle, {
      detailed: true,
    });
  }

  _isContractOrMismatchError(err) {
    if (!err || typeof err !== "object") return false;
    if (this._isOperationalError(err)) return false;
    return (
      err.isContractError === true ||
      err.isBookInfoContractError === true ||
      err.isSeriesTitleMismatch === true ||
      String(err.message || "").includes("GetBookInfo 契约校验失败") ||
      String(err.message || "").includes("GetBookInfo 未返回 Book") ||
      String(err.message || "").includes("GetBookInfo 返回了无效的漫画 Book") ||
      String(err.message || "").includes("GetBookInfo 返回的 SeriesTitle 与请求不一致")
    );
  }

  _bookInfoCacheKey(
    bookId,
    apiBase = this.apiBase,
    authGeneration = this._authGeneration,
  ) {
    return `${apiBase}\n${authGeneration}\n${bookId}`;
  }

  _trimBookInfoCache() {
    while (this._bookInfoCache.size > this.constructor.bookInfoCacheLimit) {
      const oldestKey = this._bookInfoCache.keys().next().value;
      this._bookInfoCache.delete(oldestKey);
    }
  }

  _createBookInfoContractError(bookId, data, failureReason, source = "") {
    const typeStr =
      data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
    const rootKeys =
      data && typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data).sort().join(",") || "(empty)"
        : "(none)";
    const sourcePart = source ? `, source: ${source}` : "";
    const error = new Error(
      `GetBookInfo 契约校验失败 [requested Book.Id: ${bookId}, type: ${typeStr}, root keys: [${rootKeys}], failure: ${failureReason}${sourcePart}]`,
    );
    error.code = "LIGHTNOVELSHELF_BOOK_INFO_CONTRACT";
    error.isBookInfoContractError = true;
    error.isContractError = true;
    error.requestedBookId = bookId;
    error.failureReason = failureReason;
    if (source) error.source = source;
    return error;
  }

  _normalizeBookInfo(data, requestedBookId, source = "") {
    const normalizedRequestedId = Number(requestedBookId);
    if (
      !Number.isSafeInteger(normalizedRequestedId) ||
      normalizedRequestedId <= 0
    ) {
      throw new Error("无效轻书架 Book.Id");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        "响应非有效根对象",
        source,
      );
    }

    const seriesTitle = String(
      this._value(data, "seriesTitle", "SeriesTitle", "") || "",
    ).trim();
    if (!seriesTitle) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        "缺少或空的根 SeriesTitle",
        source,
      );
    }

    const series = this._value(data, "series", "Series", null);
    if (!Array.isArray(series)) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        "根 Series 必须为数组",
        source,
      );
    }

    const rawBook = this._value(data, "book", "Book", null);
    const bookObj =
      rawBook && typeof rawBook === "object" && !Array.isArray(rawBook)
        ? rawBook
        : data;

    const rawBookId = this._value(bookObj, "id", "Id", null);
    const bookId = Number(rawBookId);
    if (!Number.isSafeInteger(bookId) || bookId <= 0) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        `无效 Book.Id (${String(rawBookId)})`,
        source,
      );
    }
    if (bookId !== normalizedRequestedId) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        `Book.Id 不匹配 (返回 ${bookId}，请求 ${normalizedRequestedId})`,
        source,
      );
    }

    const type = String(this._value(bookObj, "type", "Type", "") || "").trim();
    if (type !== "Comic") {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        `非漫画类型 (Type: ${type || "(empty)"})`,
        source,
      );
    }

    const chapters = this._value(bookObj, "chapters", "Chapters", null);
    if (!Array.isArray(chapters)) {
      throw this._createBookInfoContractError(
        normalizedRequestedId,
        data,
        "Chapters 必须为数组",
        source,
      );
    }

    const normalizedBook = {
      ...bookObj,
      id: bookId,
      Id: bookId,
      type: "Comic",
      Type: "Comic",
      chapters: chapters,
      Chapters: chapters,
    };

    return {
      ...data,
      seriesTitle: seriesTitle,
      SeriesTitle: seriesTitle,
      series: series,
      Series: series,
      book: normalizedBook,
      Book: normalizedBook,
      id: bookId,
      Id: bookId,
      type: "Comic",
      Type: "Comic",
      chapters: chapters,
      Chapters: chapters,
    };
  }

  async _getBookInfo(bookId, source = "") {
    const normalizedId = Number(bookId);
    if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
      throw new Error("无效轻书架 Book.Id");
    }
    const key = this._bookInfoCacheKey(normalizedId);
    const cached = this._bookInfoCache.get(key);
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (
        Number.isFinite(age) &&
        age >= 0 &&
        age < this.constructor.bookInfoCacheTtlMs
      ) {
        try {
          return this._normalizeBookInfo(cached.data, normalizedId, source);
        } catch (_) {
          this._bookInfoCache.delete(key);
        }
      } else {
        this._bookInfoCache.delete(key);
      }
    }
    const pending = this._bookInfoPromises.get(key);
    if (pending) return await pending;

    const apiBase = this.apiBase;
    const authGeneration = this._authGeneration;
    const request = (async () => {
      const rawData = await this._hubCall(
        "GetBookInfo",
        { Id: normalizedId },
        { retryTransport: true },
      );
      const normalizedData = this._normalizeBookInfo(
        rawData,
        normalizedId,
        source,
      );
      if (
        apiBase === this.apiBase &&
        authGeneration === this._authGeneration
      ) {
        this._bookInfoCache.set(key, {
          data: normalizedData,
          fetchedAt: Date.now(),
        });
        this._trimBookInfoCache();
      }
      return normalizedData;
    })();

    this._bookInfoPromises.set(key, request);
    try {
      return await request;
    } finally {
      if (this._bookInfoPromises.get(key) === request) {
        this._bookInfoPromises.delete(key);
      }
    }
  }

  async _loadBookDetails(comicId, bookId, isDirectId = false) {
    const bookInfo = await this._getBookInfo(bookId);
    const book = this._value(bookInfo, "book", "Book", null);
    if (!book || typeof book !== "object") {
      const err = new Error("GetBookInfo 未返回 Book");
      err.isContractError = true;
      throw err;
    }
    const resolvedBookId = Number(
      this._value(book, "id", "Id", bookId),
    );
    const type = String(this._value(book, "type", "Type", ""));
    const chapters = this._value(book, "chapters", "Chapters", null);
    if (
      !Number.isSafeInteger(resolvedBookId) ||
      resolvedBookId <= 0 ||
      type !== "Comic" ||
      !Array.isArray(chapters)
    ) {
      const err = new Error("GetBookInfo 返回了无效的漫画 Book");
      err.isContractError = true;
      throw err;
    }

    const resolvedSeriesTitle = String(
      this._value(
        bookInfo,
        "seriesTitle",
        "SeriesTitle",
        comicId,
      ) || comicId,
    );
    if (!isDirectId) {
      if (resolvedSeriesTitle !== String(comicId)) {
        const err = new Error("GetBookInfo 返回的 SeriesTitle 与请求不一致");
        err.code = "LIGHTNOVELSHELF_SERIES_TITLE_MISMATCH";
        err.isContractError = true;
        err.isSeriesTitleMismatch = true;
        err.requestedSeriesTitle = comicId;
        err.resolvedSeriesTitle = resolvedSeriesTitle;
        err.representativeBookId = bookId;
        throw err;
      }
      this._rememberRepresentativeBookId(resolvedSeriesTitle, resolvedBookId);
    }

    return bookInfo;
  }

  async _bookCommentParams(comicId, page) {
    const directBookId = this._parseDirectBookId(comicId);
    const bookId =
      directBookId !== null
        ? directBookId
        : await this._resolveRepresentativeBookId(comicId);
    const params = { Type: "Book", Id: bookId };
    if (page !== undefined) params.Page = page;
    return params;
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
      userId:
        userId === null || userId === undefined ? null : String(userId),
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
    const rawId = this._value(item, "id", "Id", null);
    const bookId = Number(rawId);
    if (!Number.isSafeInteger(bookId) || bookId <= 0) {
      throw new Error(`无效漫画代表 Book.Id: ${String(rawId)}`);
    }
    const title = String(this._value(item, "title", "Title", "") || "").trim();
    if (!title) {
      throw new Error("无效漫画标题");
    }
    const count = Number(this._value(item, "count", "Count", 0) || 0);
    const original = this._value(item, "originalTitle", "OriginalTitle", "") || "";
    const updated = this._value(item, "lastUpdatedAt", "LastUpdatedAt", "") || "";
    const cover = this._value(item, "cover", "Cover", "") || "";
    this._rememberSeriesListMetadata(item);

    return {
      // 新条目永久使用 book:<Book.Id> 作为 Venera comicId；展示标题保持不变
      id: `book:${bookId}`,
      title: title,
      subTitle: original || (count ? `${count} 话` : ""),
      cover: this._normalizeUrl(cover),
      tags: [],
      description: [
        count ? `共 ${count} 话` : "",
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
        const [latestResult, popularResult, historyResult] =
          await this._hubInvokeBatch(
            session,
            [
              {
                target: "GetComicList",
                params: {
                  Page: 1,
                  Size: LightNovelShelf.discoveryPageSize,
                  Order: "latest",
                },
                retryTransport: true,
              },
              {
                target: "GetComicList",
                params: {
                  Page: 1,
                  Size: LightNovelShelf.discoveryPageSize,
                  Order: "view",
                },
                retryTransport: true,
              },
              { target: "GetReadHistory", params: {}, retryTransport: true },
            ],
            { retryTransport: true, settled: true },
          );

        assertCurrentRequest();
        const isLatestOk = latestResult && latestResult.status === "fulfilled";
        const isPopularOk =
          popularResult && popularResult.status === "fulfilled";
        const isHistoryOk =
          historyResult && historyResult.status === "fulfilled";

        if (!isLatestOk && !isPopularOk && !isHistoryOk) {
          const firstError =
            (latestResult && latestResult.reason) ||
            (popularResult && popularResult.reason) ||
            (historyResult && historyResult.reason) ||
            new Error("发现页全部首层请求均失败");
          throw firstError;
        }

        let historyIds = [];
        let historyDetails = null;

        if (isHistoryOk) {
          historyIds = this._historyIdsFromResponse(historyResult.value);
          const pageIds = historyIds.slice(
            0,
            LightNovelShelf.discoveryPageSize,
          );
          if (pageIds.length > 0) {
            try {
              historyDetails = await this._hubInvoke(
                session,
                "GetBookListByIds",
                { Ids: pageIds, Type: "Comic" },
                { retryTransport: true },
              );
              assertCurrentRequest();
            } catch (_detailsErr) {
              // 历史详情失败只清空历史
              historyDetails = null;
            }
          }
        }

        return {
          latestData: isLatestOk ? latestResult.value : null,
          popularData: isPopularOk ? popularResult.value : null,
          historyIds: historyIds,
          historyDetails: historyDetails,
        };
      },
      { retryTransport: true },
    );

    assertCurrentRequest();
    const seenSeries = new Set();
    const latest = loaded.latestData
      ? this._comicListFromResponse(loaded.latestData)
      : { comics: [], maxPage: 1 };
    const popular = loaded.popularData
      ? this._comicListFromResponse(loaded.popularData)
      : { comics: [], maxPage: 1 };
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
      this._clearAuthCredentials("User logout");
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
      const directBookId = this._parseDirectBookId(id);
      const isDirectId = directBookId !== null;
      const apiBase = this.apiBase;
      const authGeneration = this._authGeneration;

      let bookId;
      if (isDirectId) {
        bookId = directBookId;
      } else {
        bookId = await this._resolveRepresentativeBookId(id);
      }

      let bookInfo;
      try {
        bookInfo = await this._loadBookDetails(
          id,
          bookId,
          isDirectId,
        );
      } catch (firstErr) {
        const canRecover =
          !isDirectId &&
          this._isContractOrMismatchError(firstErr);
        if (!canRecover) {
          throw firstErr;
        }

        // 从内存中清除失效的代表 ID，重新进入完整解析流程（persistent -> history -> search）
        const key = this._seriesCacheKey(id, apiBase, authGeneration);
        this._seriesRepresentativeBookIds.delete(key);
        this._seriesRepresentativeBookIdSources.delete(key);

        const newBookId = await this._resolveRepresentativeBookId(id);
        if (newBookId === bookId) {
          throw firstErr;
        }
        bookInfo = await this._loadBookDetails(
          id,
          newBookId,
          false,
        );
      }

      const book = this._value(bookInfo, "book", "Book", null) || bookInfo;
      const currentBookId = Number(this._value(book, "id", "Id", bookId));
      const seriesTitle = String(
        this._value(bookInfo, "seriesTitle", "SeriesTitle", "") || "",
      ).trim();
      const targetComicId = String(id);

      let metadata =
        this._seriesListMetadata.get(
          this._seriesCacheKey(
            `book:${currentBookId}`,
            apiBase,
            authGeneration,
          ),
        ) ||
        this._seriesListMetadata.get(
          this._seriesCacheKey(currentBookId, apiBase, authGeneration),
        );
      if (!metadata && !isDirectId) {
        const titleMeta = this._seriesListMetadata.get(
          this._seriesCacheKey(id, apiBase, authGeneration),
        );
        if (
          titleMeta &&
          Number(titleMeta.representativeBookId) === currentBookId
        ) {
          metadata = titleMeta;
        }
      }

      const bookTitle = String(
        this._value(book, "title", "Title", "") || "",
      ).trim();
      const title = bookTitle || seriesTitle || targetComicId;

      const cover = this._normalizeUrl(
        this._value(book, "cover", "Cover", "") ||
          (metadata && metadata.cover) ||
          "",
      );

      const extra = this._value(book, "extra", "Extra", {}) || {};
      const classification =
        this._value(extra, "classification", "Classification", {}) || {};
      const author =
        this._value(book, "author", "Author", "") ||
        this._value(classification, "author", "Author", "") ||
        "";
      const rawTags = this._value(classification, "tags", "Tags", []);
      const tags = Array.isArray(rawTags) ? rawTags : [];
      const description =
        this._value(book, "introduction", "Introduction", "") || "";
      const originalTitle = metadata ? metadata.originalTitle : "";

      const tagMap = {};
      if (seriesTitle && seriesTitle !== title) {
        tagMap["系列"] = [seriesTitle];
      }
      const authors = String(author)
        .split(/、|×|\bx\b/i)
        .map((name) => name.trim())
        .filter(Boolean);
      if (authors.length) tagMap["作者"] = authors;
      if (tags.length) {
        tagMap["标签"] = tags.map(String);
      }
      if (originalTitle) tagMap["原名"] = [String(originalTitle)];

      const subTitle =
        (seriesTitle && seriesTitle !== title ? seriesTitle : "") ||
        originalTitle ||
        author ||
        "";

      const bookUpdated = this._value(
        book,
        "lastUpdatedAt",
        "LastUpdatedAt",
        null,
      );
      const bookCreated = this._value(book, "createdAt", "CreatedAt", null);
      let updateTime = bookUpdated ? String(bookUpdated) : null;
      if (metadata && metadata.lastUpdatedAt) {
        const metaTime = Date.parse(String(metadata.lastUpdatedAt));
        const currTime = updateTime ? Date.parse(updateTime) : NaN;
        if (
          Number.isFinite(metaTime) &&
          (!Number.isFinite(currTime) || metaTime > currTime)
        ) {
          updateTime = String(metadata.lastUpdatedAt);
        }
      }
      const uploadTime = bookCreated ? String(bookCreated) : null;

      const chapters = new Map();
      const rawChapters = this._value(book, "chapters", "Chapters", []);
      const chapterList = (Array.isArray(rawChapters) ? rawChapters : [])
        .slice()
        .sort(
          (a, b) =>
            Number(this._value(a, "sortNum", "SortNum", 0) || 0) -
            Number(this._value(b, "sortNum", "SortNum", 0) || 0),
        );

      const chapterPageCounts = new Map();
      const chapterBookIds = new Map();

      for (const chapter of chapterList) {
        const rawChapterId = this._value(chapter, "id", "Id", "");
        const chapterId = this._comicChapterId(rawChapterId);
        if (chapterId === null) continue;
        const sortNum = this._value(chapter, "sortNum", "SortNum", "");
        const rawChapterTitle = String(
          this._value(chapter, "title", "Title", "") || "",
        ).trim();
        const chapterTitle = rawChapterTitle || `第 ${sortNum} 话`;
        chapters.set(String(chapterId), chapterTitle);

        const pageCount = Number(
          this._value(chapter, "pageCount", "PageCount", NaN),
        );
        if (Number.isSafeInteger(pageCount) && pageCount >= 0) {
          chapterPageCounts.set(
            this._comicContentStateKey(
              targetComicId,
              chapterId,
              apiBase,
              authGeneration,
            ),
            pageCount,
          );
        }
        chapterBookIds.set(
          this._comicChapterBookIdKey(
            targetComicId,
            chapterId,
            apiBase,
            authGeneration,
          ),
          currentBookId,
        );
      }

      if (apiBase === this.apiBase && authGeneration === this._authGeneration) {
        this._mergeComicMetadataCache(
          targetComicId,
          chapterBookIds,
          chapterPageCounts,
          apiBase,
          authGeneration,
        );
      }

      const recommend = [];
      const seenRelatedIds = new Set([currentBookId]);
      const rawSeries = this._value(bookInfo, "series", "Series", []);
      for (const item of Array.isArray(rawSeries) ? rawSeries : []) {
        const rawId = this._value(item, "id", "Id", null);
        const relatedId = Number(rawId);
        if (!Number.isSafeInteger(relatedId) || relatedId <= 0) continue;
        if (seenRelatedIds.has(relatedId)) continue;
        const relatedTitle = String(
          this._value(item, "title", "Title", "") || "",
        ).trim();
        if (!relatedTitle) continue;
        seenRelatedIds.add(relatedId);

        const relatedCover = this._normalizeUrl(
          String(this._value(item, "cover", "Cover", "") || ""),
        );
        const relatedSeriesTitle = String(
          this._value(item, "seriesTitle", "SeriesTitle", seriesTitle) ||
            seriesTitle,
        ).trim();
        const relatedDesc = String(
          this._value(item, "introduction", "Introduction", "") ||
            this._value(item, "description", "Description", "") ||
            "",
        );
        recommend.push({
          id: `book:${relatedId}`,
          title: relatedTitle,
          subTitle: relatedSeriesTitle || "",
          cover: relatedCover,
          tags:
            relatedSeriesTitle && relatedSeriesTitle !== relatedTitle
              ? [relatedSeriesTitle]
              : [],
          description: relatedDesc,
        });
      }

      const uploader = this._value(book, "user", "User", {}) || {};
      const uploaderName = String(
        this._value(uploader, "userName", "UserName", "") || "",
      ).trim();

      return {
        title: title,
        subTitle: subTitle,
        cover: cover,
        description: description,
        tags: tagMap,
        chapters: chapters,
        recommend: recommend,
        updateTime: updateTime,
        uploadTime: uploadTime,
        uploader: uploaderName || undefined,
        subId: String(currentBookId),
      };
    },

    loadEp: async (comicId, epId) => {
      const chapterId = this._comicChapterId(epId);
      if (chapterId === null) {
        throw new Error(`无效章节 ID: ${epId}`);
      }

      let total = this._knownComicPageCount(comicId, chapterId);
      if (total === null) {
        total = (await this._loadComicContentBatch(comicId, chapterId, 0)).total;
      }
      if (total === 0) {
        throw new Error("该章节未返回任何图片");
      }

      return {
        images: Array.from({ length: total }, (_, page) =>
          this._encodeComicPageKey(chapterId, page),
        ),
      };
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

      const params = await this._bookCommentParams(comicId, requestPage);
      if (subId !== null && subId !== undefined && subId !== "") {
        const subBookId = Number(subId);
        if (Number.isSafeInteger(subBookId) && subBookId > 0) {
          params.Id = subBookId;
        }
      }
      const data = await this._hubCall("GetComments", params);
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
            comment.replyToId = String(targetId);
            const targetName = this._replyTargetUserName(
              parts.commentaries,
              parts.users,
              targetId,
            );
            if (targetName) {
              comment.replyToUserName = targetName;
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

      const params = await this._bookCommentParams(comicId);
      const subBookId = Number(subId);
      if (Number.isSafeInteger(subBookId) && subBookId > 0) {
        params.Id = subBookId;
      }
      params.Content = text;

      if (replyTo) {
        const reference = this._parseCommentReference(replyTo);
        params.ParentId = reference.id;
        await this._hubCall("ReplyComment", params);
      } else {
        await this._hubCall("PostComment", params);
      }

      return "ok";
    },

    replyComment: async (comicId, subId, content, parentId, replyId) => {
      if (!this.isLogged) {
        throw new Error("请先登录轻书架账号");
      }
      const text = String(content == null ? "" : content);
      if (!text.trim()) {
        throw new Error("评论内容不能为空");
      }
      const parent = this._parseCommentReference(parentId);
      const params = await this._bookCommentParams(comicId);
      const subBookId = Number(subId);
      if (Number.isSafeInteger(subBookId) && subBookId > 0) {
        params.Id = subBookId;
      }
      params.Content = text;
      params.ParentId = parent.id;
      if (replyId) {
        const targetId = this._positiveCommentInteger(replyId);
        if (targetId === null) throw new Error("无效回复评论 ID");
        params.ReplyId = targetId;
      }
      await this._hubCall("ReplyComment", params, { retryTransport: false });
      return "ok";
    },

    updateReadProgress: async (comicId, epId, page) => {
      if (!this.isLogged) return "ok";
      const chapterId = this._comicChapterId(epId);
      if (chapterId === null) throw new Error("无效轻书架章节 ID");
      const pageNumber = Number(page);
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error("无效轻书架阅读页码");
      }
      const bookId = this._comicChapterBookIds.get(
        this._comicChapterBookIdKey(comicId, chapterId),
      );
      if (!Number.isSafeInteger(bookId) || bookId <= 0) return "ok";
      const fingerprint = `${String(comicId)}:${bookId}:${chapterId}:${pageNumber}`;
      if (this._lastSubmittedReadProgress === fingerprint) return "ok";
      await this._hubCall(
        "SaveReadPosition",
        { Bid: bookId, Cid: chapterId, XPath: String(pageNumber) },
        { retryTransport: false },
      );
      this._lastSubmittedReadProgress = fingerprint;
      return "ok";
    },

    onImageLoad: async (url, comicId, epId) => {
      const headers = {
        "User-Agent": this.userAgent,
        Referer: this.siteBase + "/",
      };
      const reference = this._parseComicPageKey(url);
      if (!reference) {
        return { url: url, headers: headers };
      }

      const chapterId = this._comicChapterId(epId);
      if (chapterId === null || chapterId !== reference.chapterId) {
        throw new Error("轻书架章节图片键与当前章节不匹配");
      }

      const state = this._getComicContentState(comicId, chapterId);
      if (state.total !== null && reference.page >= state.total) {
        throw new Error("轻书架章节图片页码越界");
      }

      const skip =
        Math.floor(reference.page / LightNovelShelf.comicContentPageSize) *
        LightNovelShelf.comicContentPageSize;
      const batch = await this._loadComicContentBatch(comicId, chapterId, skip);
      if (reference.page >= batch.total) {
        throw new Error("轻书架章节图片页码越界");
      }

      const actualUrl = batch.images[reference.page - skip];
      if (!actualUrl) {
        throw new Error("轻书架章节图片页码越界");
      }
      return { url: actualUrl, headers: headers };
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

    tokenLogin: {
      title: "Token 登录",
      type: "callback",
      buttonText: "登录",
      callback: async () => await this._loginWithTokenDialog(),
    },
  };
}
