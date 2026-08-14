# Versioning System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `Vx.y.z` 版本体系，并把版本历史从 README 分离到 CHANGELOG。

**Architecture:** `VERSION` 是对外版本字符串，`package.json` 保存 npm 标准版本，`CHANGELOG.md` 保存历史，`docs/versioning.md` 保存规则，`check-version.mjs` 负责一致性检查。

**Tech Stack:** Markdown、Node.js ESM、Git。

## Global Constraints

- 对外版本与 Git Tag 使用大写 `V` 前缀。
- `package.json` 版本不带 `V`。
- README 不承担版本历史职责。

---

### Task 1: 建立版本事实来源

**Files:** `VERSION`, `CHANGELOG.md`, `docs/versioning.md`, `package.json`

- [x] 将当前版本设置为 `V0.0.1` / `0.0.1`。
- [x] 新增版本修改记录和版本规则文档。

### Task 2: 清理阶段性 README 文案

**Files:** `README.md`, `docs/PROJECT_STATE.md`

- [x] 删除 README 中作为产品阶段标签的 `V1` 表述。
- [x] 将 PROJECT_STATE 的范围描述改为版本无关的 Approved Scope。

### Task 3: 增加一致性检查

**Files:** `scripts/check-version.mjs`, `scripts/check-project-memory.mjs`, `package.json`

- [x] 校验 `VERSION` 与 `package.json`。
- [x] 校验 CHANGELOG 和 PROJECT_STATE 当前版本。
- [x] 将版本检查加入 `verify:repo`。

### Task 4: 验证

- [x] 运行 `npm run verify:repo`。
- [x] 运行 `git diff --check`。
- [x] 确认 README 不再包含产品阶段性 `V1` 文案。
