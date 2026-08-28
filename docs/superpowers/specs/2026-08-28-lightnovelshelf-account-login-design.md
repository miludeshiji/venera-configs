# 轻书架账号密码登录设计

## 目标

将 `lightnovelshelf.js` 从手动填写 RefreshToken 和 `x-id / Visitor ID` 改为 Venera 原生账号登录。用户只需在 Venera 中输入轻书架邮箱和密码，源自动完成官网同等的密码摘要、设备标识生成、登录请求和令牌保存。

本次不迁移或读取旧的 RefreshToken、Visitor ID 设置；升级后用户需要重新登录。

## 依据

轻书架网页端的登录流程为：

1. 对用户输入的密码计算 SHA-256，并编码为小写十六进制字符串。
2. 向 `POST /api/user/login` 发送 JSON：

   ```json
   {
     "email": "用户邮箱",
     "password": "SHA-256 十六进制字符串"
   }
   ```

3. 请求头携带稳定的 `x-id`。
4. 从成功响应的 `Response` 中取得 `RefreshToken` 和 `Token`。

Venera JavaScript 漫画源可通过 `account.login(account, pwd)` 和 `account.logout()` 接入原生账号页面。登录成功后，Venera 会将账号和密码保存在本地源数据中，以支持“重新登录”。

## 方案选择

采用 Venera 原生账号系统：

- `account.login` 接收邮箱和密码，调用轻书架登录接口并保存令牌。
- `account.logout` 清理认证令牌。
- `x-id` 由源自动生成并持久化。
- 删除手动认证设置。

不采用设置项填写邮箱密码，因为它不能提供统一的登录、重新登录和退出登录状态。不采用 WebView 登录，因为其流程更重、平台兼容性更复杂，也不符合直接输入账号密码的目标。

## 持久化数据与内存状态

源使用以下数据：

- `visitorId`：通过 `createUuid()` 首次生成，移除 UUID 中的连字符后得到 32 位十六进制字符串；使用 `saveData` 持久化并在后续登录和刷新中复用。
- `refreshToken`：登录成功后使用 `saveData` 持久化，用于现有 `/api/user/refresh_token` 流程。
- `_sessionToken`：登录响应中的短期 Token，仅保存在当前 JavaScript 实例中。
- `_sessionTokenAt`：设置为登录成功时间，使现有短期令牌缓存逻辑可以立即复用登录响应中的 Token。

旧设置中的 `refreshToken` 和 `visitorId` 不作为回退来源。持久化数据不存在时，源不会尝试迁移旧值。

退出登录时删除 `refreshToken`，并清空 `_sessionToken` 和 `_sessionTokenAt`。`visitorId` 保留为稳定设备标识。Venera 负责同时删除其保存的账号状态。

## 登录数据流

1. 用户在 Venera 轻书架账号页面输入邮箱和密码。
2. `account.login` 验证邮箱去除首尾空白后非空，且密码非空。
3. `_getVisitorId` 读取已保存的 `visitorId`；若不存在，则生成、规范化、校验并保存新的 32 位标识。
4. 使用以下 Venera API 计算官网要求的密码摘要：

   ```js
   Convert.hexEncode(Convert.sha256(Convert.encodeUtf8(password)))
   ```

5. 请求 `POST ${apiBase}/api/user/login`，使用 JSON Content-Type、`Accept: application/json` 和 `x-id` 请求头。
6. 解析统一 API envelope。仅当 HTTP 状态为 200、`Success` 为真，且 `Response.RefreshToken` 与 `Response.Token` 均为非空字符串时判定登录成功。
7. 成功后保存 RefreshToken，更新内存中的短期 Token 及其时间戳，并返回任意成功值供 Venera 确认登录。
8. Venera 随后将邮箱和密码保存在本地账号数据中；用户可通过原生“重新登录”入口再次调用同一流程。

后续 SignalR 请求继续沿用现有认证流程：短期 Token 在缓存有效期内直接复用，过期后使用持久化的 RefreshToken 换取新 Token。

## 组件边界

为保持职责清晰，在现有类中划分以下内部职责：

- 设备标识方法：只负责读取、生成、校验和保存 `visitorId`。
- 密码摘要方法：只负责将明文密码转换为官网要求的 SHA-256 十六进制值。
- 登录方法：只负责参数校验、HTTP 请求、登录响应校验和令牌落盘。
- RefreshToken 读取方法：只从 `loadData("refreshToken")` 读取新登录数据。
- `account` 配置：只将 Venera 的登录和退出回调连接到上述方法。

现有 SignalR 建连、Hub 调用、章节批量分页、搜索和内容映射逻辑不改变。

## 设置与用户界面

从 `settings` 删除：

- `refreshToken`
- `visitorId`

保留 API 线路、每页数量、日文过滤和 AI 内容过滤设置。Venera 的源设置页将显示原生“登录”“重新登录”“退出登录”入口。Venera 的通用账号字段可能显示为“用户名”，但轻书架用户应在该字段输入注册邮箱。

文件顶部使用说明和 `index.json` 描述改为说明邮箱密码登录，不再指导用户从浏览器提取令牌。

## 错误处理与安全

- 邮箱或密码为空时，在发送网络请求前拒绝登录。
- HTTP 非 200、无效 JSON、API `Success: false`、缺少 `Response` 或缺少任一令牌时均判定失败。
- 登录失败不得保存空值，也不得覆盖已有的有效 RefreshToken 或短期 Token。
- 面向用户的错误只包含 HTTP 状态、API 状态和服务端消息，不包含邮箱、密码、密码摘要、RefreshToken、Token、`x-id` 或完整请求体。
- RefreshToken 不存在或失效时，提示用户在 Venera 中登录或使用“重新登录”；不在普通内容请求中静默使用本地密码自动登录。
- 密码明文不发送给轻书架服务器；仅通过 HTTPS 发送 SHA-256 值。Venera 原生账号系统仍会在本地保存邮箱和密码，这是重新登录功能的既有行为。

## 兼容性与变更范围

- `lightnovelshelf.js`：版本从 `0.2.6` 升级到 `0.2.7`，增加账号登录并删除手动认证设置。
- `index.json`：同步升级版本和认证说明。
- 不读取旧手动认证设置，也不提供迁移按钮。
- `cache/Web` 与 `cache/Venera-Next` 只作为接口依据，不修改。
- 不修改其他漫画源或工作区中已有的无关文件。

## 测试与验收

采用测试驱动方式：先编写会在旧实现上失败的测试，再实现登录功能。测试覆盖：

1. `account.login` 和 `account.logout` 已声明。
2. 首次登录生成、规范化并保存 32 位 `visitorId`。
3. 后续登录复用同一个 `visitorId`。
4. 密码按官网规则计算 SHA-256 小写十六进制字符串。
5. 登录请求地址、请求头和 JSON 字段正确，且不发送明文密码。
6. 成功响应保存 RefreshToken，并立即设置短期 Token 和时间戳。
7. HTTP、JSON、API envelope 或令牌字段异常时拒绝登录且不写入无效状态。
8. 退出登录删除 RefreshToken 和内存短期 Token，但保留 `visitorId`。
9. 刷新流程只读取新持久化数据，不调用 `loadSetting("refreshToken")` 或 `loadSetting("visitorId")`。
10. `settings` 不再声明手动认证字段。
11. `lightnovelshelf.js` 与 `index.json` 同步为 `0.2.7`，认证说明同步更新。
12. 现有 SignalR 批量分页和多类型搜索回归测试继续通过。

最终执行 JavaScript 语法检查、专项登录测试、现有轻书架回归测试、版本校验脚本、whitespace 检查和 Venera CLI 源校验。验证及提交时仅处理本次相关正式文件与设计文档。
