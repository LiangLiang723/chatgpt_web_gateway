# Roadmap（实施路线图）

原则：每个 Phase（阶段）交付一个可测试最小闭环；进入复杂 Phase 前建立对应 spec（设计规格）和 plan（实施计划）。

## Phase 0：Living Repository 基础

状态：**完成基础骨架**。

交付：Agent 规则、项目状态、架构/API/测试/Git 文档、Project Memory（项目记忆）协议、机器一致性检查、空模块目录。

验收：新 Agent 不读聊天，也能准确回答“现在实现了什么、V1 要做什么、下一步是什么”。

## Phase 1：工具链 + 统一协议模型 + 正式 Docker 运行边界

状态：**完成**。

交付：TypeScript、pnpm、Fastify、TypeBox/Ajv Schema 校验、内部统一请求类型、API Key 认证、`/health`、`/v1/models`、Chat Completions / Responses 请求 Normalizer 单元测试，以及完整 `linux/amd64` Docker 镜像、基础 Compose、按需 noVNC 维护 overlay、`/data` Bind Mount 和非 root `PUID/PGID` 运行边界。

验收：不连接真实 ChatGPT 也能完成协议解析和基础路由测试；完整容器可构建并完成 HTTP、认证、挂载、运行用户和维护 overlay 的确定性 smoke test。

## Phase 2：SQLite + Conversation 持久化

状态：**完成**。

交付：数据库迁移、Conversation / Message / Tool Call / File / Attachment / Generated Image Repository，完整对话保存与加载。

验收：进程重启后完整会话数据可恢复。

## Phase 3：Playwright Chromium + 最小 ChatGPT Driver

状态：**完成**。

交付：Persistent BrowserContext、manual maintenance login 边界、bounded Page Pool、Selector Registry（选择器注册表）、Auth Probe、`inspect:chatgpt`、Fresh 非流式纯文本 Driver、Chat Completions / Responses 文本响应编码和显式 real E2E harness。

确定性 `verify`、Docker normal/maintenance smoke 与真实 ChatGPT E2E 均已通过。独立 Profile 由 maintenance Google Chrome Stable 人工登录；随后产品 Playwright Chromium 实际完成 authenticated auth/selector inspection、Fresh Driver 文本 challenge，以及 Gateway HTTP → ChatGPT Web → Chat Completion challenge。

验收：真实 E2E 已完成 auth/selector inspection、一次 Fresh Driver 文本一问一答，以及至少一次 Gateway HTTP → ChatGPT Web → Chat Completion。Phase 3 验收关闭后进入 Phase 4 Context Sync 设计。

## Phase 4：Conversation + Context Sync

状态：**完成**。

交付：Conversation Key、same-key FIFO、跨会话并行、full-history / single-user incremental、`FRESH | APPEND | RESTORE | REBUILD`、Page idle + LRU 回收、安全 URL 恢复、crash-safe SQLite `clean | in_flight` sync checkpoint 与 NULL-key 独立持久化。当前这些交付已完成并通过 43 个测试文件 / 274 个测试及 fresh Docker smoke。

验收：deterministic tests 已证明完整历史与 incremental APPEND 不重复灌入已确认历史、未知 post-checkpoint failure 保持 `in_flight` 并在下一轮 REBUILD、进程重启可 RESTORE、跨协议共享同一 Conversation。2026-08-16 combined real E2E 在新的干净隔离 Profile 上真实通过 Phase 3 regression，以及 APPEND live DOM、restart RESTORE 与 divergence REBUILD；验收期间还修复了全局 Stop control 滞留导致的 Completion 假超时。Phase 4 已关闭，下一步进入 Phase 5 Streaming 设计。

## Phase 5：真 Streaming

状态：**实现、确定性验证与 fresh Docker smoke 已完成；authenticated real ChatGPT Streaming E2E 待执行，Phase 5 尚未关闭**。规格见 [`docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md`](superpowers/specs/2026-08-16-phase-5-true-streaming-design.md)，活动计划见 [`docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md`](superpowers/plans/2026-08-16-phase-5-true-streaming.md)。

交付代码已包含：目标 Assistant Turn Snapshot、约 200ms DOM polling、3-sample Stable Prefix、target-turn Completion Detector、Chat Completions / Responses 两套 SSE Encoder、raw SSE backpressure、same-key 全生命周期 FIFO、Client abort → pre-Send cancellation / best-effort Stop，以及 SQLite `in_flight` / clean 一致性。Phase 4 的 APPEND / RESTORE / REBUILD 已有 Streaming 集成覆盖。

当前验收：最终 branch-head 只读 CI 已通过 `corepack pnpm verify`、fresh `linux/amd64` Docker build 和完整 Docker smoke。真实 Phase 5 harness 也已实现为真实 TCP listener 增量读取，覆盖长回复、Markdown/code、Responses typed SSE 和 abort→REBUILD；但本次工具环境没有可访问的隔离已登录 ChatGPT Browser Profile / LAN 代理执行边界，因此没有实际运行 Phase 5 authenticated real E2E。不能用 Phase 3/4 的真实通过或 deterministic/Docker 结果外推“当前 ChatGPT DOM 真 Streaming 已验收”。

验收关闭条件仍是：真实长回复在 target Assistant completion marker 出现前已经收到 meaningful delta，最终 delta 拼接与 live DOM / SQLite 一致，并真实通过 Markdown/code、Responses 和 abort/REBUILD 场景。

## Phase 6：图片和文件输入

交付：`/v1/files` 生命周期、URL/Base64 图片、Base64 文件、`file_id`、SHA-256、ChatGPT upload readiness（上传就绪）检测。

验收：图片理解和代表性文档上传 E2E 通过。

## Phase 7：Tool Calling

交付：Tool Schema canonicalization（规范化）、fingerprint、Prompt、检测 buffer、Parser、`tool_calls` 输出、Tool Result 回传。

验收：完成“模型 → 工具 → 工具结果 → 最终回答”闭环。

## Phase 8：ChatGPT 图片生成

交付：`POST /v1/images/generations`、`n=1`、最终图片检测/下载、Gateway URL/Base64、SQLite 记录。

验收：真实 E2E 生成图片并通过 API 返回可读取结果。

## Phase 9：恢复、诊断与 NAS 生产成熟化

交付：分级恢复、结构化错误、日志/诊断、安全加固、NAS 运维与备份/恢复文档，以及对 Phase 1 容器运行边界的生产成熟化。

验收：容器重启不丢 Browser Profile 和 Conversation；维护/恢复流程可操作；普通 `pnpm verify` 不依赖外网。

## Phase 10：V1 验收

覆盖 Chat Completions、Responses、Files、Images Generation、并发会话、Context Sync、浏览器异常恢复和文档/API 一致性。
