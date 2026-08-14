# Living Repository Foundation Implementation Plan

> **For agentic workers:** This plan was executed to create the foundation skeleton. Checkbox state reflects the delivered artifact.

**Goal:** 把现有项目骨架升级为可以从仓库恢复状态、持续回写项目记忆并由机器检查关键一致性的 Living Repository（活仓库）。

**Architecture:** `AGENTS.md` 只保存稳定 Agent 规则；`PROJECT_STATE.md` 保存当前真实状态；专项文档保存稳定事实；spec/plan 保存设计和执行过程。零依赖 Node.js 检查脚本为文档引用、状态引用和核心模块边界提供机器兜底。

**Tech Stack:** Markdown、Node.js ESM（ECMAScript 模块）脚本、Git；本计划不引入产品运行时依赖。

## Global Constraints

- 不实现 ChatGPT 产品功能，只优化仓库基础与自更新能力。
- 不把 V1 目标写成当前已实现能力。
- 不引入文档生成平台或 YAML（配置文件）作为新的唯一事实来源。
- 检查脚本必须使用 Node.js 标准库，不需要 `npm install` / `pnpm install`。

---

### Task 1: 重构 Agent 入口和项目记忆协议

**Files:**
- Modify: `AGENTS.md`
- Create: `docs/project-memory-protocol.md`
- Create: `docs/development-workflow.md`

**Interfaces:**
- Consumes: 用户批准的 Living Repository 设计。
- Produces: 每次任务启动/结束的固定恢复和回写流程。

- [x] 明确“聊天不是项目记忆，仓库才是”。
- [x] 固化与具体执行环境解耦的工作区恢复规则。
- [x] 加入用户纠错 → 稳定规则判断 → 收紧/专项文档/机器检查的自我改进流程。
- [x] 建立 Writeback Decision 矩阵。

### Task 2: 拆开当前实现和 V1 目标

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/api-compatibility.md`

**Interfaces:**
- Consumes: 已批准 V1 范围。
- Produces: 不会把未来目标误读为当前实现的项目状态。

- [x] 增加 Machine State 机器状态块。
- [x] 建立 `Implemented Now` 明确 ✅ / ❌。
- [x] 把 V1 目标放进 `V1 Approved Scope`。
- [x] API 矩阵声明自身描述的是 V1 目标，真实完成度以 PROJECT_STATE 为准。

### Task 3: 加入仓库机器兜底

**Files:**
- Create: `scripts/check-project-memory.mjs`
- Create: `scripts/check-docs.mjs`
- Create: `scripts/check-architecture.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run verify:repo` 可运行的基础一致性检查。

- [x] 检查 `PROJECT_STATE` 必需字段和 spec/plan 路径。
- [x] 检查核心文档缺失和占位符。
- [x] 检查 Markdown 相对链接。
- [x] 建立模块依赖与 Selector 集中规则扫描。

### Task 4: 固化产品 V1 主设计并回写状态

**Files:**
- Create: `docs/superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md`
- Modify: `docs/PROJECT_STATE.md`
- Modify: `README.md`

**Interfaces:**
- Produces: 后续 Phase 的 governing spec（主设计规格）。

- [x] 汇总 API、Conversation、Context Sync、Streaming、Tools、附件、图片生成、SQLite 和 Browser Runtime 设计。
- [x] 将 Governing Spec 写入 PROJECT_STATE Machine State。
- [x] 明确 Phase 1 是下一个独立设计/计划阶段。

### Task 5: 验证和提交

**Files:**
- Verify: whole repository

**Interfaces:**
- Produces: 当前骨架的可重复验证证据。

- [x] 运行 `npm run verify:repo`。
- [x] 运行 `git diff --check`。
- [x] 扫描 `TBD/TODO` 等占位符。
- [x] 检查 Git 状态与提交内容。
