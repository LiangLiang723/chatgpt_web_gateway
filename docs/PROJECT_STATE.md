# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-6-complete
STATUS=phase-6-finalizing
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-18-phase-6-attachments-files.md
NEXT_TASK=commit-phase-6-final-writeback
UPDATED_AT=2026-08-26
```

## Snapshot（快照）

- **当前阶段：** Phase 6 — 图片和文件输入的产品能力与真实网页验收已经完成；当前只剩 Task 10 branch/documentation 收尾。
- **当前状态：** `phase-6-finalizing`。Task 1–9 已完成，Task 10 的事实回写与 fresh final verify 已通过；下一步是 staged inspection、提交和 push，这些 Git 收尾完成后进入 Phase 7 Tool Calling 设计。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。
- **Active Plan：** [`docs/superpowers/plans/2026-08-18-phase-6-attachments-files.md`](superpowers/plans/2026-08-18-phase-6-attachments-files.md)。
- **最新 deterministic 证据：** 2026-08-26 real-web 修复后 fresh `corepack pnpm verify` 通过 **72 test files / 495 tests**；format、ESLint、TypeScript、build、Project Memory、Docs、Architecture、Version 全通过，`git diff --check` 无输出。
- **最新 Docker 证据：** Phase 6 Task 8 fresh `linux/amd64` build digest `sha256:4726ee0cd39e641941385887ec44346aceb6641a190689fa188ec87764426558`，full `docker:smoke` 通过 migration `001/002/003`、Files restart lifecycle、PUID/PGID writeability 与既有 Browser/noVNC/seccomp 回归。
- **最新真实网页证据：** 2026-08-26 最终 combined Phase 3/4/5/6 real E2E 单进程退出码 **0**。结果为 Phase 3 `gatewayChallenge=true`；Phase 4 `append/restore/rebuild=true`；Phase 5 `chatCompletions/markdown/responses/abort=true`；Phase 6 `imageDataUrl/imageFileId/txt/pdf/docx/xlsx/append/restore/streaming=true`。

## Implemented Now（当前已实现）

### 仓库与运行基础

- ✅ Living Repository：`AGENTS.md`、Project Memory、Architecture/API/Testing/Roadmap、spec/plan 工作流和可执行治理检查。
- ✅ TypeScript / Fastify / TypeBox/Ajv / Vitest 工具链；`corepack pnpm verify` 是确定性总入口。
- ✅ 正式 `linux/amd64` Docker 运行边界、Playwright Chromium、Xvfb 产品模式、按需 noVNC maintenance Google Chrome Stable、非 root `PUID/PGID`、`/data` Bind Mount。
- ✅ Node 24 `node:sqlite` 单连接持久化、checksum migrations `001/002/003`、Conversation aggregate / File metadata / Blob lifecycle 与 restart 恢复。
- ✅ BrowserManager、bounded Page Pool、Conversation Page affinity、idle timeout、LRU idle eviction、Browser Profile single-owner 与显式 ChatGPT proxy 边界。
- ✅ `corepack pnpm project:status`、standalone Phase E2E、combined 二次 opt-in、单主会话与 real-E2E 请求退避规则。

### API / Conversation / Streaming

- ✅ `GET /health`、`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`。
- ✅ Gateway Bearer API Key；`/health` 免认证，`/v1/*` 默认认证。
- ✅ 两套协议共享 `NormalizedRequest`、`X-Conversation-Key` 与统一 Conversation Engine。
- ✅ Phase 4 `FRESH | APPEND | RESTORE | REBUILD`、full-history / incremental、same-key FIFO、different-key parallel、SQLite `clean | in_flight` checkpoint、安全 Conversation URL restore/rebuild。
- ✅ Phase 5 True Streaming：Chat Completions SSE、Responses typed SSE、backpressure、client abort/Stop、final-clean-before-terminal、target Assistant ownership 与 completion marker。
- ✅ Stable Prefix 当前默认 **64 Unicode code points commit-tail holdback**。2026-08-26 real E2E 观测到 38-code-point Markdown renderer 尾部回排，因此从 16 提升为 64；如果 rewrite 穿过已 committed prefix，仍返回 `chatgpt_stream_diverged`，不撤回已发 SSE。
- ✅ Driver 在 Composer `fill()` 后等待 strict unique Send readiness；不会错误要求 Assistant 完成后的空 Composer 必须仍暴露 Send control。

### Phase 6 Files / Attachments

- ✅ migration 003：logical File 与 content-addressed SHA-256 Blob 分离；相同 bytes 可共享 Blob 而保留独立 File identity。
- ✅ `/v1/files` 五接口：multipart streaming create、list、retrieve、content、delete，支持 restart recovery。
- ✅ DELETE 立即撤销公开访问；历史 Conversation Attachment 仍引用时可保留内部 File/Blob bytes 以支持 REBUILD/恢复，不承诺立即 secure erase。
- ✅ Attachment Resolver：URL/Data URL/Base64/public `file_id` → Gateway-owned File；strict image signature/MIME、SSRF/DNS/redirect/pinned-address、32 MiB 单附件/64 MiB 请求/16 attachments、敏感 source redaction 与 request staging。
- ✅ ordered multimodal canonical content/fingerprint；FRESH/REBUILD 重传完整有效附件，APPEND/RESTORE 只上传当前新增附件。
- ✅ ChatGPT upload Driver：owned preview baseline、pending/ready/error、exact owned upload readiness、abort/timeout/error 语义，Send 晚于全部 owned attachments ready。
- ✅ Conversation attachment lifecycle：resolve/lease/stage/checkpoint/upload/final Attachment → File → Blob linkage，stream/non-stream 共享 Phase 5 target-turn/Streaming 核心。
- ✅ Chat Completions 支持 image URL/Data URL、`file.file_data`、`file.file_id`；Responses 支持 `input_image.image_url/file_id`、`input_file.file_data/file_id`。
- ✅ authenticated real E2E 已证明 Data URL image、image `file_id`、TXT/PDF/DOCX/XLSX、same-key APPEND、runtime restart RESTORE 与 attachment Streaming；最终 combined Phase 3/4/5/6 也已通过。

### 后续未实现能力

- ❌ Tool Calling Prompt / Parser / Tool Result 执行闭环（Phase 7）。
- ❌ Structured Output execution。
- ❌ ChatGPT 图片生成 / `POST /v1/images/generations`（Phase 8）。
- ❌ NAS 实机部署、备份/恢复和生产运维成熟化（后续 Phase）。

## Architecture Facts（当前关键架构事实）

- ChatGPT Web only；不使用私有 `/backend-api`。
- OpenAI Compatible API only；默认模型只暴露 `chatgpt-web`。
- `api/` 不实现浏览器 DOM 逻辑；`chatgpt/` 不理解 OpenAI SSE；`attachments/` 不依赖 Playwright/API/ChatGPT；`stream/` 不依赖 Playwright/API/Browser/ChatGPT/Persistence/SQLite。
- SQLite 是 Conversation/File 恢复事实来源；Page 是可丢弃运行时缓存；same-key Queue 是单进程 Conversation 写序列化边界。
- Browser upload 是 Conversation side effect；checkpoint 必须先成为 `in_flight`。未知 post-checkpoint failure 保持 `in_flight` 并由下一请求 REBUILD 收敛。
- Streaming 只承诺 Stable Prefix，已经发送给客户端的 prefix 不撤回；成功 terminal 晚于 final SQLite clean commit。
- Docker 是正式运行边界；Docker smoke 不能替代 authenticated ChatGPT E2E。

## Recent Milestones（最近里程碑）

- 2026-08-26：最终 combined Phase 3/4/5/6 authenticated real E2E 退出码 0，全阶段断言通过；Phase 6 产品验收门槛关闭。
- 2026-08-26：真实网页发现并修复 Markdown **38 code-point** 尾部回排（默认 holdback 16 → 64）与 Composer fill 后 Send 短暂未挂载竞态；fresh verify 72 files / 495 tests 全绿。
- 2026-08-26：Task 9A 完成 real-E2E/session recovery hardening：`project:status`、standalone Phase 3、combined 二次 opt-in、四组 Phase 6 conversation budget 与请求退避规则。
- 2026-08-21：standalone Phase 6 authenticated real E2E 已通过图片、TXT/PDF/DOCX/XLSX、APPEND/RESTORE 与 Streaming。
- 2026-08-19：Phase 6 Task 8 fresh `linux/amd64` Docker build/smoke 完成，验证 migration 003 与 Files restart lifecycle。

## Next Steps（下一步）

1. 完成 Task 10 staged inspection。
2. 提交 Phase 6 最终文档/Project Memory 回写并 push `phase-6-attachments`。
3. Git 收尾完成后将 `ACTIVE_PLAN` 置 `none`，进入 Phase 7 Tool Calling 设计。

## Known Risks / Limits（已知风险 / 限制）

- ChatGPT DOM、Cloudflare、认证、上传格式支持与网页限流仍是外部变化面；后续 Phase 必须独立 real E2E，不能从 Phase 6 外推。
- Stable Prefix 的 64-code-point holdback 只吸收当前 bounded tail rewrite；更深 rewrite 穿过 committed prefix 仍会 `chatgpt_stream_diverged`。
- Remote URL image 产品路径已实现并有 deterministic SSRF/DNS/redirect/pinned-address coverage；本轮没有稳定公网 fixture，因此**未执行 live remote-fetch E2E**。
- REBUILD historical attachments 通过 synthetic Context Envelope 重新附着，是明确兼容近似，不等价于原生 OpenAI item storage。
- Files DELETE 不是立即 secure erase：历史 Attachment 引用可延长内部 bytes 生命周期。
- 当前 Docker 验收矩阵仍只有 `linux/amd64`，未验证 ARM64。
