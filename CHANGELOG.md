# Changelog（版本修改记录）

本文件记录 ChatGPT Web Gateway 每个公开版本的重要变化。

版本命名与升级规则见 [`docs/versioning.md`](docs/versioning.md)。

## V0.1.3 - 2026-08-31

### Fixed（修复）

- 修复 Pi/OpenAI-compatible 客户端把单个 user text part 序列化为 `content:{type:"text",text:string}` 时被 strict Chat Completions message union 拒绝并返回 400；仅新增这一种 singleton text-object 兼容形状，并规范化为普通 text part。
- 补齐 Assistant history 的 `reasoning` / `reasoning_text` replay metadata allowlist；与既有 `reasoning_content` 一样只在 adapter 边界兼容接收，不进入 Browser Prompt。
- 修复 Cherry Studio 等不发送 `X-Conversation-Key` 的 full-history 客户端每轮都创建新 ChatGPT Web Conversation：Gateway 现在只在唯一一个 clean anonymous persisted Conversation 被现有 Context Sync planner 严格证明为 APPEND/RESTORE 时复用；0 个或多个匹配仍 FRESH，显式 `X-Conversation-Key` 始终优先。
- 匿名续接使用 persisted Conversation id 派生内部 FIFO queue key，并同时覆盖 non-stream、Streaming 与 restart RESTORE；获得 queue slot 后会重新证明原候选仍是唯一 APPEND/RESTORE 匹配，避免两个同时选中同一候选的请求让后到者 REBUILD/覆盖已推进 Conversation；不创建伪造的客户端可见 conversation key。
- Phase 4 authenticated E2E 增加无 header 两轮 full-history continuation gate，要求第二轮保持同一 ChatGPT Conversation URL 且 Web user turn 只包含当前 user 内容。

### Validation（验证）

- focused compatibility/continuity suite：**5 files / 52 tests** 全通过，包含 non-stream / Streaming 两个匿名并发锁后重验证回归。
- fresh `corepack pnpm verify`：**86 test files / 618 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 全绿。
- 使用 `http://192.168.3.83:7890` 与隔离登录 Profile fresh `inspect:chatgpt` 得到 `auth=authenticated` / Composer unique；随后 standalone Phase 4 返回 `append=true / restore=true / rebuild=true / anonymousContinuation=true`。
- 本 PATCH 不改变 Docker runtime、依赖或 SQLite migration，因此不重复 Docker build/smoke；不创建 V0.1.3 Tag / GitHub Release，也不发布 Docker Registry 镜像。

## V0.1.2 - 2026-08-31

### Fixed（修复）

- 修复 Cherry Studio 多轮历史中 Assistant `reasoning_content` / reasoning metadata 被 strict message schema 拒绝导致 HTTP 400；这些字段现在显式兼容接收并在 adapter 边界忽略，不污染 Browser Prompt。
- 扩展 Chat Completions 对 Pi、OpenClaw、Hermes Agent 等 OpenAI-compatible Agent 常见 `store`、`reasoning_effort`、`reasoning`、`parallel_tool_calls`、`service_tier`、prompt-cache/provider metadata 的 strict allowlist；未知顶层字段仍拒绝。
- 扩展 Responses 对当前 Codex CLI request shape 的兼容：message history metadata、function `output_schema`、namespace/custom/freeform tools、custom tool history，以及当前 `web_search` / `tool_search` declarations。namespace/custom 会桥接到现有 external-function protocol；OpenAI-hosted server tools 只接受并过滤，不伪造执行。
- `/v1/models` 同时返回 snake_case 与 Cherry-compatible camelCase 的 capabilities、input/output modalities、Streaming 与 context/max-input/max-output token hints；新增 `MODEL_MAX_INPUT_TOKENS` 与 `MODEL_MAX_OUTPUT_TOKENS` 配置。
- Claude Code 原生 Anthropic Messages 明确不在本次兼容范围。

### Validation（验证）

- 功能分支 fresh `corepack pnpm verify` 连续两次、fast-forward 后本地 `main` 再一次，均通过 **86 test files / 610 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 全绿；`git diff --check` 与 staged 安全检查通过。功能提交 `7d475fe` 已推送 `origin/main` 并经 post-push fetch 确认一致。本 PATCH 不改变 Browser selectors、SQLite schema 或 Docker runtime，因此未重复真实 ChatGPT E2E / Docker build。

## V0.1.1 - 2026-08-31

### Fixed（修复）

- Cherry Studio / OpenAI-compatible Chat Completions 兼容接收 strict `stream_options.include_usage?: boolean`；该字段仅作为兼容 metadata 忽略，不生成 fake token usage chunk，未知字段继续拒绝。
- `GET /v1/models` 增加 `chatgpt-web` 能力、输入模态、Streaming 支持与 `context_window` 扩展元数据；新增 `MODEL_CONTEXT_WINDOW=128000` 可配置 compatibility hint，不声明为 ChatGPT 官方 Web context limit。

### Validation（验证）

- `fix/cherry-studio-compat` 已 fast-forward 合并到 `main`；V0.1.1 版本元数据更新后 fresh `corepack pnpm verify`：**86 test files / 600 tests**，format / lint / typecheck / build / Project Memory / Docs / Architecture / Version 全绿。本地 schema/metadata maintenance change 未运行 Docker 或真实 ChatGPT E2E。

## V0.1.0 - 2026-08-30

### Added（新增）

- 完成 Chat Completions / Responses 主链路，支持 Conversation `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、跨 key 并行、SQLite checkpoint 与真实 DOM Streaming / abort。
- 完成 Files / Attachments：Data URL、URL、Base64、`file_id`、TXT/PDF/DOCX/XLSX、图片上传、文件生命周期、SSRF/DNS/redirect 安全边界与 restart recovery。
- 完成 Tool Calling V2 external-function request protocol、`tool_choice` policy、Tool Result continuation、tool/text Streaming 与 tool-context fingerprint REBUILD。
- 完成 Structured Output `json_object` / `json_schema` 的 Prompt 约束与本地 JSON/Ajv 最终校验。
- 完成 Images Generation `url|b64_json`、生成图片原子持久化、SQLite `generated_images`、SHA-256 integrity 与 restart 后读取。
- 新增 authenticated `/v1/diagnostics`、冷 `backup:data` / `restore:data`、NAS 运维文档，以及正式 `linux/amd64` Docker / noVNC maintenance 边界。

### Fixed（修复）

- 修复 Markdown renderer 尾部回排导致 Streaming committed prefix 分叉的问题，并将稳定尾部 holdback 调整为 64 Unicode code points。
- 修复 Composer Send readiness、Persistent BrowserContext 最后 Page replacement、失败 Page 回池、网络中断状态块与正文 selector 冲突等真实网页生命周期问题。
- 修复 Fastify/Ajv union validation 删除合法 `tool_call_id`、`tool_choice=none` continuation policy、function policy 未进入 fingerprint 等 Tool Calling 边界。
- 修复登出首页多个 `Log in` 控件导致 Auth Probe selector ambiguous，以及跨 URL RESTORE 中 Composer 早于历史 turns 水合导致 Assistant baseline 竞态。

### Validation（验证）

- 发布候选 fresh `corepack pnpm verify`：**86 test files / 595 tests**，format / lint / typecheck / build / Project Memory / Docs / Architecture / Version 全绿。
- 最新 `linux/amd64` Docker image `sha256:866e2b280a1a3ab790c1ab4ae725ec0c1fe345420b7aeec438497806fbd896fa` 与 full `docker:smoke` 已通过。
- authenticated Phase 7 standalone 八项、相邻 Phase 6 standalone 九项、Phase 8 standalone 与 reduced combined Phase 3→8 均已有真实 ChatGPT Web 通过证据。

### Known limits（已知限制）

- ChatGPT DOM、Cloudflare、认证、上传与图片生成 UI/CDN 属于外部变化面；正式 Docker 验收仍只覆盖 `linux/amd64`，ARM64 未验证。
- Images `size/quality/style` 当前只兼容接收并忽略；Structured Output 是 Prompt 约束 + 本地验证，不是原生 constrained decoding。
- 本版本发布 Git Tag / GitHub Release；不发布 Docker Registry 镜像。

## V0.0.1 - 2026-08-14

### Added（新增）

- 建立 ChatGPT Web Gateway 项目骨架与模块目录。
- 固化 OpenAI Compatible API（OpenAI 兼容接口）、Playwright Chromium、Conversation（对话）、Streaming（流式输出）、Tool Calling（工具调用）、附件和图片生成等架构设计。
- 建立 Living Repository（活仓库）治理方式，包括 `AGENTS.md`、`PROJECT_STATE.md`、设计规格和实施计划。
- 加入项目记忆、文档链接和架构一致性检查脚本。
- 添加 MIT License（MIT 开源协议）。

### Status（状态）

- 当前版本仍属于早期项目基础阶段，产品功能尚未完成。
