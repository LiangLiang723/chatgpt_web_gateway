# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-4-complete
STATUS=phase-5-design-review
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md
ACTIVE_PLAN=none
NEXT_TASK=review-and-approve-phase-5-streaming-spec
UPDATED_AT=2026-08-16
```

## Snapshot（快照）

- **当前阶段：** Phase 4 — Conversation + Context Sync 已完成代码、deterministic、Docker 与真实 ChatGPT Web E2E 验收。
- **当前状态：** `phase-5-design-review`；Phase 5 真 Streaming 设计规格已完成草案，等待用户审阅批准，尚未进入实施计划或代码实现。
- **活动计划：** `none`；已完成计划保留在 [`docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md`](superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md) 作为实施历史。
- **Governing Spec：** [`docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md`](superpowers/specs/2026-08-16-phase-5-true-streaming-design.md)。当前锁定 DOM-only target Assistant observation、约 200ms polling、3-sample Stable Prefix、target-turn completion marker、双 SSE Encoder、backpressure 与 client abort → best-effort Stop + `in_flight` 收敛方向。
- **下一个可执行任务：** 审阅并批准 Phase 5 真 Streaming 设计规格；批准后再编写实施计划。
- **验收事实：** 修复当前 ChatGPT DOM 中全局 Stop control 可能滞留导致的假 `chatgpt_generation_timeout` 后，当前树 `corepack pnpm verify` 通过 43 个测试文件 / 274 个测试；显式 combined `corepack pnpm test:e2e:chatgpt` 已真实通过 Phase 3 authenticated/composer/Driver/Gateway 回归，以及 Phase 4 `append=true`、`restore=true`、`rebuild=true`。最终 fresh `linux/amd64` 镜像为 `sha256:a7a9dd99cb3c7f48d2cf13d829cc83d6d577778806a1605011ab257fbca8fd71`，Docker smoke 已通过。

## Implemented Now（当前已实现）

### 仓库治理

- ✅ `AGENTS.md` Agent 工作入口。
- ✅ 项目记忆 Writeback（回写）协议。
- ✅ `PROJECT_STATE.md` 机器可检查状态头。
- ✅ 架构、API 兼容、测试、Git、Roadmap（路线图）文档。
- ✅ `docs/superpowers/specs/` / `plans/` 工作流目录。
- ✅ Phase 1 工具链、协议模型和正式 Docker 运行边界设计与实施计划。
- ✅ Phase 2 `node:sqlite`、Migration、Repository 与 Conversation aggregate 持久化设计规格和实施计划。
- ✅ Phase 3 Persistent BrowserContext / Page Pool / Selector Registry / Auth Probe / Fresh Text Driver / real E2E 设计规格。
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
- ✅ 两个 POST 路由完成 HTTP → Schema → Normalizer → Conversation Engine → 协议响应编码；headless 生产 runtime 已注入 Phase 4 Conversation/Browser/Driver 执行链。
- ✅ 完整 `linux/amd64` Docker 运行基础：Playwright Chromium 镜像、Compose、`/data` Bind Mount、动态非 root `PUID/PGID`。
- ✅ 按需 noVNC maintenance overlay；默认 headless Compose 不启动维护进程、不发布 noVNC 端口。
- ✅ Node 24 内置 `node:sqlite` 单连接持久化；`${DATA_DIR}/gateway.db` 在 Gateway listen 前创建并完成 migration。
- ✅ `foreign_keys=ON`、WAL、5000ms busy timeout，以及 checksum migration history / 篡改检测。
- ✅ Conversation / Message / Tool Call / Attachment / File / Generated Image Repository。
- ✅ `ConversationStore` 单事务完整 aggregate 保存/加载；invalid replacement rollback 后旧快照保持不变。
- ✅ 真实文件 SQLite close → reopen 后 Conversation aggregate 与独立 File metadata 恢复。
- ✅ Docker 镜像包含 migrations；smoke 验证数据库 `PUID/PGID` owner、migration history 和 Bind Mount restart 持久性。
- ✅ Phase 3 BrowserManager / bounded Page Pool 与 `MAX_ACTIVE_PAGES` 配置已接入 Gateway runtime；可选 `CHATGPT_PROXY_SERVER` 同时作用于 normal、maintenance、inspect 和 real E2E Chromium，拒绝在 proxy URL 内携带账号密码。
- ✅ ChatGPT Selector Registry 与 Auth Probe：unique/collection、fallback、missing/ambiguous、authenticated/auth_required/unknown；真实 authenticated DOM 已校准，Auth Probe 会在首次 unknown 时等待 Composer/Login signal 挂载后重新 strict probe。
- ✅ Fresh ChatGPT text Driver 与 Completion Observer：Assistant baseline/new-turn ownership、目标 Assistant turn completion marker + 稳定文本采样；不再把可能滞留的全局 Stop control 当作唯一完成条件，真实网页 Driver challenge 已通过。
- ✅ Phase 4 纯 Context Sync Planner 已实现 `FRESH | APPEND | RESTORE | REBUILD`，并保持 `src/context/` 不依赖 API/Playwright/ChatGPT。
- ✅ 同一 `ConversationKey` 使用 keyed Queue 串行，不同 key 不使用全局锁；未提供 key 的请求每次独立 FRESH 并持久化为 `conversation_key = NULL`，但不猜测跨请求身份。
- ✅ Conversation Page affinity、`PAGE_IDLE_TIMEOUT_MINUTES`、idle sweep、容量不足时 LRU idle eviction 和失败 lease discard 已实现。
- ✅ ChatGPT Driver 已拆分 `openFresh` / `openConversation` / `sendText`；RESTORE 校验安全 ChatGPT `/c/...` Conversation identity，明确不可恢复时可触发安全 REBUILD。
- ✅ Conversation Engine 已接入 SQLite `ConversationStore` 与 sync checkpoint；成功后原子保存 reconciled 同步快照与安全 ChatGPT Conversation URL，checkpoint 后未知失败保持 `in_flight` 供下一轮 REBUILD。
- ✅ Chat Completions / Responses 非流式文本编码与 stable execution error → OpenAI-style HTTP error 映射；Phase 4 仍明确拒绝 Streaming、附件、Tools、Structured Output 和 image execution。
- ✅ Headless Gateway runtime 已注入 BrowserManager + Conversation Queue + Conversation Page Registry + Conversation Engine；`UI_MODE=novnc` 明确禁用产品 BrowserManager/Queue/Registry 并返回 `browser_maintenance_mode`。
- ✅ `inspect:chatgpt` 与 `test:e2e:chatgpt` 显式真实 E2E harness、安全隔离 Profile 门槛和可选诊断产物边界；支持显式代理，authenticated inspect / Driver / Gateway HTTP real E2E 均已通过。
- ✅ 产品级 Playwright Chromium 生命周期 / Browser Manager 已接入正常 Gateway runtime；Docker smoke 已验证普通 headless 与 maintenance headed Chromium 的 Profile 单 owner、PUID/PGID 和 restart 边界。
- ✅ ChatGPT Driver（网页驱动）Fresh 非流式纯文本路径已完成，并在 Phase 3 通过真实 ChatGPT DOM/登录态/问答 E2E 验收。
- ✅ Phase 4 SQLite sync checkpoint 已实现：`002_add_conversation_sync_checkpoint`、`clean | in_flight`、`syncedMessageCount`、metadata-only `markSyncInFlight` 与越界 aggregate 校验。
- ✅ Phase 4 pure Context Planner 已实现 canonicalization、SHA-256 fingerprint、`incremental | full` 与完整 `FRESH | APPEND | RESTORE | REBUILD`/REBUILD reason 决策，`context/` 保持 browser/API/DB-free。
- ✅ Phase 4 Request Adapter 已实现 capability gate、canonical text 转换与 `incremental | full` 分类；same-key Queue 使用 Promise-tail FIFO，不同 key 可并行，close 后拒绝新任务但已排队工作继续 drain。
- ✅ Phase 4 PageLease 已使用互斥 `release | close` 终态；Conversation Page Registry 已实现 keyed affinity、transient lease、idle deadline close、LRU capacity eviction、busy 保护和 deterministic tie-break。
- ✅ ChatGPT Driver 已拆分 `openFresh` / `openConversation` / `sendText`；persisted URL 只接受安全 `https://chatgpt.com` non-root URL，identity 比较忽略 query/hash，`not_restorable` 不吞 auth/selector/browser error。
- ✅ Context/Append Envelope 使用版本化 JSON-only payload；aggregate builder 按 canonical longest common prefix 复用 Message identity，并在成功后收敛为 clean checkpoint。
- ✅ 新 Conversation Engine 已接入真实 `ConversationStore`、same-key Queue、Page Registry 与 pure Planner；FRESH、full/incremental APPEND、NULL-key 持久化及 checkpoint 写入顺序已有真实临时 SQLite 集成测试。
- ✅ Conversation Engine 四态已闭环：RESTORE、`not_restorable → REBUILD`、full history/incremental instructions REBUILD、checkpoint uncertainty/mismatch 与 post-checkpoint `in_flight` reopen 均有真实临时 SQLite 集成测试。
- ✅ Headless production runtime 已正式切换到 `ConversationQueue + ConversationPageRegistry + ConversationEngine`；maintenance 模式不创建产品 Browser/Queue/Registry，公共 Phase 4 invalid/unsupported error mapping 已完成。
- ✅ 系统级 integration 已证明 queued single-user incremental 会在 FIFO 内重读第一轮 SQLite 状态、不同 key 并行、capacity-2 LRU/busy 保护、runtime restart RESTORE 与 Chat Completions/Responses 同 key 连续性。
- ✅ Phase 4 架构 checker 已强化并有 synthetic import rule tests；最终 fresh `linux/amd64` 镜像 `sha256:a7a9dd99cb3c…` Docker smoke 已验证 migration 001+002、checkpoint columns、idle-timeout 与既有 normal/maintenance 安全边界。
- ✅ Phase 4 real ChatGPT E2E 已通过：Phase 3 regression + APPEND live DOM + restart RESTORE + divergence REBUILD 均完成真实网页验收。
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
- SQLite 访问集中在 `src/persistence/`；架构检查禁止其他产品模块导入 `node:sqlite`，并识别 side-effect import。
- Persistence 业务实体使用 UUID v4 主键、Unix 毫秒时间；复杂 payload 使用受 JSON 校验保护的 `TEXT`。
- `ConversationStore` 是 Phase 2 的恢复聚合边界；同步事务拒绝 async callback。
- Docker 从 Phase 1 起是正式运行边界；目标平台先锁定 `linux/amd64`。
- Phase 3 普通 `UI_MODE=headless` Compose 会启动 Xvfb + 产品 BrowserManager / Persistent BrowserContext；BrowserManager 内部使用 full Chromium `headless:false`，但不启动/发布 x11vnc/noVNC。Docker smoke 已验证 Xvfb、Chromium 与 Gateway 使用指定 `PUID/PGID`。
- noVNC 只通过维护 overlay 按需启用，默认宿主机绑定 `127.0.0.1`；maintenance 模式禁用产品 BrowserManager，只启动 headed maintenance browser。
- `/data/browser-profile/` 是 normal BrowserManager 与 maintenance browser 共用但互斥占用的持久 Profile 边界；Docker smoke 验证两种模式都只有一个 browser owner。
- `/health` 无需认证；所有 `/v1/*` 默认要求 Gateway Bearer API Key。
- `X-Conversation-Key` 是受控兼容扩展；有 key 时 Phase 4 使用 SQLite Conversation 快照、同 key Queue 和 Page affinity 执行上下文同步；无 key 时每请求独立 FRESH 并持久化 NULL-key Conversation，不自动生成或猜测跨请求会话身份。
- Context Sync 只允许 `FRESH | APPEND | RESTORE | REBUILD`；当前安全 APPEND 仅接受“持久化前缀完全一致 + 恰好新增一个最终 user turn”，否则 REBUILD。
- 同 Conversation 串行、跨 Conversation 可并行；Page affinity 空闲超时默认 30 分钟，Page 容量不足时只回收 idle affinity，不抢占 active Conversation。
- SQLite 是 Conversation 已同步事实来源；成功执行后保存完整请求历史 + 新 Assistant 回复和当前 ChatGPT `/c/...` URL，失败保持旧快照。
- Phase 3 Selector/Auth/Driver/Completion 与 Phase 4 APPEND/RESTORE/REBUILD 均已有 2026-08-16 最新真实 authenticated E2E 证据；Completion 以目标 Assistant turn 自身的 `copy-turn-action-button` 完成标记为主，不依赖全局 Stop control 消失。
- 后续 Streaming 仍保持约 200ms DOM polling + Stable Prefix 方向。

详细约束见 [`architecture.md`](architecture.md)。

## Recent Milestones（最近里程碑）

- 2026-08-16：完成 Phase 5 真 Streaming 设计规格草案：保持 DOM-only，以目标 Assistant turn snapshot 驱动约 200ms polling；使用 3-sample Stable Prefix 防止 Markdown/React DOM 回写造成重复；完成以 target-turn completion marker + final stable confirmation 为终态；Conversation Engine 继续拥有 same-key Queue、SQLite `in_flight`/clean checkpoint 与最终 aggregate commit；Chat Completions / Responses 使用独立 SSE Encoder；client abort 在生成中 best-effort Stop 且不保存 partial Assistant。当前仅为设计事实，Streaming 仍未实现。
- 2026-08-16：Phase 4 最终真实验收完成。旧隔离 Profile 重新认证时再次陷入 challenge loop，因此保留旧 Profile 并创建新的干净隔离 Profile；maintenance Google Chrome Stable 登录后 `inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`。首次 combined E2E 随即暴露当前 ChatGPT DOM 的 Stop control 可能在可见答案稳定后继续滞留，导致 Completion Observer 假超时；真实 DOM 采样确认目标 Assistant turn 的 `copy-turn-action-button` 只在 turn 完成后挂载，修复后红→绿单测通过，combined real E2E 最终返回 Phase 3 `driverChallenge=true` / `gatewayChallenge=true` 与 Phase 4 `append=true` / `restore=true` / `rebuild=true`。
- 2026-08-15：恢复远端已批准 Phase 4 设计/13-Task 计划后发现本地实施分支只覆盖其子集；当前已非破坏性合并设计历史，并继续实施 sync checkpoint、single-user incremental、无 key 持久化和 crash-convergence。此前较窄实现的 `verify` 为 33 个测试文件 / 177 个测试、镜像 `sha256:7fd07b887b7b…` Docker smoke 通过，作为回归基线保留。
- 2026-08-15：Phase 3 真实验收完成：独立 Profile 通过固定 Google Chrome Stable 151.0.7922.137 人工登录；真实 `inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`，完整 `test:e2e:chatgpt` 返回 `driverChallenge=true` / `gatewayChallenge=true`。authenticated 实测发现 Composer 延迟挂载，Auth Probe 已用 Locator attachment wait + strict re-probe 修复并有红→绿单测。
- 2026-08-15：maintenance 登录路径正式切换到固定 Google Chrome Stable，镜像以 SHA256 固定 deb；Compose 使用 vendored Playwright seccomp profile，Docker smoke 验证非 root Chrome 保持 sandbox、`Seccomp=2`、无 `CAP_SYS_ADMIN`、无 `--no-sandbox` / `--remote-debugging-pipe`。当前正式镜像验证基线为 `sha256:1ceb828d…`。
- 2026-08-15：人工登录曾暴露 `auth.openai.com` Turnstile 在 Chrome for Testing 中重复 challenge；真实 A/B 证明 Google Chrome Stable 可正常完成人工安全验证，因此 maintenance-only 浏览器与产品 Playwright Chromium 明确分离。
- 2026-08-15：修复 real noVNC 登录入口长期停在 `Connecting...`：根因是 Ubuntu x11vnc `0.9.16` 默认单线程在 Xvfb 下高 CPU 且不发送 RFB banner；`-threads` A/B 实测约 104ms 返回 `RFB 003.008`。Docker smoke 新增真实 `/websockify` RFB banner 验证，新镜像 `sha256:d2cf5c2c…` 通过；真实 6088 noVNC 页面已验证进入 `Credentials are required` 密码状态。
- 2026-08-15：maintenance mode switch 增加 PersistentContext readiness handshake、有序 shutdown 和受 hostname/PID 约束的 stale Chromium `Singleton*` 清理；新镜像 `sha256:99a0c44b…` Docker smoke 验证 maintenance `down` 后测试 Profile 无 Singleton marker，人工登录后可安全切回 normal runtime。
- 2026-08-15：真实 Cloudflare 对照验证表明 Playwright headless-shell 与 Chromium new-headless 都会长期停在 challenge，而 Xvfb + full Chromium 能稳定进入正常 ChatGPT Guest 页面并由 Auth Probe 报告 `auth_required`。normal `UI_MODE=headless` 因此实现为“无暴露 UI 的 Xvfb + full Chromium”；确定性 `verify` 继续通过 26 个测试文件 / 130 个测试，Docker smoke 通过 normal/maintenance virtual display、proxy/Profile single-owner、HTTP/SQLite/restart 验证。
- 2026-08-15：新增可选 `CHATGPT_PROXY_SERVER`，normal/maintenance/inspect/E2E 共用同一代理；Compose 同步补齐 `MAX_ACTIVE_PAGES` 透传。代理 URL 禁止内嵌凭据，maintenance 可显式切换独立 E2E Profile。
- 2026-08-15：真实 Phase 3 网络/Cloudflare blocker 已收敛：系统 DNS/直连路径不可用，但用户提供的 LAN 代理 + Xvfb/full Chromium 能稳定进入 HTTP 200 ChatGPT Guest 页面，真实 inspect 返回 `auth_required`；当前 blocker 只剩隔离 E2E Profile 的人工 ChatGPT 登录/MFA。
- 2026-08-15：完成 Phase 3 BrowserManager / PagePool / Selector Registry / Auth Probe / Fresh Driver / Phase3Executor / OpenAI-style text encoder / inspect + real E2E harness 代码实现；此前最终文档回写后的 `corepack pnpm verify` 通过 26 个测试文件 / 128 个测试，镜像 `sha256:f6435e40…` 的 Docker smoke 通过 Chromium 单-owner / SQLite / HTTP / restart 验证。
- 2026-08-14：完成 Phase 2 SQLite / Conversation persistence 实施：单 `DatabaseSync`、checksum migration、六类业务 Repository、原子 aggregate save/load、真实文件 DB close/reopen 恢复和 Gateway/Docker 生命周期接入。
- 2026-08-14：Phase 2 最终确定性验证通过 15 个测试文件 / 67 个测试；Docker smoke 验证 `/data/gateway.db`、`001_initial`、非 root owner 和 restart 持久性。
- 2026-08-14：批准 Phase 2 SQLite / Conversation persistence 设计：`node:sqlite`、单向 checksum migration、UUID v4、Unix 毫秒、关系型核心 + JSON payload、单 `DatabaseSync` 与 aggregate transaction。
- 2026-08-14：完成 Phase 1 实施：TypeScript/Fastify/TypeBox 工具链、认证、统一 Chat Completions / Responses Normalizer、基础 GET/POST 路由和 40 个确定性测试。
- 2026-08-14：完成正式 `linux/amd64` Docker 运行基础与 noVNC maintenance overlay；Docker smoke 验证 Node 24、HTTP 认证、Bind Mount、非 root `PUID/PGID`、维护进程/端口隔离和 noVNC 页面。
- 2026-08-14：固化 pnpm/Corepack 精确版本、pnpm 11 build-script allowlist 和整套“升级项目依赖”流程。
- 2026-08-14：完成 Phase 1 工具链 / 协议 / Docker 设计讨论；Docker 正式运行边界从 Phase 9 前移到 Phase 1。
- 2026-08-14：建立 `V0.0.1` 初始版本和 Living Repository（活仓库）治理体系。

## Next Steps（下一步）

1. 审阅并批准 [`Phase 5 True Streaming Design`](superpowers/specs/2026-08-16-phase-5-true-streaming-design.md)。
2. 设计批准后编写 Phase 5 implementation plan；当前 `ACTIVE_PLAN=none`，不提前进入代码实现。
3. 后续实施必须保留显式真实 ChatGPT E2E，使用真实 TCP HTTP listener 证明首个 meaningful delta 发生在目标 Assistant turn completion marker 之前，不能以 Phase 4 非流式通过外推 Streaming 正确性。

## Known Risks（已知风险）

- Phase 3 真实 ChatGPT Web E2E 已通过，但网页 DOM、Cloudflare 和认证流程属于外部变化面；未来升级 Playwright / Chrome 或 ChatGPT UI 后仍需重跑显式 real E2E。
- maintenance Google Chrome Stable 与产品 Playwright Chromium 当前主版本一致；升级其中任一浏览器时必须重新验证 Profile 兼容、人工登录和产品 real E2E。
- Phase 4 已完成真实 APPEND/RESTORE/REBUILD 网页验收；但 ChatGPT DOM 会继续变化，尤其 completion marker / action 区与 Composer 控件，升级或 UI 变化后仍必须重跑显式 real E2E。
- 当前 Docker 验收矩阵只有 `linux/amd64`，未验证 ARM64。
- ChatGPT 网页 DOM 会变化；后续 Selector 必须集中并有诊断工具。
- Tool Calling 是 Gateway 的 Prompt + Parser 模拟层，不应伪装成 ChatGPT Web 原生工具协议。
- 真正的网页兼容性只有真实 E2E 才能证明；普通 Unit（单元）/Integration（集成）/Docker smoke 不能替代。
