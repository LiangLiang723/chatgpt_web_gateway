# ChatGPT Web Gateway - Agent 工作规则

> **聊天记录不是项目事实来源；会影响后续 Agent 判断的稳定事实必须写回仓库。**

本文件是 Agent（智能体）的**工作入口**，不是项目知识库。项目当前状态看 [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)，架构看 [`docs/architecture.md`](docs/architecture.md)，API（应用程序接口）兼容范围看 [`docs/api-compatibility.md`](docs/api-compatibility.md)，测试看 [`docs/testing.md`](docs/testing.md)，详细开发流程看 [`docs/development-workflow.md`](docs/development-workflow.md)。

## 1. 核心原则

- **想清楚再写：** 不猜 API、CLI（命令行接口）、包版本、模型名、DOM（文档对象模型）行为或配置；能从代码、测试、文档和运行结果确认的事实先确认。
- **简单优先：** 只实现当前批准范围，不为假想需求增加抽象、配置或依赖。
- **外科手术式改动：** 每处改动都应直接服务当前任务，不顺手翻新无关代码。
- **目标驱动：** 开始前明确什么算成功；行为变化优先通过失败测试 → 最小实现 → 绿测试 → 更大范围验证完成闭环。
- **事实优先于计划：** 计划与现实冲突时先修正文档/计划，再继续实现，不为旧计划强行写错代码。
- **单主会话：** 同一长期仓库任务优先复用一个主开发会话，不为了“继续”主动创建平行会话；聊天历史不是恢复来源，换会话或中断后必须从仓库状态恢复。

## 2. 任务开始

按顺序恢复上下文：

1. 如果工具链可用，先运行 `corepack pnpm project:status` 获取 branch / HEAD / dirty files / Phase / Active Plan / NEXT_TASK / 首个未解决步骤摘要。
2. 查看 `git status --short --branch`，确认当前工作树和已有改动；摘要不能替代真实 Git 状态。
3. 阅读本文件与 `docs/PROJECT_STATE.md`。
4. 阅读 `PROJECT_STATE` 指向的 Governing Spec（主设计规格）和 Active Plan（活动计划）；没有活动计划时，按任务复杂度判断是否需要先建立 spec（设计规格）/plan（实施计划）。
5. 阅读任务相关的专项文档、源码和测试。
6. 修改前搜索已有实现、引用和测试，不只凭文件名或记忆判断行为。

长任务和 spec/plan 规则见 [`docs/development-workflow.md`](docs/development-workflow.md)。

## 3. 指令与事实优先级

冲突时按以下顺序处理：

1. 系统、安全和平台限制。
2. 用户最新明确要求。
3. 刚刚验证的运行行为与可执行测试。
4. 距离被修改文件最近的项目说明。
5. `docs/PROJECT_STATE.md` 当前事实。
6. 架构、API、测试等专项文档。
7. 本文件默认规则。

发现仓库事实来源互相矛盾时，不靠聊天解释过去；在当前任务中修正或明确记录 blocker（阻塞）。

## 4. 实现与验证

- 行为修改优先写能证明目标的测试；修 bug（缺陷）先复现，再修复。
- 优先使用仓库已有脚本和工具链，不随意更换包管理器、升级依赖或添加生产依赖。
- 在相关检查通过前，不声称任务完成；验证证据必须来自当前改动后的新鲜运行结果。
- 先跑最小相关检查，再按影响范围扩大到类型检查、Lint（代码检查）、测试、构建和仓库治理检查。
- 真实 ChatGPT E2E（端到端）测试必须显式运行；没运行时不得声称当前网页 Selector（选择器）、登录、上传、Streaming（流式输出）或图片生成已经真实验证。调试真实网页失败时优先使用最窄 standalone Phase；combined E2E 只用于最终候选回归，具体请求预算与退避规则见 `docs/testing.md`。
- 详细验收门槛见 [`docs/testing.md`](docs/testing.md)。

## 5. Git 与安全

- 默认使用功能分支，不直接 push（推送）默认分支；未经明确批准不 force-push（强制推送）、重写历史或破坏性 reset（重置）。
- 提交前检查 `git status`、`git diff --check` 和 staged diff（已暂存差异）。
- 不绕过 Hook（钩子），不把密钥、Cookie、Token、Browser Profile（浏览器配置）、数据库、真实上传文件、生成图片或日志提交进 Git。
- Commit（提交）格式遵循 [`docs/git-commit-convention.md`](docs/git-commit-convention.md)。
- 密钥与凭证处理见 [`SECURITY.md`](SECURITY.md)。

## 6. 项目记忆回写

任务结束前执行 [`docs/project-memory-protocol.md`](docs/project-memory-protocol.md) 的 Writeback Decision（回写判断）。至少检查：

- 当前实现、Phase（阶段）、下一任务或 blocker 是否变化。
- API 行为、架构、测试、部署/使用方式是否变化。
- Active Plan 的步骤、假设或状态是否变化。
- 是否产生新的重要设计决定。

**代码完成但该更新的项目事实没有写回仓库，任务不算完成。**

## 7. AGENTS.md 自我改进

用户纠正 Agent 后，只有**稳定、可复用、有防错价值且未被现有规则覆盖**的问题才值得沉淀。

优先级：

```text
收紧已有规则
> 专项文档
> 可执行检查
> 新增 AGENTS.md 条目
```

不要把一次性环境、具体实现细节或某次任务的特殊情况写进本文件。如果规则开始变长或重复，优先下沉、合并或删除。

## 8. 完成门槛

结束任务前按顺序确认：

```text
实现
→ 相关验证
→ 更大范围验证
→ 文档影响判断
→ Plan / PROJECT_STATE 回写
→ AGENTS 自我改进判断
→ 仓库治理检查
→ git diff --check
→ 检查提交内容
→ 简洁汇报
```

最终汇报说明：改了什么、验证了什么、哪些内容没有验证、涉及的重要文件，以及仍存在的风险或下一步。
