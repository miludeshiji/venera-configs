/**
 * 轻书架 (LightNovelShelf) WebSocket SignalR 迁移专项契约测试
 *
 * 运行方式: node scripts/_test_lightnovelshelf.js
 * 无任何外部 npm 依赖，基于原生 Node.js (v18+) 运行。
 *
 * 覆盖 Venera 运行时契约与迁移审查全部要点：
 * 1. 真实登录与 refresh 后建连 (验证 _jsonHeaders 恢复与返回邮箱)
 * 2. 全生命周期中无任何 /negotiate 调用与直连握手
 * 3. 真实 Venera _Timer.cancel() 与沙箱严禁注入 clear*
 * 4. 严格单 Receive Loop 互斥约束验证
 * 5. SignalR 握手分片到达与业务帧合帧处理
 * 6. SignalR Type 1/3/6/7 帧处理与 Type 7 幂等只断开一次
 * 7. Send 拒绝且无 unhandled rejection
 * 8. 旧 connect 晚失败不污染新连接 (Generation 代际隔离与 started barrier)
 * 9. Token 刷新连续失败后按退避阶梯重连并在恢复后成功建连
 * 10. 401 Unauthorized 触发强制刷新 sessionToken 并重建 WebSocket (支持空/本地化 Msg)
 * 11. public _hubCall timeout 仅拒绝自身且不断开健康 socket / 不影响其他 pending
 * 12. 真实发现页 _loadDiscoveryPageRequest 发送后断线有限重试
 * 13. 切换 API 线路时淘汰旧 WebSocket 并连接新线路
 * 14. 状态修改类非幂等调用遇断线坚决抛出 LIGHTNOVELSHELF_HUB_NO_REPLAY (覆盖真实 _performDailySignIn 与 sendComment 生产入口)
 * 15. Logout 彻底清理：凭据、Timer、Socket、Pending
 * 16. handshake 帧与 Type 7 关闭帧在同一 payload 到达不得复活连接
 * 17. 线路切换发生于旧 connect 尚在途时，淘汰旧尝试并立即连接新线路
 * 18. handshake early reject 时无 unhandledRejection 逃逸 (受控挂起 send)
 * 19. 主动断开 (Logout / _disconnectHub) 重置退避计数为 0
 * 20. Hub 信封以数值 Status 401 与 -100 表达认证失效时触发 SessionToken 刷新与重试
 * 21. refresh HTTP 401/404 或 Status -100 终态失效原子清理凭据且绝不后台重试，网络错误仍退避
 * 22. 切换线路时旧线路刷新独立隔离，新线路发起独立 refresh 且旧线路晚到失败不清凭据
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert");
const crypto = require("node:crypto");

// 监听未处理 rejection，确保全套测试中零 unhandledRejection 逃逸
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

class MockWebSocket {
  constructor(url, headers = {}, options = {}) {
    this.url = url;
    this.headers = headers;
    this.options = options;
    this.id = Math.floor(Math.random() * 1000000);
    this.closed = false;
    this.sentData = [];
    this.closeCode = null;
    this.closeReason = null;

    this._incomingQueue = [];
    this._pendingReceiver = null;
    this._hasActiveReceiver = false;
  }

  async send(data) {
    if (this.closed) {
      throw new Error("WebSocket is closed");
    }
    this.sentData.push(data);
  }

  async receive() {
    if (this.closed && this._incomingQueue.length === 0) {
      return {
        type: "close",
        code: this.closeCode || 1000,
        reason: this.closeReason || "Closed",
      };
    }

    // 严格模拟 Venera-Next 桥接层单 receiver 约束 (js_websocket.dart:376-378)
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

    if (this._pendingReceiver) {
      const receiver = this._pendingReceiver;
      this._pendingReceiver = null;
      this._hasActiveReceiver = false;
      // 严格模拟 Venera-Next 契约: 本地主动 close 时，挂起的 receive() 直接 reject StateError (js_websocket.dart:425-426)
      receiver.reject(
        new Error(`StateError: WebSocket Closed Connection: ${this.id}`),
      );
    }
  }

  pushMessage(data) {
    if (this._pendingReceiver) {
      const receiver = this._pendingReceiver;
      this._pendingReceiver = null;
      this._hasActiveReceiver = false;
      receiver.resolve({ type: "message", data });
      return;
    }
    this._incomingQueue.push({ type: "message", data });
  }

  pushClose(code = 1000, reason = "Closed") {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this._pendingReceiver) {
      const receiver = this._pendingReceiver;
      this._pendingReceiver = null;
      this._hasActiveReceiver = false;
      receiver.resolve({ type: "close", code, reason });
      return;
    }
    this._incomingQueue.push({ type: "close", code, reason });
  }
}

class MockTimer {
  constructor(fn, ms) {
    this.fn = fn;
    this.ms = ms;
    this.cancelled = false;
    this._id = setInterval(() => {
      if (this.cancelled) {
        clearInterval(this._id);
        return;
      }
      this.fn();
    }, ms);
  }

  cancel() {
    this.cancelled = true;
    clearInterval(this._id);
  }
}

function createSourceHarness(customNetwork = {}, initialData = {}) {
  const dataStore = new Map([
    [
      "account",
      JSON.stringify({
        email: "tester@example.com",
        password: "mockpassword",
      }),
    ],
    ["refreshToken", "mock-refresh-token-12345"],
    ["visitorId", "0123456789abcdef0123456789abcdef"],
    ...Object.entries(initialData),
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
      const refreshToken = this.loadData("refreshToken");
      return Boolean(
        (account && String(account).trim()) ||
        (refreshToken && String(refreshToken).trim()),
      );
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
    sha256: (buf) =>
      crypto.createHash("sha256").update(Buffer.from(buf)).digest(),
  };

  const createUuid = () => "01234567-89ab-cdef-0123-456789abcdef";

  const httpLog = [];
  const defaultNetwork = {
    post: async (url, headers, body) => {
      httpLog.push({ method: "POST", url, headers, body });
      if (url.includes("/api/user/login")) {
        return {
          status: 200,
          body: JSON.stringify({
            Success: true,
            Response: {
              RefreshToken: "login-refresh-token-99999",
              Token: "login-session-token-11111",
            },
          }),
        };
      }
      if (url.includes("/api/user/refresh_token")) {
        return {
          status: 200,
          body: JSON.stringify({
            Success: true,
            Response: {
              Token: "session-token-" + Date.now(),
            },
          }),
        };
      }
      throw new Error("Unexpected HTTP POST: " + url);
    },
    get: async (url, headers) => {
      httpLog.push({ method: "GET", url, headers });
      throw new Error("Unexpected HTTP GET: " + url);
    },
    delete: async (url, headers) => {
      httpLog.push({ method: "DELETE", url, headers });
      throw new Error("Unexpected HTTP DELETE: " + url);
    },
  };

  const Network = Object.assign({}, defaultNetwork, customNetwork);
  if (!Network.WebSocket) {
    Network.WebSocket = {
      connect: async (url, headers, options) => {
        const ws = new MockWebSocket(url, headers, options);
        return ws;
      },
    };
  }

  // Venera QuickJS 真实宿主环境：
  // 1. setInterval 返回具有 cancel() 方法的 _Timer 对象
  // 2. setTimeout 返回 undefined，无清理句柄
  // 3. 绝不注入 clearInterval 或 clearTimeout，模拟真实宿主！
  const sandboxSetInterval = (fn, ms) => {
    return new MockTimer(fn, ms);
  };
  const sandboxSetTimeout = (fn, ms) => {
    setTimeout(fn, ms);
    return undefined;
  };

  const UI = {
    showMessage: (_message) => {},
  };

  const sandbox = {
    ComicSource: MockComicSource,
    Convert,
    createUuid,
    Network,
    UI,
    setTimeout: sandboxSetTimeout,
    setInterval: sandboxSetInterval,
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
  sandbox.LightNovelShelf = LightNovelShelf;

  const source = new LightNovelShelf();

  // 注入微型测试计时器，确保测试毫秒级完成
  LightNovelShelf.hubPingIntervalMs = 25;
  LightNovelShelf.hubInvocationTimeoutMs = 60;
  LightNovelShelf.hubConnectTimeoutMs = 150;
  LightNovelShelf.hubHandshakeTimeoutMs = 150;
  LightNovelShelf.hubReconnectDelays = [0, 15, 30, 45];
  return { source, sandbox, dataStore, settingsStore, httpLog };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log("=== 轻书架 WebSocket SignalR 迁移专项契约测试 ===");
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total += 1;
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err);
      throw err;
    }
  }

  // 1. 真实登录与 refresh 后建连 (_jsonHeaders 验证)
  await test("1. 真实邮箱登录与 Token 刷新建连 (_jsonHeaders 可执行验证)", async () => {
    let capturedWs = null;
    const { source, httpLog, dataStore } = createSourceHarness(
      {
        WebSocket: {
          connect: async (url, headers, options) => {
            capturedWs = new MockWebSocket(url, headers, options);
            setTimeout(() => {
              capturedWs.pushMessage("{}\x1e");
            }, 10);
            return capturedWs;
          },
        },
      },
      {
        account: null,
        refreshToken: null,
      },
    );

    // 1.1 执行邮箱登录，验证 _jsonHeaders 正常工作
    const loginRes = await source.account.login(
      "newuser@example.com",
      "password123",
    );
    assert.strictEqual(loginRes, "newuser@example.com");
    assert.strictEqual(
      dataStore.get("refreshToken"),
      "login-refresh-token-99999",
    );

    const loginReq = httpLog.find((r) => r.url.includes("/api/user/login"));
    assert.ok(loginReq, "应有登录 HTTP 请求");
    assert.strictEqual(
      loginReq.headers["Content-Type"],
      "application/json",
      "_jsonHeaders 必须携带 application/json",
    );
    assert.strictEqual(loginReq.headers["Accept"], "application/json");

    // 1.2 显式过期刚刚登录缓存的 session token，建连时触发 _refreshSessionToken (同样调用 _jsonHeaders)
    source._sessionTokenAt = 0;
    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(socket, capturedWs);
    assert.strictEqual(source._hubState, "connected");

    const refreshReq = httpLog.find((r) =>
      r.url.includes("/api/user/refresh_token"),
    );
    assert.ok(refreshReq, "首次建连必须换取 session token");
    assert.strictEqual(
      refreshReq.headers["Content-Type"],
      "application/json",
    );
    assert.strictEqual(refreshReq.headers["Accept"], "application/json");
    await source._disconnectHub("Test completed");
  });

  // 2. 全生命周期中无任何 /negotiate 调用与直连握手
  await test("2. 全生命周期中无任何 /negotiate 调用，直连携带完整握手凭证", async () => {
    let capturedWs = null;
    const { source, httpLog } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(socket, capturedWs);
    assert.match(
      capturedWs.url,
      /^wss:\/\/api\.lightnovel\.life\/hub\/api\?access_token=session-token-/,
    );
    assert.match(
      capturedWs.headers["Authorization"],
      /^Bearer session-token-/,
    );
    assert.strictEqual(
      capturedWs.headers["x-id"],
      "0123456789abcdef0123456789abcdef",
    );
    assert.match(capturedWs.headers["User-Agent"], /Mozilla/);

    const hasNegotiate = httpLog.some((req) => req.url.includes("negotiate"));
    assert.strictEqual(hasNegotiate, false, "不得发起 /negotiate 请求");

    assert.strictEqual(capturedWs.sentData.length >= 1, true);
    assert.strictEqual(
      capturedWs.sentData[0],
      '{"protocol":"json","version":1}\x1e',
    );
    assert.strictEqual(source._hubState, "connected");

    await source._disconnectHub("Test completed");
  });

  // 3. 真实 Venera _Timer.cancel() 与沙箱严禁注入 clear*
  await test("3. 定时器使用 Venera _Timer.cancel() 管理，沙箱无 clearInterval/clearTimeout 仍正常工作", async () => {
    let capturedWs = null;
    const { source, sandbox } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    assert.strictEqual(
      typeof sandbox.clearInterval,
      "undefined",
      "沙箱中严禁存在 clearInterval",
    );
    assert.strictEqual(
      typeof sandbox.clearTimeout,
      "undefined",
      "沙箱中严禁存在 clearTimeout",
    );

    await source._ensureHubConnected(false);
    assert.ok(source._hubPingTimer, "建连后应生成 Ping 计时器");
    assert.strictEqual(
      typeof source._hubPingTimer.cancel,
      "function",
      "Ping 计时器必须拥有 cancel() 方法",
    );

    // 断开连接，验证 _stopHubPing 调用 timer.cancel() 且不抛出 ReferenceError
    source._disconnectHub("Stop ping test");
    assert.strictEqual(source._hubPingTimer, null);
    assert.strictEqual(source._hubState, "disconnected");
  });

  // 4. 单 Receive Loop 互斥约束验证
  await test("4. 严格遵守单一长期 Receive Loop，无并发 receive()", async () => {
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(source._hubState, "connected");

    const promise1 = source._hubInvoke(socket, "MockTarget1", { p: 1 });
    const promise2 = source._hubInvoke(socket, "MockTarget2", { p: 2 });

    await delay(15);
    const sentFrames = capturedWs.sentData.slice(1).join("");
    const ids = [...sentFrames.matchAll(/"invocationId":"(\d+)"/g)].map(
      (m) => m[1],
    );
    assert.strictEqual(ids.length, 2);

    capturedWs.pushMessage(
      `{"type":3,"invocationId":"${ids[0]}","result":{"success":true,"response":"data1"}}\x1e` +
        `{"type":3,"invocationId":"${ids[1]}","result":{"success":true,"response":"data2"}}\x1e`,
    );

    const [res1, res2] = await Promise.all([promise1, promise2]);
    assert.strictEqual(res1, "data1");
    assert.strictEqual(res2, "data2");

    await source._disconnectHub("Test completed");
  });

  // 5. SignalR 握手分片到达与业务帧合帧处理
  await test("5. 握手响应支持字符分片与业务帧合在同一 0x1E 报文传输", async () => {
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          // 模拟分片推送握手响应
          setTimeout(() => {
            capturedWs.pushMessage("{");
            capturedWs.pushMessage("}\x1e");
          }, 10);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(source._hubState, "connected");

    // 模拟服务端将 Completion 拆分分片推送
    const invokePromise = source._hubInvoke(socket, "SplitTarget", {});
    await delay(10);
    const lastPayload = capturedWs.sentData[capturedWs.sentData.length - 1];
    const match = lastPayload.match(/"invocationId":"(\d+)"/);
    const id = match ? match[1] : "1";

    capturedWs.pushMessage(`{"type":3,"invoc`);
    capturedWs.pushMessage(
      `ationId":"${id}","result":{"success":true,"response":"merged"}}\x1e`,
    );

    const res = await invokePromise;
    assert.strictEqual(res, "merged");

    await source._disconnectHub("Test completed");
  });

  // 6. SignalR Type 1/3/6/7 帧处理与 Type 7 幂等只断开一次
  await test("6. Type 1 忽略、Type 6 刷新保活、Type 7 服务端关闭且幂等断开", async () => {
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(source._hubState, "connected");

    // Type 1: 服务端调用广播，忽略未知 target，不断开连接
    capturedWs.pushMessage(
      '{"type":1,"target":"OnServerAnnouncement","arguments":["hello"]}\x1e',
    );
    await delay(10);
    assert.strictEqual(source._hubState, "connected");

    // Type 6: Ping 刷新时间
    const oldTime = source._hubLastReceivedAt;
    await delay(10);
    capturedWs.pushMessage('{"type":6}\x1e');
    await delay(5);
    assert.strictEqual(source._hubLastReceivedAt >= oldTime, true);
    // Type 7: 服务端主动关闭帧。设置重连退避延迟大于断言窗口，确保断言在自动重连执行前完成
    source.constructor.hubReconnectDelays = [50, 100, 150];
    capturedWs.pushMessage(
      '{"type":7,"error":"Server shutting down"}\x1e',
    );
    await delay(10);

    // 验证 _handleHubDisconnected 幂等保护：reconnectCount 仅递增 1 次，而非被 finally 重复触发递增 2 次
    assert.strictEqual(
      source._hubReconnectCount,
      1,
      "Type 7 断线必须只处理一次，不得连跳两级退避",
    );
    assert.strictEqual(
      source._hubState === "disconnected" ||
        source._hubState === "reconnecting",
      true,
    );

    await source._disconnectHub("Test completed");
  });

  // 7. Send 拒绝且无 unhandled rejection
  await test("7. socket.send 拒绝时所有 pending 均被捕获，零 unhandledRejection 逃逸", async () => {
    const preCount = unhandledRejections.length;
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          // 握手成功
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);

    // 覆盖 socket.send 模拟网络异常拒绝
    capturedWs.send = async () => {
      throw new Error("Socket send aborted by OS");
    };

    let caughtError = null;
    try {
      await source._hubInvokeBatch(socket, [
        { target: "BatchA", params: {} },
        { target: "BatchB", params: {} },
      ]);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Batch 发送失败必须向调用方抛出错误");
    assert.strictEqual(caughtError.code, "LIGHTNOVELSHELF_HUB_TRANSPORT");

    // 等待微任务与事件循环检查 unhandledRejection
    await delay(20);
    assert.strictEqual(
      unhandledRejections.length,
      preCount,
      "send 拒绝时不得触发全局 unhandledRejection 事件",
    );

    await source._disconnectHub("Test completed");
  });

  // 8. 旧 connect 晚失败不污染新连接 (Generation 代际隔离)
  await test("8. 旧 WebSocket 建连晚失败不覆盖新连接 connected 状态", async () => {
    let connectCount = 0;
    let rejectOldConnect = null;
    let firstConnectStartedResolve = null;
    const firstConnectStarted = new Promise((resolve) => {
      firstConnectStartedResolve = resolve;
    });

    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          connectCount += 1;
          const count = connectCount;
          if (count === 1) {
            // 第 1 次连接挂起，稍后由测试控制失败
            return new Promise((resolve, reject) => {
              rejectOldConnect = reject;
              firstConnectStartedResolve();
            });
          }
          const ws = new MockWebSocket(url, headers, options);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    // 触发第 1 次建连（挂起中，确保真正进入 WebSocket.connect 启动屏障）
    const p1 = source._ensureHubConnected(false).catch((err) => err);
    await firstConnectStarted;

    // 用户强制重连或状态失效，启动第 2 条连接
    source._disconnectHub("Supersede");
    const p2 = source._ensureHubConnected(false);
    const socket2 = await p2;
    assert.strictEqual(source._hubState, "connected");
    assert.strictEqual(source._hubSocket, socket2);

    // 此时旧连接晚失败
    rejectOldConnect(new Error("Old connection timed out"));
    await p1;
    await delay(10);

    // 验证新连接的状态未被旧失败篡改
    assert.strictEqual(
      source._hubState,
      "connected",
      "旧连接建连失败不得将新连接状态改为 disconnected",
    );
    assert.strictEqual(source._hubSocket, socket2);

    await source._disconnectHub("Test completed");
  });

  // 9. Token 刷新连续失败后按退避阶梯重连并在恢复后成功建连
  await test("9. 连续 Token 刷新失败按阶梯重试，网络恢复后第 3 次建连恢复", async () => {
    let refreshAttempts = 0;
    const sockets = [];

    const { source } = createSourceHarness({
      post: async (url, headers, body) => {
        if (url.includes("/api/user/refresh_token")) {
          refreshAttempts += 1;
          if (refreshAttempts < 3) {
            throw new Error("HTTP 503 Service Unavailable");
          }
          return {
            status: 200,
            body: JSON.stringify({ token: "recovered-token-123" }),
          };
        }
        throw new Error("Unexpected post: " + url);
      },
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          sockets.push(ws);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    // 触发首次建连，因刷新失败将调度阶梯重试
    const initialPromise = source._ensureHubConnected(false).catch(() => {});
    await initialPromise;

    assert.strictEqual(refreshAttempts, 1);
    assert.strictEqual(
      source._hubState === "reconnecting" ||
        source._hubState === "disconnected",
      true,
    );

    // 等待重试阶梯执行 (测试设置延迟分别为 0ms, 15ms, 30ms)
    await delay(120);

    assert.strictEqual(
      refreshAttempts >= 3,
      true,
      "应当已自动进行至少 3 次 refresh 尝试",
    );
    assert.strictEqual(
      source._hubState,
      "connected",
      "网络恢复后连接必须自动恢复至 connected",
    );
    assert.strictEqual(sockets.length, 1);

    await source._disconnectHub("Test completed");
  });

  // 10. 401 Unauthorized 触发强制刷新 sessionToken 并重建 WebSocket
  await test("10. 401 Unauthorized 触发清空 Token、单飞刷新并无缝重试", async () => {
    let callCount = 0;
    const sockets = [];
    let refreshCount = 0;

    const { source } = createSourceHarness({
      post: async (url, headers, body) => {
        if (url.includes("/api/user/refresh_token")) {
          refreshCount += 1;
          return {
            status: 200,
            body: JSON.stringify({
              token: `session-token-v${refreshCount}`,
            }),
          };
        }
        throw new Error("Unexpected post: " + url);
      },
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          sockets.push(ws);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    const res = await source._runHubSession("GetBookList", async (socket) => {
      callCount += 1;
      const promise = source._hubInvoke(
        socket,
        "GetBookList",
        {},
        { retryTransport: true },
      );
      await delay(10);
      const lastPayload = socket.sentData[socket.sentData.length - 1];
      const match = lastPayload.match(/"invocationId":"(\d+)"/);
      const id = match ? match[1] : "1";

      if (callCount === 1) {
        // 第 1 次返回 401 未授权
        socket.pushMessage(
          `{"type":3,"invocationId":"${id}","result":{"success":false,"status":401,"msg":"Unauthorized"}}\x1e`,
        );
      } else {
        // 第 2 次返回正常数据
        socket.pushMessage(
          `{"type":3,"invocationId":"${id}","result":{"success":true,"response":"auth-success"}}\x1e`,
        );
      }
      return await promise;
    });

    assert.strictEqual(res, "auth-success");
    assert.strictEqual(callCount, 2, "401 必须自动重试 1 次");
    assert.strictEqual(sockets.length, 2, "401 必须关闭旧连接并重建新连接");
    assert.strictEqual(refreshCount, 2, "401 必须强制重新刷新 SessionToken");

    await source._disconnectHub("Test completed");
  });

  // 11. public _hubCall timeout 仅拒绝自身且不断开健康 socket / 不影响其他 pending
  await test("11. public _hubCall 调用超时仅自身抛出 TIMEOUT，socket 保持 connected 且其余 pending 正常", async () => {
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);

    // 并发两个调用：call1 (public _hubCall) 发生超时，call2 (_hubInvoke 在同 socket 上) 正常返回
    const call1 = source._hubCall("HangingCall", { p: 1 });
    await delay(10);
    const call2 = source._hubInvoke(socket, "NormalCall", { p: 2 });

    // 等待 15ms 后为 call2 提供 completion 响应
    await delay(15);
    let id2 = null;
    const allFrames = capturedWs.sentData.join("").split("\x1e");
    for (const frameStr of allFrames) {
      if (!frameStr.trim()) continue;
      try {
        const frame = JSON.parse(frameStr);
        if (frame && frame.target === "NormalCall") {
          id2 = String(frame.invocationId);
          break;
        }
      } catch (_) {}
    }
    assert.ok(id2, "NormalCall 应当已成功发送");
    capturedWs.pushMessage(
      `{"type":3,"invocationId":"${id2}","result":{"success":true,"response":"normal-ok"}}\x1e`,
    );

    const res2 = await call2;
    assert.strictEqual(res2, "normal-ok", "正常请求应成功 resolve");

    // call1 超时拒绝
    let call1Err = null;
    try {
      await call1;
    } catch (err) {
      call1Err = err;
    }

    assert.ok(call1Err, "超时调用必须抛出异常");
    assert.strictEqual(call1Err.code, "LIGHTNOVELSHELF_HUB_TIMEOUT");
    assert.strictEqual(
      source._hubState,
      "connected",
      "单次 invocation 超时绝不得把健康 socket 断开",
    );
    assert.strictEqual(capturedWs.closed, false);

    await source._disconnectHub("Test completed");
  });

  // 12. 真实发现页 _loadDiscoveryPageRequest 发送后断线有限重试
  await test("12. 发现页批量调用携带 retryTransport，发送后断线可安全重试 1 次并成功", async () => {
    let callCount = 0;
    const sockets = [];

    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          sockets.push(ws);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    const pagePromise = source._loadDiscoveryPage();

    // 监控 socket 发送批处理请求后断线
    const checkAndRespond = async () => {
      while (sockets.length === 0) await delay(5);
      const s1 = sockets[0];
      while (s1.sentData.length < 2) await delay(5);

      callCount += 1;
      // 模拟发送后网络异常中断
      s1.pushClose(1006, "Dropped after discovery batch sent");

      // 等待重连创建第 2 个 socket
      while (sockets.length < 2) await delay(5);
      const s2 = sockets[1];
      while (s2.sentData.length < 2) await delay(5);

      callCount += 1;
      const batchPayload = s2.sentData[s2.sentData.length - 1];
      const ids = [...batchPayload.matchAll(/"invocationId":"(\d+)"/g)].map(
        (m) => m[1],
      );

      // 为发现页的 3 个请求推送完成帧 (GetComicList latest, GetComicList view, GetReadHistory)
      s2.pushMessage(
        `{"type":3,"invocationId":"${ids[0]}","result":{"success":true,"response":{"list":[],"total":0}}}\x1e` +
          `{"type":3,"invocationId":"${ids[1]}","result":{"success":true,"response":{"list":[],"total":0}}}\x1e` +
          `{"type":3,"invocationId":"${ids[2]}","result":{"success":true,"response":{"list":[]}}}\x1e`,
      );
    };

    checkAndRespond();
    const parts = await pagePromise;
    assert.strictEqual(Array.isArray(parts), true);
    assert.strictEqual(callCount, 2, "发现页发送后遇断线必须自动重试 1 次");

    await source._disconnectHub("Test completed");
  });

  // 13. 切换 API 线路时淘汰旧 WebSocket 并连接新线路
  await test("13. 切换 API 线路自动淘汰旧线路 socket 并重连新线路", async () => {
    const sockets = [];
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          sockets.push(ws);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    const s1 = await source._ensureHubConnected(false);
    assert.match(s1.url, /^wss:\/\/api\.lightnovel\.life/);

    // 原地切换线路至 Cloudflare
    source.saveSetting("apiServer", "https://cf-api.lightnovel.life");

    // 下一次调用确保连接
    const s2 = await source._ensureHubConnected(false);
    assert.strictEqual(s1.closed, true, "旧线路 socket 必须已被安全关闭");
    assert.match(
      s2.url,
      /^wss:\/\/cf-api\.lightnovel\.life/,
      "新 socket 必须连接到 Cloudflare 新线路",
    );
    assert.strictEqual(source._hubSocket, s2);

    await source._disconnectHub("Test completed");
  });

  // 14. 状态修改类非幂等调用遇断线坚决抛出 LIGHTNOVELSHELF_HUB_NO_REPLAY
  await test("14. SignIn / PostComment / ReplyComment 真实入口发送后认证断线坚决保持 NO_REPLAY 且绝不重发", async () => {
    const scenarios = [
      {
        name: "_performDailySignIn (SignIn 直接生产边界)",
        target: "SignIn",
        invoke: (s) => s._performDailySignIn(),
        expectThrow: true,
      },
      {
        name: "dailySignIn (公开签到入口，捕获并吞错)",
        target: "SignIn",
        invoke: (s) => s.dailySignIn(false),
        expectThrow: false,
      },
      {
        name: "comic.sendComment PostComment (发表主评论)",
        target: "PostComment",
        invoke: (s) => s.comic.sendComment("comic-123", "sub-1", "测试主评论", null),
        expectThrow: true,
      },
      {
        name: "comic.sendComment ReplyComment (回复评论)",
        target: "ReplyComment",
        invoke: (s) => s.comic.sendComment("comic-123", "sub-1", "测试回复评论", "456//1"),
        expectThrow: true,
      },
    ];

    for (const scenario of scenarios) {
      const sockets = [];
      let targetSentCount = 0;

      const { source, dataStore } = createSourceHarness({
        WebSocket: {
          connect: async (url, headers, options) => {
            const ws = new MockWebSocket(url, headers, options);
            sockets.push(ws);
            setTimeout(() => ws.pushMessage("{}\x1e"), 5);

            const originalSend = ws.send.bind(ws);
            ws.send = async (data) => {
              const res = await originalSend(data);
              const frames = String(data).split("\x1e");
              for (const f of frames) {
                if (!f.trim()) continue;
                try {
                  const parsed = JSON.parse(f);
                  if (parsed && parsed.target === scenario.target) {
                    targetSentCount += 1;
                    // 在调用已发送、尚未收到 completion 时，断开连接且原因携带 Unauthorized
                    setTimeout(() => {
                      ws.pushClose(1008, "Unauthorized: token revoked during in-flight call");
                    }, 5);
                  }
                } catch (_) {}
              }
              return res;
            };

            return ws;
          },
        },
      });

      dataStore.set("account", JSON.stringify({ email: "user@example.com" }));
      dataStore.set("refreshToken", "valid-refresh-token");
      dataStore.set("visitorId", "visitor-123");
      source._sessionToken = "active-session-token";
      source._sessionTokenAt = Date.now();
      source._sessionTokenGeneration = source._authGeneration;

      let caughtError = null;
      let result = undefined;
      try {
        result = await scenario.invoke(source);
      } catch (err) {
        caughtError = err;
      }

      if (scenario.expectThrow) {
        assert.ok(
          caughtError,
          `${scenario.name} 遇认证断线必须抛出异常`,
        );
        assert.strictEqual(
          caughtError.code,
          "LIGHTNOVELSHELF_HUB_NO_REPLAY",
          `${scenario.name} 遇认证断线必须保持 NO_REPLAY 错误码`,
        );
        assert.strictEqual(
          caughtError.message,
          "轻书架连接结果不确定，为避免重复操作，本次请求不会自动重放",
        );
      } else {
        assert.strictEqual(
          caughtError,
          null,
          `${scenario.name} 设计为外层吞错时不得向外抛出异常`,
        );
        assert.strictEqual(
          result,
          null,
          `${scenario.name} 失败时必须返回 null`,
        );
      }

      assert.strictEqual(
        targetSentCount,
        1,
        `${scenario.name} 发送后断线绝不得重新发送该 target`,
      );
      assert.strictEqual(
        sockets.length,
        1,
        `${scenario.name} 发生 NO_REPLAY 时绝不得建立第 2 个 socket 发起重试`,
      );

      await source._disconnectHub("Test completed");
    }
  });

  // 15. Logout 彻底清理：凭据、Timer、Socket、Pending
  await test("15. Logout 彻底清理状态：清除持久化凭据、关闭 socket、停止 Timer、不发起重连", async () => {
    let capturedWs = null;
    const { source, dataStore } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          setTimeout(() => capturedWs.pushMessage("{}\x1e"), 5);
          return capturedWs;
        },
      },
    });

    const socket = await source._ensureHubConnected(false);
    assert.strictEqual(source._hubState, "connected");
    assert.strictEqual(source._hubDesiredConnected, true);

    let pendingError = null;
    source
      ._hubInvoke(socket, "PendingBeforeLogout", {})
      .catch((err) => {
        pendingError = err;
      });

    source.account.logout();

    assert.strictEqual(dataStore.has("account"), false);
    assert.strictEqual(dataStore.has("refreshToken"), false);
    assert.strictEqual(dataStore.has("visitorId"), false);
    assert.strictEqual(source._hubDesiredConnected, false);
    assert.strictEqual(source._hubState, "disconnected");
    assert.strictEqual(source._hubPingTimer, null);
    assert.strictEqual(source._hubReconnectTimer, null);
    assert.strictEqual(source._hubPending.size, 0);
    assert.strictEqual(capturedWs.closed, true);

    await delay(30);
    assert.ok(pendingError, "挂起调用必须被拒绝");
    assert.strictEqual(source._hubState, "disconnected", "登出后绝不重连");
  });

  // 16. handshake 帧与 Type 7 关闭帧在同一 payload 到达不得复活连接
  await test("16. handshake 帧与 Type 7 关闭帧在同一 payload 到达不得复活连接", async () => {
    let capturedWs = null;
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          // 在同一数据包中同时推送握手成功与 Type 7 关闭帧
          setTimeout(() => {
            capturedWs.pushMessage(
              '{}\x1e{"type":7,"error":"Server shutting down immediately after handshake"}\x1e',
            );
          }, 10);
          return capturedWs;
        },
      },
    });

    // 建连应当捕获断线 transport 错误，而不是将已关闭的 socket 复活为 connected
    let caughtError = null;
    try {
      await source._ensureHubConnected(false);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "握手即断线必须向建连等待方抛出异常");
    assert.strictEqual(
      source._hubState === "reconnecting" || source._hubState === "disconnected",
      true,
      "状态机不得停留在 connected",
    );
    assert.notStrictEqual(
      source._hubSocket,
      capturedWs,
      "死连接绝不得保留在 _hubSocket 中",
    );
    assert.strictEqual(
      source._hubReconnectCount,
      1,
      "Type 7 必须只触发一次退避递增",
    );

    await source._disconnectHub("Test completed");
  });

  // 17. 线路切换发生于旧 connect 尚在途时，淘汰旧尝试并立即连接新线路
  await test("17. 线路切换发生于旧 connect 尚在途时，淘汰旧尝试并立即连接新线路", async () => {
    let line1ConnectResolve = null;
    const createdSockets = [];

    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          createdSockets.push(ws);
          if (url.includes("api.lightnovel.life") && !url.includes("cf-api")) {
            // 线路 A 建连挂起在途
            return new Promise((resolve) => {
              line1ConnectResolve = () => {
                setTimeout(() => ws.pushMessage("{}\x1e"), 5);
                resolve(ws);
              };
            });
          }
          // 线路 B 快速建连
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    // 线路 A 启动建连（在途挂起）
    const p1 = source._ensureHubConnected(false).catch((err) => err);
    await delay(10);
    assert.strictEqual(createdSockets.length, 1);
    assert.match(createdSockets[0].url, /^wss:\/\/api\.lightnovel\.life/);

    // 用户在设置中切换到 Cloudflare 线路
    source.saveSetting("apiServer", "https://cf-api.lightnovel.life");

    // 线路 B 发起请求，必须立即淘汰线路 A 的在途连接，而不得复用线路 A 的 _hubConnectPromise
    const p2 = source._ensureHubConnected(false);
    const socketB = await p2;

    assert.match(
      socketB.url,
      /^wss:\/\/cf-api\.lightnovel\.life/,
      "新连接必须直连 Cloudflare 线路",
    );
    assert.strictEqual(source._hubSocket, socketB);
    assert.strictEqual(source._hubState, "connected");

    // 此时线路 A 即使晚完成，也不得影响或篡改线路 B
    if (line1ConnectResolve) line1ConnectResolve();
    await p1;
    await delay(10);

    assert.strictEqual(source._hubSocket, socketB);
    assert.strictEqual(source._hubState, "connected");

    await source._disconnectHub("Test completed");
  });

  // 18. handshake early reject 时无 unhandledRejection 逃逸
  await test("18. 接收循环先于 send 完成前发生握手拒绝，零 unhandledRejection 逃逸", async () => {
    const preCount = unhandledRejections.length;
    let capturedWs = null;
    let releaseSend = null;
    const sendSuspended = new Promise((resolve) => {
      releaseSend = resolve;
    });

    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          capturedWs = new MockWebSocket(url, headers, options);
          const originalSend = capturedWs.send.bind(capturedWs);
          let sendCount = 0;
          capturedWs.send = async (data) => {
            sendCount += 1;
            if (sendCount === 1) {
              // 握手 send: 挂起直到错误帧已推送并跨越 unhandledRejection 检查时机
              await sendSuspended;
            }
            return await originalSend(data);
          };

          // 延迟 5ms 确保 socket.send 已被调用且进入挂起状态
          setTimeout(async () => {
            // 推送握手拒绝错误帧，促使 receiveLoop 触发 onHandshakeError -> handshakeReject
            capturedWs.pushMessage('{"error":"Handshake rejected: invalid protocol"}\x1e');
            // 跨过 microtask / tick 检查时机，确保如果未预装 catch 将触发 unhandledRejection
            await delay(15);
            // 释放挂起的 send，让 _openHubWebSocket 继续向下执行
            releaseSend();
          }, 5);

          return capturedWs;
        },
      },
    });

    let caughtError = null;
    try {
      await source._ensureHubConnected(false);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "早期握手错误必须向建连方抛出");
    await delay(25);
    assert.strictEqual(
      unhandledRejections.length,
      preCount,
      "握手早于 await 拒绝时不得产生全局 unhandledRejection",
    );

    await source._disconnectHub("Test completed");
  });

  // 19. 主动断开 (Logout / _disconnectHub) 重置退避计数为 0
  await test("19. 主动断开或登出重置重连退避计数为 0，新账号首次连接从 0ms 退避开始", async () => {
    const { source } = createSourceHarness({
      WebSocket: {
        connect: async (url, headers, options) => {
          throw new Error("Simulated network outage");
        },
      },
    });

    // 连续触发建连失败，使退避计数递增
    for (let i = 0; i < 3; i++) {
      try {
        await source._openHubWebSocket(false);
      } catch (_) {}
    }
    assert.strictEqual(
      source._hubReconnectCount >= 3,
      true,
      "连续失败后退避计数应递增至至少 3",
    );

    // 主动断开 / 登出
    source.account.logout();

    assert.strictEqual(
      source._hubReconnectCount,
      0,
      "主动登出必须将退避计数彻底重置为 0",
    );
    assert.strictEqual(
      source._getHubReconnectDelay(),
      0,
      "下一次连接的退避延迟必须从第 0 档 (0ms) 重新计算",
    );
  });

  // 20. Hub 信封以数值 Status 401 与 -100 表达认证失效时触发 SessionToken 刷新与重试
  await test("20. Hub 信封以数值 Status 401 与 -100 表达认证失效时触发 SessionToken 刷新与重试", async () => {
    for (const testStatus of [401, -100]) {
      let callCount = 0;
      let refreshCount = 0;
      const sockets = [];

      const { source } = createSourceHarness({
        post: async (url, headers, body) => {
          if (url.includes("/api/user/refresh_token")) {
            refreshCount += 1;
            return {
              status: 200,
              body: JSON.stringify({
                Success: true,
                Response: {
                  Token: `session-token-refresh-${testStatus}-${refreshCount}`,
                },
              }),
            };
          }
          throw new Error("Unexpected post: " + url);
        },
        WebSocket: {
          connect: async (url, headers, options) => {
            const ws = new MockWebSocket(url, headers, options);
            sockets.push(ws);
            setTimeout(() => ws.pushMessage("{}\x1e"), 5);
            return ws;
          },
        },
      });

      const res = await source._runHubSession("GetBookList", async (socket) => {
        callCount += 1;
        const promise = source._hubInvoke(
          socket,
          "GetBookList",
          {},
          { retryTransport: true },
        );
        await delay(10);
        const lastPayload = socket.sentData[socket.sentData.length - 1];
        const match = lastPayload.match(/"invocationId":"(\d+)"/);
        const id = match ? match[1] : "1";

        if (callCount === 1) {
          // 第 1 次返回空 Msg 或中文 Msg 的结构化 Status 401 / -100 错误
          socket.pushMessage(
            `{"type":3,"invocationId":"${id}","result":{"Success":false,"Status":${testStatus},"Msg":""}}\x1e`,
          );
        } else {
          // 第 2 次返回成功结果
          socket.pushMessage(
            `{"type":3,"invocationId":"${id}","result":{"Success":true,"Response":"recovered-${testStatus}"}}\x1e`,
          );
        }
        return await promise;
      });

      assert.strictEqual(res, `recovered-${testStatus}`);
      assert.strictEqual(callCount, 2, `Status ${testStatus} 必须触发 1 次重试`);
      assert.strictEqual(sockets.length, 2, `Status ${testStatus} 必须重建 WebSocket 连接`);
      assert.strictEqual(refreshCount, 2, `Status ${testStatus} 必须强制刷新 SessionToken`);

      await source._disconnectHub("Test completed");
    }
  });

  // 21. refresh HTTP 401/404 或 Status -100 终态失效原子清理凭据且绝不后台重试，网络错误仍退避
  await test("21. refresh 401/404/-100 终态失效原子清理凭据且绝无后续重连，网络 5xx 保持凭据并退避重试", async () => {
    // 21.1 终态失效测试：HTTP 404, HTTP 401, 信封 Status -100
    for (const terminalCase of [
      { type: "http-404", status: 404, body: "Not Found" },
      { type: "http-401", status: 401, body: "Unauthorized" },
      { type: "envelope-minus-100", status: 200, body: JSON.stringify({ Success: false, Status: -100, Msg: "Token expired" }) },
    ]) {
      let refreshCallCount = 0;
      const { source, dataStore } = createSourceHarness({
        post: async (url, headers, body) => {
          if (url.includes("/api/user/refresh_token")) {
            refreshCallCount += 1;
            return {
              status: terminalCase.status,
              body: terminalCase.body,
            };
          }
          throw new Error("Unexpected post: " + url);
        },
      });

      let caughtErr = null;
      try {
        await source._ensureHubConnected(false);
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr, `终态失效 [${terminalCase.type}] 必须抛出异常`);
      assert.strictEqual(
        dataStore.has("account"),
        false,
        `终态失效 [${terminalCase.type}] 必须原子清除持久化 account 凭据`,
      );
      assert.strictEqual(
        dataStore.has("refreshToken"),
        false,
        `终态失效 [${terminalCase.type}] 必须原子清除持久化 refreshToken 凭据`,
      );
      assert.strictEqual(
        source._hubDesiredConnected,
        false,
        `终态失效 [${terminalCase.type}] 必须将 desiredConnected 置为 false`,
      );
      assert.strictEqual(
        source._hubReconnectTimer,
        null,
        `终态失效 [${terminalCase.type}] 不得调度任何重连计时器`,
      );

      // 等待 60ms 验证绝无第二次 refresh 调用
      await delay(60);
      assert.strictEqual(
        refreshCallCount,
        1,
        `终态失效 [${terminalCase.type}] 绝不得在后台自动发起第二次重试`,
      );
    }

    // 21.2 瞬态网络/5xx 错误测试：凭据完整保留且按退避重连
    let transientRefreshCount = 0;
    const { source: transientSource, dataStore: transientStore } = createSourceHarness({
      post: async (url, headers, body) => {
        if (url.includes("/api/user/refresh_token")) {
          transientRefreshCount += 1;
          return {
            status: 503,
            body: "Service Unavailable",
          };
        }
        throw new Error("Unexpected post: " + url);
      },
    });

    try {
      await transientSource._ensureHubConnected(false);
    } catch (_) {}

    assert.strictEqual(
      transientStore.has("refreshToken"),
      true,
      "瞬态网络错误必须完整保留持久化凭据",
    );
    assert.strictEqual(
      transientSource._hubDesiredConnected,
      true,
      "瞬态网络错误必须维持 desiredConnected 为 true",
    );
    assert.strictEqual(
      transientSource._hubState,
      "reconnecting",
      "瞬态网络错误必须处于 reconnecting 状态",
    );

    await transientSource._disconnectHub("Test completed");
  });

  // 22. 切换线路时旧线路刷新独立隔离，新线路发起独立 refresh 且旧线路晚到失败不清凭据
  await test("22. 切换线路时旧线路刷新独立隔离，新线路发起独立 refresh 且旧线路晚到失败不清凭据", async () => {
    let lineARefreshResolve = null;
    const lineARefreshPromise = new Promise((resolve) => {
      lineARefreshResolve = resolve;
    });

    let refreshACount = 0;
    let refreshBCount = 0;
    const sockets = [];

    const { source, dataStore } = createSourceHarness({
      post: async (url, headers, body) => {
        if (url.includes("/api/user/refresh_token")) {
          if (url.startsWith("https://line-a.example.com")) {
            refreshACount += 1;
            // 挂起线路 A 的 refresh 请求
            await lineARefreshPromise;
            return {
              status: 401,
              body: "Unauthorized on line A",
            };
          }
          if (url.startsWith("https://line-b.example.com")) {
            refreshBCount += 1;
            return {
              status: 200,
              body: JSON.stringify({
                Success: true,
                Response: {
                  Token: "session-token-line-b",
                },
              }),
            };
          }
        }
        throw new Error("Unexpected post: " + url);
      },
      WebSocket: {
        connect: async (url, headers, options) => {
          const ws = new MockWebSocket(url, headers, options);
          sockets.push(ws);
          setTimeout(() => ws.pushMessage("{}\x1e"), 5);
          return ws;
        },
      },
    });

    // 初始状态：线路 A
    source.saveSetting("apiServer", "https://line-a.example.com");
    source._sessionToken = "";
    source._sessionTokenAt = 0;

    // 1. 线路 A 发起建连（此时处于 refresh 阶段，挂起在 lineARefreshPromise）
    const connectPromiseA = source._ensureHubConnected(false);
    await delay(10);
    assert.strictEqual(refreshACount, 1, "线路 A 应当已发起第 1 次 refresh 请求");

    // 2. 线路切换到线路 B
    source.saveSetting("apiServer", "https://line-b.example.com");

    // 3. 线路 B 发起建连，必须发起独立 refresh，不得复用线路 A 的 refreshPromise，且不被 A 阻塞
    const connectPromiseB = source._ensureHubConnected(false);
    const socketB = await connectPromiseB;

    assert.ok(socketB, "线路 B 应当成功建连");
    assert.strictEqual(refreshBCount, 1, "线路 B 必须发起独立的 refresh 请求");
    assert.strictEqual(source._sessionToken, "session-token-line-b", "当前 SessionToken 必须为线路 B 的结果");
    assert.strictEqual(source._hubState, "connected", "线路 B 应当处于 connected 状态");

    // 4. 释放线路 A 的挂起刷新，返回终态 401 失败
    lineARefreshResolve();

    let errA = null;
    try {
      await connectPromiseA;
    } catch (err) {
      errA = err;
    }

    assert.ok(errA, "线路 A 的建连应当失败");

    // 5. 关键断言：线路 A 的晚到终态失败绝不得清除持久化凭据，不得修改线路 B 的 sessionToken 与连接状态
    assert.strictEqual(
      dataStore.has("account"),
      true,
      "线路 A 晚到终态失败不得清除持久化 account 凭据",
    );
    assert.strictEqual(
      dataStore.has("refreshToken"),
      true,
      "线路 A 晚到终态失败不得清除持久化 refreshToken 凭据",
    );
    assert.strictEqual(
      source._sessionToken,
      "session-token-line-b",
      "线路 A 晚到失败不得清除或覆盖线路 B 的 SessionToken",
    );
    assert.strictEqual(
      source._hubState,
      "connected",
      "线路 A 晚到失败不得断开线路 B 的连接状态",
    );
    assert.strictEqual(socketB.closed, false, "线路 B 的 WebSocket 必须保持开启");

    await source._disconnectHub("Test completed");
  });

  assert.strictEqual(
    unhandledRejections.length,
    0,
    `全局未处理 Rejection 计数必须为 0，实际发现: ${JSON.stringify(unhandledRejections)}`,
  );

  console.log(`\n全部专项契约测试通过: ${passed}/${total}`);
}

runTests().catch((err) => {
  console.error("测试套件执行失败:", err);
  process.exit(1);
});
