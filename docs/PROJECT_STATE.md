# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-5
STATUS=phase-5-real-e2e-blocked
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md
NEXT_TASK=run-phase-5-real-streaming-e2e
UPDATED_AT=2026-08-16
```

## Snapshot（快照）

- **当前阶段：** Phase 5 — True Streaming 实现阶段；Phase 4 Conversation + Context Sync 已正式完成。
- **当前状态：** `phase-5-real-e2e-blocked`。Phase 5 产品代码、确定性验证、fresh `linux/amd64` Docker build 与完整 Docker smoke 已通过；阶段尚未关闭，因为当前工具环境无法访问项目原隔离且已登录的 ChatGPT Browser Profile / LAN proxy 来执行 authenticated real Streaming E2E。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md`](superpowers/specs/2026-08-16-phase-5-true-streaming-design.md)。用户已批准该设计。
- **Active Plan：** [`docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md`](superpowers/plans/2026-08-16-phase-5-true-streaming.md)。实现与 deterministic/Docker 任务已完成；authenticated Phase 5 / combined real E2E 保持阻塞，不能提前标记完成。
- **下一个可执行任务：** 在能够访问隔离登录 Profile 与需要的 `CHATGPT_PROXY_SERVER` 的 DevSpace 环境运行 `inspect:chatgpt`、`test:e2e:chatgpt:phase5` 和 combined `test:e2e:chatgpt`；只有它们实际通过后才能关闭 Phase 5 并进入 Phase 6 设计。
- **最新确定性/Docker 证据：** 2026-08-16 branch-head GitHub Actions 只读 check-run 成功，执行了 `corepack pnpm verify`、fresh `corepack pnpm docker:build`、image inspect 和 `corepack pnpm docker:smoke`。Docker smoke 的 normal/maintenance、SQLite、Profile single-owner、non-root/PUID/PGID、seccomp/RFB/restart 等断言均成功。
- **真实网页证据边界：** Phase 3/4 authenticated real E2E 仍有历史通过证据；Phase 5 real harness 已实现但本次没有实际运行。不得从 Phase 3/4 或 deterministic/Docker 结果外推当前 ChatGPT DOM Streaming 已通过。

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

- ✅ `src/stream/` 纯逻辑层：CRLF/CR normalization、Unicode code-point-safe longest common prefix、3-sample Stable Prefix、target disappearance / committed-prefix rewrite divergence、约 200ms 默认 polling、120s completion timeout。
- ✅ ChatGPT Driver `ChatGptTextTurn`：`observe()` / `stop()` / safe `conversationUrl()`；non-stream `sendText()` 与 stream 复用 target-turn ownership / completion semantics。
- ✅ `ChatGptTextRequest.signal` 在 baseline/composer/fill/send 等异步边界前传播取消；首个 SSE `started` 后若已断开，Engine 在 checkpoint 前退出，不产生网页 turn。
- ✅ Conversation Engine 提供 protocol-neutral `{ execute, stream }`；Streaming 继续共享 Phase 4 Planner、Page Registry、same-key Queue、checkpoint 和 final aggregate builder。
- ✅ Streaming 成功顺序为 stable deltas → final clean SQLite save → Page success → protocol success terminal；final clean save 失败不会发送成功终止。
- ✅ 生成中 client abort：best-effort Stop、no partial Assistant persistence、checkpoint 保持 `in_flight`、Page session fail；clean commit 后才发生的 terminal transport close 不 Stop/回滚已完成 turn。
- ✅ Chat Completions SSE：稳定 id/created/model、Assistant role chunk、text delta、single stop chunk、single `[DONE]`，不伪造 usage。
- ✅ Responses SSE：`response.created` / `in_progress` / item+content added / `output_text.delta` / done / `response.completed`，稳定 IDs 和单调 `sequence_number`，`usage=null`。
- ✅ Fastify Streaming transport：首个 internal `started` 才 `reply.hijack()`，raw SSE writer 支持 Node backpressure；pre-start error 保持普通 HTTP JSON，post-start error 使用流内错误且不写成功 terminal。
- ✅ Streaming 集成覆盖 FRESH、full-history APPEND、RESTORE、history-divergence REBUILD、same-key FIFO、different-key parallel、final-save failure、生成中 abort 和 pre-Send abort。
- ✅ Phase 5 real E2E harness 已实现真实 TCP listener 增量读取，包含长回复“completion marker 前收到 meaningful delta”、Markdown/code、Responses typed SSE、abort → `in_flight` → same-key REBUILD。
- ❌ **Phase 5 authenticated real ChatGPT Streaming E2E 尚未在本次实现后实际运行，因此“当前 ChatGPT DOM 真 Streaming 已验收”仍未成立。**

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

- 2026-08-16：Phase 5 True Streaming 产品链实现完成：Stable Prefix、target turn handle/completion、Conversation streaming lifecycle、双 SSE Encoder、backpressure、abort/Stop、FRESH/APPEND/RESTORE/REBUILD Streaming 集成和真实 E2E harness 全部落地。TDD 过程中实际捕获并修复 late terminal transport close、首帧后 pre-Send abort、stream architecture purity 等边界。
- 2026-08-16：最终 branch-head 只读 CI 通过 deterministic `corepack pnpm verify`、fresh `linux/amd64` Docker build 与完整 Docker smoke。Docker smoke 验收期间还修复 hosted runner 上 PUID/PGID bind mount 临时目录清理：功能断言已通过但宿主因 sticky-bit/ownership 无法删除根目录，最终通过 root cleanup container 清空内容并把挂载根 ownership 恢复给宿主后解决。
- 2026-08-16：本次 Phase 5 authenticated real E2E 没有执行。原因不是产品测试失败，而是当前会话后半段 DevSpace 执行连接器不可用，GitHub hosted runner 又没有项目隔离登录 Browser Profile 和 LAN proxy；因此阶段保留 `phase-5-real-e2e-blocked`。
- 2026-08-16：Phase 4 真实验收完成；combined real E2E 通过 Phase 3 regression、APPEND live DOM、restart RESTORE 与 divergence REBUILD，并修复全局 Stop control 滞留导致的 Completion 假超时。

## Next Steps（下一步）

1. 恢复可访问项目隔离登录 Profile 的 DevSpace 执行环境。
2. 运行 `CHATGPT_PROFILE_DIR=... CHATGPT_PROXY_SERVER=... corepack pnpm inspect:chatgpt`，确认 `auth=authenticated` 和当前 selector contract。
3. 运行 `E2E_CHATGPT=1 ... corepack pnpm test:e2e:chatgpt:phase5`，真实通过长回复、Markdown/code、Responses、abort/REBUILD。
4. 运行 combined `E2E_CHATGPT=1 ... corepack pnpm test:e2e:chatgpt`，确认 Phase 3/4/5 regression 同时通过。
5. 只有上述真实 E2E 全绿后，才把 `PHASE=phase-5-complete` / `ACTIVE_PLAN=none`，并进入 Phase 6 附件设计。

## Known Risks / Blockers（已知风险 / 阻塞）

- **当前 blocker：** 本次会话无法访问已登录的隔离 ChatGPT Browser Profile / LAN proxy 执行环境，所以 Phase 5 real authenticated E2E 未运行。
- ChatGPT DOM、Cloudflare 和认证流程属于外部变化面；当前 deterministic/Docker success 不能证明 selector、登录态或真实 Streaming 时间行为。
- Stable Prefix 选择“不撤回”语义：如果 ChatGPT DOM 重写穿过已发 prefix，请求会失败并保持 `in_flight`，下一 keyed request REBUILD；这是有意的一致性取舍。
- 当前 Docker 验收矩阵仍只有 `linux/amd64`，未验证 ARM64。
- Tool Calling、附件和图片能力仍必须各自经过后续 deterministic + real E2E，不能从 Phase 5 基础设施外推。
