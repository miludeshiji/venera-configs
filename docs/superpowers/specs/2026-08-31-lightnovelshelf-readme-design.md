# 轻书架 README 设计

## 目标

将根目录 `README.md` 从通用的 Venera 配置仓库说明改为中文的轻书架专用说明，使首次访问仓库的用户能够了解 `lightnovelshelf.js` 的用途、主要功能、使用前提、登录方式和可配置项。

## 受众与定位

- 主要受众：希望在 Venera 或 VeneraNext 中使用轻书架漫画源的用户。
- 次要受众：需要快速了解该源通信方式和仓库文件职责的维护者。
- README 以用户指南为主，仅保留帮助理解兼容性和性能行为的简短技术说明。

## README 结构

### 1. 标题与仓库定位

标题使用“轻书架 Venera 漫画源”。开头说明：

- `lightnovelshelf.js` 是面向 Venera / VeneraNext 的轻书架漫画源配置。
- 本仓库通过 `index.json` 发布该源，并通过仓库中的源文件提供在线安装或更新内容。

不在 README 中写死当前版本号，避免版本升级后产生重复维护点；版本以 `lightnovelshelf.js` 和 `index.json` 为准。

### 2. 功能

用分组列表概括已经由源码实现的用户可见能力：

- 浏览：最近更新、热门漫画、阅读历史和分类分页。
- 检索：模糊、精确、书名、作者、系列名、标签六种模式，并可忽略日文原文或 AI 内容。
- 阅读：系列详情、作者与标签、按上传源划分的章节分组、完整正文图片。
- 互动：系列评论、回复浏览、发表评论和回复。
- 账号：邮箱密码登录、自动管理设备标识与认证令牌、每日自动或手动签到。

### 3. 安装与首次使用

提供短步骤，不猜测不同 Venera 版本中的具体菜单名称：

1. 在 Venera / VeneraNext 中安装本仓库发布的 `lightnovelshelf.js` 漫画源。
2. 打开轻书架漫画源设置中的账号登录。
3. 输入已注册的轻书架邮箱和密码。
4. 说明 `x-id`、RefreshToken 和短期会话 Token 均由漫画源自动生成或管理，无需用户手动填写。

给出 `lightnovelshelf.js` 的仓库文件链接，方便用户查看或手动导入；不声称未经验证的应用菜单路径。

### 4. 设置

按源码中的 `settings` 列出：

- API 线路：HK / 默认、Cloudflare。
- 搜索时忽略日文原文。
- 搜索时忽略 AI 内容。
- 每日自动签到。
- 手动签到按钮。

说明自动签到默认关闭，其他默认值不作额外扩展。

### 5. 技术说明

保持简短，只描述实现中可验证的事实：

- ASP.NET Core SignalR JSON Hub Protocol。
- HTTP Long Polling transport 与 Bearer Token 认证。
- RefreshToken 自动换取短期会话 Token。
- 后台预连接及 15 秒共享 Hub 会话。
- 发现页和长章节使用批量 Hub 调用。
- Long Polling URL 使用唯一防缓存参数。
- 对结果不确定的非幂等请求不自动重放，避免重复操作。

### 6. 仓库文件

只列与轻书架发布直接相关的文件：

- `lightnovelshelf.js`：漫画源实现。
- `index.json`：Venera 漫画源索引元数据。

不继续保留旧 README 中创建通用配置文件的教程，因为用户已选择将 README 定位为轻书架专用说明。

## 内容约束

- 所有功能描述必须能在当前 `lightnovelshelf.js` 中找到对应实现。
- 不记录账号、密码、Token、设备标识等用户数据示例。
- 不承诺服务端可用性、网络区域可达性或未由源码保证的兼容版本。
- 不修改 `lightnovelshelf.js`、`index.json` 或其他漫画源。
- 不增加徽章、截图、FAQ、贡献指南或发布流程等未请求内容。

## 验证

1. 对照 `lightnovelshelf.js` 的公开配置与用户可见接口检查每项功能、设置及登录说明。
2. 检查 README 中的仓库内文件链接能够解析到 `lightnovelshelf.js` 和 `index.json`。
3. 检查 README 不包含旧的通用模板创建教程，也不包含易过期的硬编码版本号。
4. 检查最终变更范围仅包括设计文档、实施计划和 `README.md`。
