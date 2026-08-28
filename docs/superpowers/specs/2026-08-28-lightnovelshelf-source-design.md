# 轻书架漫画源仓库接入设计

## 目标

将已有的“轻书架”漫画源接入 `miludeshiji/venera-configs`，使其可以通过仓库索引被发现，并从当前 fork 获取在线更新。此次接入不修改漫画源的业务逻辑。

## 变更范围

1. 将 `C:\Users\miludeshiji\Downloads\lightnovelshelf.js` 复制到仓库根目录，文件名保持为 `lightnovelshelf.js`。
2. 保持源名称 `轻书架`、唯一键 `LightNovelShelf` 和版本 `0.2.3` 不变。
3. 将源内 `url` 设置为：
   `https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js`
4. 在根目录 `index.json` 中新增对应条目：
   - `name`: `轻书架`
   - `fileName`: `lightnovelshelf.js`
   - `key`: `LightNovelShelf`
   - `version`: `0.2.3`
   - `description`: 说明使用前需要配置 `RefreshToken` 和 `x-id / Visitor ID`

不进行代码风格整理、重构或功能调整，也不修改其他漫画源。

## 组件与数据流

- `lightnovelshelf.js` 提供漫画源实现及在线更新地址。
- `index.json` 向 Venera 发布源名称、文件名、唯一键和版本。
- Venera 从当前 fork 的索引发现该源，并通过 jsDelivr 对应的 fork 地址下载或更新源文件。

## 错误处理

保留源文件现有的认证、网络和 SignalR 错误处理。仓库接入层不新增运行时逻辑；索引中的描述会提示用户预先配置登录所需凭据。

## 验证

1. 检查 `lightnovelshelf.js` JavaScript 语法。
2. 检查 `index.json` 可被正确解析。
3. 确认源文件与索引中的名称、键和版本一致。
4. 确认在线更新地址指向 `miludeshiji/venera-configs@main`。
5. 运行仓库可用的源校验或等价静态检查。
6. 确认最终差异仅包含设计文档、`lightnovelshelf.js` 和 `index.json` 的预期内容，不纳入工作区原有的换行符差异。
