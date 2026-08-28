# 轻书架多类型搜索设计

## 目标

为 `lightnovelshelf.js` 增加与轻书架网页端一致的漫画搜索类型，使用户可以在 Venera 中选择模糊搜索、精确搜索、书名、作者、系列名或标签，并让详情页作者与标签点击自动使用正确的搜索类型。

## 依据

轻书架前端 `cache/Web` 的漫画搜索统一调用 SignalR Hub Method `SearchComicSeries`，请求中的 `Mode` 支持以下值：

- `fuzzy`：模糊搜索
- `exact`：精确搜索
- `title`：按书名
- `author`：按作者
- `name`：按系列名
- `tags`：按标签；多个标签使用逗号分隔

Venera 的 JavaScript 漫画源接口通过 `search.optionList` 声明搜索选项，并将选中值按位置传给 `search.load(keyword, options, page)`。新版页面跳转对象可以通过 `attributes.options` 为搜索结果页指定选项。

## 方案选择

采用 Venera 原生搜索选项方案：

1. 在 `search.optionList` 中增加一个 `select` 类型的“搜索类型”选项组。
2. 将六种模式的 API 值直接作为选项值。
3. `search.load` 校验并读取 `options[0]`，再传入 `SearchComicSeries.Mode`。
4. 作者与标签点击使用新版搜索页面跳转参数携带对应模式，同时保留旧式跳转字段作为兼容回退。

不采用关键词前缀作为主方案，因为前缀会污染搜索框内容、增加解析逻辑，而且 Venera 已有原生选项传递能力。

## 搜索选项与默认值

选项顺序固定为：

1. `fuzzy-模糊搜索`
2. `exact-精确搜索`
3. `title-书名`
4. `author-作者`
5. `name-系列名`
6. `tags-标签`

不显式声明 `default`。Venera 会将首个选项作为默认值，因此普通搜索和不显示选项控件的聚合搜索均继续使用 `fuzzy`。这也避免显式字符串默认值在部分 Venera 版本中被再次 JSON 编码的问题。

## 数据流

1. 用户输入关键词并选择搜索类型。
2. Venera 调用 `search.load(keyword, options, page)`。
3. 源从 `options[0]` 读取模式；若参数缺失、类型错误或不在六种白名单中，则回退为 `fuzzy`。
4. 源调用：

   ```text
   SearchComicSeries({
     KeyWords,
     Mode,
     Page,
     Size,
     IgnoreJapanese,
     IgnoreAI
   })
   ```

5. 结果继续沿用现有漫画列表转换和 `TotalPages` 分页逻辑。

## 作者与标签跳转

- 点击“作者”标签时，跳转搜索页并传递当前文字及 `options: ["author"]`。
- 点击“标签”标签时，跳转搜索页并传递当前文字及 `options: ["tags"]`。
- 返回对象同时保留旧格式的 `action: "search"`、`keyword` 和 `param` 字段。新版 Venera 优先读取 `page/attributes` 并自动选择类型；不支持新版字段的旧版本仍可按原有方式打开搜索页。
- 其他命名空间保持现有“不支持此类 Tag 检索”的错误行为。

## 错误处理与兼容性

- 非数组、空数组、空值和未知模式全部回退到 `fuzzy`，避免向服务端发送非法 `Mode`。
- 不修改认证、SignalR、分页、日文过滤和 AI 内容过滤逻辑。
- 不启用 Venera 的全局标签建议，因为其语法与轻书架标签搜索并不等价。
- `cache/Web` 与 `cache/Venera-Next` 仅作为参考，不纳入变更。

## 版本与变更范围

- `lightnovelshelf.js`：版本从 `0.2.5` 升级到 `0.2.6`，实现多类型搜索与带类型的标签跳转。
- `index.json`：同步升级到 `0.2.6`。
- 不修改其他正式源文件。

## 验证

采用测试驱动方式验证：

1. 先证明当前实现即使传入 `author`、`tags` 等选项仍固定发送 `Mode: "fuzzy"`。
2. 验证六种合法模式逐一传入 `SearchComicSeries.Mode`。
3. 验证缺失或非法选项回退为 `fuzzy`。
4. 验证 `optionList` 的类型、顺序、显示文字和默认首项。
5. 验证作者、标签点击分别携带 `author`、`tags`，并保留兼容字段。
6. 验证原有列表映射、页码和过滤设置不变。
7. 执行 JavaScript 语法检查、版本一致性检查、仓库版本校验及 Venera CLI 源校验。
