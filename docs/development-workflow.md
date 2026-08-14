# Development Workflow（开发流程）

## 任务启动

```text
打开工作区
→ git status
→ AGENTS.md
→ PROJECT_STATE.md
→ Active Plan
→ 任务相关文档 / 代码 / 测试
→ 明确成功标准
```

## 小任务

如果行为明确、风险低且不需要多步架构变更：

1. 读取相关实现和测试。
2. 写失败测试。
3. 写最小实现。
4. 运行相关测试。
5. 运行受影响的更大范围检查。
6. 执行项目记忆回写判断。
7. 运行仓库治理检查。
8. 检查 diff（差异）并提交。

## 长任务

满足任一条件时先建立/更新 spec（设计规格）和 plan（实施计划）：

- 跨多个模块。
- 新公开 API。
- 数据库结构变化。
- Context Sync（上下文同步）/ Streaming（流式输出）/ Browser（浏览器）恢复等核心行为变化。
- 部署方式或安全边界变化。
- 预计需要多个独立测试闭环。

长任务执行中：

```text
每个可独立验收 Task
→ 红测试
→ 最小实现
→ 绿测试
→ 更新 Plan checkbox
→ 必要时更新 PROJECT_STATE
→ 下一个 Task
```

## 完成门槛

在声称完成前必须有刚刚运行的验证证据。

仓库基础检查：

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
```

完整 TypeScript（类型化 JavaScript）工具链建立后，目标总入口：

```bash
pnpm verify
```

真实 ChatGPT E2E（端到端）不应默认包含在本地确定性 `verify` 中，必须显式开启。

## 提交

提交规范见 [`git-commit-convention.md`](git-commit-convention.md)。提交前必须看 staged diff（已暂存差异），防止把浏览器 Profile（配置）、SQLite、Cookie 或真实用户文件带入 Git。
