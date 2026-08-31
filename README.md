# 轻书架 Venera 漫画源

本仓库维护适用于 Venera / VeneraNext 的轻书架漫画源配置。当前版本以这文件中的元数据为准。

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

- 支持使用轻书架注册邮箱和密码登录。
- 支持填写 RefreshToken 和 x-id 直接进行 Token 登录。
- 支持每日自动签到和手动签到。

## 安装与首次使用

1. 在 Venera / VeneraNext 中添加本仓库索引，或导入 [`lightnovelshelf.js`](./lightnovelshelf.js)。
   - 索引地址：`https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/index.json`
   - 源文件地址：`https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js`
2. 选择一种登录方式：
   - 邮箱登录：打开账号登录，输入轻书架注册邮箱和密码。
   - Token 登录：点击源设置底部、邮箱登录上方的“Token 登录”，在弹窗中输入 `RefreshToken|x-id`。也可使用 `，`、`,`、`；` 或 `;` 分隔。

## 设置

| 设置 | 作用 | 默认值 |
| --- | --- | --- |
| Token 登录 | 弹窗输入 RefreshToken 和 x-id，支持 `，`、`,`、`；`、`;`、`|` 分隔 | 按需使用 |
| API 线路 | 在 `HK / 默认` 与 `Cloudflare` 线路之间切换 | `HK / 默认` |
| 搜索时忽略日文原文 | 从搜索结果中过滤日文原文 | 关闭 |
| 搜索时忽略 AI 内容 | 从搜索结果中过滤 AI 内容 | 关闭 |
| 每日自动签到 | 登录后每天自动尝试签到 | 关闭 |
| 手动签到 | 立即发起一次签到 | 按需使用 |



## 仓库文件

| 文件 | 说明 |
| --- | --- |
| [`lightnovelshelf.js`](./lightnovelshelf.js) | 轻书架漫画源实现及在线更新地址 |
| [`index.json`](./index.json) | Venera 漫画源索引元数据 |