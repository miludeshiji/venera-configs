# 轻书架漫画源接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有轻书架漫画源加入 `miludeshiji/venera-configs`，登记仓库索引并启用从该 fork 在线更新。

**Architecture:** 保持漫画源业务逻辑原样，仅复制源文件并修改其顶层更新地址；在 `index.json` 追加与源元数据一致的发布条目。使用独立断言和 Venera CLI 验证语法、元数据、索引及源格式。

**Tech Stack:** Venera JavaScript 漫画源、JSON、Node.js、Venera CLI、Git

---

## 文件结构

- Create: `lightnovelshelf.js` — 轻书架漫画源实现及 fork 在线更新地址。
- Modify: `index.json:205` — 轻书架源发布条目。
- Reference: `C:\Users\miludeshiji\Downloads\lightnovelshelf.js` — 用户提供的原始源文件，只读。
- Reference: `docs/superpowers/specs/2026-08-28-lightnovelshelf-source-design.md` — 已批准设计。

### Task 1: 添加源文件并配置 fork 更新地址

**Files:**
- Create: `lightnovelshelf.js`
- Reference: `C:\Users\miludeshiji\Downloads\lightnovelshelf.js`

- [ ] **Step 1: 运行文件存在性断言，确认接入前失败**

Run:

```bash
node.exe -e "const fs=require('fs'); if(!fs.existsSync('lightnovelshelf.js')) throw new Error('lightnovelshelf.js is missing')"
```

Expected: FAIL，错误包含 `lightnovelshelf.js is missing`。

- [ ] **Step 2: 复制用户提供的文件并只替换在线更新地址**

Run:

```bash
node.exe <<'NODE'
const fs = require("fs");
const sourcePath = "C:/Users/miludeshiji/Downloads/lightnovelshelf.js";
const targetPath = "lightnovelshelf.js";
const oldUrl = '  url = "";';
const newUrl = '  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";';
const source = fs.readFileSync(sourcePath, "utf8");
if (!source.includes(oldUrl)) {
  throw new Error("Expected empty top-level update URL was not found");
}
if (source.indexOf(oldUrl) !== source.lastIndexOf(oldUrl)) {
  throw new Error("Top-level update URL match is not unique");
}
fs.writeFileSync(targetPath, source.replace(oldUrl, newUrl), "utf8");
NODE
```

- [ ] **Step 3: 验证除更新地址外，仓库文件与原文件内容一致**

Run:

```bash
node.exe <<'NODE'
const fs = require("fs");
const original = fs.readFileSync("C:/Users/miludeshiji/Downloads/lightnovelshelf.js", "utf8");
const actual = fs.readFileSync("lightnovelshelf.js", "utf8");
const expected = original.replace(
  '  url = "";',
  '  url = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";'
);
if (actual !== expected) throw new Error("Unexpected source logic changes detected");
console.log("Source copy matches; only update URL changed.");
NODE
```

Expected: PASS，输出 `Source copy matches; only update URL changed.`。

- [ ] **Step 4: 检查 JavaScript 语法**

Run:

```bash
node.exe --check lightnovelshelf.js
```

Expected: PASS，退出码为 0 且无语法错误。

### Task 2: 在仓库索引中登记轻书架

**Files:**
- Modify: `index.json:205`
- Test: inline Node.js assertions

- [ ] **Step 1: 运行索引断言，确认新增条目之前失败**

Run:

```bash
node.exe <<'NODE'
const index = require("./index.json");
const entry = index.find((item) => item.fileName === "lightnovelshelf.js");
if (!entry) throw new Error("lightnovelshelf.js is missing from index.json");
NODE
```

Expected: FAIL，错误包含 `lightnovelshelf.js is missing from index.json`。

- [ ] **Step 2: 确认 `index.json` 只有工作区原有的换行符差异**

Run:

```bash
git diff --ignore-space-at-eol --exit-code -- index.json
```

Expected: PASS，退出码为 0。若失败，立即停止，不能覆盖非换行符形式的已有修改。

- [ ] **Step 3: 从已跟踪版本生成最小索引变更并追加条目**

Run:

```bash
git show HEAD:index.json > index.json
node.exe <<'NODE'
const fs = require("fs");
const tracked = fs.readFileSync("index.json", "utf8");
const closing = "\n]\n";
if (!tracked.endsWith(closing)) throw new Error("Unexpected index.json ending");
const entry = `    {
        "name": "轻书架",
        "fileName": "lightnovelshelf.js",
        "key": "LightNovelShelf",
        "version": "0.2.3",
        "description": "轻书架漫画源，使用前需配置 RefreshToken 和 x-id / Visitor ID"
    }`;
const next = tracked.slice(0, -closing.length) + ",\n" + entry + closing;
fs.writeFileSync("index.json", next, "utf8");
NODE
```

- [ ] **Step 4: 验证 JSON、唯一性和全部发布元数据**

Run:

```bash
node.exe <<'NODE'
const fs = require("fs");
const index = JSON.parse(fs.readFileSync("index.json", "utf8"));
const matches = index.filter((item) =>
  item.fileName === "lightnovelshelf.js" || item.key === "LightNovelShelf"
);
if (matches.length !== 1) throw new Error(`Expected one matching entry, got ${matches.length}`);
const expected = {
  name: "轻书架",
  fileName: "lightnovelshelf.js",
  key: "LightNovelShelf",
  version: "0.2.3",
  description: "轻书架漫画源，使用前需配置 RefreshToken 和 x-id / Visitor ID",
};
if (JSON.stringify(matches[0]) !== JSON.stringify(expected)) {
  throw new Error(`Index metadata mismatch: ${JSON.stringify(matches[0])}`);
}
console.log("Index entry is valid and unique.");
NODE
```

Expected: PASS，输出 `Index entry is valid and unique.`。

- [ ] **Step 5: 暂存且仅暂存实现文件，检查提交差异**

Run:

```bash
git add -- lightnovelshelf.js index.json
git diff --cached --check
git diff --cached --name-status
```

Expected: PASS；文件列表仅包含：

```text
M	index.json
A	lightnovelshelf.js
```

- [ ] **Step 6: 提交仓库接入变更**

Run:

```bash
git commit -m "feat: 添加轻书架漫画源"
```

Expected: 创建一个仅包含 `index.json` 和 `lightnovelshelf.js` 的提交。

### Task 3: 执行完整验证

**Files:**
- Verify: `lightnovelshelf.js`
- Verify: `index.json`

- [ ] **Step 1: 验证源文件和索引中的名称、键、版本及更新地址一致**

Run:

```bash
node.exe <<'NODE'
const fs = require("fs");
const source = fs.readFileSync("lightnovelshelf.js", "utf8");
const index = JSON.parse(fs.readFileSync("index.json", "utf8"));
function field(name) {
  const match = source.match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, "m"));
  if (!match) throw new Error(`Missing source field: ${name}`);
  return match[1];
}
const entry = index.find((item) => item.fileName === "lightnovelshelf.js");
if (!entry) throw new Error("Missing index entry");
if (field("name") !== entry.name) throw new Error("Name mismatch");
if (field("key") !== entry.key) throw new Error("Key mismatch");
if (field("version") !== entry.version) throw new Error("Version mismatch");
const expectedUrl = "https://cdn.jsdelivr.net/gh/miludeshiji/venera-configs@main/lightnovelshelf.js";
if (field("url") !== expectedUrl) throw new Error("Update URL mismatch");
console.log("Source and index metadata are consistent.");
NODE
```

Expected: PASS，输出 `Source and index metadata are consistent.`。

- [ ] **Step 2: 运行仓库版本校验脚本**

Run:

```bash
GIT_DIR_WIN="$(wslpath -w "$(git rev-parse --git-dir)")"
WORK_TREE_WIN="$(wslpath -w "$PWD")"
WSLENV="GIT_DIR:GIT_WORK_TREE${WSLENV:+:$WSLENV}" \
  GIT_DIR="$GIT_DIR_WIN" \
  GIT_WORK_TREE="$WORK_TREE_WIN" \
  node.exe scripts/validate-pr-versions.js HEAD^
```

Expected: PASS，输出 `Version validation passed for 1 config file(s).`。

- [ ] **Step 3: 使用上游 Venera CLI 校验源格式**

Run:

```bash
REPO_ROOT="$PWD"
VALIDATOR_DIR="$(mktemp -d /mnt/f/workspace/venera-cli.XXXXXX)"
git clone --depth 1 https://github.com/venera-app/venera_cli.git "$VALIDATOR_DIR"
(
  cd "$VALIDATOR_DIR"
  /mnt/f/flutter-env/flutter/bin/cache/dart-sdk/bin/dart.exe pub get
  SOURCE_WIN="$(wslpath -w "$REPO_ROOT/lightnovelshelf.js")"
  /mnt/f/flutter-env/flutter/bin/cache/dart-sdk/bin/dart.exe run bin/venera.dart source validate "$SOURCE_WIN"
)
rm -rf "$VALIDATOR_DIR"
```

Expected: PASS，Venera CLI 退出码为 0，并报告 `lightnovelshelf.js` 校验成功。

- [ ] **Step 4: 检查最终提交和残余工作区状态**

Run:

```bash
git show --stat --oneline HEAD
git show --format= --name-status HEAD
git diff --ignore-space-at-eol --stat
git status --short
```

Expected:

- 最新实现提交只包含 `index.json` 和 `lightnovelshelf.js`。
- `git diff --ignore-space-at-eol --stat` 无非预期内容差异。
- 工作区仍可能显示任务开始前已存在的其他文件换行符差异；这些文件不得被暂存或提交。
