# Project Memory Protocol（项目记忆协议）

## 目标

让不同会话、不同 Agent（智能体）和不同开发工具都能仅通过仓库恢复项目上下文，而不是依赖聊天历史。

## 文档职责

| 文件 | 只负责什么 |
|---|---|
| `AGENTS.md` | Agent 怎么工作、任务恢复入口、验证与回写触发条件 |
| `README.md` | 项目是什么、面向人的入口、如何开始 |
| `docs/PROJECT_STATE.md` | **现在真实实现到哪里**、活动计划、下一任务、阻塞 |
| `docs/architecture.md` | 稳定架构、模块责任和数据流 |
| `docs/api-compatibility.md` | 当前公开 API（应用程序接口）的兼容行为 |
| `docs/testing.md` | 测试层级和完成门槛 |
| `docs/roadmap.md` | 阶段顺序和阶段性目标 |
| `docs/superpowers/specs/*` | 某项设计为什么这样做 |
| `docs/superpowers/plans/*` | 某项工作具体如何实施、当前执行到哪 |

不要在这些文件之间复制大段相同内容；用链接指向事实来源。代码边界、浏览器细节、API 兼容规则等实现知识不得回填到 `AGENTS.md`。

## 版本变化

如果任务改变公开版本，必须同步 `VERSION`、`package.json`、`CHANGELOG.md` 和 `docs/PROJECT_STATE.md`。版本规则见 [`versioning.md`](versioning.md)。

## Writeback Decision（回写判断）

每次任务结束前逐项判断：

| 发生了什么 | 必须回写 |
|---|---|
| 当前实现能力变化 | `PROJECT_STATE.md` |
| 当前 Phase / 下一任务 / blocker 变化 | `PROJECT_STATE.md` |
| API 路由、字段、支持程度变化 | `api-compatibility.md` |
| 模块边界、数据流、持久化策略变化 | `architecture.md` |
| 测试命令或验收标准变化 | `testing.md` |
| 人类使用、部署或配置方式变化 | `README.md` / 对应部署文档 |
| Plan 步骤完成、取消、阻塞或事实变化 | 当前 plan |
| 新的重要设计决定 | 对应 spec；必要时同步 architecture/state |
| 用户纠正了稳定的 Agent 工作方式 | 先检查 `AGENTS.md` 是否已有规则，再决定收紧规则或把细节放专项文档/检查脚本 |

## `PROJECT_STATE.md` 的硬规则

1. **只写当前事实，不把未来目标写成已实现。**
2. `Implemented Now` 必须允许 `✅/❌` 一眼区分真实能力。
3. `Machine State` 中的 `ACTIVE_PLAN` 必须指向存在文件或为 `none`。
4. `NEXT_TASK` 必须是当前可执行的最小下一步，不写“继续开发”这类空话。
5. 里程碑只保留最近少量高价值变化；完整历史由 Git 保存。
6. 任务完成后如果状态没变化，不为了“有更新”而制造无意义编辑。

## Plan 状态规则

计划任务使用：

```text
[x] 已完成
[ ] 未完成
[!] 被阻塞
[-] 被新设计替代 / 明确取消
```

当计划与现实冲突：

1. 先记录现实。
2. 更新 plan 的假设、步骤或状态。
3. 如果冲突改变了设计边界，更新 spec 并重新经过设计批准。
4. 再继续实现。

禁止为了“遵守旧计划”强行实现已经被事实证明不合理的步骤。

## 用户纠错学习

用户纠正 Agent 后，不是所有纠正都进入 `AGENTS.md`。

进入规则的条件：

- 稳定：不是只对当前一次任务有效。
- 可复用：以后大概率会再次遇到。
- 有防错价值：规则能明显减少重复错误。
- 没有被现有规则覆盖。

优先级：

```text
收紧已有规则
> 专项文档
> 可执行检查
> 新增 AGENTS.md 条目
```

如果规则可以机器验证，优先写检查脚本，让文字只解释“为什么”。

## 自动检查

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
node scripts/check-version.mjs
```

这些检查只保证仓库内部一致性，不能替代产品测试。
