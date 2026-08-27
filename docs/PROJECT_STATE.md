# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-7-implementation
STATUS=phase-7-real-e2e-blocked
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-26-phase-7-tool-calling-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-26-phase-7-tool-calling.md
NEXT_TASK=restore-chatgpt-proxy-and-run-phase7-real-e2e
UPDATED_AT=2026-08-27
```

## Snapshot（快照）

- **当前阶段：** Phase 7 — Tool Calling implementation candidate 已完成，等待 authenticated real ChatGPT acceptance。
- **当前状态：** `phase-7-real-e2e-blocked`。Tool Calling 产品代码、deterministic coverage、Docker build/smoke 与 standalone/combined E2E harness 已完成；fresh `inspect:chatgpt` 因既有 LAN proxy connection refused 在网页加载前失败，因此 Phase 7 尚未关闭。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-26-phase-7-tool-calling-design.md`](superpowers/specs/2026-08-26-phase-7-tool-calling-design.md)。
- **Active Plan：** [`docs/superpowers/plans/2026-08-26-phase-7-tool-calling.md`](superpowers/plans/2026-08-26-phase-7-tool-calling.md)。保持 active，剩余 acceptance 从 network restore → inspect → standalone Phase 7 → combined Phase 3→7 收敛。
- **最新 deterministic 证据：** 2026-08-27 fresh `corepack pnpm verify` 通过 **78 test files / 537 tests**；format、ESLint、TypeScript、build、Project Memory、Docs、Architecture、Version 全通过。
- **最新 Docker 证据：** 2026-08-27 fresh `linux/amd64` image ID `sha256:7a74ac01608619baf130b765ba2b82b54f1262b971f2ac3fc1f97d7bcc882499`，full `docker:smoke` 通过 migration `001/002/003`、Files restart lifecycle、PUID/PGID writeability 与既有 Browser/noVNC/seccomp 回归。
- **最新真实网页证据：** 已通过的最新产品证据仍是 2026-08-26 combined Phase 3/4/5/6 real E2E 单进程退出码 **0**。2026-08-27 Phase 7 fresh inspect 使用既有隔离 re-auth Profile 与已批准 `http://192.168.3.163:7890` proxy，但 `page.goto` 前即失败为 `ERR_PROXY_CONNECTION_FAILED`；TCP 诊断确认 proxy connection refused。随后复查 DevSpace direct `chatgpt.com:443` 为 network unreachable。因而 standalone Phase 7 / combined Phase 3→7 **未运行**。

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

### Phase 7 Tool Calling implementation candidate

- ✅ function Tool definitions canonicalization + SHA-256 fingerprint；tool declaration order 不触发 REBUILD，name/description/parameters 变化触发 `REBUILD(reason='tools_changed')`。
- ✅ `tool_choice=auto|none|required|function` validation；built-in/MCP/custom/freeform tools 不在 Phase 7 范围。
- ✅ Context/Append Prompt v2 + 固定 private sentinel protocol + strict Parser；Tool Result output 作为不可信 data field，普通 prompt 不再加入无必要的 Gateway/agent 身份话术。
- ✅ first-class canonical assistant Tool Call / tool-result messages，pending turn 支持 one user 或 one-or-more consecutive tool results；unknown/duplicate/mixed tail 按稳定 `invalid_conversation_request` 拒绝。
- ✅ Gateway-owned `call_<32 hex>` external ID、SQLite `messages` + `tool_calls` persistence、restart round-trip 与 prefix identity reuse；Gateway 不执行 caller-defined functions。
- ✅ non-stream shared execution result 支持 text/tool_calls；Chat Completions 映射 `content:null` + `tool_calls` + `finish_reason=tool_calls`，Responses 映射 completed `function_call` items。
- ✅ tool-aware Streaming：`ToolDetectionBuffer` 在 Stable Prefix 后阻止 private sentinel/JSON 泄漏；text 保持 true streaming，tool arguments 在 generation complete 后安全缓冲解析，再输出协议级 chunks/events。
- ✅ Phase 7 stable errors：`chatgpt_tool_required`、`chatgpt_tool_protocol_invalid`、`chatgpt_tool_unknown`、`chatgpt_tool_forbidden`、`unsupported_phase7_request`；post-SSE error 不发送成功 terminal。
- ✅ standalone Phase 7 与 combined Phase 3→7 E2E harness 已实现；**尚未取得 authenticated live pass 证据**。

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

### 后续未实现能力 / 未关闭验收

- ⏳ Phase 7 Tool Calling authenticated real ChatGPT E2E acceptance：代码和本地/Docker验证已完成，当前受 proxy 网络阻塞。
- ❌ Structured Output execution。
- ❌ ChatGPT 图片生成 / `POST /v1/images/generations`（Phase 8）。
- ❌ NAS 实机部署、备份/恢复和生产运维成熟化（后续 Phase）。

## Architecture Facts（当前关键架构事实）

- ChatGPT Web only；不使用私有 `/backend-api`。
- OpenAI Compatible API only；默认模型只暴露 `chatgpt-web`。
- `api/` 不实现浏览器 DOM 逻辑；`chatgpt/` 不理解 OpenAI SSE；`attachments/` 不依赖 Playwright/API/ChatGPT；`stream/` 不依赖 Playwright/API/Browser/ChatGPT/Persistence/SQLite。
- SQLite 是 Conversation/File 恢复事实来源；Page 是可丢弃运行时缓存；same-key Queue 是单进程 Conversation 写序列化边界。
- Browser upload 是 Conversation side effect；checkpoint 必须先成为 `in_flight`。未知 post-checkpoint failure 保持 `in_flight` 并由下一请求 REBUILD 收敛。
- Streaming 只承诺 Stable Prefix，已经发送给客户端的 prefix 不撤回；成功 terminal 晚于 final SQLite clean commit。存在 tools 时 ToolDetectionBuffer 只允许已分类的公开 text 进入 SSE，private protocol 不外泄。
- Tool definitions/result 均按不可信数据处理；Gateway 只翻译/持久化 Tool Call，不执行 caller-defined function、Shell、HTTP 或插件。
- Docker 是正式运行边界；Docker smoke 不能替代 authenticated ChatGPT E2E。

## Recent Milestones（最近里程碑）

- 2026-08-27：Phase 7 implementation candidate 完成；fresh verify 78 files / 537 tests 全绿，fresh linux/amd64 image `sha256:7a74ac01608619baf130b765ba2b82b54f1262b971f2ac3fc1f97d7bcc882499` 与 full Docker smoke 通过。
- 2026-08-27：Phase 7 fresh authenticated inspect 被外部网络阻塞：既有 `192.168.3.163:7890` proxy connection refused，最新 DevSpace direct HTTPS 复查为 network unreachable；按 real-E2E 退避规则未继续 standalone/combined 请求，Phase 7 保持 active 未关闭。
- 2026-08-26：建立 Phase 7 Tool Calling Governing Spec 与 10-Task implementation plan，进入 `implementing-phase-7`；Task 1 从 canonical tool context / Prompt / strict Parser 开始。
- 2026-08-26：建立 Phase 7 Tool Calling Governing Spec，锁定私有 Tool Protocol、严格 Parser、tool fingerprint / REBUILD、Tool Result continuation、tool-aware Streaming 与两套 OpenAI-compatible 输出边界。
- 2026-08-26：最终 combined Phase 3/4/5/6 authenticated real E2E 退出码 0，全阶段断言通过；Phase 6 产品验收门槛关闭。
- 2026-08-26：真实网页发现并修复 Markdown **38 code-point** 尾部回排（默认 holdback 16 → 64）与 Composer fill 后 Send 短暂未挂载竞态；fresh verify 72 files / 495 tests 全绿。
- 2026-08-26：Task 9A 完成 real-E2E/session recovery hardening：`project:status`、standalone Phase 3、combined 二次 opt-in、四组 Phase 6 conversation budget 与请求退避规则。
- 2026-08-21：standalone Phase 6 authenticated real E2E 已通过图片、TXT/PDF/DOCX/XLSX、APPEND/RESTORE 与 Streaming。
- 2026-08-19：Phase 6 Task 8 fresh `linux/amd64` Docker build/smoke 完成，验证 migration 003 与 Files restart lifecycle。

## Next Steps（下一步）

1. 恢复一个 DevSpace 可达的 ChatGPT proxy/network path；不要重复请求当前已明确 connection-refused 的 `192.168.3.163:7890`。
2. 复用现有隔离 re-auth E2E Profile，先运行 fresh `corepack pnpm inspect:chatgpt` 并要求 authenticated + unique Composer。
3. inspect 通过后运行 standalone `test:e2e:chatgpt:phase7`；全部七组语义断言通过后才运行 combined Phase 3→7。
4. combined 通过后重新 fresh verify/docs/diff，关闭 Active Plan 并进入 Phase 8 design；在此之前不设置 `PHASE=phase-7-complete`。

## Known Risks / Limits（已知风险 / 限制）

- **当前 acceptance blocker：** 2026-08-27 `192.168.3.163:7890` TCP connection refused；最新 DevSpace direct `chatgpt.com:443` 复查为 network unreachable。该 blocker 在 Browser DOM/Auth 检查之前发生，不能据此判断当前 Profile 登录或 Phase 7 网页协议行为是否有效。
- ChatGPT DOM、Cloudflare、认证、上传格式支持与网页限流仍是外部变化面；Phase 7 必须独立 real E2E，不能从 Phase 6 外推。
- Stable Prefix 的 64-code-point holdback 只吸收当前 bounded tail rewrite；更深 rewrite 穿过 committed prefix 仍会 `chatgpt_stream_diverged`。
- Remote URL image 产品路径已实现并有 deterministic SSRF/DNS/redirect/pinned-address coverage；本轮没有稳定公网 fixture，因此**未执行 live remote-fetch E2E**。
- REBUILD historical attachments 通过 synthetic Context Envelope 重新附着，是明确兼容近似，不等价于原生 OpenAI item storage。
- Files DELETE 不是立即 secure erase：历史 Attachment 引用可延长内部 bytes 生命周期。
- 当前 Docker 验收矩阵仍只有 `linux/amd64`，未验证 ARM64。
