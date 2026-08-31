# 轻书架 Token 登录弹窗设计

## 目标

调整 `lightnovelshelf.js` 的 Token 登录入口：删除持久化的 RefreshToken 与 x-id 设置输入，只保留紧邻邮箱密码登录上方的“Token 登录”按钮。点击按钮后弹出单行输入界面，用户粘贴 RefreshToken 和 x-id，并以支持的分隔符隔开，源完成验证并登录。

同时明确注销语义：无论当前通过 Token 还是邮箱密码登录，点击注销都清除账号认证状态；稳定设备标识 `visitorId` 继续保留。

## Venera 界面约束

Venera 漫画源 API 的 `UI.showInputDialog` 只提供一个单行文本输入值。Flutter 在 `maxLines == 1` 时自动应用 `FilteringTextInputFormatter.singleLineFormatter`，会过滤换行，因此不能可靠接收两行文本，也不能由源定义含两个独立字段的页面。

采用单输入弹窗，以一个分隔符连接两个值：

```text
<RefreshToken>|<x-id>
```

支持中文逗号 `，`、英文逗号 `,`、中文分号 `；`、英文分号 `;` 和竖线 `|`。不采用连续两个弹窗，因为用户已选择一次粘贴、一次确认。不修改 VeneraNext 本体，因此该源继续兼容 Venera / VeneraNext 的现有 ComicSource API。

VeneraNext 设置页按以下固定顺序渲染：

1. `settings` 中的所有设置项；
2. `account` 登录或注销入口。

JavaScript 对象属性保持声明顺序。因此把 `tokenLogin` 声明为最后一个设置项，即可使“Token 登录”按钮直接位于邮箱密码账号入口上方。

## 设置变更

从 `settings` 删除：

- `tokenRefreshToken`；
- `tokenVisitorId`。

保留 `tokenLogin`，并移动到设置对象末尾：

- 标题：`Token 登录`；
- 类型：`callback`；
- 按钮文字：`登录`；
- callback：打开 Token 输入弹窗。

删除 `_clearTokenLoginSettings`。输入只存在于弹窗返回值和当前调用栈中，不再写入 `data.settings`，因此登录成功或失败后都没有设置值需要清理。

## 弹窗与输入格式

点击“Token 登录”后调用一次 `UI.showInputDialog`。标题明确说明：

```text
Token 登录：输入 RefreshToken|x-id
```

解析规则：

1. 用户取消时，`UI.showInputDialog` 返回 `null`；立即结束，不显示失败消息，不发送网络请求，不改变认证状态。
2. 非空输入先去除整个文本首尾空白。
3. 使用正则 `/[，,；;|]/` 拆分中文逗号、英文逗号、中文分号、英文分号或竖线。
4. 拆分后必须恰好得到两项；出现零个或多个分隔符均拒绝。
5. 两项分别去除首尾空白，且都必须非空。
6. 第一项作为 RefreshToken；第二项作为 x-id。
7. x-id 继续由现有 `_normalizeVisitorId` 去除连字符并转小写，规范化结果必须是 32 位十六进制字符串。

弹窗 validator 使用同一解析方法检查格式。格式错误时弹窗内显示：

```text
请输入 RefreshToken 和 x-id，并用 ， , ； ; 或 | 分隔
```

validator 只做同步格式校验；服务端 Token 校验在弹窗确认并返回文本后执行。

## 登录数据流

新增 `_parseTokenLoginInput(value)`，只负责按上述规则返回：

```js
{
  refreshToken,
  visitorId,
}
```

格式错误时抛出固定错误，不包含原始输入。

将 `_loginWithTokenSettings` 替换为 `_loginWithTokenDialog`：

1. 调用 `UI.showInputDialog`，传入标题和格式 validator。
2. 用户取消时返回 `null`。
3. 解析单行中的两个值。
4. 调用现有 `_loginWithToken(refreshToken, visitorId)`。
5. 成功后显示“Token 登录成功”并返回 `"ok"`。
6. 格式校验以外的解析或服务端错误显示“Token 登录失败，请检查 RefreshToken 和 x-id”，返回 `null`。

`_loginWithToken`、`_requestSessionToken`、认证代际检查和原子提交逻辑保持不变。候选凭据验证失败不得覆盖当前账号。

## 注销语义

两种登录状态共用 Venera 的 `data.account`：

- 邮箱密码登录成功后，Venera 保存 `[邮箱, 密码]`；
- Token 登录成功后，源保存字符串 `"token"`；
- 任一新登录会替换当前 account 值，两种标记不会并存。

点击注销时：

1. Venera 账号页先把 `data.account` 设为 `null`；
2. `account.logout` 再执行 `deleteData("account")`；
3. 删除持久化 `refreshToken` 和 `lastSignInUtcDate`；
4. 重置自动签到尝试日期；
5. `_invalidateAuthState()` 清空短期 Token、刷新 Promise、共享 Hub 会话、阅读历史和发现页认证状态。

因此注销对 Token 登录和邮箱密码登录都完整生效。`visitorId` 是稳定设备标识，不是认证状态，继续保留以避免下次登录生成新设备 ID。

由于两个 Token 输入设置已删除，注销不再调用 `_clearTokenLoginSettings`。

## 安全与错误处理

- RefreshToken 和 x-id 不再保存在可见设置中。
- 错误消息不拼接弹窗原始输入、网络异常内容或服务端响应 body。
- 用户取消不会被视为失败。
- 格式错误在发送请求前拒绝。
- 服务端验证和原子提交继续沿用已测试的 Token 登录路径。
- 邮箱和密码仍由 Venera 原生账号机制管理，本次不改变其保存行为。

## 文件与版本

- `lightnovelshelf.js`：删除两个 Token 输入设置及设置清理方法，增加分隔符解析和弹窗登录，调整设置顺序，版本从 `0.2.14` 升至 `0.2.15`。
- `index.json`：同步版本到 `0.2.15`；登录能力描述保持邮箱密码与 Token 两种方式。
- `README.md`：把设置输入步骤改为点击按钮后在弹窗中粘贴 `RefreshToken|x-id`，并列出五种分隔符；设置表只保留 Token 登录按钮。
- 临时测试：更新为弹窗交互、取消、五种分隔符、格式校验、位置顺序和双模式注销测试，验证后删除。

## 验收

1. `settings` 不再包含 `tokenRefreshToken` 或 `tokenVisitorId`。
2. `tokenLogin` 是 `settings` 的最后一个属性，Venera 中显示在邮箱密码账号入口上方。
3. 点击 Token 登录只打开一次单行输入弹窗。
4. 中文逗号、英文逗号、中文分号、英文分号和竖线五种分隔符均能解析并调用现有 Token 登录。
5. 没有分隔符、多个分隔符或任一项为空时，弹窗 validator 返回固定格式提示，且不发送网络请求。
6. 取消弹窗不显示失败消息、不发送请求、不改变旧登录。
7. 有效 Token 登录仍保存规范化 x-id、RefreshToken、短期 Token 和 `account = "token"`。
8. 原始 RefreshToken 和 x-id 不写入设置数据。
9. 注销 Token 登录后清除 account、RefreshToken、短期 Token、Hub 和签到状态，保留 visitorId。
10. 注销邮箱密码登录后清除同一组认证状态，且删除 Venera 保存的邮箱密码 account 列表。
11. 邮箱密码登录和正常 RefreshToken 刷新回归继续通过。
12. `lightnovelshelf.js`、`index.json` 和 README 同步为 `0.2.15` 交互说明。
13. JavaScript 语法、专项行为测试、非过期 Hub 回归、版本校验和 Venera CLI 验证通过。
