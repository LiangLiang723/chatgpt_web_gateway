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

状态：**完成**。规格见 [`docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md`](superpowers/specs/2026-08-16-phase-5-true-streaming-design.md)；Phase 5 活动计划已完成，Project State 已推进到 Phase 6 设计。

交付代码包含：目标 Assistant Turn Snapshot、约 200ms DOM polling、3-sample Stable Prefix + 当前默认 64 Unicode code points commit-tail holdback、target-turn Completion Detector、Chat Completions / Responses 两套 SSE Encoder、raw SSE backpressure、same-key 全生命周期 FIFO、Client abort → pre-Send cancellation / best-effort Stop，以及 SQLite `in_flight` / clean 一致性。真实验收期间还固化了 `/c/WEB:*` provisional route、无正文 Assistant placeholder、唯一 `.markdown` authoritative content 与明确 conversation-history rate-limit 通知 overlay 的 Driver 边界；writing-block/editor 仍不属于 Phase 5。

验收：2026-08-17 fresh `corepack pnpm verify` 通过 55 test files / 332 tests；fresh `linux/amd64` Docker build digest `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0` 与完整 smoke 通过。隔离已登录 Profile 上 `inspect:chatgpt` 返回 authenticated；standalone Phase 5 real E2E 真实通过长 Chat Completions、Markdown/code、Responses typed SSE 与 abort→Stop→`in_flight`→REBUILD，随后 combined Phase 3/4/5 real E2E 全绿。Phase 5 已正式关闭，下一步是 Phase 6 图片和文件输入设计。

## Phase 6：图片和文件输入

状态：**完成**。Governing Spec 见 [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。

交付：migration 003、logical File / SHA-256 physical Blob、`/v1/files` 五接口、Attachment Resolver/SSRF/security/staging、ordered multimodal Context 与四-mode upload selection、authenticated ChatGPT upload Driver/readiness、Conversation attachment lifecycle、跨协议 deterministic integration、fresh `linux/amd64` Docker Files lifecycle smoke，以及 Chat Completions / Responses 的 URL/Data URL/Base64/`file_id` 图片与文件输入。

验收：standalone Phase 6 real E2E 已证明 Data URL image、image `file_id`、TXT/PDF/DOCX/XLSX、same-key APPEND、runtime restart RESTORE 与 attachment Streaming；2026-08-26 最终 combined Phase 3/4/5/6 real E2E 退出码 0，全阶段断言通过。验收过程中还修复了 38-code-point Markdown 尾部回排与 Composer fill 后 Send readiness 竞态。Remote URL fetch 的 SSRF/DNS/redirect 逻辑由 deterministic tests 覆盖，本轮没有公网 fixture 的 live remote-fetch E2E。

Phase 6 已关闭，下一步进入 Phase 7 Tool Calling 设计。

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
