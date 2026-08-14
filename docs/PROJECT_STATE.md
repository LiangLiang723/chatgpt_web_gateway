# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-3-implementation
STATUS=blocked
RELEASE_VERSION=V0.0.1
GOVERNING_SPEC=docs/superpowers/specs/2026-08-15-phase-3-browser-driver-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-15-phase-3-browser-driver.md
NEXT_TASK=resolve-phase-3-real-e2e-network-access
UPDATED_AT=2026-08-15
```

## Snapshot（快照）

- **当前阶段：** Phase 3 — Playwright Chromium + Minimal ChatGPT Driver（最小网页驱动）实施中。
- **当前状态：** `blocked`
- **活动计划：** [`2026-08-15-phase-3-browser-driver.md`](superpowers/plans/2026-08-15-phase-3-browser-driver.md)。
- **下一个可执行任务：** 恢复/确认 DevSpace 到 `https://chatgpt.com/` 的 HTTPS 可达性后，使用独立 E2E Profile 重跑 `inspect:chatgpt` 和完整 Phase 3 real E2E。
- **当前 blocker（阻塞）：** 真实 E2E 已实际启动，但 DevSpace 到 `https://chatgpt.com/` 的 HTTPS 连接超时：DNS 可解析，独立 Node `fetch` 失败为 `ETIMEDOUT`，Playwright `page.goto` 60 秒超时并稳定映射为 `browser_unavailable`。因此尚未进入登录态、Selector 校准、Fresh Driver challenge 或 Gateway HTTP challenge。

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
- ✅ 两个 POST 路由完成 HTTP → Schema → Normalizer → Phase3Executor → 协议响应编码；headless 生产 runtime 已注入真实 Browser/Driver 执行链，实际 ChatGPT 成功仍待 real E2E。
- ✅ 完整 `linux/amd64` Docker 运行基础：Playwright Chromium 镜像、Compose、`/data` Bind Mount、动态非 root `PUID/PGID`。
- ✅ 按需 noVNC maintenance overlay；默认 headless Compose 不启动维护进程、不发布 noVNC 端口。
- ✅ Node 24 内置 `node:sqlite` 单连接持久化；`${DATA_DIR}/gateway.db` 在 Gateway listen 前创建并完成 migration。
- ✅ `foreign_keys=ON`、WAL、5000ms busy timeout，以及 checksum migration history / 篡改检测。
- ✅ Conversation / Message / Tool Call / Attachment / File / Generated Image Repository。
- ✅ `ConversationStore` 单事务完整 aggregate 保存/加载；invalid replacement rollback 后旧快照保持不变。
- ✅ 真实文件 SQLite close → reopen 后 Conversation aggregate 与独立 File metadata 恢复。
- ✅ Docker 镜像包含 migrations；smoke 验证数据库 `PUID/PGID` owner、migration history 和 Bind Mount restart 持久性。
- ✅ Phase 3 BrowserManager / bounded Page Pool 与 `MAX_ACTIVE_PAGES` 配置已接入 Gateway runtime。
- ✅ ChatGPT Selector Registry 与 Auth Probe 核心：unique/collection、fallback、missing/ambiguous、authenticated/auth_required/unknown；真实 DOM 尚待 E2E 校准。
- ✅ Fresh ChatGPT text Driver 核心与 Completion Observer：Assistant baseline/new-turn ownership、生成状态与稳定文本采样；真实网页尚待 E2E 验证。
- ✅ Phase3Executor Fresh-only capability boundary、JSON instruction envelope 与 Page lease finally-release 已接入生产 POST runtime。
- ✅ Chat Completions / Responses 非流式文本编码与 stable execution error → OpenAI-style HTTP error 映射。
- ✅ Headless Gateway runtime 已注入 BrowserManager + Phase3Executor；`UI_MODE=novnc` 明确禁用产品 BrowserManager 并返回 `browser_maintenance_mode`。
- ✅ `inspect:chatgpt` 与 `test:e2e:chatgpt` 显式真实 E2E harness、安全隔离 Profile 门槛和可选诊断产物边界；真实命令已运行，但被当前 DevSpace 网络超时阻塞。
- ✅ 产品级 Playwright Chromium 生命周期 / Browser Manager 已接入正常 Gateway runtime；Docker smoke 已验证普通 headless 与 maintenance headed Chromium 的 Profile 单 owner、PUID/PGID 和 restart 边界。
- ✅ ChatGPT Driver（网页驱动）代码已实现 Fresh 非流式纯文本路径；当前 ChatGPT DOM/登录态/真实问答尚未通过 real E2E 验收。
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
- SQLite 访问集中在 `src/persistence/`；架构检查禁止其他产品模块导入 `node:sqlite`，并识别 side-effect import。
- Persistence 业务实体使用 UUID v4 主键、Unix 毫秒时间；复杂 payload 使用受 JSON 校验保护的 `TEXT`。
- `ConversationStore` 是 Phase 2 的恢复聚合边界；同步事务拒绝 async callback。
- Docker 从 Phase 1 起是正式运行边界；目标平台先锁定 `linux/amd64`。
- Phase 3 普通 Compose 的 Gateway 进程会启动产品级 headless BrowserManager / Persistent BrowserContext；Docker smoke 已验证 Chromium 与 Gateway 使用指定 `PUID/PGID`。
- noVNC 只通过维护 overlay 按需启用，默认宿主机绑定 `127.0.0.1`；maintenance 模式禁用产品 BrowserManager，只启动 headed maintenance browser。
- `/data/browser-profile/` 是 normal BrowserManager 与 maintenance browser 共用但互斥占用的持久 Profile 边界；Docker smoke 验证两种模式都只有一个 browser owner。
- `/health` 无需认证；所有 `/v1/*` 默认要求 Gateway Bearer API Key。
- `X-Conversation-Key` 是受控兼容扩展；协议层负责标准化，Phase3Executor 看到该 key 会明确返回 `conversation_sync_not_implemented`，不静默忽略。
- Phase 3 使用一个 Persistent BrowserContext + bounded Page Pool；Selector/Auth/Driver/Completion 都已实现确定性边界，但真实 selector/login/answer 尚被网络 blocker 阻塞。
- 后续仍保持 Context Sync `FRESH | APPEND | RESTORE | REBUILD`、SQLite 为 Conversation 事实来源、约 200ms DOM polling + Stable Prefix Streaming。

详细约束见 [`architecture.md`](architecture.md)。

## Recent Milestones（最近里程碑）

- 2026-08-15：完成 Phase 3 BrowserManager / PagePool / Selector Registry / Auth Probe / Fresh Driver / Phase3Executor / OpenAI-style text encoder / inspect + real E2E harness 代码实现；最终文档回写后的 `corepack pnpm verify` 通过 26 个测试文件 / 128 个测试，最终镜像 `sha256:f6435e40…` 的 Docker smoke 通过 Chromium 单-owner / SQLite / HTTP / restart 验证。
- 2026-08-15：真实 Phase 3 E2E 已实际启动；当前 DevSpace DNS 可解析 `chatgpt.com`，但 HTTPS `fetch` 为 `ETIMEDOUT`、Playwright navigation 60 秒超时，状态记录为 `blocked`，未进入 auth/selector/Driver/Gateway challenge。
- 2026-08-14：完成 Phase 2 SQLite / Conversation persistence 实施：单 `DatabaseSync`、checksum migration、六类业务 Repository、原子 aggregate save/load、真实文件 DB close/reopen 恢复和 Gateway/Docker 生命周期接入。
- 2026-08-14：Phase 2 最终确定性验证通过 15 个测试文件 / 67 个测试；Docker smoke 验证 `/data/gateway.db`、`001_initial`、非 root owner 和 restart 持久性。
- 2026-08-14：批准 Phase 2 SQLite / Conversation persistence 设计：`node:sqlite`、单向 checksum migration、UUID v4、Unix 毫秒、关系型核心 + JSON payload、单 `DatabaseSync` 与 aggregate transaction。
- 2026-08-14：完成 Phase 1 实施：TypeScript/Fastify/TypeBox 工具链、认证、统一 Chat Completions / Responses Normalizer、基础 GET/POST 路由和 40 个确定性测试。
- 2026-08-14：完成正式 `linux/amd64` Docker 运行基础与 noVNC maintenance overlay；Docker smoke 验证 Node 24、HTTP 认证、Bind Mount、非 root `PUID/PGID`、维护进程/端口隔离和 noVNC 页面。
- 2026-08-14：固化 pnpm/Corepack 精确版本、pnpm 11 build-script allowlist 和整套“升级项目依赖”流程。
- 2026-08-14：完成 Phase 1 工具链 / 协议 / Docker 设计讨论；Docker 正式运行边界从 Phase 9 前移到 Phase 1。
- 2026-08-14：建立 `V0.0.1` 初始版本和 Living Repository（活仓库）治理体系。

## Next Steps（下一步）

1. 恢复/确认 DevSpace 到 `https://chatgpt.com/` 的 HTTPS 可达性；当前独立 Node HTTPS 请求为 `ETIMEDOUT`。
2. 使用独立且人工登录的 E2E Browser Profile 运行 `corepack pnpm inspect:chatgpt`，校准当前真实 Selector / Auth 状态。
3. 运行 `corepack pnpm test:e2e:chatgpt`，完成 Fresh Driver challenge 与 Gateway HTTP challenge。
4. 只有上述 real E2E 全部通过后，才关闭 Phase 3 并进入 Phase 4 Context Sync 设计。

## Known Risks（已知风险）

- **真实 ChatGPT Web E2E 已启动但未通过。** 当前 DevSpace 网络无法在超时内建立到 `chatgpt.com` 的 HTTPS 页面访问，因此不能证明当前 Selector、真实登录或 Fresh 文本问答可用。
- maintenance browser 已在 `about:blank` 下通过 Docker smoke，但尚未用真实 ChatGPT 账号完成首次登录流程验证。
- 当前 POST 端点已经接入 Phase3Executor/Browser/Driver 的 Fresh 非流式纯文本路径，但真实 `chatgpt.com` E2E 尚未通过；Conversation persistence 仍未接入运行时 Conversation Engine，Context Sync 属于 Phase 4。
- 当前 Docker 验收矩阵只有 `linux/amd64`，未验证 ARM64。
- ChatGPT 网页 DOM 会变化；后续 Selector 必须集中并有诊断工具。
- Tool Calling 是 Gateway 的 Prompt + Parser 模拟层，不应伪装成 ChatGPT Web 原生工具协议。
- 真正的网页兼容性只有真实 E2E 才能证明；普通 Unit（单元）/Integration（集成）/Docker smoke 不能替代。
