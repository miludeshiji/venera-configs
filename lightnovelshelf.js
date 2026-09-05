/**
 * 轻书架 (LightNovelShelf) for Venera / VeneraNext
 *
 * 版本：0.3.1
 *
 * 实现：
 * - ASP.NET Core SignalR JSON Hub Protocol
 * - WebSocket transport (skipNegotiation)
 * - 邮箱密码 / RefreshToken+x-id 登录并自动管理认证令牌
 * - RefreshToken -> session Token 自动刷新
 * - SignalR Bearer Token 认证
 * - 每日自动/手动签到
 * - 后台预连接 / WebSocket 长期连接与自动重连 / 单连接批量发现页（12 项）/ 24 项分类分页
 * - 漫画阅读历史 / 搜索 / 详情 / 章节 / 正文图片 / 系列评论与回复
 *
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
  version = "0.3.1";
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
      throw this._hubTransportError(
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
        const timeoutErr = this._hubTransportError(
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
        this._hubTransportError(
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
    const batchPromise = Promise.all(promises);
    batchPromise.catch(() => {});
    const payload = invocations.map((item) => item.message).join("");

    try {
      await activeSocket.send(payload);
      for (const item of invocations) {
        const pending = this._hubPending.get(item.invocationId);
        if (pending) pending.sent = true;
      }
    } catch (sendErr) {
      const transportError = this._hubTransportError(
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

  _comicContentBatchFromResponse(data, requestedSkip) {
    const chapter = this._value(data, "chapter", "Chapter", null);
    if (!chapter || typeof chapter !== "object") {
      throw new Error("GetComicContent 未返回 chapter/Chapter");
    }

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
    return { skip: requestedSkip, total: total, images: images };
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
      const batch = this._comicContentBatchFromResponse(data, skip);
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
            { retryTransport: true },
          );

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
            { retryTransport: true },
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
      const pageCountApiBase = this.apiBase;
      const pageCountAuthGeneration = this._authGeneration;
      const data = await this._hubCall("GetComicSeriesInfo", {
        SeriesTitle: id,
        Order: "latest",
      });

      const series = this._value(data, "series", "Series", null);
      const booksRaw = this._value(data, "books", "Books", []);
      const books = Array.isArray(booksRaw) ? booksRaw : [];
      const chapterPageCounts = new Map();
      const chapterBookIds = new Map();

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
        const bookId = Number(this._value(book, "id", "Id", NaN));
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
          const normalizedChapterId = this._comicChapterId(chapterId);
          const pageCount = Number(
            this._value(chapter, "pageCount", "PageCount", NaN),
          );
          if (
            normalizedChapterId !== null &&
            Number.isSafeInteger(pageCount) &&
            pageCount >= 0
          ) {
            chapterPageCounts.set(
              this._comicContentStateKey(
                id,
                normalizedChapterId,
                pageCountApiBase,
                pageCountAuthGeneration,
              ),
              pageCount,
            );
          }
          if (
            normalizedChapterId !== null &&
            Number.isSafeInteger(bookId) &&
            bookId > 0
          ) {
            chapterBookIds.set(
              this._comicChapterBookIdKey(
                id,
                normalizedChapterId,
                pageCountApiBase,
                pageCountAuthGeneration,
              ),
              bookId,
            );
          }

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
        .split(/、|×|\bx\b/i)
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

      if (
        pageCountApiBase === this.apiBase &&
        pageCountAuthGeneration === this._authGeneration
      ) {
        this._mergeComicMetadataCache(
          id,
          chapterBookIds,
          chapterPageCounts,
          pageCountApiBase,
          pageCountAuthGeneration,
        );
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

    replyComment: async (comicId, subId, content, parentId, replyId) => {
      if (!this.isLogged) {
        throw new Error("请先登录轻书架账号");
      }
      const text = String(content == null ? "" : content);
      if (!text.trim()) {
        throw new Error("评论内容不能为空");
      }
      const parent = this._parseCommentReference(parentId);
      const params = {
        Type: "Series",
        Id: 0,
        SeriesTitle: String(comicId),
        Content: text,
        ParentId: parent.id,
      };
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
