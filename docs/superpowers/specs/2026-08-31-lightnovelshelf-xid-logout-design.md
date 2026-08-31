# 轻书架注销清理 x-id 设计

## 目标

`visitorId` 是轻书架请求头使用的持久化 `x-id`。调整注销行为：无论当前通过 Token 还是邮箱密码登录，注销时除账号和令牌外，也删除持久化的 `visitorId`。

## 当前行为

- 邮箱密码登录通过 `_getVisitorId()` 读取已有 `visitorId`；不存在时使用 `createUuid()` 生成并保存。
- Token 登录从弹窗取得 x-id，验证成功后保存为 `visitorId`。
- RefreshToken 刷新读取 `visitorId` 并作为 `x-id` 请求头。
- 当前 `account.logout` 删除 `account`、`refreshToken` 和签到状态，但保留 `visitorId`。

因此 `visitorId` 与 x-id 是同一数据，只是源内部使用了描述设备标识的键名。

## 方案

只在 `account.logout` 中显式增加：

```js
this.deleteData("visitorId");
```

不把删除逻辑放入 `_invalidateAuthState()`。该方法还用于登录提交、账号切换和会话失效；如果统一删除，会在仍需 x-id 的非注销流程中误删认证数据。

## 注销结果

Token 登录和邮箱密码登录共用同一个 `account.logout`：

1. 删除 `account`；
2. 删除 `refreshToken`；
3. 删除 `visitorId`，即 x-id；
4. 删除 `lastSignInUtcDate`；
5. 重置自动签到尝试日期；
6. 调用 `_invalidateAuthState()` 清空短期 Token、刷新 Promise、共享 Hub 会话以及认证相关缓存。

注销完成后，两种登录方式都不保留账号、RefreshToken、短期 Token 或 x-id。

## 下次登录

- 下次邮箱密码登录：`_getVisitorId()` 发现数据不存在，生成并保存新的 x-id。
- 下次 Token 登录：使用用户在弹窗中提供的 x-id；验证成功后重新保存。
- 未注销期间：`visitorId` 继续持久化，RefreshToken 刷新流程不变。

## 安全与错误处理

- 删除 `visitorId` 是本地幂等操作；键不存在时同样安全。
- 注销不发起网络请求，不依赖当前登录方式。
- 不输出已删除的 x-id。
- 只改变显式注销行为；登录失败、会话重试和普通认证失效不会删除 x-id。

## 文件与版本

- `lightnovelshelf.js`：注销增加 `visitorId` 删除；版本从 `0.2.15` 升至 `0.2.16`。
- `index.json`：同步版本到 `0.2.16`。
- `README.md`：无需新增用户操作；现有登录说明不声称保留 x-id，因此内容保持不变。
- 临时测试：覆盖两种登录注销删除 x-id，以及邮箱注销后下次登录生成新 x-id。

## 验收

1. Token 登录注销后 `account`、`refreshToken`、`visitorId`、短期 Token 和共享 Hub 会话均被清除。
2. 邮箱密码登录注销后清除同一组状态。
3. 两种注销都继续清除签到状态和认证缓存。
4. 注销后再次邮箱登录会调用 `createUuid()` 并保存新的 32 位 x-id。
5. 未注销的普通 RefreshToken 刷新继续复用当前 `visitorId`。
6. `_invalidateAuthState()` 本身不删除 `visitorId`。
7. `lightnovelshelf.js` 与 `index.json` 同步为 `0.2.16`。
8. 专项行为测试、JavaScript 语法、非过期 Hub 回归、版本校验和 Venera CLI 验证通过。
