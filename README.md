# 轻书架 Venera 漫画源

本仓库维护适用于 Venera / VeneraNext 的轻书架漫画源配置。漫画源实现位于 [`lightnovelshelf.js`](./lightnovelshelf.js)，并通过 [`index.json`](./index.json) 发布；当前版本以这两个文件中的元数据为准。

> 使用前需要轻书架账号，并在漫画源设置中完成登录。

## 功能

### 浏览与搜索

- 发现页包含最近更新、热门漫画和阅读历史。
- 最近更新、热门漫画和阅读历史支持分类分页，每页 24 项。
- 支持模糊、精确、书名、作者、系列名和标签六种搜索模式。
- 搜索时可选择忽略日文原文或 AI 内容。

### 阅读与互动

- 展示系列简介、封面、原名、作者、标签及更新时间。
- 按轻书架上传源组织章节分组，并加载完整章节图片。
- 支持查看系列评论与回复，以及发表评论和回复。

### 账号

- 使用轻书架注册邮箱和密码登录。
- 自动生成并管理 `x-id`，自动刷新 RefreshToken 对应的短期会话 Token。
- 支持每日自动签到和手动签到。

## 安装与首次使用

1. 在 Venera / VeneraNext 中添加本仓库索引，或导入 [`lightnovelshelf.js`](./lightnovelshelf.js)。
   - 索引地址：`https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/index.json`
   - 源文件地址：`https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js`
2. 打开轻书架漫画源设置中的账号登录。
3. 输入已注册的轻书架邮箱和密码。
4. `x-id`、RefreshToken 和短期会话 Token 由漫画源自动生成或管理，无需手动填写。

## 设置

| 设置 | 作用 | 默认值 |
| --- | --- | --- |
| API 线路 | 在 `HK / 默认` 与 `Cloudflare` 线路之间切换 | `HK / 默认` |
| 搜索时忽略日文原文 | 从搜索结果中过滤日文原文 | 关闭 |
| 搜索时忽略 AI 内容 | 从搜索结果中过滤 AI 内容 | 关闭 |
| 每日自动签到 | 登录后每天自动尝试签到 | 关闭 |
| 手动签到 | 立即发起一次签到 | 按需使用 |

## 技术实现

- 使用 ASP.NET Core SignalR JSON Hub Protocol 和 HTTP Long Polling transport。
- 使用 Bearer Token 认证，并通过 RefreshToken 自动取得短期会话 Token。
- 登录后后台预连接，Hub 操作串行复用 15 秒共享会话。
- 发现页与长章节通过单连接批量 Hub 调用减少往返请求。
- Long Polling 请求附加唯一防缓存参数，避免复用旧响应。
- 对结果不确定的非幂等请求不自动重放，避免重复签到、评论或回复。

## 仓库文件

| 文件 | 说明 |
| --- | --- |
| [`lightnovelshelf.js`](./lightnovelshelf.js) | 轻书架漫画源实现及在线更新地址 |
| [`index.json`](./index.json) | Venera 漫画源索引元数据 |