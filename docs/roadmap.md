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

状态：**实现完成；代理 + virtual display 已恢复真实 Guest 页面并验证 `auth_required`，当前真实 E2E 只阻塞在隔离 headed Profile 的人工 ChatGPT 登录/MFA，尚未验收完成**。

交付：Persistent BrowserContext、manual maintenance login 边界、bounded Page Pool、Selector Registry（选择器注册表）、Auth Probe、`inspect:chatgpt`、Fresh 非流式纯文本 Driver、Chat Completions / Responses 文本响应编码和显式 real E2E harness。

当前已通过确定性 `verify` 与 Docker normal/maintenance Chromium smoke；真实 E2E 已实际启动。直连路径不可用，但 `CHATGPT_PROXY_SERVER` + Xvfb/full Chromium 已进入真实 ChatGPT Guest 页面并验证 `auth_required`；只需隔离 headed Profile 完成人工账号登录/MFA 后继续 authenticated Selector/问答验收。

验收：真实 E2E 能完成 auth/selector inspection、一次 Fresh Driver 文本一问一答，以及至少一次 Gateway HTTP → ChatGPT Web → Chat Completion。未满足前不得进入 Phase 4 实施。

## Phase 4：Conversation + Context Sync

交付：Conversation Key、同会话 Queue、跨会话并行、`FRESH | APPEND | RESTORE | REBUILD`、Page idle（空闲）回收和 URL 恢复。

验收：第二轮不重复灌入第一轮完整历史；进程重启可 RESTORE。

## Phase 5：真 Streaming

交付：Assistant Snapshot、200ms polling、Stable Prefix、Completion Detector（完成检测）、两套 SSE Encoder、Client abort 停止生成。

验收：长回复边生成边输出，无重复、无尾部丢失。

## Phase 6：图片和文件输入

交付：`/v1/files` 生命周期、URL/Base64 图片、Base64 文件、`file_id`、SHA-256、ChatGPT upload readiness（上传就绪）检测。

验收：图片理解和代表性文档上传 E2E 通过。

## Phase 7：Tool Calling

交付：Tool Schema canonicalization（规范化）、fingerprint、Prompt、检测 buffer、Parser、`tool_calls` 输出、Tool Result 回传。

验收：完成“模型 → 工具 → 工具结果 → 最终回答”闭环。

## Phase 8：ChatGPT 图片生成

交付：`/v1/images/generations`、`n=1`、最终图片检测/下载、Gateway URL/Base64、SQLite 记录。

验收：真实 E2E 生成图片并通过 API 返回可读取结果。

## Phase 9：恢复、诊断与 NAS 生产成熟化

交付：分级恢复、结构化错误、日志/诊断、安全加固、NAS 运维与备份/恢复文档，以及对 Phase 1 容器运行边界的生产成熟化。

验收：容器重启不丢 Browser Profile 和 Conversation；维护/恢复流程可操作；普通 `pnpm verify` 不依赖外网。

## Phase 10：V1 验收

覆盖 Chat Completions、Responses、Files、Images Generation、并发会话、Context Sync、浏览器异常恢复和文档/API 一致性。
