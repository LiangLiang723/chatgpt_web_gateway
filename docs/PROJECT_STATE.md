# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-2-implementation
STATUS=active
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-14-phase-2-sqlite-conversation-persistence-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-14-phase-2-sqlite-conversation-persistence.md
NEXT_TASK=execute-phase-2-task-7-acceptance-writeback
UPDATED_AT=2026-08-14
```

## Snapshot（快照）

- **当前阶段：** Phase 2 — SQLite + Conversation Persistence（持久化）实施中。
- **当前状态：** `active`
- **活动计划：** [`2026-08-14-phase-2-sqlite-conversation-persistence.md`](superpowers/plans/2026-08-14-phase-2-sqlite-conversation-persistence.md)。
- **下一个可执行任务：** 执行 Phase 2 Task 7：架构约束、完整验收与项目记忆回写。
- **当前 blocker（阻塞）：** 无。真实 ChatGPT 页面能力仍需要后续 Browser / Driver Phase 和显式 E2E（端到端）验证。

## Implemented Now（当前已实现）

### 仓库治理

- ✅ `AGENTS.md` Agent 工作入口。
- ✅ 项目记忆 Writeback（回写）协议。
- ✅ `PROJECT_STATE.md` 机器可检查状态头。
- ✅ 架构、API 兼容、测试、Git、Roadmap（路线图）文档。
- ✅ `docs/superpowers/specs/` / `plans/` 工作流目录。
- ✅ Phase 1 工具链、协议模型和正式 Docker 运行边界设计与实施计划。
- ✅ Phase 2 `node:sqlite`、Migration、Repository 与 Conversation aggregate 持久化设计规格。
- ✅ 文档链接、项目记忆、架构和版本一致性检查。
- ✅ TypeScript / Vitest 产品代码与测试基础。

### 产品代码

- ✅ Fastify（Web 服务框架）HTTP Server。
- ✅ Gateway Bearer API Key 认证；`/health` 免认证，`/v1/*` 默认认证。
- ✅ `GET /health` 与 `GET /v1/models`；模型列表只暴露 `chatgpt-web`。
- ✅ Chat Completions / Responses TypeBox/Ajv 请求 Schema（结构）。
- ✅ 两套协议共享的 `NormalizedRequest` 与纯 Normalizer（标准化器）。
- ✅ `X-Conversation-Key` 协议扩展、Tool Schema / Tool Choice、Structured Output、附件描述标准化。
- ✅ ignored 参数诊断与 unsupported 参数稳定错误。
- ✅ 两个 POST 路由完成 HTTP → Schema → Normalizer → injected execution boundary；默认生产执行器明确返回 `501 backend_not_implemented`，不伪造 ChatGPT 回答。
- ✅ 完整 `linux/amd64` Docker 运行基础：Playwright Chromium 镜像、Compose、`/data` Bind Mount、动态非 root `PUID/PGID`。
- ✅ 按需 noVNC maintenance overlay；默认 headless Compose 不启动维护进程、不发布 noVNC 端口。
- ❌ SQLite 持久化。
- ❌ 产品级 Playwright Chromium 生命周期 / Browser Manager。
- ❌ ChatGPT Driver（网页驱动）。
- ❌ Context Sync（上下文同步）。
- ❌ 真 Streaming（流式输出）。
- ❌ 文件 / 图片实际解析、落盘和上传；Phase 1 仅标准化输入描述。
- ❌ Tool Calling（工具调用）Prompt / Parser / 执行闭环；Phase 1 仅标准化 Tool Schema。
- ❌ ChatGPT 图片生成。
- ❌ NAS 实机部署、备份/恢复和生产运维成熟化。

**注意：Approved Scope（已批准范围）不代表上述未实现产品能力已经完成。**

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
- Playwright 自带 Chromium；项目 package 与官方镜像当前固定为 `1.62.1`。
- Phase 1 Docker 实测运行时为 `linux/amd64` + Node `v24.18.1`。
- 不使用 ChatGPT 私有 `/backend-api`。
- API Adapter（适配器）共享统一内部请求模型，不允许各自实现浏览器逻辑。
- `NormalizedRequest` 当前包含 `toolChoice` 与 `diagnostics.ignoredParameters`，用于保留协议策略和明确记录网页无法真实执行的 ignored 参数。
- 配置集中在 `src/config/`；架构检查禁止其他 `src/` 模块直接读取 `process.env`。
- Docker 从 Phase 1 起是正式运行边界；目标平台先锁定 `linux/amd64`。
- Phase 1 普通 Compose 当前只启动 Gateway；产品级 headless Browser Manager 属于 Phase 3。
- noVNC 只通过维护 overlay 按需启用，默认宿主机绑定 `127.0.0.1`，正常运行不启动也不发布 noVNC。
- `/data/browser-profile/` 是未来正常 browser runtime 与当前 maintenance browser 共用的持久 Profile 边界。
- `/health` 无需认证；所有 `/v1/*` 默认要求 Gateway Bearer API Key。
- `X-Conversation-Key` 是受控兼容扩展，协议层只负责标准化，不提前实现会话生命周期。
- 后续设计仍保持一个 BrowserContext 管理多个 Page、Context Sync `FRESH | APPEND | RESTORE | REBUILD`、SQLite 为 Conversation 事实来源、约 200ms DOM polling + Stable Prefix Streaming。

详细约束见 [`architecture.md`](architecture.md)。

## Recent Milestones（最近里程碑）

- 2026-08-14：批准 Phase 2 SQLite / Conversation persistence 设计：`node:sqlite`、单向 checksum migration、UUID v4、Unix 毫秒、关系型核心 + JSON payload、单 `DatabaseSync` 与 aggregate transaction。
- 2026-08-14：完成 Phase 1 实施：TypeScript/Fastify/TypeBox 工具链、认证、统一 Chat Completions / Responses Normalizer、基础 GET/POST 路由和 40 个确定性测试。
- 2026-08-14：完成正式 `linux/amd64` Docker 运行基础与 noVNC maintenance overlay；Docker smoke 验证 Node 24、HTTP 认证、Bind Mount、非 root `PUID/PGID`、维护进程/端口隔离和 noVNC 页面。
- 2026-08-14：固化 pnpm/Corepack 精确版本、pnpm 11 build-script allowlist 和整套“升级项目依赖”流程。
- 2026-08-14：完成 Phase 1 工具链 / 协议 / Docker 设计讨论；Docker 正式运行边界从 Phase 9 前移到 Phase 1。
- 2026-08-14：建立 `V0.0.1` 初始版本和 Living Repository（活仓库）治理体系。

## Next Steps（下一步）

1. Phase 2 plan：把已批准的 SQLite / Repository / Conversation aggregate spec 拆成可测试任务。
2. 实现数据库打开、PRAGMA、checksum migration 和 `001_initial.sql`。
3. 实现各 Repository 与 `ConversationStore`，证明 close → reopen 后完整结构化状态恢复。
4. 把数据库生命周期接入 Gateway startup/shutdown，并扩展 Docker smoke 验证 `/data/gateway.db`。
5. Phase 3 再实现正常运行的 Playwright Browser Manager、登录脚本、Selector Registry、ChatGPT Driver 与真实文本 E2E。

## Known Risks（已知风险）

- **真实 ChatGPT Web E2E 尚未运行。** 当前不能证明 ChatGPT Selector、真实登录、实际文件上传或图片生成可用。
- maintenance browser 已在 `about:blank` 下通过 Docker smoke，但尚未用真实 ChatGPT 账号完成首次登录流程验证。
- Phase 1 POST 端点只有协议闭环，默认生产执行器返回 `501 backend_not_implemented`，在 Phase 3/4 前不能用于真实聊天。
- 当前 Docker 验收矩阵只有 `linux/amd64`，未验证 ARM64。
- ChatGPT 网页 DOM 会变化；后续 Selector 必须集中并有诊断工具。
- Tool Calling 是 Gateway 的 Prompt + Parser 模拟层，不应伪装成 ChatGPT Web 原生工具协议。
- 真正的网页兼容性只有真实 E2E 才能证明；普通 Unit（单元）/Integration（集成）/Docker smoke 不能替代。
