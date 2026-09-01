# Testing Strategy（测试策略）

## 原则

测试要证明行为边界，而不是只证明“Playwright 能启动”。真实 ChatGPT Web（ChatGPT 网页）变化与纯业务逻辑必须分开测试。

## Unit（单元测试）

不得访问网络或真实浏览器。重点覆盖：

- OpenAI Schema（结构）→ `NormalizedRequest`；Chat Completions `stream_options.include_usage?: boolean`、Cherry/Pi Assistant `reasoning_content` / `reasoning` / `reasoning_text` history、Pi singleton user text object `content:{type:"text",text:string}`、Pi/OpenClaw/Hermes 常见兼容 metadata 保持 strict allowlist；兼容 metadata 在 adapter 边界丢弃，singleton text object 规范化成普通 text part；Responses 覆盖当前 Codex message/function/namespace/custom/server-tool 请求形状，未知字段仍拒绝。
- Runtime config 默认值/覆盖/非法值，包括 `MODEL_CONTEXT_WINDOW`、`MODEL_MAX_INPUT_TOKENS`、`MODEL_MAX_OUTPUT_TOKENS` 正整数 compatibility hints。
- `FRESH | APPEND | RESTORE | REBUILD`。
- Message canonicalization（消息规范化）与 fingerprint（指纹）。
- Stable Prefix（稳定前缀）。
- Phase 7 Tool Schema canonicalization、tool-context fingerprint（definitions + private protocol version + normalized `tool_choice`/function policy）、`tool_choice` validation、V2 external-function Prompt / strict Tool Parser、Tool Detection Buffer。
- Structured Output policy、JSON object parse、JSON Schema compile/validation 与 final-success gate。
- Phase 8 Images request normalization、request-scoped conversation-turn image baseline ownership、zero/one/multiple candidate selection、signature sniff、atomic storage、SHA-256 integrity 与 `PUBLIC_BASE_URL` validation。
- Phase 9/V0.1.4 diagnostics active probe（authenticated/auth_required/unknown、capacity/probe failure、lease release）、failed Page discard、Persistent BrowserContext last-Page replacement-before-close、unexpected BrowserContext close signaling，以及 cold backup/restore CLI guards/round-trip。
- V0.1.4 Composer transport：单行保持 `keyboard.insertText()`、普通多行保持单次 ProseMirror `text/plain` paste、>16 KiB UTF-8 多行 Prompt 使用 ≤4 KiB UTF-8 安全 insert chunks + `Shift+Enter`；Driver unknown Page failure 只附加 operation/page/prompt-size bounded diagnostics 并保留 cause，不含 Prompt 正文。
- Compose proxy boundary：`host.docker.internal:host-gateway` 与可选 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` passthrough。
- MIME（媒体类型）、strict Base64/Data URL、PNG/JPEG/WEBP/GIF signature sniff、URL 输入解析。
- Phase 6 SSRF/DNS/redirect/pinned-address guard、16 attachment / 32 MiB single / 64 MiB request limits、filename policy、request staging hardlink/copy/cleanup。
- 文件 SHA-256 去重。
- OpenAI 错误映射。
- SQLite PRAGMA、checksum migration、失败 migration rollback。
- Conversation / Message / Tool Call / Attachment / File / Generated Image Repository 约束与 JSON round-trip。
- `ConversationStore` aggregate validation 与同步事务边界。
- Phase 3 Page Pool capacity/reuse/close、BrowserManager lifecycle、Selector Registry unique/collection/fallback/missing/ambiguous。
- Auth Probe authenticated/auth_required/unknown（Composer 仍要求唯一；登录入口按 collection 信号处理，因为当前登出首页可同时出现多个可见 `Log in` 控件）、Driver turn ownership、authoritative `.markdown.prose` 正文与非 prose `.markdown` 状态块隔离、completion stable sampling/timeout、primary completion marker、stalled original Page 的 same-Conversation reload verification（本轮先观察到唯一 Stop、无非-prose 状态、同一正文稳定达到阈值；临时 verifier 必须在同一 target index 得到 exact text + 正式 marker）、从未观察到生成态时禁止启动 verifier、verifier 必须关闭且不得输入/Send，以及 Stop control inspect→click detach race 的 bounded cancellation、Phase 4 `openFresh` / `openConversation` / `sendText` 分离、安全 Conversation identity 校验、跨 URL RESTORE 在 Composer readiness 后再次校验 URL，并等待既有 user/assistant turn 成对稳定且末个 Assistant completion marker 就绪后才允许捕获下一轮 baseline。
- Phase 4/6 `incremental | full` 分类、`FRESH | APPEND | RESTORE | REBUILD` 纯 Planner、`clean | in_flight` checkpoint、ordered multimodal canonical content/fingerprint、四-mode attachment upload selection、普通单条 user 文本 + 已上传附件直接 Browser Prompt（不额外包 JSON/context wrapper）、Context Envelope 敏感字段排除、同 key FIFO、Conversation Page affinity/idle+LRU eviction、Conversation Engine 原子成功/未知失败收敛语义；V0.1.3 额外覆盖无 key 完整历史的唯一 anonymous APPEND/RESTORE、restart、Streaming、多候选歧义 FRESH，以及两个并发匿名请求在同一 queue slot 前同时选中候选时的锁后重验证，防止第二个请求覆盖已推进 Conversation。2026-09-01 Pi continuity regression 额外要求 anonymous FRESH 首轮成功后以 generated persisted Conversation id 保留 Page affinity，non-stream 同 runtime 第二轮必须在同一个 Page 对象 APPEND；Streaming 首轮也必须建立同样 affinity，restart 仍由既有 RESTORE regression 覆盖。
- Chat Completions / Responses 非流式文本 Encoder 与 stable Browser/Driver/API error mapping。
- Chat Completions / Responses SSE Encoder，包括 Phase 7 `tool_calls` / `function_call` 生命周期与 private protocol 防泄漏。

## Integration（集成测试）

使用 local fixture（本地固定样本）和 fake driver（假驱动），不连接 ChatGPT：

- Phase 1：Fastify HTTP → Schema → Normalizer → injected fake execution boundary；Cherry Studio `stream_options.include_usage + reasoning history`、Pi singleton user text object + Assistant `reasoning/reasoning_text`、Pi/OpenClaw/Hermes-style Chat Completions metadata，以及当前 Codex Responses function/namespace/custom/server-tool + request metadata 都有 deterministic HTTP regression，证明不会在 schema 层误报 400；compatibility-only metadata 不产生 fake usage/reasoning/server-tool behavior。
- `GET /v1/models` authenticated integration 覆盖 snake_case + Cherry-compatible camelCase 能力/模态/Streaming/token metadata，以及默认/自定义 context/max-input/max-output hints，不连接 ChatGPT。
- Phase 2：真实临时 SQLite 文件 → migration → aggregate save → close → reopen → aggregate/File recovery。
- Phase 2：Gateway runtime 在 Fastify readiness 前创建/迁移 `${DATA_DIR}/gateway.db`，shutdown 幂等关闭 SQLite。
- Phase 3：POST route → Normalizer → injected/fake execution result → Chat Completions / Responses Encoder，全程不访问真实 ChatGPT。
- Phase 4：Gateway runtime headless → BrowserManager → Conversation Queue → Page Registry → Conversation Engine → fake ChatGPT Driver → SQLite ConversationStore；maintenance 模式不启动产品 BrowserManager/Queue/Registry。
- Phase 4：同 key HTTP 请求 FIFO、不同 key 可并行；full-history 与 single-user incremental APPEND 都不重发已确认前缀；close/recreate runtime 后 RESTORE 使用持久化 Conversation URL；post-checkpoint unknown failure 保持 `in_flight` 并在下一轮 REBUILD。
- Phase 6 Task 1/2：真实临时 SQLite + 文件系统 → migration 003 → SHA-256 Blob dedup → `/v1/files` multipart streaming create/list/retrieve/content/delete → close/reopen runtime → exact content recovery；private File 不进入公开 list，DELETE 保持历史 Attachment 引用边界。
- Phase 6 Task 6：真实临时 SQLite/FileService + AttachmentResolver + fake Driver 覆盖 same-key queue 内 resolve、Page acquire 前 staging、checkpoint-before-Browser-upload、FRESH/APPEND/RESTORE/REBUILD upload selection、redacted AttachmentRecords + required File refs，以及 stream pre-start resolver failure / post-start upload failure/abort / final-save failure 的 `in_flight` 收敛。
- Phase 6 Task 7：真实 Fastify HTTP + 两套 Normalizer + shared Conversation Engine/Resolver/FileService + fake Driver 覆盖 Chat Completions image URL/Data URL/file data/`file_id`、Responses `input_image` URL/Data URL/`file_id` + `input_file` data/`file_id`、双协议 stream/error framing、same-key slow resolve FIFO、different-key parallel、pre-start `file_not_found`、post-start `chatgpt_upload_failed` 与 Phase 7 capability gate 回归。
- Phase 7：canonical Tool Call / Tool Result message fingerprint，pending tool-result validation，tool definition/private protocol/function-policy fingerprint change → `REBUILD tools_changed`，SQLite ToolCall/Result round-trip、Gateway-owned external call ID、相同 policy 的 tool-result APPEND/RESTORE、policy 改变时 Tool Result continuation REBUILD、`tool_choice=none` context Prompt 且 tool-result pending 不被误写成 pending user 的回归、single/multiple call、两套 non-stream/stream encoder、post-start parser error 无成功 terminal，以及 tools + attachments 共存回归。
- Phase 8：真实临时 SQLite + generated filesystem + fake Page Pool/Image Driver 覆盖 URL/Base64 shapes、authenticated content route、maintenance mode、storage rollback/restart recovery 与 GeneratedImage persistence。
- Phase 9/V0.1.4：Structured Output preflight/final validation、failed Page close、last failed Page 关闭前创建 fresh idle replacement、BrowserContext fatal callback、authenticated active diagnostics sensitive-field/capacity/release boundary、普通 HTTP mapped 5xx 与 post-200 SSE execution failure 结构化日志，以及 backup → restore byte-for-byte DATA_DIR round-trip。
- Client abort（客户端断开）→ stop generation。

## E2E（端到端）

真实 ChatGPT E2E 默认关闭，而且必须同时显式提供**独立于生产**的测试 Browser Profile：

```bash
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm inspect:chatgpt

E2E_CHATGPT=1 \
E2E_CHATGPT_COMBINED=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase3

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase4

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase5

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase6

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase7

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase8

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:pi-runtime
```

`CHATGPT_PROFILE_DIR` 缺失会 fail fast；如果解析到生产 `${DATA_DIR}/browser-profile/` 也会拒绝运行。测试 Profile 不得使用个人日常浏览器 Profile，登录由人工完成；E2E harness 不自动填写账号密码、MFA 或 CAPTCHA。需要代理时显式设置 `CHATGPT_PROXY_SERVER`；只接受 `http` / `https` / `socks5` server origin，URL 内禁止账号密码。combined `test:e2e:chatgpt` 额外要求 `E2E_CHATGPT_COMBINED=1`，避免调试单一 Phase 时误跑整套真实网页回归。

### 真实 E2E 请求预算与退避

真实 ChatGPT E2E 是昂贵且会创建网页 Conversation 的外部验收，不作为普通调试循环：

1. deterministic/unit/integration 失败时不得访问真实 ChatGPT；先在本地收敛。
2. 真实网页问题先运行最窄 standalone Phase；禁止用 combined suite 定位一个已知单 Phase 失败。
3. combined Phase 3→8 只在 standalone 相关 Phase 已通过、代码达到最终候选时运行，并要求额外 `E2E_CHATGPT_COMBINED=1`。为避免重复制造最昂贵且最容易触发外部断线/频率保护的请求：combined 的 Phase 5 只复验 Chat Completions / Markdown / Responses，不重复 abort→Stop→REBUILD；combined 的 Phase 6 不重复完整九项附件矩阵，而显式报告 `attachmentMatrix=not_run_in_combined`。Phase 5 abort 与 Phase 6 全矩阵都必须由紧邻 combined 之前的 focused standalone gate 单独证明。
4. 同一种真实网页失败最多允许立即复现一次；第二次仍失败后停止重复真实请求，转为 deterministic、DOM inspection、network diagnostics 或代码路径分析，直到形成新的可验证假设。
5. 出现 HTTP 429、ChatGPT history access restriction、平台“请求过于频繁”或同类频率保护时，立即停止全部 real E2E；不得通过新建平行 ChatGPT 会话、换测试入口或连续重试绕过限制，等外部限制解除后再从 standalone 恢复。
6. 不为了验证 E2E harness 的治理/节流改动本身而访问真实 ChatGPT；此类改动用 gate、scenario grouping、typecheck 和 deterministic tests 验证。
7. Phase 6 standalone 当前预算固定为四个逻辑 ChatGPT Conversation group：images、documents-primary、documents-secondary、memory/restore。图片两个场景共用 images；XLSX + TXT 共用 documents-primary；PDF + DOCX 共用 documents-secondary；memory/restore 只允许 **1 个新附件 turn**：该首轮同时承担 attachment Streaming 验证与 memory seed，随后 APPEND/RESTORE 不再上传新文件。四组新附件 turn 固定为 **2 / 2 / 2 / 1**。每个附件 turn 仍使用唯一 token 并验证各 Conversation 内累计 AttachmentRecords。2026-08-29 focused live 证据先证明同一 documents Conversation 的第 4 个连续新文档分析 turn会稳定出现 `chatgpt_response_missing`；后续整轮又证明第 3 个新附件 turn 即使明确要求忽略历史附件，模型仍可能选择更早 PDF token；把 Streaming 放到 memory Conversation 后，第二个 memory 附件又会让 restart RESTORE 错回忆更早 Streaming token。因此最终 harness 把 Streaming 与 memory seed 合并为同一个首轮附件请求，在**不增加四个 Conversation 数量**的前提下消除历史附件歧义并减少一次真实请求。当前附件读取 prompt 仍必须明确只读取**本轮新附加**的文件/图片并忽略更早附件，避免模型选择历史资源造成假阴性。
8. Phase 7 standalone 固定为五个逻辑 ChatGPT Conversation group：single tool + result continuation 的 **function-policy-change REBUILD** + 随后 same-policy restart RESTORE 共用一组；multiple tools、stream tool、stream auto text、schema/protocol-change REBUILD 各一组。Gateway 不执行测试函数；结果由 harness 确定性回传。policy-change REBUILD 不新增 Conversation group，只在同一逻辑组内验证 URL 改变；stable-policy restart 再验证 URL 保持。
9. Phase 8 standalone 固定为两次真实图片生成：一次 `url`，一次 `b64_json`。URL 场景同时核对 authenticated content bytes、SQLite GeneratedImage record、磁盘 bytes/SHA-256，并在关闭后以新 Gateway runtime 重新读取同一 persisted image；不通过额外重复图片请求验证 harness 自身。
10. V0.1.4 Pi Browser runtime standalone 必须启动服务器实际安装的 `pi` CLI，而不是手工伪造 HTTP body；使用隔离 `PI_CODING_AGENT_DIR`、临时 OpenAI-compatible provider/extension、精确 16 active tools，并以同一个 Pi `session-id/session-dir` 连续发送两个最终用户请求。首轮完成后 harness 额外占用一个 PagePool distractor lease：如果 anonymous FRESH 没有正确保留自己的 Page affinity，第二轮就会被迫拿另一个 Page。若安装包装器设置代理，保留该包装器，仅把本地 Gateway listener 合并进 `NO_PROXY/no_proxy`。成功门槛包括两次真实 Pi 输出都正确、`gatewayRequests=2`、导航序列严格为 `fresh → conversation`、第二次 `openConversation` 使用首轮同一个 Page、首轮 Browser Prompt >16 KiB UTF-8 且 16 tool names 全部保留，以及第二轮只 APPEND 当前 turn、不得重新携带首轮 token/大型 Context Prompt。

2026-08-15 Phase 3 已实际运行真实命令并通过最终验收。DevSpace 直连 `chatgpt.com` 的系统 DNS/HTTPS 路径不可用，显式 `CHATGPT_PROXY_SERVER` 恢复网络；Xvfb + full Playwright Chromium 可进入 ChatGPT 网页。隔离 Profile 通过 maintenance Google Chrome Stable 人工登录后，真实 `inspect:chatgpt` 得到 `auth=authenticated`、`composer=unique`；完整 `test:e2e:chatgpt` 随后同时得到 `driverChallenge=true` 与 `gatewayChallenge=true`。

Phase 3/4/5/6/7/8 均提供 standalone 入口；主 `test:e2e:chatgpt` 只用于最终候选 combined regression，并按 Phase 3 → 4 → 5 → Phase 6 standalone-evidence marker → 7 → 8 顺序收口。V0.1.3 的 Phase 4 standalone 在既有 keyed APPEND/RESTORE/REBUILD 后增加一个两轮 anonymous full-history continuation：第二轮不得把第一轮 user token 重发到新的 Web user turn，并必须保持同一个 persisted ChatGPT Conversation URL；该 focused live gate 用来证明 Cherry-style 无 header 续接确实到达 Browser continuation 语义。Phase 6 不在 combined 内重复真实附件矩阵，因为各 Phase harness 本身使用独立 runtime/profile，重复九项不会增加共享状态覆盖；最终 acceptance 绑定紧邻 combined 前的 standalone Phase 6 九项全绿证据。Phase 4 harness 真实走 Gateway HTTP，验证 full-history APPEND 后 live ChatGPT user turn 只含新 marker、不含第一轮 token；随后 close/recreate runtime，以 single-user incremental 请求验证 RESTORE；最后提交修改后的 full history 强制 REBUILD，并要求 local key/UUID 不变而 ChatGPT URL 改变。Harness 会把显式隔离源 Profile 复制到临时 Profile 并排除 Chromium `Singleton*` marker，避免测试污染/锁死人工登录基准 Profile；复制行为有确定性单测。2026-08-16 新的干净隔离 Profile 通过 maintenance Google Chrome Stable 登录后，`inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`；combined E2E 最终真实返回 Phase 3 `driverChallenge=true` / `gatewayChallenge=true` 与 Phase 4 `append=true` / `restore=true` / `rebuild=true`，Phase 4 real E2E 验收完成。

隔离 E2E Profile 可通过 maintenance overlay 人工登录：设置 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile` 后，maintenance Google Chrome Stable 使用该测试 Profile；normal headless runtime 仍固定使用 `${DATA_DIR}/browser-profile/`。真实调试证明 Chrome for Testing 在 `auth.openai.com` Turnstile 会反复 challenge，而固定 Google Chrome Stable 能通过人工验证；maintenance 因此不使用产品 Playwright 浏览器。若一个**已失效**的隔离 Profile 在重新认证时再次陷入 challenge loop，不要把“曾经用 Stable Chrome 成功”理解为该旧 Profile 必然可恢复：保留旧 Profile，不继续重复验证，创建一个新的干净隔离 Profile，用 Stable Chrome 登录后先跑 `inspect:chatgpt`，确认 `auth=authenticated` 再运行 real E2E。

目标场景：

1. 登录状态检查。
2. 普通文本一问一答。
3. 多轮 APPEND。
4. Gateway 重启后 RESTORE。
5. 长回复真 Streaming。
6. Markdown / 代码块 Streaming。
7. 图片输入。
8. PDF / TXT / DOCX / XLSX 代表性文件输入。
9. Tool Calling 单工具和多工具。
10. Tool Result 回传后继续回答。
11. ChatGPT 图片生成。
12. Page 回收后重新打开原 Conversation URL。

Phase 6 Task 5 已于 2026-08-19 完成 authenticated DOM inspection：当前网页有唯一 generic `input[type=file]:not([accept])`，owned file tile 用 baseline count 归属；pending 时 tile 内存在 `cursor-wait` / progress circles，ready 时两者同时消失；0-byte fixture 会新增 `role=alert` 并被映射为 upload failure。`inspect:chatgpt` 可通过 `CHATGPT_ATTACHMENT_PROBE_PATH` 运行受控、不点击 Send 的 readiness probe，并在完成后 reload Composer。

2026-08-21 standalone Phase 6 real E2E 真实通过 Data URL image、image `file_id`、TXT、PDF、DOCX、XLSX、same-key APPEND、runtime restart RESTORE 和 attachment Streaming，并要求最终 Conversation 保持 clean 的 Attachment → File → Blob linkage。随后真实网页调试修复了 Markdown 38-code-point 尾部回排与 Composer fill 后 Send 短暂未挂载两个回归。2026-08-26 最终 combined Phase 3/4/5/6 real E2E 以退出码 0 完成，Phase 3 `gatewayChallenge=true`、Phase 4 `append/restore/rebuild=true`、Phase 5 `chatCompletions/markdown/responses/abort=true`、Phase 6 九项均为 `true`，因此 Phase 6 authenticated real E2E 门槛关闭。Remote URL image fetch 的 SSRF/DNS/redirect 安全链由 deterministic tests 覆盖；本轮没有使用公网 fixture 做 live remote-fetch E2E。完整设计见 [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。

2026-08-27 新 LAN proxy `http://192.168.3.83:7890` 已恢复真实 ChatGPT 网络；正确的隔离 re-auth Profile fresh `inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique` / `sendButton=unique`。standalone Phase 7 V1 真实执行先暴露 Fastify/Ajv union validation 删除合法 `tool_call_id` 与 pseudo/native Tool 语义拒绝，均已转为确定性修复/V2 external-function request protocol；随后 V2 restart Tool Result continuation 又暴露当前轮 `tool_choice=none` 未进入 APPEND Prompt。显式 none policy 一度让 standalone 七项通过，但 2026-08-29 reduced combined 与随后 standalone 复现更深层失败：网页仍重新输出上一轮 external-function request，Gateway 正确报 `chatgpt_tool_forbidden`。根因是 persisted `toolFingerprint` 未包含 function policy，导致 forced-function → none 仍错误 RESTORE。当前候选把 normalized `tool_choice` 纳入 fingerprint，使 policy 变化走 `tools_changed → REBUILD`；修复后的 fresh Phase 7 standalone 尚待最终运行。

## DOM 诊断

Phase 3 已提供 `corepack pnpm inspect:chatgpt`。当前至少报告 URL、Auth State（认证状态）、Composer、Send Button、Assistant Turn collection 和 Stop Control 的结构化状态；后续附件 Phase 再把 File Input 纳入诊断 contract。

默认不保存用户页面。只有显式设置 `CHATGPT_DIAGNOSTICS_DIR` 时才保存受控 screenshot（截图）和 HTML/DOM snapshot（网页快照）；这些诊断产物与 E2E Profile 都被 Git hygiene 排除。

## 仓库治理检查

这些脚本不依赖产品代码：

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
```

它们检查文档/状态/模块边界一致性，不代表产品功能测试。

## Docker Smoke（容器冒烟）

Phase 1 起 Docker 是正式运行边界，因此除普通 Unit / Integration 外还必须验证：

- `linux/amd64` 镜像可构建。
- 容器内 Node 版本符合批准 LTS 基线。
- Playwright package 与官方基础镜像版本约束一致。
- 默认 `UI_MODE=headless` Compose 可启动 Gateway、Xvfb 和产品 full Chromium，但不启动/发布 noVNC。
- `/health` 可访问。
- `/v1/models` 的 API Key 认证正确。
- `/data` Bind Mount 可写，长期进程非 root。
- noVNC overlay 只在维护配置下启动并发布端口；默认宿主机绑定为 `127.0.0.1`。
- Xvfb 在 normal/maintenance 两种模式都以指定 `PUID/PGID` 运行；noVNC HTML、x11vnc / websockify / maintenance browser 只在 maintenance 可用。
- maintenance smoke 不只检查 noVNC HTML 200，还必须通过 `/websockify` WebSocket 实际收到 `RFB 003.008` banner，证明 x11vnc → websockify → noVNC 协议链可用；maintenance 根浏览器必须是固定 Google Chrome Stable，不得存在 `--remote-debugging-pipe` 或 `--no-sandbox`。
- maintenance Compose 必须使用 vendored Playwright seccomp profile；Chrome 进程 `Seccomp` 必须为 filter 模式，且不得拥有 `CAP_SYS_ADMIN`，证明人工登录浏览器以非 root Linux sandbox 运行。
- 当前 Ubuntu x11vnc `0.9.16` 必须使用 `-threads`；真实故障复现表明默认单线程模式会持续高 CPU 且不发送 RFB banner。
- noVNC 密码不出现在进程命令行参数中。
- `/data/gateway.db` 由指定 `PUID/PGID` 创建并可持续读取/写入。
- `schema_migrations` 包含且只包含当前三条 migration：`001_initial`、`002_add_conversation_sync_checkpoint` 与 `003_add_file_blob_lifecycle`，checksum 与顺序均正确。
- `/data/files/blobs`、`/data/generated` 与 `/data/temp` 在容器内由指定 `PUID/PGID` Gateway 可写；File/Blob/Generated Image bytes 不依赖容器可写层。
- 通过容器 HTTP `/v1/files` 上传 fixture 后 metadata/content 可读；使用同一 Bind Mount restart Gateway 后 exact bytes 可恢复；DELETE 后 metadata/content 均返回 404。
- 使用同一 Bind Mount restart Gateway 后数据库和 migration history 仍可用。
- 正常 `UI_MODE=headless` Compose 存在且只存在一个 `/data/browser-profile/` full Chromium browser owner，命令行不得带 `--headless`，并以指定 `PUID/PGID` 运行。
- maintenance overlay 存在且只存在一个 headed Google Chrome Stable owner；产品 BrowserManager 不并发占用同一 Profile。
- maintenance `down` 后隔离测试 Profile 不残留 `SingletonLock` / `SingletonCookie` / `SingletonSocket`，证明模式切换不会因 stale Chromium owner marker 被阻塞。
- Compose 必须透传 `PAGE_IDLE_TIMEOUT_MINUTES`；当前 smoke 使用非默认值 `12` 验证配置进入容器并保持 normal/maintenance 启动边界。

Docker smoke 不等于真实 ChatGPT E2E，不能用来证明当前 Selector、登录、Fresh 文本回答、上传或图片生成有效。

## 最终目标验证入口

Phase 1 建立完整工具链后：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
corepack pnpm verify
corepack pnpm docker:build
corepack pnpm docker:smoke
```

`corepack pnpm verify` 组合 format、lint、typecheck、unit/integration test、build 和全部仓库治理检查。2026-08-29 final RESTORE-hydration/Auth candidate 的 fresh deterministic evidence 为 **86 test files / 595 tests**，format、lint、typecheck、build、Project Memory、Docs、Architecture、Version 与 `git diff --check` 全部通过。Driver regression 继续要求单行走 keyboard text input、含换行文本由 ProseMirror `text/plain` paste transaction 接收；Phase 7 regression 证明 normalized function policy 变化进入 tool-context fingerprint 并触发 `tools_changed` REBUILD；RESTORE regression 证明跨 Conversation URL 导航后不能只等待 Composer，必须等待历史 user/assistant turns 水合并稳定。使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。

`corepack pnpm verify` 必须是本地确定性检查，不自动访问真实 ChatGPT。

2026-08-31 V0.1.1 Cherry Studio compatibility maintenance fresh `corepack pnpm verify` 通过 **86 test files / 600 tests**。随后 V0.1.2 OpenAI-compatible Agent maintenance candidate 第一轮 full `corepack pnpm verify` 通过 **86 test files / 610 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 全绿；新增 deterministic coverage 包含 Cherry Assistant `reasoning_content` history、Pi/OpenClaw/Hermes-style Chat Completions metadata、当前 Codex Responses function/namespace/custom/server-tool shape，以及 snake/camel `/v1/models` metadata/token hints。V0.1.2 不改变 Browser selector、SQLite schema 或 ChatGPT Web execution semantics，因此本轮未运行 Docker build/smoke 或 authenticated ChatGPT E2E。

2026-08-31 V0.1.4 Pi Browser runtime candidate 的 focused deterministic 通过 **7 test files / 41 tests**，代表性 `docker compose config` 确认 Host alias 与 generic/Chromium proxy passthrough；随后 feature branch fresh `corepack pnpm verify` 通过 **91 test files / 638 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 全绿。使用 `http://192.168.3.83:7890`、隔离已登录 Profile 与服务器实际安装 Pi `0.84.4` 完成当时的单请求 `Pi → Gateway → ChatGPT Web` focused E2E：精确 16 tools、最终 Browser Prompt **21,019 UTF-8 bytes**、`gatewayRequests=1`、Pi 输出正确。2026-09-01 因真实 Pi 同 session 网页会话连续性回归，当前 harness 已升级为同 session 两轮 + distractor Page 的 same-affinity gate；本次 DevSpace 没有可用隔离已登录 Profile，因此新的两轮 real ChatGPT gate 尚未执行，不能用旧的单请求证据替代。

## 不能伪造的验证

只有真实 E2E 才能证明：

- ChatGPT 当前 Selector 可用。
- Browser Profile 当前仍登录。
- 文件实际上传成功。
- 图片实际生成并能下载。
- 当前 ChatGPT UI 没有破坏完成检测。

最终真实 E2E 已于 2026-08-29 关闭：fresh inspect 返回 authenticated / Composer unique；Phase 7 standalone 返回 `singleTool/resultContinuation/policyRebuild/multipleTools/streamTool/streamText/restore/schemaRebuild=true`；紧邻 Phase 6 final `2/2/2/1` standalone 九项全部通过；随后 reduced combined Phase 3→8 退出码 0，Phase 3 `gatewayChallenge=true`、Phase 4 APPEND/RESTORE/REBUILD、Phase 5 Chat Completions/Markdown/Responses、Phase 7 八项与 Phase 8 `url/base64/persistence/restart` 全绿。combined 明确报告 `abort=not_run_in_combined` 与 `attachmentMatrix=not_run_in_combined`，对应覆盖由紧邻 standalone gate 提供。验收期间真实 DOM 时序证明跨 URL RESTORE 时 Composer 可比历史 turns 提前约 700ms 出现；Driver 现等待历史 Conversation 水合稳定后才允许新的 Assistant baseline。

### Phase 5 Docker 验收事实

2026-08-17 最终 Phase 5 产品代码 fresh `linux/amd64` Docker build 与完整 `docker:smoke` 实际通过，最终镜像 digest 为 `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0`。这是 Phase 5 历史证据，不代表当前 Phase 6 镜像。

### Phase 6 Docker 验收事实

2026-08-19 Task 8 fresh `linux/amd64` Docker build 实际通过，镜像 digest 为 `sha256:4726ee0cd39e641941385887ec44346aceb6641a190689fa188ec87764426558`；随后完整 `docker:smoke` 通过。Smoke 实际覆盖 migration `001/002/003`、`/data/files/blobs` 与 `/data/temp` PUID/PGID writeability、容器 `/v1/files` upload/metadata/content、same Bind Mount restart 后 exact bytes recovery、DELETE 后 public metadata/content 404，以及既有 normal/maintenance single owner、SQLite restart、Chrome sandbox/seccomp 与 noVNC RFB。Docker smoke 仍不访问真实 ChatGPT，因此不证明模型能读取附件。

### Phase 7 Docker 验证事实

2026-08-27 implementation candidate fresh `linux/amd64` build 实际通过，image ID 为 `sha256:7a74ac01608619baf130b765ba2b82b54f1262b971f2ac3fc1f97d7bcc882499`；随后 full `docker:smoke` 通过。Phase 7 没有新增 migration 或生产依赖，因此 smoke 主要证明当前代码仍保持 migration `001/002/003`、Files restart lifecycle、PUID/PGID、Browser/noVNC/seccomp 等正式容器边界。该证据不能替代 Phase 7 authenticated Tool Calling real E2E。
