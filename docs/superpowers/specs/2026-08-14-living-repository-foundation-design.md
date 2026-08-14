# Living Repository Foundation Design

**Date:** 2026-08-14
**Status:** Approved and applied to the foundation skeleton

## Problem

原骨架有 `PROJECT_STATE.md`，但主要依赖 Agent 人工记得更新。V1 目标和当前实现也容易混在同一个状态文件里，让后续 Agent 把“已设计”误认为“已实现”。用户希望参考 FlyMail 的 `AGENTS.md`，让仓库能够随着任务持续自我更新，而不是依赖聊天记忆。

## Decision

采用 **B：Living Repository（活仓库）**。

仓库分成六类事实：

1. `AGENTS.md`：工作规则。
2. `PROJECT_STATE.md`：当前真实状态。
3. 架构/API/测试等专项文档：稳定项目事实。
4. `specs/`：已批准设计。
5. `plans/`：执行步骤和当前执行状态。
6. Git：完整历史。

不采用全机器化 `project-contract.yaml` 生成所有文档，避免项目治理平台化和过度设计。

## Self-update Loop（自更新闭环）

```text
任务启动
→ 从仓库恢复事实
→ 实现 / 验证
→ Writeback Decision
→ 更新 State / Docs / Plan
→ 用户纠错规则判断
→ 机器一致性检查
→ Git diff / commit
```

## Machine Guardrails（机器兜底）

基础阶段提供三个零依赖脚本：

- `check-project-memory.mjs`：检查 `PROJECT_STATE` 机器头、spec/plan 引用、状态值和占位符。
- `check-docs.mjs`：检查 Markdown 相对链接。
- `check-architecture.mjs`：扫描源码导入，约束已确定模块边界。

这些脚本只做仓库内部一致性检查，不声称验证产品功能。

## State Separation（状态隔离）

`PROJECT_STATE.md` 必须区分：

- `Implemented Now`：已经真实存在并可验证的能力。
- `V1 Approved Scope`：未来批准目标。

未来目标不能用“✅ 已实现”的语气写入实现区。

## Agent Learning（Agent 学习）

用户纠正不是自动无限追加到 `AGENTS.md`。只有稳定、可复用、有防错价值且未被已有规则覆盖的纠正才沉淀。

优先顺序：收紧旧规则 → 专项文档 → 可执行检查 → 新增 AGENTS 条目。

## Success Criteria（成功标准）

- 新会话只读仓库即可知道当前真实状态和下一步。
- V1 设计目标不会被误读为当前实现。
- Active Plan 引用失效会被机器检查发现。
- 文档相对链接失效会被机器检查发现。
- 已知核心模块越界 import 会被机器检查发现。
- 用户纠正能形成可控、不会无限膨胀的规则改进流程。
