# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-1-implementation
STATUS=active
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-14-phase-1-toolchain-protocol-docker-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-14-phase-1-toolchain-protocol-docker.md
NEXT_TASK=execute-phase-1-task-6-post-routes
UPDATED_AT=2026-08-14
```

## Snapshot（快照）

- **当前阶段：** Phase 1 — Toolchain / Protocol / Docker Implementation（工具链 / 协议 / Docker 实施）。
- **当前状态：** `active`
- **活动计划：** [`2026-08-14-phase-1-toolchain-protocol-docker.md`](superpowers/plans/2026-08-14-phase-1-toolchain-protocol-docker.md)。
- **下一个可执行任务：** 执行 Phase 1 Task 6：POST 路由验证链与注入执行边界。
- **当前 blocker（阻塞）：** 无。真实 ChatGPT 页面能力仍需要后续 E2E（端到端）验证。

## Implemented Now（当前已实现）

### 仓库治理

- ✅ `AGENTS.md` Agent 工作入口。
- ✅ 项目记忆 Writeback（回写）协议。
- ✅ `PROJECT_STATE.md` 机器可检查状态头。
- ✅ 架构、API 兼容、测试、Git、Roadmap（路线图）文档。
- ✅ `docs/superpowers/specs/` / `plans/` 工作流目录。
- ✅ Phase 1 工具链、协议模型和正式 Docker 运行边界设计规格。
- ✅ 文档链接检查脚本。
- ✅ 项目记忆一致性检查脚本。
- ✅ 基础架构依赖检查脚本。
- ✅ `src/` / `tests/` 空模块骨架。

### 产品代码

- ❌ Fastify（Web 服务框架）HTTP Server。
- ❌ OpenAI 请求 Schema（结构）与 Normalizer（标准化器）。
- ❌ SQLite 持久化。
- ❌ Playwright Chromium 生命周期。
- ❌ ChatGPT Driver（网页驱动）。
- ❌ Context Sync（上下文同步）。
- ❌ 真 Streaming（流式输出）。
- ❌ 文件 / 图片输入。
- ❌ Tool Calling（工具调用）。
- ❌ ChatGPT 图片生成。
- ❌ Docker / NAS 运行实现。

**注意：Approved Scope（已批准范围）不代表上述产品能力已经完成。**

## Approved Scope（已批准产品范围）

### API

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/files`
- `GET /v1/files`
- `GET /v1/files/:id`
- `GET /v1/files/:id/content`
- `DELETE /v1/files/:id`
- `POST /v1/images/generations`

### 核心能力

- 文本、多轮 Conversation（对话）。
- 图片 URL / Base64 图片。
- 文件上传 / Base64 文件 / `file_id` 复用。
- Tool Calling（工具调用）。
- 基于 ChatGPT DOM（文档对象模型）的真 Streaming（流式输出）。
- 完整对话持久化。
- ChatGPT 图片生成；当前批准范围为非流式、`n=1`。
- 同一 Conversation 串行，不同 Conversation 可并行。

## Architecture Facts（当前架构事实）

- ChatGPT Web only（仅 ChatGPT 网页）。
- OpenAI Compatible API only（仅 OpenAI 兼容接口）。
- Playwright 自带 Chromium。
- 不使用 ChatGPT 私有 `/backend-api`。
- 一个 BrowserContext（浏览器上下文）管理多个 Page（网页标签）。
- Context Sync 模式：`FRESH | APPEND | RESTORE | REBUILD`。
- SQLite 是结构化 Conversation 状态的事实来源；文件字节使用文件系统。
- Streaming 当前方案采用约 200ms DOM polling（网页轮询）+ Stable Prefix（稳定前缀）。
- API Adapter（适配器）共享统一内部请求模型，不允许各自实现浏览器逻辑。
- Docker 从 Phase 1 起是正式运行边界；目标平台先锁定 `linux/amd64`。
- 默认 headless；noVNC 只通过维护 overlay 按需启用，正常运行不启动也不发布 noVNC。
- `/health` 无需认证；所有 `/v1/*` 默认要求 Gateway Bearer API Key。
- `X-Conversation-Key` 是受控兼容扩展，协议层只负责标准化，不提前实现会话生命周期。

详细约束见 [`architecture.md`](architecture.md)。

## Recent Milestones（最近里程碑）

- 2026-08-14：完成 Phase 1 工具链 / 协议 / Docker 设计讨论并写入正式 spec；Docker 正式运行边界从 Phase 9 前移到 Phase 1，依赖升级流程同步固化。
- 2026-08-14：建立 `V0.0.1` 初始版本，并将版本历史统一迁移到 `CHANGELOG.md`。
- 2026-08-14：精简 `AGENTS.md` 为长期工作入口，移除一次性执行环境描述，并把代码边界与实现细节统一下沉到专项文档。
- 2026-08-14：把 ChatGPT Web Gateway 的 API、Context Sync、Streaming、附件、Tools、图片生成和持久化决策汇总为 governing spec。
- 2026-08-14：确认 B 方案 Living Repository（活仓库）作为项目治理模式。
- 2026-08-14：参考 FlyMail 的 `AGENTS.md`，加入用户纠错沉淀、计划随事实更新、文档同步和 Agent 自我改进机制。
- 2026-08-14：把“已实现”与“已批准产品范围”严格拆开，避免 Agent 把设计目标误认成现有能力。
- 2026-08-14：加入可执行 `project-memory / docs / architecture` 仓库检查。

## Next Steps（下一步）

1. 用户审阅并批准 Phase 1 书面 spec。
2. Phase 1 plan：把 spec 拆成可测试任务。
3. 实现 TypeScript / pnpm / Fastify / TypeBox 工具链、认证、统一 Normalizer 和正式 Docker 运行边界。
4. 完成 `/health`、`/v1/models`、两类 POST Adapter 与 Docker smoke 的最小闭环。
5. 按 [`roadmap.md`](roadmap.md) 逐 Phase 推进。

## Known Risks（已知风险）

- Playwright 官方镜像内置 Node 版本可能与批准的 Node LTS 不同步；Docker 构建必须显式校验版本组合。
- ChatGPT 网页 DOM 会变化；Selector 必须集中并有诊断工具。
- ChatGPT Web 自动化不是官方 OpenAI API，可靠性和平台限制必须通过保守并发与恢复策略控制。
- Tool Calling 是 Gateway 的 Prompt + Parser 模拟层，不应伪装成 ChatGPT Web 原生工具协议。
- 真正的网页兼容性只有真实 E2E 才能证明；普通 Unit（单元）/Integration（集成）测试不能替代。
