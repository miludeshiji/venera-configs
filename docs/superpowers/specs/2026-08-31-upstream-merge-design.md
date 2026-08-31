# 上游特性合并设计

## 目标

将 `venera-app/venera-configs` 的最新 `main` 分支完整合并到当前仓库，在保留本地 48 个独有提交及上游原始提交关系的前提下，引入上游提交 `4e48db6` 中的 MangaDex 改进和 CopyManga、ComicWalker 修复。

## 当前状态

- 当前分支为 `main`，工作区干净，并与 `origin/main` 一致。
- 本地与上游的共同祖先为 `ac76299654c452e287b9650bfdb210c61b20f53b`。
- 本地独有 48 个提交，上游独有 1 个提交：`4e48db6 Improve MangaDex updates and fix CopyManga and ComicWalker (#327)`。
- 上游提交修改 `manga_dex.js`、`copy_manga.js`、`comic_walker.js` 和 `index.json`。
- `git merge-tree --write-tree main upstream/main` 已成功生成合并树，未报告冲突。

## 决策

采用普通 merge commit 合并完整的 `upstream/main`，不 cherry-pick、不拆分提交，也不手工重写上游文件。

该方案保留双方提交拓扑，明确记录本仓库已经吸收该上游节点，后续同步时 Git 可以正确识别已合并内容。Cherry-pick 会切断上游提交关系；手工移植在已经确认完整合并的前提下只会增加遗漏和未来重复合并的风险。

## 合并流程

1. 再次确认工作区仍然干净，且 `upstream/main` 指向已审查的 `4e48db6`。
2. 在当前 `main` 上创建一次非快进 merge commit，完整合并 `upstream/main`。
3. 不对无冲突的上游内容作额外格式化或重构。
4. 检查 merge commit 的父节点和文件集合，确认本地历史与上游提交均被保留。

## 异常处理

预合并已经确认无冲突。若实际合并仍出现冲突或上游引用在实施前发生变化，立即停止合并；不使用 `ours`、`theirs` 或批量覆盖隐藏差异。重新比较新提交的文件范围及本地重叠改动后，再决定具体处理方式。

## 验证

- 对三个受影响的 JavaScript 文件运行语法检查，并解析 `index.json`。
- 运行仓库已有的索引/版本校验入口，确认 `index.json` 与源文件元数据保持一致。
- 运行 `git diff --check` 检查合并结果没有空白错误。
- 检查最终工作区干净，merge commit 同时拥有本地原 HEAD 和 `4e48db6` 两个父节点。
- 确认 `main` 已包含 `upstream/main`，且本地合并前提交仍可从 `main` 到达。

## 范围约束

本次只合并上游提交及完成必要验证。除设计文档、实施计划和 merge commit 外，不修改无关漫画源、缓存文件、README 或工作流配置。