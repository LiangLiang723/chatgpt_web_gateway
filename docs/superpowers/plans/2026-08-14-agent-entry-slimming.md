# Agent Entry Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `AGENTS.md` 收敛为精简的长期入口，并把详细规则下沉到各自专项文档。

**Architecture:** `AGENTS.md` 只保存跨任务稳定的工作方式；`architecture.md`、`development-workflow.md`、`project-memory-protocol.md`、`testing.md` 和 `api-compatibility.md` 各自成为对应事实的唯一维护位置。项目治理保持执行环境无关。

**Tech Stack:** Markdown、Node.js ESM（ECMAScript 模块）仓库检查、Git。

## Global Constraints

- 不改变 ChatGPT Web Gateway V1 产品架构和产品范围。
- 不删除项目记忆回写、自我改进和验证机制，只调整它们的文档归属。
- 不在 `AGENTS.md` 复制详细模块边界、API 路由或浏览器实现细节。
- 项目治理文档不得绑定某个一次性执行环境。

---

### Task 1: 精简 Agent 入口

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `docs/PROJECT_STATE.md` 与各专项文档。
- Produces: 新 Agent 的短入口和长期工作规则。

- [x] 保留核心原则、恢复顺序、事实优先级和目标驱动执行。
- [x] 删除模块清单、浏览器实现细节和项目硬边界的重复正文，改为指向专项文档。
- [x] 保留验证、Git/密钥、项目记忆回写和自我改进底线。

### Task 2: 清理环境耦合并强化文档职责

**Files:**
- Modify: `docs/development-workflow.md`
- Modify: `docs/project-memory-protocol.md`
- Modify: `docs/superpowers/plans/2026-08-14-living-repository-foundation.md`

**Interfaces:**
- Produces: 与具体开发工具无关的长期工作流，以及明确的文档职责边界。

- [x] 删除一次性工作区工具说明。
- [x] 明确 `AGENTS.md` 是工作入口，不保存代码边界和实现细节。
- [x] 保留历史计划的真实目标，同时改为环境无关表述。

### Task 3: 回写项目状态并验证

**Files:**
- Modify: `docs/PROJECT_STATE.md`
- Verify: whole repository

**Interfaces:**
- Produces: 可恢复的最新治理状态和验证证据。

- [x] 记录本次治理精简里程碑。
- [x] 运行 `npm run verify:repo`。
- [x] 搜索治理文档，确认没有一次性执行环境残留。
- [x] 运行 `git diff --check`。
