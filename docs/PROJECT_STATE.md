# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-6-implementation
STATUS=implementing-phase-6
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-18-phase-6-attachments-files.md
NEXT_TASK=implement-phase-6-task-5-chatgpt-upload-driver
UPDATED_AT=2026-08-18
```

## Snapshot（快照）

- **当前阶段：** Phase 6 — 图片和文件输入已进入实现阶段；公开附件能力仍未完成验收。
- **当前状态：** `implementing-phase-6`。Active Plan Task 1/2/3/4 已完成：File/Blob storage、Files API、Attachment Resolver/security/staging 与 ordered multimodal Context/四-mode upload selection 已通过 deterministic verification；当前进入 Task 5 authenticated DOM inspection + ChatGPT upload Driver。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。该设计锁定 Files API、Blob/File 分离、Attachment Resolver、安全 URL 获取、multimodal Context Sync、ChatGPT upload readiness 与真实 E2E 验收边界。
- **Active Plan：** [`docs/superpowers/plans/2026-08-18-phase-6-attachments-files.md`](superpowers/plans/2026-08-18-phase-6-attachments-files.md)。按 10 个可独立验收 Task 执行，计划状态必须随真实进展回写。
- **下一个可执行任务：** Task 5 — authenticated attachment DOM inspection + ChatGPT upload Driver；canonical Context 已能表达附件语义并选择 FRESH/REBUILD 全集与 APPEND/RESTORE 当前附件，但 Driver selector/readiness 尚未实测。
- **最新完整确定性/Docker 证据：** 2026-08-17 在真实 DevSpace checkout 上 fresh `corepack pnpm verify` 全绿：55 个 test files / 332 tests，Prettier、ESLint、TypeScript、build、Project Memory、Docs、Architecture、Version 全通过。随后 fresh `linux/amd64` Docker build 与完整 `docker:smoke` 通过，最终本地镜像 digest 为 `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0`；这是 Phase 5 最终证据。
- **Phase 6 最新确定性证据：** 2026-08-18 Task 4 multimodal Context 改动后 fresh `corepack pnpm verify` 全绿：64 test files / 454 tests，Prettier、ESLint、TypeScript、build、Project Memory、Docs、Architecture、Version 全通过，`git diff --check` 通过。纯文本 canonical/prompt/Planner 形状保持回归，多模态 fingerprint 排除 request-local reference/source，upload selection 覆盖 FRESH/APPEND/RESTORE/REBUILD。Phase 6 Docker 与真实 ChatGPT attachment E2E 尚未执行。
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

### Phase 6 实现中

- ✅ Task 1 storage foundation：`003_add_file_blob_lifecycle`、逻辑 File / 物理 Blob 分离、SHA-256 去重、原子 temp→Blob 写入、32 MiB File 上限、public/private File identity、进程内 lease、DELETE tombstone/deferred GC 与 orphan cleanup 已实现并通过确定性测试。
- ✅ Task 2 Files API：`POST/GET/list/content/DELETE /v1/files` 已实现，multipart 文件流不使用 `toBuffer()`；支持 purpose、after/limit/order filter、跨 runtime restart content recovery、public/private 隔离和 DELETE retained-history 语义基础。
- ✅ Task 3 Attachment Resolver：strict Base64/Data URL、PNG/JPEG/WEBP/GIF signature sniff、public `file_id` lease、URL DNS/IP/redirect SSRF guard、32/64 MiB limits、敏感 source redaction、collision-safe request staging 与 hardlink→copy fallback 已实现并通过确定性测试。
- ✅ Task 4 multimodal Context：含附件 message 使用 ordered canonical `content[]`，纯文本继续保持既有 `{role,text}` fingerprint/plan 形状；attachment semantic fingerprint 仅使用 kind/SHA-256/filename/MIME，prompt 只暴露 kind/filename/upload_filename；FRESH/REBUILD 与 APPEND/RESTORE upload reference selection 已有确定性测试。
- ❌ ChatGPT 网页上传/readiness、Conversation attachment lifecycle 与附件 real E2E 尚未实现/验收。

### 后续未实现能力
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

- 2026-08-18：Phase 6 Task 4 完成：canonical Conversation 支持 ordered multimodal content，同时保持 text-only 既有 shape；attachment fingerprint 排除 request-local identity，Planner 四种 mode 不变并得到 FRESH/REBUILD 全附件、APPEND/RESTORE 当前附件 upload selection；fresh `corepack pnpm verify` 64 files / 454 tests 全绿，下一步 authenticated upload DOM inspection。
- 2026-08-18：Phase 6 Task 3 完成：Attachment Resolver 已支持 URL/Data URL/Base64/public `file_id` → Gateway-owned File，新增严格图片 signature/MIME 验证、SSRF/DNS/redirect/pinned-address 安全边界、16 附件/64 MiB 请求上限与 request-scoped staging；fresh `corepack pnpm verify` 63 files / 445 tests 全绿，下一步 multimodal Context。
- 2026-08-18：Phase 6 Task 2 完成：五个 `/v1/files` endpoint 接通 exact `@fastify/multipart@10.1.0` streaming upload、public File pagination/retrieve/content/delete 和 runtime restart recovery；fresh `corepack pnpm verify` 59 files / 361 tests 全绿，下一步 Attachment Resolver/security/staging。
- 2026-08-18：Phase 6 Task 1 完成：新增 migration 003，将 Phase 2 `files` 迁移为 logical File + content-addressed `file_blobs`，并实现原子 FileService、SHA-256 物理去重、public/private logical identity、lease/tombstone/deferred GC 与 orphan cleanup；full test 57 files / 342 tests 通过。
- 2026-08-17：Phase 6 图片和文件输入设计完成。规格锁定 `/v1/files` 生命周期、逻辑 File/物理 SHA-256 Blob 分离、URL/Data URL/Base64/`file_id` 统一解析、SSRF/文件名/大小安全边界、ordered multimodal Context fingerprint、FRESH/REBUILD 全有效附件重传与 APPEND/RESTORE 当前附件上传、Browser upload ownership/readiness、DELETE 历史引用保留语义，以及 image + PDF/TXT/DOCX/XLSX authenticated real E2E 门槛；实现尚未开始。
- 2026-08-17：Phase 5 authenticated real Streaming 验收在真实 DevSpace 完成。真实 DOM 暴露并通过 TDD 修复了 Fresh `/c/WEB:*` provisional route、APPEND 临时 Assistant placeholder、Markdown renderer 短尾回排、writing-block 多正文边界，以及 conversation-history rate-limit 通知 overlay；未扩展附件/Tool/Structured Output/image execution。
- 2026-08-17：fresh `corepack pnpm verify` 通过 55 files / 332 tests；fresh `linux/amd64` Docker build digest `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0` 与完整 smoke 通过。authenticated `inspect:chatgpt`、standalone Phase 5 real E2E、combined Phase 3/4/5 real E2E 随后全部通过，Phase 5 正式关闭。
- 2026-08-16：Phase 5 True Streaming 产品链实现完成：Stable Prefix、target turn handle/completion、Conversation streaming lifecycle、双 SSE Encoder、backpressure、abort/Stop、FRESH/APPEND/RESTORE/REBUILD Streaming 集成和真实 E2E harness 全部落地。
- 2026-08-16：Phase 4 真实验收完成；combined real E2E 通过 Phase 3 regression、APPEND live DOM、restart RESTORE 与 divergence REBUILD，并修复全局 Stop control 滞留导致的 Completion 假超时。

## Next Steps（下一步）

1. 执行 Active Plan Task 5：先扩展 deterministic inspection contract，再使用隔离已登录 Profile 实测 ChatGPT attachment input/preview/readiness；只有实测后才锁 Selector 并实现 Driver upload。
2. 随后按计划完成 Conversation attachment lifecycle、跨协议 deterministic integration、Docker 与 authenticated real E2E。
3. 实现完成后运行 fresh deterministic、Docker 与独立登录 Profile authenticated real Phase 6 E2E；只有 image + PDF/TXT/DOCX/XLSX 等真实上传通过后才关闭 Phase 6。

## Known Risks / Blockers（已知风险 / 阻塞）

- Phase 6 当前没有已知实现 blocker；具体 ChatGPT attachment input / preview / readiness Selector 仍必须在 Task 5 先通过 authenticated `inspect:chatgpt` 实测，不能根据设计猜测。
- ChatGPT DOM、Cloudflare、认证和网页限流提示仍属于外部变化面；后续 Phase 不能从本次 Phase 5 通过外推其真实网页能力。
- Stable Prefix 选择“不撤回”语义：16-code-point tail holdback 只吸收 bounded renderer 尾部回排；如果 DOM 重写穿过已发 prefix，请求仍会失败并保持 `in_flight`，下一 keyed request REBUILD。
- 当前 Docker 验收矩阵仍只有 `linux/amd64`，未验证 ARM64。
- Tool Calling、附件和图片能力仍必须各自经过后续 deterministic + real E2E，不能从 Phase 5 基础设施外推。
