# 轻书架 Token 登录设计

## 目标

在保留现有邮箱密码登录的同时，为 `lightnovelshelf.js` 增加手动 Token 登录。用户在源设置中填入 `RefreshToken` 和 `x-id`，点击“Token 登录”后即可建立 Venera 登录状态，不需要轻书架邮箱或密码。

Token 登录必须先由轻书架服务端校验，失败时不得破坏当前有效登录。登录成功后清空设置中的敏感输入；长期认证数据继续使用源现有的持久化键和刷新流程。

## 现状与约束

当前源通过 Venera 的 `account.login(account, pwd)` 提供邮箱密码登录。成功后持久化 `refreshToken` 和自动生成的 `visitorId`，并在内存中缓存短期会话 Token。

Venera 只支持一套原生账号输入表单：

- `account.login` 使用固定的 Username/Password 字段；
- `account.loginWithCookies` 可以自定义字段名，但与 `account.login` 不能同时作为两套可见登录入口；
- 普通源设置支持 `input` 和 `callback`，可作为第二套登录入口；
- `saveData("account", value)` 会使 Venera 将源判定为已登录，非列表值不会触发邮箱密码“重新登录”。

因此 Token 登录使用源设置，不替换或复用现有原生邮箱密码表单。

## 方案选择

采用“设置项 + Token 登录按钮”：

- 保留 `account.login` 的邮箱密码行为；
- 新增标题为 `RefreshToken` 和 `x-id` 的两个输入设置；
- 新增“Token 登录”回调按钮；
- 登录成功后保存非列表型账号标记。

未采用以下方案：

1. 改用 `account.loginWithCookies`：字段名和遮挡效果更合适，但会移除邮箱密码登录入口。
2. 复用 Username/Password：字段标签与 Token 含义不符，自动识别脆弱，并会把 Token 保存为可“重新登录”的账号列表。

## 设置与数据

新增设置键：

- `tokenRefreshToken`：标题 `RefreshToken`，类型 `input`；
- `tokenVisitorId`：标题 `x-id`，类型 `input`；
- `tokenLogin`：标题 `Token 登录`，类型 `callback`，按钮文字 `登录`。

认证数据继续使用现有键：

- `refreshToken`：通过 `saveData` 持久化的长期令牌；
- `visitorId`：通过 `saveData` 持久化的规范化 `x-id`；
- `_sessionToken`：当前 JavaScript 实例中的短期会话令牌；
- `_sessionTokenAt`：短期令牌取得时间；
- `_sessionTokenGeneration`：短期令牌所属认证代际；
- `account`：Token 登录成功后写入字符串标记，使 `isLogged` 为真。

Venera 的普通输入设置会在设置页显示当前值。为缩短敏感值暴露时间，Token 登录成功后把 `tokenRefreshToken` 和 `tokenVisitorId` 的已保存设置值清空；失败时保留输入，便于用户修正。

## 输入规范化

点击 Token 登录后，在发送请求前执行：

1. `RefreshToken` 转为字符串并去除首尾空白；空值拒绝登录。
2. `x-id` 转为字符串、去除首尾空白和连字符并转为小写。
3. 规范化后的 `x-id` 必须是 32 位十六进制字符串；否则拒绝登录。

自动生成设备标识与手动输入共用同一套 `x-id` 规范化和校验规则，避免出现第二套格式约定。

## 服务端校验

候选凭据通过现有 API 线路发送：

```http
POST ${apiBase}/api/user/refresh_token
Content-Type: application/json
Accept: application/json
x-id: <规范化 x-id>

{"token":"<RefreshToken>"}
```

请求必须满足：

- HTTP 状态为 200；
- JSON 可解析；
- 若响应包含统一 envelope，则 `Success` 为真；
- 解包后的结果是非空字符串，或对象中的 `Token`、`token`、`AccessToken`、`accessToken` 是非空字符串。

Token 登录和正常会话刷新共用一个“使用明确 RefreshToken/x-id 换取短期 Token”的内部请求与响应解析方法。正常刷新仍负责认证代际、共享 Promise 和旧响应保护；候选 Token 校验只返回短期 Token，不提前修改认证状态。

## 原子提交

只有候选凭据校验成功后才提交新登录：

1. 调用现有认证失效逻辑，推进 `_authGeneration`、关闭旧共享 Hub 会话并清空旧短期状态。
2. 保存规范化后的 `visitorId`。
3. 保存候选 `refreshToken`。
4. 把校验得到的短期 Token 写入 `_sessionToken`，记录当前时间和新的认证代际。
5. 清除 `lastSignInUtcDate` 并重置当前实例的自动签到尝试日期，避免新账号继承旧账号的签到状态。
6. `saveData("account", "token")`，使 Venera 立即把源判定为已登录，同时用 Token 登录标记替换可能存在的邮箱密码账号列表。
7. 清空两个 Token 登录设置值。
8. 显示“Token 登录成功”。

如果校验或解析失败，上述提交步骤一个也不执行。已有 `refreshToken`、`visitorId`、短期 Token、认证代际、共享 Hub 会话和账号标记保持不变。
认证提交中的签到状态重置只发生在 Token 已经验证成功之后；失败的候选凭据不会改变当前账号的签到记录。

## 并发与账号切换

候选 Token 校验不租用或修改当前 Hub 会话，因此进行中的旧账号请求不会被未验证输入打断。

校验成功后的认证提交使用现有 `_invalidateAuthState()` 完成干净切换。提交后，旧账号请求会因认证代际变化失效，不能把旧响应写回新账号状态。

Token 登录按钮在请求进行期间由 Venera 的 callback 设置显示加载状态。重复点击产生的请求各自验证；只有仍属于当前认证代际的成功请求可以提交，避免较早的慢响应覆盖较新的登录。实现将为 Token 登录请求记录起始认证代际，并在提交前确认代际未变化。

## 退出登录

退出登录继续清理：

- `refreshToken`；
- `lastSignInUtcDate`；
- 当前短期会话 Token 和共享 Hub 状态；
- Token 登录写入的 `account` 标记。

保留 `visitorId`，与现有邮箱密码登录的稳定设备标识行为一致。两个 Token 输入设置在成功登录时已经清空；退出时再次清空，防止旧版本或中断流程遗留敏感值。

## 错误与反馈

以下情况显示 Token 登录失败且不提交状态：

- 任一输入为空；
- `x-id` 格式错误；
- 网络请求失败；
- HTTP 非 200；
- 响应不是有效 JSON；
- API envelope 表示失败；
- 响应缺少可用短期 Token；
- 校验期间认证状态已经被其他登录或退出操作改变。

错误消息可以包含 HTTP 状态、API 状态和服务端消息，但不得包含 RefreshToken、会话 Token、`x-id` 或完整请求体。设置 callback 自行捕获错误并通过 `UI.showMessage` 反馈，避免未处理 Promise 拒绝。

## 文件范围与版本

- `lightnovelshelf.js`：新增 Token 登录流程、设置和说明；版本从 `0.2.13` 升至 `0.2.14`。
- `index.json`：同步 `0.2.14` 与登录能力描述。
- `README.md`：补充邮箱密码与 Token 两种登录方式、Token 登录步骤和敏感输入清空行为。
- 临时测试文件：按仓库既有方式放在被忽略的 `test/` 目录，验证完成后删除。

不修改其他漫画源、Venera 缓存源码或轻书架服务端缓存源码。

## 验收

1. 现有邮箱密码登录请求、令牌保存和退出行为继续通过回归测试。
2. 设置中存在 `RefreshToken`、`x-id` 和 Token 登录按钮，邮箱密码账号配置仍存在。
3. 有效 RefreshToken/x-id 发送到正确线路和接口，使用正确请求头及 JSON body。
4. 有效响应保存长期令牌、规范化 x-id、短期令牌及账号标记，重置旧账号签到状态，并清空敏感设置值。
5. Token 登录后 `isLogged` 为真，首次内容请求可直接复用刚取得的短期 Token。
6. 空输入、无效 x-id、HTTP 错误、无效 JSON、API 拒绝和缺失 Token 均不改变已有认证状态。
7. Token 校验期间发生登录或退出时，过期响应不得提交。
8. Token 登录成功会使旧共享 Hub 会话和旧账号请求失效。
9. 退出登录清除 Token 登录状态与敏感设置残留，但保留规范化 `visitorId`。
10. `lightnovelshelf.js` 与 `index.json` 版本一致，README 和索引描述同时列出两种登录方式。
11. JavaScript 语法检查、Token 登录专项测试、现有认证与 Hub 回归、版本校验脚本和源配置校验通过。
