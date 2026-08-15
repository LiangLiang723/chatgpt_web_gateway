# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-4-implementation
STATUS=ready-for-phase-4-implementation
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
NEXT_TASK=execute-phase-4-plan-task-1
UPDATED_AT=2026-08-15
```

## Snapshot（快照）

- **当前阶段：** Phase 4 — Conversation + Context Sync 设计与实施计划完成，产品实现尚未开始。
- **当前状态：** `ready-for-phase-4-implementation`
- **活动计划：** [`superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md`](superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md)。
- **下一个可执行任务：** Plan Task 1 — 增加 `002_add_conversation_sync_checkpoint.sql`、Persistence sync checkpoint 类型与 metadata-only in-flight 更新。
- **当前真实产品能力：** 仍是 Phase 3 Fresh 非流式纯文本闭环；Phase 4 Context Sync 尚未接入运行时。
- **Phase 3 真实验收事实：** 独立 E2E Profile 已完成人工登录；产品 Playwright Chromium 已实际通过 authenticated inspect、Fresh Driver challenge 和 Gateway HTTP → ChatGPT Web → Chat Completions challenge。

## Implemented Now（当前已实现）

### 仓库治理与设计

- ✅ `AGENTS.md` Agent 工作入口、Project Memory（项目记忆）协议和机器一致性检查。
- ✅ 架构、API 兼容、测试、Git、Roadmap（路线图）文档。
- ✅ `docs/superpowers/specs/` / `plans/` 长任务工作流。
- ✅ Phase 1 工具链、统一协议模型和正式 Docker 运行边界设计/实现。
- ✅ Phase 2 SQLite / Conversation aggregate 持久化设计/实现。
- ✅ Phase 3 BrowserManager / PagePool / Selector / Auth / Fresh Text Driver / real E2E 设计/实现。
- ✅ Phase 4 Conversation identity / FIFO / Context Sync / Page affinity / crash checkpoint **设计规格**。
- ✅ Phase 4 13-Task TDD implementation plan。

### 产品代码

- ✅ Fastify HTTP Server、Gateway Bearer API Key；`/health` 免认证，`/v1/*` 默认认证。
- ✅ `GET /health`、`GET /v1/models`；只暴露 `chatgpt-web`。
- ✅ Chat Completions / Responses TypeBox/Ajv Schema、统一 `NormalizedRequest` 与 Normalizer。
- ✅ `X-Conversation-Key` 协议扩展已经标准化，但当前执行层尚未实现其多轮语义。
- ✅ ignored 参数诊断与 unsupported 参数稳定错误。
- ✅ POST 路由已完成 HTTP → Normalizer → Phase3Executor → ChatGPT Web → 协议响应编码。
- ✅ `linux/amd64` Docker、`/data` Bind Mount、非 root `PUID/PGID`、Xvfb full Chromium 和按需 noVNC maintenance overlay。
- ✅ `CHATGPT_PROXY_SERVER` 可选代理贯穿 normal / maintenance / inspect / real E2E；代理 URL 不允许内嵌凭据。
- ✅ Node 24 `node:sqlite` 单连接、checksum migration、WAL、foreign keys、busy timeout。
- ✅ Conversation / Message / Tool Call / Attachment / File / Generated Image Repository。
- ✅ `ConversationStore` 完整 aggregate 单事务保存/加载与 close → reopen 恢复。
- ✅ BrowserManager / bounded Page Pool、Selector Registry、Auth Probe、Completion Observer、Fresh ChatGPT Driver。
- ✅ `inspect:chatgpt` 与显式 real E2E harness；真实 authenticated Fresh 文本 E2E 已通过。
- ❌ Conversation Engine / Context Sync；Phase 4 目前仅设计与计划完成。
- ❌ `FRESH | APPEND | RESTORE | REBUILD` 产品执行状态机。
- ❌ 同 key FIFO / Page affinity / idle+LRU 回收 / sync checkpoint migration。
- ❌ 真 Streaming。
- ❌ 文件 / 图片实际解析、落盘和上传。
- ❌ Tool Calling Prompt / Parser / 执行闭环。
- ❌ ChatGPT 图片生成。
- ❌ NAS 实机部署、备份/恢复和生产运维成熟化。

**注意：Approved Scope（已批准范围）和已完成设计不代表产品能力已经实现。**

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

- ChatGPT Web only（仅 ChatGPT 网页），不调用 ChatGPT 私有 `/backend-api`。
- OpenAI Compatible API only（仅 OpenAI 兼容接口）。
- Playwright package 与官方镜像当前固定 `1.62.1`；当前正式运行基线为 Node 24 / `linux/amd64`。
- API Adapter 共享 `NormalizedRequest`；不得各自实现浏览器逻辑。
- 配置集中在 `src/config/`；业务模块不得分散读取 `process.env`。
- SQLite 访问集中在 `src/persistence/`；其他产品模块不得导入 `node:sqlite`。
- Persistence 使用 UUID v4、Unix 毫秒、关系型核心 + JSON `TEXT`；`ConversationStore` 是完整 aggregate 恢复边界。
- 正常 `UI_MODE=headless` 实际运行 Xvfb + full Playwright Chromium `headless:false`，不启动/发布 noVNC；maintenance 使用固定 Google Chrome Stable 并与产品 BrowserManager 互斥占用 Profile。
- Phase 3 使用一个 Persistent BrowserContext + bounded Page Pool；Page Pool 当前不理解 Conversation identity。
- `X-Conversation-Key` 当前仍由 Phase3Executor 返回 `conversation_sync_not_implemented`；Phase 4 实施完成前不能声称可续接。
- Phase 4 已批准：无 key 不隐式绑定；keyed request 同时支持 full-history 与 single-user incremental；同 key FIFO；SQLite 最小 clean/in_flight checkpoint；Page affinity + 30 分钟 idle timeout + capacity-pressure LRU；`FRESH | APPEND | RESTORE | REBUILD` 遵循“能证明一致才 APPEND，否则 REBUILD”。
- Phase 4 FRESH/REBUILD 使用单次 Context Envelope，不逐轮 replay 历史；RESTORE 只恢复 URL 后 APPEND。
- Phase 4 persisted restore URL 必须限制到安全 `https://chatgpt.com` 非 root Conversation 路径；auth/selector/browser error 不得被吞成 `not_restorable`。
- Streaming 后续仍保持约 200ms DOM polling + Stable Prefix 方向。

详细 Phase 4 设计见 [`superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md`](superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md)。

## Recent Milestones（最近里程碑）

- 2026-08-15：完成 Phase 4 implementation plan：13 个独立 TDD Task 覆盖 checkpoint migration、pure planner、FIFO、Page affinity/LRU、Driver restore、Conversation Engine、runtime、Docker smoke、真实 APPEND/RESTORE/REBUILD E2E 和最终项目回写。
- 2026-08-15：批准 Phase 4 Conversation + Context Sync 设计：无 key 不做隐式身份；key 同时支持 full/incremental；分叉、instructions 变化、RESTORE 不可恢复和 sync uncertainty 统一 REBUILD；同 key FIFO；SQLite 最小 checkpoint；Page affinity idle+LRU；FRESH/REBUILD 单次 Context Envelope。
- 2026-08-15：Phase 3 真实验收完成：独立 Profile 人工登录后，authenticated inspect、Fresh Driver challenge 和 Gateway HTTP challenge 均通过。
- 2026-08-15：maintenance 人工登录路径切换到固定 Google Chrome Stable，并完成 sandbox/seccomp、Profile mode-switch 和 noVNC RFB 握手验证。
- 2026-08-14：Phase 2 SQLite / Conversation persistence 完成并通过确定性恢复与 Docker restart 持久性验证。
- 2026-08-14：Phase 1 工具链、协议模型、正式 Docker 运行边界完成。

## Next Steps（下一步）

1. 执行 Phase 4 Plan Task 1：`002_add_conversation_sync_checkpoint.sql` + Persistence checkpoint 红→绿闭环。
2. 按活动计划依次实施 pure Context Planner、FIFO、Page affinity/LRU、Driver restore、Conversation Engine 和 runtime wiring。
3. 确定性 `verify` / Docker smoke 完成后，显式运行 keyed APPEND、Gateway restart RESTORE、divergence REBUILD 的真实 ChatGPT E2E。
4. 只有真实 E2E 全部通过后才关闭 Phase 4，并进入 Phase 5 Streaming 设计。

## Known Risks（已知风险）

- Phase 4 尚未实现；当前 POST 端点仍只有 Phase 3 Fresh 非流式纯文本能力。
- Phase 4 sync checkpoint 用于未知网页副作用后的确定性收敛，不提供跨进程 exactly-once；V1 仍只有单 Gateway / Browser owner。
- 无 key Conversation 按已批准设计会持久化但不自动续接；Phase 4 不提供 retention/GC。
- REBUILD 会留下旧 ChatGPT server-side Conversation orphan；不通过私有 API 或自动网页清理删除。
- ChatGPT DOM、Cloudflare、认证和 Conversation URL 都是外部变化面；Phase 4 APPEND/RESTORE/REBUILD 只有真实 E2E 才能最终证明。
- maintenance Chrome / 产品 Chromium 升级后仍需重新验证 Profile 兼容与 real E2E。
- 当前 Docker 验收矩阵只有 `linux/amd64`，未验证 ARM64。
- Tool Calling 是 Gateway Prompt + Parser 模拟层，不应伪装成 ChatGPT Web 原生工具协议。
