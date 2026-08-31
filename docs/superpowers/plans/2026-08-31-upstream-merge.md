# 上游特性合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将上游提交 `4e48db6` 完整、无冲突地合并到当前 `main`，并验证三个漫画源文件及 `index.json`。

**Architecture:** 通过一次非快进 merge commit 保留当前仓库与上游的提交拓扑。合并内容保持上游原样；验证以 merge commit 的第一父节点为基线，只检查本次上游引入的文件和版本变化。

**Tech Stack:** Git、Node.js 20、Dart 3.13、`venera-app/venera_cli`、仓库内 `scripts/list-changed-configs.js` 与 `scripts/validate-pr-versions.js`

---

## 文件范围

- Merge-modify: `comic_walker.js` — ComicWalker 修复与版本更新。
- Merge-modify: `copy_manga.js` — CopyManga 修复与版本更新。
- Merge-modify: `manga_dex.js` — MangaDex 更新逻辑改进与版本更新。
- Merge-modify: `index.json` — 与三个漫画源对应的索引元数据更新。
- 不手工修改上述文件，不新增测试文件，不触碰其他漫画源。

### Task 1: 创建无冲突的上游 merge commit

**Files:**
- Modify through merge: `comic_walker.js`
- Modify through merge: `copy_manga.js`
- Modify through merge: `manga_dex.js`
- Modify through merge: `index.json`

- [ ] **Step 1: 确认实施前状态与上游节点**

Run:

```bash
git status --short --branch
git rev-parse upstream/main
```

Expected: 工作区无文件变更；分支为 `main`；第二条命令输出 `4e48db6bb3a9584e7643ff65e55c85ae98cf16c2`。任一条件不符即停止，不执行合并。

- [ ] **Step 2: 再次执行三方合并预检**

Run:

```bash
git merge-tree --write-tree main upstream/main
```

Expected: 仅输出一个合并树对象 ID，不输出 `CONFLICT`。

- [ ] **Step 3: 创建保留双方历史的 merge commit**

Run:

```bash
git merge --no-ff --no-edit upstream/main
```

Expected: Git 使用 `ort` 策略成功合并，修改 `comic_walker.js`、`copy_manga.js`、`manga_dex.js`、`index.json`，不进入冲突状态。

- [ ] **Step 4: 验证 merge commit 的双方父节点**

Run:

```bash
git rev-parse HEAD^2
git merge-base --is-ancestor upstream/main HEAD
git merge-base --is-ancestor HEAD^1 HEAD
```

Expected: 第一条命令输出 `4e48db6bb3a9584e7643ff65e55c85ae98cf16c2`；后两条命令退出码均为 0 且无输出。

### Task 2: 验证上游文件与仓库不变量

**Files:**
- Verify: `comic_walker.js`
- Verify: `copy_manga.js`
- Verify: `manga_dex.js`
- Verify: `index.json`
- Verify with: `scripts/list-changed-configs.js`
- Verify with: `scripts/validate-pr-versions.js`

- [ ] **Step 1: 确认第一父节点差异范围**

Run:

```bash
git diff --name-only HEAD^1..HEAD
node scripts/list-changed-configs.js HEAD^1
```

Expected: 第一条命令只列出 `comic_walker.js`、`copy_manga.js`、`index.json`、`manga_dex.js`；第二条命令只列出三个 `.js` 文件。

- [ ] **Step 2: 检查 JavaScript 与 JSON 语法**

Run:

```bash
node --check comic_walker.js
node --check copy_manga.js
node --check manga_dex.js
node -e "JSON.parse(require('fs').readFileSync('index.json', 'utf8'))"
```

Expected: 四条命令均以退出码 0 完成且无输出。

- [ ] **Step 3: 构建仓库工作流使用的 Venera CLI 校验器**

Run from repository root:

```bash
git clone --depth 1 https://github.com/venera-app/venera_cli.git cache/venera_cli
```

Run from `cache/venera_cli`:

```bash
dart pub get
dart build cli --target bin/venera.dart --output ../venera-cli-build
```

Expected: 依赖解析和构建均以退出码 0 完成，并生成 `cache/venera-cli-build/bundle/bin/venera.exe`。

- [ ] **Step 4: 使用 Venera CLI 验证三个变更源**

Run from repository root:

```bash
cache/venera-cli-build/bundle/bin/venera.exe source validate comic_walker.js
cache/venera-cli-build/bundle/bin/venera.exe source validate copy_manga.js
cache/venera-cli-build/bundle/bin/venera.exe source validate manga_dex.js
```

Expected: 三条命令均以退出码 0 完成，并分别报告源文件有效。

- [ ] **Step 5: 运行仓库版本一致性校验**

Run:

```bash
node scripts/validate-pr-versions.js HEAD^1
```

Expected: 输出 `Version validation passed for 3 config file(s).`。

- [ ] **Step 6: 删除本次验证生成的临时 CLI**

Run from repository root:

```bash
rm -rf cache/venera_cli cache/venera-cli-build
```

Expected: 两个临时目录均被删除；仓库跟踪文件不受影响。

- [ ] **Step 7: 检查合并结果与最终状态**

Run:

```bash
git diff --check HEAD^1..HEAD
git status --short --branch
git log -1 --oneline --decorate
```

Expected: 空白检查无输出；工作区无文件变更；最新提交为合并 `upstream/main` 的 merge commit。此 merge commit 本身即为本任务的实施提交，不再创建额外代码提交。