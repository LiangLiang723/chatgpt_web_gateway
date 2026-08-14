# Agent Entry Slimming Design

**Date:** 2026-08-14  
**Status:** Approved

## Problem

现有 `AGENTS.md` 同时承担 Agent 工作方式、项目硬边界、模块职责、Playwright/Streaming 细节、Git、测试和项目记忆等多种职责，达到约 200 行。它开始从“工作入口”变成“项目知识库”，与 `architecture.md`、`testing.md` 等专项文档产生重复和未来漂移风险。

同时，仓库中存在针对某一次开发环境的工具/路径描述。这些内容不能成为长期项目规则，否则未来其他 Agent 会误以为必须使用同一工具才能维护项目。

## Decision

采用 **精简入口型 `AGENTS.md`**：

`AGENTS.md` 只保存长期稳定且跨任务重复适用的规则：

- 核心工作原则。
- 任务开始时如何恢复项目上下文。
- 指令/事实优先级。
- 实现和验证的底线。
- Git 与凭据安全底线。
- 项目记忆回写触发条件。
- 用户纠正后的规则自我改进策略。
- 任务完成门槛。

以下内容不得继续放在 `AGENTS.md` 作为详细正文：

- 模块依赖和源码边界 → `docs/architecture.md`。
- Browser / Playwright / Selector / Streaming 实现细节 → `docs/architecture.md`。
- OpenAI API 兼容字段 → `docs/api-compatibility.md`。
- 测试层级和命令 → `docs/testing.md`。
- spec/plan 的完整多步骤流程 → `docs/development-workflow.md`。
- 项目记忆字段和回写矩阵 → `docs/project-memory-protocol.md`。

`AGENTS.md` 通过链接指向这些事实来源。

## Execution-environment neutrality（执行环境中立）

项目治理文档只描述通用动作，例如“进入项目工作区、检查 Git 状态、读取项目说明”。某一次会话使用的工作区工具、挂载路径或平台特有命令不能写进长期项目规则。

## Anti-growth rule（防膨胀规则）

用户纠正后的规则沉淀顺序保持：

```text
收紧现有规则
> 专项文档
> 可执行检查
> 新增 AGENTS.md 条目
```

一次性环境和某项实现细节直接排除在 `AGENTS.md` 自我改进候选之外。

## Success Criteria（成功标准）

- `AGENTS.md` 明显短于原约 200 行版本，并可在一次阅读中掌握。
- `AGENTS.md` 不包含模块职责清单、Selector 策略、Streaming 算法或 API 兼容矩阵等专项细节。
- 仓库治理文档不绑定任何一次性开发环境工具或本机路径。
- Project Memory、自我改进、验证和 Git 安全规则仍然存在。
- `npm run verify:repo` 与 `git diff --check` 继续通过。
