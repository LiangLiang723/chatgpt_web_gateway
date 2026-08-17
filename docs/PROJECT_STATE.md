# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-6-design-complete
STATUS=ready-for-phase-6-plan
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md
ACTIVE_PLAN=none
NEXT_TASK=write-phase-6-implementation-plan
UPDATED_AT=2026-08-17
```

## Snapshot（快照）

- **当前阶段：** Phase 6 — 图片和文件输入设计已完成；代码实现尚未开始。
- **当前状态：** `ready-for-phase-6-plan`。Phase 5 仍保持完整验收事实；Phase 6 已锁定 Files API、Blob/File 分离、Attachment Resolver、安全 URL 获取、multimodal Context Sync、ChatGPT upload readiness 与真实 E2E 验收边界。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。该设计已批准进入实施计划阶段，但尚未实现。
- **Active Plan：** `none`。下一步先建立 Phase 6 implementation plan，再按 Task 进入 TDD 实现。
- **下一个可执行任务：** 编写 Phase 6 图片和文件输入实施计划；计划建立前不把附件能力标为已实现。
- **最新确定性/Docker 证据：** 2026-08-17 在真实 DevSpace checkout 上 fresh `corepack pnpm verify` 全绿：55 个 test files / 332 tests，Prettier、ESLint、TypeScript、build、Project Memory、Docs、Architecture、Version 全通过。随后 fresh `linux/amd64` Docker build 与完整 `docker:smoke` 通过，最终本地镜像 digest 为 `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0`；migration 仍仅 `001_initial` + `002_add_conversation_sync_checkpoint`。
- **真实网页证据：** 2026-08-17 复用项目隔离已登录 Profile 与 `CHATGPT_PROXY_SERVER` 后，`inspect:chatgpt` 实际得到 `auth=authenticated` / `composer=unique`；standalone `test:e2e:chatgpt:phase5` 返回 Chat Completions / Markdown / Responses / abort 全部 `true`；随后 combined `test:e2e:chatgpt` 返回 Phase 3 auth/driver/gateway challenge、Phase 4 APPEND/RESTORE/REBUILD、Phase 5 四项 Streaming 场景全部通过。

## Implemented Now（当前已实现）

### 仓库与运行基础

- ✅ Living Repository：`AGENTS.md`、Project Memory、Architecture/API/Testing/Roadmap、spec/plan 工作流和可执行治理检查。
- ✅ TypeScript / Fastify / TypeBox/Ajv / Vitest 工具链；`corepack pnpm verify` 是确定性总入口。
- ✅ 正式 `linux/amd64` Docker 运行边界、Playwright Chromium、Xvfb 产品模式、按需 noVNC maintenance Google Chrome Stable、非 root `PUID/PGID`、`/data` Bind Mount。
- ✅ Node 24 `node:sqlite` 单连接持久化、checksum migrations、Conversation aggregate / File metadata 持久化和 restart 恢复。
- ✅ BrowserManager、bounded Page Pool、Conversation Page affinity、idle timeout、LRU idle eviction 与 Browser Profile single-owner 边界。
- ✅ Selector Registry、Auth Probe、显式 `inspect:chatgpt` / real E2E safety gate 与可选 `CHATGPT_PROXY_SERVER`。

### API / Conversation

- ✅ `GET /health`、`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` 的当前文本执行链。
- ✅ Gateway Bearer API Key；`/health` 免认证，`/v1/*` 默认认证。
- ✅ 两套协议共享 `NormalizedRequest`、`X-Conversation-Key` 与统一 Conversation Engine，不在 route 中复制浏览器逻辑。
- ✅ Phase 4 `FRESH | APPEND | RESTORE | REBUILD`、full-history / single-user incremental、same-key FIFO、different-key parallel、SQLite `clean | in_flight` checkpoint、安全 ChatGPT Conversation URL restore/rebuild。
- ✅ ChatGPT Driver 使用发送前 Assistant baseline 锁定本请求 target turn；target-turn `copy-turn-action-button` completion marker 是当前完成主证据，不依赖可能滞留的全局 Stop control。

### Phase 5 True Streaming 代码

- ✅ `src/stream/` 纯逻辑层：CRLF/CR normalization、Unicode code-point-safe longest common prefix、3-sample Stable Prefix、默认 16 Unicode code points commit-tail holdback、target disappearance / committed-prefix rewrite divergence、约 200ms 默认 polling、120s completion timeout；最终 completion 精确 flush 被保留尾部。
- ✅ ChatGPT Driver `ChatGptTextTurn`：`observe()` / `stop()` / safe `conversationUrl()`；non-stream `sendText()` 与 stream 复用 target-turn ownership / completion semantics。真实验收进一步固化 `/c/WEB:*` provisional route 拒绝、无 `.markdown` placeholder 忽略、owned turn 唯一 `.markdown` 正文读取，以及明确 `modal-conversation-history-rate-limit` 的唯一 `Got it` 通知确认；不处理 CAPTCHA/MFA/其它 modal。
- ✅ `ChatGptTextRequest.signal` 在 baseline/composer/fill/send 等异步边界前传播取消；首个 SSE `started` 后若已断开，Engine 在 checkpoint 前退出，不产生网页 turn。
- ✅ Conversation Engine 提供 protocol-neutral `{ execute, stream }`；Streaming 继续共享 Phase 4 Planner、Page Registry、same-key Queue、checkpoint 和 final aggregate builder。
- ✅ Streaming 成功顺序为 stable deltas → final clean SQLite save → Page success → protocol success terminal；final clean save 失败不会发送成功终止。
- ✅ 生成中 client abort：best-effort Stop、no partial Assistant persistence、checkpoint 保持 `in_flight`、Page session fail；clean commit 后才发生的 terminal transport close 不 Stop/回滚已完成 turn。
- ✅ Chat Completions SSE：稳定 id/created/model、Assistant role chunk、text delta、single stop chunk、single `[DONE]`，不伪造 usage。
- ✅ Responses SSE：`response.created` / `in_progress` / item+content added / `output_text.delta` / done / `response.completed`，稳定 IDs 和单调 `sequence_number`，`usage=null`。
- ✅ Fastify Streaming transport：首个 internal `started` 才 `reply.hijack()`，raw SSE writer 支持 Node backpressure；pre-start error 保持普通 HTTP JSON，post-start error 使用流内错误且不写成功 terminal。
- ✅ Streaming 集成覆盖 FRESH、full-history APPEND、RESTORE、history-divergence REBUILD、same-key FIFO、different-key parallel、final-save failure、生成中 abort 和 pre-Send abort。
- ✅ Phase 5 real E2E harness 使用真实 TCP listener 增量读取，已真实证明长回复首个 meaningful delta 早于 target completion marker、Chat Completions terminal/单 `[DONE]`、Markdown/代码块 multiline、Responses typed lifecycle/稳定 IDs/严格 sequence、`delta concat == live authoritative DOM == SQLite`，以及 client abort 后真实 Stop、`in_flight`、Page affinity discard 与 same-key REBUILD。
- ✅ **Phase 5 authenticated real ChatGPT Streaming E2E 已于 2026-08-17 standalone 与 combined 两条命令真实通过，Phase 5 正式关闭。**

### 后续未实现能力

- ❌ 文件 / 图片实际解析、落盘和上传；`/v1/files` 产品闭环仍属于 Phase 6。
- ❌ Tool Calling Prompt / Parser / Tool Result 执行闭环。
- ❌ ChatGPT 图片生成。
- ❌ NAS 实机部署、备份/恢复和生产运维成熟化。

## Architecture Facts（当前关键架构事实）

- ChatGPT Web only；不使用私有 `/backend-api`。
- OpenAI Compatible API only；默认模型只暴露 `chatgpt-web`。
- `api/` 不实现浏览器 DOM 逻辑；`chatgpt/` 不理解 OpenAI SSE；`stream/` 不依赖 Playwright/API/Browser/ChatGPT/Persistence/SQLite。
- SQLite 是 Conversation 恢复事实来源；Page 是可丢弃运行时缓存；same-key Queue 是单进程 Conversation 写序列化边界。
- Streaming 只承诺 Stable Prefix；已经发送给客户端的 prefix 不允许撤回。DOM 重写穿过 committed prefix 时进入 `chatgpt_stream_diverged`，不发送 correction/backspace。
- Streaming 成功 terminal 晚于 final SQLite clean commit；未知 post-checkpoint failure 保持 `in_flight` 并由下一请求 REBUILD 收敛。
- Client abort 只能 best-effort Stop 当前严格归属的生成，不保存 partial Assistant。
- Docker 是正式运行边界；Docker smoke 不能替代 authenticated ChatGPT E2E。

详细架构见 [`architecture.md`](architecture.md)。

## Recent Milestones（最近里程碑）

- 2026-08-17：Phase 6 图片和文件输入设计完成。规格锁定 `/v1/files` 生命周期、逻辑 File/物理 SHA-256 Blob 分离、URL/Data URL/Base64/`file_id` 统一解析、SSRF/文件名/大小安全边界、ordered multimodal Context fingerprint、FRESH/REBUILD 全有效附件重传与 APPEND/RESTORE 当前附件上传、Browser upload ownership/readiness、DELETE 历史引用保留语义，以及 image + PDF/TXT/DOCX/XLSX authenticated real E2E 门槛；实现尚未开始。
- 2026-08-17：Phase 5 authenticated real Streaming 验收在真实 DevSpace 完成。真实 DOM 暴露并通过 TDD 修复了 Fresh `/c/WEB:*` provisional route、APPEND 临时 Assistant placeholder、Markdown renderer 短尾回排、writing-block 多正文边界，以及 conversation-history rate-limit 通知 overlay；未扩展附件/Tool/Structured Output/image execution。
- 2026-08-17：fresh `corepack pnpm verify` 通过 55 files / 332 tests；fresh `linux/amd64` Docker build digest `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0` 与完整 smoke 通过。authenticated `inspect:chatgpt`、standalone Phase 5 real E2E、combined Phase 3/4/5 real E2E 随后全部通过，Phase 5 正式关闭。
- 2026-08-16：Phase 5 True Streaming 产品链实现完成：Stable Prefix、target turn handle/completion、Conversation streaming lifecycle、双 SSE Encoder、backpressure、abort/Stop、FRESH/APPEND/RESTORE/REBUILD Streaming 集成和真实 E2E harness 全部落地。
- 2026-08-16：Phase 4 真实验收完成；combined real E2E 通过 Phase 3 regression、APPEND live DOM、restart RESTORE 与 divergence REBUILD，并修复全局 Stop control 滞留导致的 Completion 假超时。

## Next Steps（下一步）

1. 根据 Phase 6 Governing Spec 编写详细 implementation plan，并把它设为 Active Plan。
2. 按计划从 File/Blob migration + FileService 开始 TDD，不跳过 Files API、Attachment Resolver、multimodal Context 与 Browser upload readiness 的独立验证闭环。
3. 实现完成后运行 fresh deterministic、Docker 与独立登录 Profile authenticated real Phase 6 E2E；只有 image + PDF/TXT/DOCX/XLSX 等真实上传通过后才关闭 Phase 6。

## Known Risks / Blockers（已知风险 / 阻塞）

- Phase 6 当前没有设计 blocker；下一工作是实施计划。具体 ChatGPT attachment input / preview / readiness Selector 仍必须在实施阶段先通过 authenticated `inspect:chatgpt` 实测，不能根据设计猜测。
- ChatGPT DOM、Cloudflare、认证和网页限流提示仍属于外部变化面；后续 Phase 不能从本次 Phase 5 通过外推其真实网页能力。
- Stable Prefix 选择“不撤回”语义：16-code-point tail holdback 只吸收 bounded renderer 尾部回排；如果 DOM 重写穿过已发 prefix，请求仍会失败并保持 `in_flight`，下一 keyed request REBUILD。
- 当前 Docker 验收矩阵仍只有 `linux/amd64`，未验证 ARM64。
- Tool Calling、附件和图片能力仍必须各自经过后续 deterministic + real E2E，不能从 Phase 5 基础设施外推。
