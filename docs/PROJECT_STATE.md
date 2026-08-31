# Project State（项目状态）

> 这是“当前真实实现状态”的唯一入口。目标、计划和历史不能覆盖这里的事实；详细架构、API 和测试事实分别见 [`architecture.md`](architecture.md)、[`api-compatibility.md`](api-compatibility.md) 与 [`testing.md`](testing.md)。

## Machine State（机器状态）

下面字段会被 `scripts/check-project-memory.mjs` 校验。值变化时必须和正文同步。

```text
PROJECT_STATE_SCHEMA=1
PHASE=phase-10-complete
STATUS=v0.1.3-maintenance-ready-for-git-closure
RELEASE_VERSION=V0.1.3
GOVERNING_SPEC=docs/superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md
ACTIVE_PLAN=docs/superpowers/plans/2026-08-31-v0.1.3-client-continuity.md
NEXT_TASK=commit-integrate-main-reverify-push-and-close-v0.1.3
UPDATED_AT=2026-08-31
```

## Snapshot（快照）

- **当前阶段：** Phase 1–10 的 V1 实现、验收与 feature-branch Git 收口已全部关闭。最终 fresh deterministic、Docker、Phase 7 standalone、相邻 Phase 6 standalone 与 reduced combined Phase 3→8 均已通过；主 acceptance checkpoint `e0d804c` 已正常推送到 `origin/phase-7-tool-calling`。
- **当前状态：** `v0.1.3-maintenance-ready-for-git-closure`。V0.1.3 已完成 Pi singleton user text-object / Assistant reasoning replay schema 兼容，以及 Cherry-style 无 `X-Conversation-Key` full-history 匿名 Conversation 唯一匹配续接；合并前并发审查又补上匿名 FIFO 锁后重验证，防止两个同时选中同一候选的请求让后到者覆盖已推进 Conversation。focused **5 files / 52 tests**、fresh full **86 files / 618 tests** 均通过；使用批准 LAN proxy 的 fresh inspect 为 `auth=authenticated` / Composer unique，standalone Phase 4 返回 `append/restore/rebuild/anonymousContinuation=true`。当前只剩 commit → fast-forward `main` → merged-main re-verify → push → plan closure。`V0.1.0` Git Tag / GitHub Release 仍保留；本次不创建 V0.1.3 Tag / GitHub Release，也不发布 Docker registry image。
- **Governing Spec：** V1 主设计仍是 [`docs/superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md`](superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md)；当前 maintenance 设计见 [`docs/superpowers/specs/2026-08-31-v0.1.3-client-continuity-design.md`](superpowers/specs/2026-08-31-v0.1.3-client-continuity-design.md)。
- **Active Plan：** [`docs/superpowers/plans/2026-08-31-v0.1.3-client-continuity.md`](superpowers/plans/2026-08-31-v0.1.3-client-continuity.md)。实现、文档、full deterministic 与 authenticated Browser continuity 均已完成，当前只剩 Git 收口。
- **最新 deterministic / Docker 基线：** V0.1.3 focused compatibility/continuity suite 通过 **5 files / 52 tests**；fresh full `corepack pnpm verify` 通过 **86 test files / 618 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 全绿。新增两个并发回归分别证明 non-stream / Streaming 在匿名 queue wait 后必须重新验证候选。最近一次 `linux/amd64` Docker 仍是 V0.1.0 release candidate image `sha256:866e2b280a1a3ab790c1ab4ae725ec0c1fe345420b7aeec438497806fbd896fa` + full `docker:smoke` PASS；V0.1.3 不改 Docker runtime、依赖或 migration，因此本 PATCH 不重复 Docker build/smoke。
- **最新真实网页事实：** V0.1.3 使用 `http://192.168.3.83:7890` 与隔离登录 Profile fresh inspect 为 `auth=authenticated` / Composer unique；随后 focused standalone Phase 4 返回 `append=true`、`restore=true`、`rebuild=true`、`anonymousContinuation=true`，其中匿名第二轮保持同一 ChatGPT Conversation URL 且 Web user turn 不重放首轮 token。此前 V1 final Phase 7 standalone、相邻 Phase 6 standalone 与 reduced combined Phase 3→8 的验收事实继续有效。

## Implemented Now（当前已实现）

### 基础运行、持久化与 API

- ✅ TypeScript / Fastify / TypeBox/Ajv / Vitest / pnpm 11 工具链；正式 deterministic 入口为 `corepack pnpm verify`。
- ✅ 正式 `linux/amd64` Docker 边界、Playwright bundled Chromium + Xvfb normal 模式、maintenance-only Google Chrome Stable/noVNC、非 root `PUID/PGID` 与 `/data` Bind Mount。
- ✅ Node 24 `node:sqlite` 单连接、checksum migrations `001/002/003`、Conversation / Message / Tool Call / Attachment / File / Blob / Generated Image persistence。
- ✅ `GET /health`、`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、Phase 6 Files 五接口。V0.1.3 Chat Completions strict 兼容 Pi singleton user text object、Cherry/Pi Assistant reasoning replay history 与 Pi/OpenClaw/Hermes 常见 OpenAI-compatible metadata；Responses 继续兼容当前 Codex message/function/namespace/custom request shapes。compatibility-only metadata 在 API adapter 层消费/忽略，不产生 fake usage/reasoning/server-tool behavior；`/v1/models` 同时暴露 snake_case + Cherry camelCase capabilities/modalities/Streaming/context/max-input/max-output hints。
- ✅ `/v1/*` Bearer authentication；Fastify Ajv 显式 `removeAdditional:false`，避免 union 分支验证删除合法 branch-specific 字段（真实 Phase 7 暴露的 `tool_call_id` 回归）。

### Conversation / Streaming / Attachments

- ✅ `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、different-key parallel、Conversation Page affinity、idle/LRU 回收、SQLite `clean | in_flight` checkpoint 与 restart RESTORE/REBUILD；V0.1.3 对无 `X-Conversation-Key` full-history 客户端增加唯一 anonymous candidate APPEND/RESTORE 与 persisted-id internal FIFO，歧义时保持 FRESH；内部 FIFO 获锁后再次验证候选，若并发请求已推进原 Conversation 则当前请求 FRESH。
- ✅ Chat Completions / Responses True DOM Streaming、backpressure、abort/Stop、final-clean-before-success-terminal，以及默认 **64 Unicode code points** Stable Prefix commit-tail holdback。Assistant authoritative text 使用 owned turn 内唯一 `.markdown.prose`；非 prose `.markdown` 网页状态块不计入正文 cardinality，多个 prose 正文仍严格拒绝。
- ✅ Phase 6 图片/文件输入、`/v1/files` lifecycle、Data URL / URL / Base64 / `file_id`、SSRF/DNS/redirect/pinned-address 安全边界、ChatGPT upload readiness 与 restart recovery；Phase 6 authenticated real E2E 已关闭。

### Phase 7 Tool Calling V2

- ✅ function Tool declarations canonicalization + stable SHA-256 **tool-context** fingerprint；fingerprint 同时绑定 canonical definitions、private protocol version 与 normalized `tool_choice`/function policy。declaration reorder 且 policy 不变不 REBUILD；schema/name/description/parameters、协议版本或 policy 变化触发 `REBUILD(reason='tools_changed')`。
- ✅ `tool_choice=auto|none|required|function`；`none` 在模型 Prompt 中显式携带最小禁止策略，但不注入 function schema/protocol。Conversation core 仍只理解 external function；V0.1.2 Responses adapter 可把 namespace/custom/freeform declarations 桥接为该 function representation，并在输出时恢复 Responses shape；OpenAI-hosted `web_search/tool_search` 只过滤、不执行。
- ✅ 模型侧改为 external-function request semantics：固定 `<<<EXTERNAL_FUNCTION_REQUESTS_V1>>>` envelope；caller-defined function 被描述为 Gateway 外部操作，ChatGPT 只生成 request records，不假装拥有或执行函数。
- ✅ strict Parser、ToolDetectionBuffer、Gateway-owned `call_<32 hex>` persisted IDs、Tool Result continuation、restart round-trip、Chat Completions / Responses non-stream + stream function-call encoding。
- ✅ tool result/output 均按不可信 data 处理；普通网页 Prompt 不加入无必要 Gateway/agent 身份话术。
- ✅ final authenticated Phase 7 standalone 已证明 forced-function → `none` **policy-change REBUILD**、same-policy restart **RESTORE**、single/multiple tool、tool/text Streaming 与 schema REBUILD 全部通过；reduced combined Phase 3→8 中 Phase 7 八项再次全绿。跨 URL RESTORE 额外等待历史 user/assistant turn 水合稳定，避免 Composer 先就绪时误捕获旧 Assistant baseline。

### Structured Output

- ✅ Chat Completions `response_format=json_object/json_schema` 与 Responses `text.format=json_object/json_schema` 不再返回 Phase 7 501。
- ✅ Structured constraint 作为 JSON-safe Prompt policy 注入；`json_schema` 在 Browser execution 前用本地 Ajv compile，无效 schema 请求前拒绝。
- ✅ 最终 Assistant text 必须是完整 JSON object；`json_schema` 还需通过同一 schema 本地校验。失败返回稳定 `chatgpt_structured_output_invalid`，不保存 clean success、不发送成功 stream terminal。
- ✅ 明确属于 **prompt-constrained + local validation** 兼容，不声称 ChatGPT Web 具备原生 constrained decoding。

### Phase 8 Images Generation

- ✅ `POST /v1/images/generations`：`prompt`、只支持 `n=1`、`response_format=url|b64_json`；`size/quality/style/model/user` 仅接受为 ignored compatibility metadata，不伪造网页精确控制。
- ✅ 独立 `ImageGenerationService` + ChatGPT image Driver：Fresh page，最小 `Create an image: ...`；Send 前记录 conversation-turn 图片 baseline，只检查本请求新增、可见、loaded、至少 256×256 的图片候选，不依赖文本 Assistant role/copy completion marker；相同 `currentSrc || src` 的重复 DOM copy 去重为一个生成资源，不同图片源仍稳定拒绝。
- ✅ 最终 bytes 经 PNG/JPEG/WebP/GIF signature sniff，`${DATA_DIR}/generated` 同目录 temp → rename 原子写入，`generated_images` SQLite record + SHA-256 integrity；DB insert 失败删除刚写文件。
- ✅ authenticated `GET /v1/images/:id/content`；可选安全 `PUBLIC_BASE_URL` 只改变 URL base，不绕过 Bearer auth。
- ✅ standalone Phase 8 URL/Base64/persistence/restart E2E harness 已编写；combined harness 已扩展到 Phase 3→8。
- ✅ Phase 8 authenticated standalone 已完整通过：`url=true`、`base64=true`、`persistence=true`、`restart=true`。真实验收先后暴露并关闭 image-only Assistant ownership 与 duplicate generated-asset DOM copy 两个问题；最终 bytes/SQLite/磁盘 SHA-256/restart read 均已证明，并已在最新 PagePool lifecycle 修复后的 reduced combined Phase 3→8 中再次通过。

### Phase 9 Production Maturity

- ✅ failed keyed/transient Conversation Page 直接关闭，不重新放回 idle pool；下一请求获取新 Page 后按 SQLite 状态 RESTORE/REBUILD 收敛。
- ✅ failed Page 仍真正关闭；若它是 Persistent BrowserContext 的最后一个 tracked Page，PagePool 先创建 fresh idle replacement 再关闭 failed Page，避免 Page-level failure 错误触发 context death。Persistent BrowserContext 真正 unexpected close 仍触发 fatal callback；生产入口有序关闭后非零退出，复用 Compose `restart: unless-stopped` 重建 Chromium/Context，同时保留 `/data`。
- ✅ authenticated `GET /v1/diagnostics` 只报告 bounded local Browser/Page/Persistence snapshot，固定 `auth_state=not_probed`；不暗访 ChatGPT、不返回 API Key/Cookie/proxy/Profile/Prompt/Tool data/content bytes。
- ✅ `backup:data` / `restore:data` 冷备份 CLI：必须显式 `--gateway-stopped`，backup destination 位于 DATA_DIR 外且不存在，manifest schema 校验，restore 目标必须为空；完整 `/data`（包括 SQLite、Profile、Files、Generated Images）为备份边界。
- ✅ backup/restore byte-for-byte round-trip deterministic test 已编写；[`operations.md`](operations.md) 已记录 NAS 首次部署、登录、更新、冷备份/恢复、诊断与回滚流程。

## Acceptance Evidence（验收证据）

1. ✅ final candidate fresh `corepack pnpm verify` + governance + `git diff --check`：**86 test files / 595 tests** 全绿。
2. ✅ fresh `linux/amd64` image `sha256:866e2b280a1a3ab790c1ab4ae725ec0c1fe345420b7aeec438497806fbd896fa` + full `corepack pnpm docker:smoke` PASS；构建显式使用批准 LAN proxy。
3. ✅ latest authenticated standalone Phase 5 已通过 `chatCompletions/markdown/responses/abort=true`；final adjacent Phase 6 four-group harness 九项完整 PASS；Phase 8 standalone `url/base64/persistence/restart=true` 已通过。
4. ✅ final Phase 7 standalone 八项语义结果全部 `true`，包含 policy-change REBUILD 与 same-policy restart RESTORE。
5. ✅ reduced combined Phase 3→8 退出码 0；Phase 3/4/5/7/8 全绿，Phase 5 abort 与 Phase 6 attachment matrix 按治理由相邻 standalone 证据承担。
6. ✅ Git / release closure：feature branch 已 fast-forward 合并到 `main`；`V0.1.0` 发布元数据同步 `VERSION` / `package.json` / `CHANGELOG` / Project State，并创建同名 Git Tag / GitHub Release。Docker registry image 未发布。

## Architecture Facts（当前关键边界）

- ChatGPT Web only；不调用或逆向私有 `/backend-api`。
- 默认只暴露 `chatgpt-web`；不伪造具体 OpenAI API 模型或 token usage。`MODEL_CONTEXT_WINDOW=128000`、`MODEL_MAX_INPUT_TOKENS=context window`、`MODEL_MAX_OUTPUT_TOKENS=32768` 仅作为 `/v1/models` compatibility hints，以 snake_case + Cherry camelCase aliases 暴露，不代表 ChatGPT Web 官方固定 token limit；对话模型不声明独立 Images endpoint 的 `image-generation` 能力。
- SQLite 是 Conversation/File/Generated Image 恢复事实来源；Page 是可丢弃 runtime cache；same-key Queue 是单进程写序列化边界。
- Browser upload/image generation 是网页 side effect；未知 post-checkpoint Conversation failure 保持 `in_flight` 并由下一请求 REBUILD 收敛。
- Tool definitions/results、Structured Output schema、附件来源都按不可信客户端数据处理；Gateway 不执行 caller-defined functions、Shell、HTTP plugin 或 MCP tool。
- Docker 是正式运行边界；Docker smoke 不等于 authenticated ChatGPT E2E。
- 冷备份包含 ChatGPT Browser Profile 和用户数据，属于高敏感凭据/内容；不提供 hot backup 一致性承诺。

## Recent Milestones（最近里程碑）

- 2026-08-31：V0.1.2 OpenAI-compatible Agent maintenance 已完成：Cherry reasoning history、Pi/OpenClaw/Hermes metadata、Codex Responses namespace/custom bridge、server-tool filtering 与模型 compatibility metadata 均已收口；功能分支和 merged `main` fresh deterministic 均为 **86/610**，功能提交 `7d475fe` 已推送 `origin/main`。Claude Code 不在范围；本次未创建 Tag/Release、未发布 Docker 镜像。
- 2026-08-31：Cherry Studio compatibility maintenance 已 fast-forward 合并到 `main`，仓库版本由 `V0.1.0` 升级为 `V0.1.1`。Chat Completions strict 接收并忽略 `stream_options.include_usage?: boolean`、不伪造 usage；`/v1/models` 增加能力/输入模态/Streaming/context metadata，`MODEL_CONTEXT_WINDOW` 默认 `128000`。版本更新后 fresh deterministic 为 **86 test files / 600 tests**；本地 schema/metadata 变更未运行 Docker 或真实 ChatGPT E2E，且本次未创建 `V0.1.1` Tag / GitHub Release。
- 2026-08-30：`phase-7-tool-calling` 以 fast-forward 合并到 `main`；公开版本从 `V0.0.1` 提升到 `V0.1.0`，同步 CHANGELOG / README / Project State，并按显式发布指令创建同名 Git Tag / GitHub Release；Docker registry image 未发布。
- 2026-08-29：最终 V1 acceptance 收口。function-policy fingerprint、cross-URL RESTORE history hydration 与多登录入口 Auth Probe 均修复；fresh deterministic **86/595**、fresh Docker/full smoke、Phase 7 standalone、紧邻 Phase 6 standalone 与 reduced combined Phase 3→8 全部通过。staged diff/secret 检查完成后，主 acceptance commit `e0d804c` 已正常推送到 `origin/phase-7-tool-calling`。
- 2026-08-28：multiline Composer paste + Phase 6 current-attachment prompt + combined request-budget 候选 fresh **86/580** deterministic 与 `linux/amd64` image `sha256:193c8c89f973887815e5a4dede95803dbaccc45095b86297a8093f6302e0d3c7` + full smoke 通过；standalone Phase 5 四项随后真实通过。final combined 在 Phase 6 image `file_id` 一次 token mismatch 后停止；focused Phase 6 两轮失败位置又分别移动到 TXT timeout 与 XLSX missing response，第二轮已真实通过图片/TXT/PDF/DOCX。为降低无价值重复请求，combined Phase 6 全矩阵现由紧邻 standalone gate 取代，runner 显式输出 `attachmentMatrix=not_run_in_combined`。
- 2026-08-28：PagePool replacement-before-close 候选完成 fresh deterministic/Docker 并通过 standalone Phase 5；随后 final-candidate combined Phase 3→8 两次暴露同一网络中断 DOM 状态块与正文 `.markdown` 冲突，当前候选把 authoritative Assistant text 收紧为 `.markdown.prose` 后等待统一复验。
- 2026-08-27：Phase 7 `tool_choice=none` continuation 修复后 standalone V2 七项真实通过；Phase 8 image-only ownership + duplicate-resource 去重后 standalone `url/base64/persistence/restart` 全部通过。随后 combined Phase 5 abort 暴露 Persistent BrowserContext 最后 Page close 会带死 context；PagePool 当前候选改为 replacement-before-close。
- 2026-08-27：Phase 8 Images 与 Phase 9 Structured Output/recovery/diagnostics/cold-backup implementation candidate 收口；新增 standalone Phase 8 + combined Phase 3→8 harness、backup/restore round-trip test、`/data/generated` Docker smoke boundary 与 NAS operations guide。
- 2026-08-27：Phase 7 根据真实网页拒绝证据从 pseudo/native Tool wording 改为 V2 external-function request protocol；协议版本进入 fingerprint。此前同时修复 Fastify/Ajv union validation 删除 `tool_call_id` 的真实缺陷。
- 2026-08-27：新 LAN proxy `192.168.3.83:7890` 恢复 ChatGPT 网络，fresh inspect 返回 authenticated / unique Composer；旧 V1 standalone 真实进入网页链。
- 2026-08-26：最终 combined Phase 3/4/5/6 authenticated real E2E 退出码 0；Phase 6 关闭。验收期间修复 Markdown 38-code-point 尾部回排与 Composer Send readiness 竞态。

## Known Risks / Limits（已知风险 / 限制）

- Phase 7 function-policy Context Sync 与 cross-URL RESTORE hydration 根因均已修复并通过 standalone + combined；仍需持续防范 ChatGPT DOM/历史加载时序变化，不能把 Composer ready 等同于 Conversation history ready。
- Phase 6 final standalone、Phase 8 standalone、PagePool lifecycle、`.markdown.prose` selector、multiline abort→REBUILD 与 final combined 都已有真实通过证据。
- ChatGPT DOM、Cloudflare、认证、图片生成 UI/CDN、上传格式与平台频率保护仍可能变化；Phase 8 request-scoped image baseline + duplicate-resource dedup 已通过 standalone，并在最新 PagePool 生命周期修复后的 reduced combined 中证明可共存。
- Images `size/quality/style` 当前只是兼容接收/忽略，不承诺精确控制；只支持 `n=1`，不支持 edits/variations/partial image streaming。
- Structured Output 是 Prompt 约束 + 最终本地验证，不是原生 constrained decoding；模型不满足格式时请求会稳定失败，而不是 Gateway 修复/伪造 JSON。
- `/v1/models` 已同时返回 snake_case 与 Cherry-compatible camelCase aliases；客户端仍可能对自定义 OpenAI provider 做自己的字段裁剪，因此最终 UI 呈现仍取决于客户端版本。token limits 都只是 Gateway compatibility hints。
- Stable Prefix 64-code-point holdback 只吸收当前 bounded tail rewrite；更深 rewrite 穿过 committed prefix 仍 `chatgpt_stream_diverged`。
- Remote URL image input 的 SSRF/DNS/redirect/pinned-address 链已有 deterministic coverage，但此前没有稳定公网 fixture 的 live remote-fetch E2E。
- Files DELETE 不是立即 secure erase；历史 Attachment 引用可延长内部 bytes 生命周期。
- 正式 Docker 验收矩阵仍只覆盖 `linux/amd64`，未验证 ARM64。
