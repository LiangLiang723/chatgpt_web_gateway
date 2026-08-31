# OpenAI Compatible API（OpenAI 兼容接口）矩阵

> 本文同时记录 **V1 已批准目标** 与当前已经实现的公开协议行为。阶段是否完成、哪些外部 E2E 已真实运行，以 [`PROJECT_STATE.md`](PROJECT_STATE.md) 为准。

## Endpoint（接口端点）

| Endpoint | V1 目标 | 当前 |
|---|---:|---:|
| `GET /health` | ✅ | ✅ |
| `GET /v1/models` | ✅ | ✅ |
| `GET /v1/diagnostics` | Extension | ✅ authenticated active diagnostics；显式调用时有界探测 ChatGPT 登录态 |
| `POST /v1/chat/completions` | ✅ | ✅ 文本 + 图片/文件输入 + function Tools + Structured Output |
| `POST /v1/responses` | ✅ | ✅ 文本 + 图片/文件输入 + function Tools + Structured Output |
| `POST /v1/files` | ✅ | ✅ Phase 6 local Files lifecycle |
| `GET /v1/files` | ✅ | ✅ Phase 6 local Files lifecycle |
| `GET /v1/files/:id` | ✅ | ✅ Phase 6 local Files lifecycle |
| `GET /v1/files/:id/content` | ✅ | ✅ Phase 6 local Files lifecycle |
| `DELETE /v1/files/:id` | ✅ | ✅ Phase 6 local Files lifecycle |
| `POST /v1/images/generations` | ✅ | ✅ Phase 8；`n=1` + `url|b64_json`，standalone authenticated acceptance 已通过 |
| `GET /v1/images/:id/content` | Extension | ✅ authenticated persisted generated-image content |
| Audio / Embeddings / Realtime / Batches / Fine-tuning / Vector Stores | ❌ | ❌ |

### V0.1.4 Browser Runtime / Diagnostics compatibility

- OpenAI-compatible request schema 不因为 Pi 大 Prompt 特判或降级：system/developer instructions、history 与 function tool declarations 仍按既有 strict schema/Normalizer 全量处理。最终 Browser Prompt 若为单行继续 `keyboard.insertText()`；普通多行继续一次 ProseMirror `text/plain` paste；超过 16 KiB UTF-8 的多行 Prompt 改为 ≤4 KiB UTF-8 安全分块 + `Shift+Enter`。该运输变化不改变公共 request/response shape，也不静默删减 tools/context。
- 服务器实际安装的 Pi `0.84.4` 已用精确 16 tools 通过 `Pi → Gateway → ChatGPT Web` focused real E2E；最终 Browser Prompt 为 **21,019 UTF-8 bytes**，单次 Gateway/ChatGPT 请求完成。
- unknown Browser/Page failure 对客户端继续稳定映射为 `browser_unavailable` 等现有 OpenAI-compatible error；Playwright cause 与 bounded Driver diagnostics 只写服务端日志。SSE 已开始时仍保持 HTTP 200 + 流内 error frame，不把内部错误改成新的公共字段。
- authenticated `GET /v1/diagnostics` 是 operator 主动调用的扩展：有 Browser runtime 时获取一个 PagePool lease，访问 ChatGPT 首页并返回 `auth_state=authenticated|auth_required|unknown` 和 `probe.status=ok|capacity_exceeded|failed`、safe `page_url/document_state`；maintenance mode 保持 `not_probed`。该接口不返回 API key、Cookie、Prompt/tool/content、proxy/Profile path。

## Current Phase 7 Tool Calling（当前 Phase 7 工具调用）

Phase 7 function Tool Calling 已完成 V2 external-function request protocol 验收。2026-08-27 新 LAN proxy 恢复 authenticated `inspect:chatgpt` 后，V1 private-tool wording 的真实网页拒绝证据促使当前实现不再要求 ChatGPT 把 caller-defined function 当作“网页里已经安装的工具”，而只要求生成外部函数请求记录。后续 restart Tool Result continuation 又暴露 `tool_choice=none` Prompt 传播、stale function-policy RESTORE 与跨 URL RESTORE history hydration 三层真实缺陷；当前实现分别通过显式 none policy、function policy 纳入 tool-context fingerprint、以及导航后等待历史 user/assistant turns 水合稳定来关闭。最终 Phase 7 standalone 八项语义结果全部为 `true`，随后 reduced combined Phase 3→8 中 Phase 7 也再次全绿。

- Chat Completions 与 Responses 都支持 function tool declarations、`tool_choice=auto|none|required|function`、assistant Tool Call history 与 Tool Result continuation。
- Gateway 不执行客户端函数；模型需要工具时只返回 Tool Call，客户端执行后通过 `role=tool` / `function_call_output` 回传结果。
- Tool definitions 递归稳定 canonicalize；object keys 排序、tool list 按 name 排序。SHA-256 tool-context fingerprint 同时包含 canonical definitions、private protocol version 与 normalized `tool_choice`/function policy。仅调整声明顺序且 policy 不变不会 REBUILD；schema/name/description/parameters、协议版本或 policy 变化都会 `REBUILD(reason='tools_changed')`。
- ChatGPT Web 侧使用固定 `EXTERNAL_FUNCTION_REQUESTS_V1` sentinel/envelope；声明函数被描述为 Gateway 外部操作，ChatGPT 只生成 request records，不假装拥有或执行这些函数。strict Parser 不修复 Markdown fence、损坏 JSON、未知函数或 policy 违规。Gateway-owned `call_<32 hex>` ID 持久化到 SQLite，并在 RESTORE/full-history replay 中保持稳定。
- Context Prompt/Append Prompt 已升级到 version 2；FRESH/REBUILD 在允许 function request 时携带 external-function definitions + protocol。APPEND/RESTORE 只在 tool-context fingerprint（包括 function policy）不变时使用，并只携带当前 policy 与 pending；从 forced/required/auto 切换到 `none` 会先 REBUILD。`tool_choice=none` 的 Context Prompt 不注入 function schema/protocol，只携带最小禁止 `function_policy`。pending 只有 Tool Result 时按“使用外部函数结果继续此前 user request”处理，不伪造一个不存在的 pending user turn。Tool Result 会从已持久化 call 解析 function name，result 作为不可信 data field 注入。
- text streaming 仍使用 Phase 5 Stable Prefix；存在 tools 时先经过纯 `ToolDetectionBuffer`。普通 text 一旦分类后继续真流式；private Tool Protocol 完整缓冲到 generation completed 后 strict parse，随后一次或少量 function-call argument chunks 对外发送，绝不把 private marker/JSON 作为公共 `content`。
- Chat Completions non-stream 返回 `content:null` + `tool_calls[]` + `finish_reason='tool_calls'`；stream 返回 role chunk → `delta.tool_calls` → `finish_reason='tool_calls'` → `[DONE]`。
- Responses non-stream 返回 completed `function_call` items；stream 使用 `response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done`，最终一个 `response.completed`。

## Current Phase 6 Files and Attachments（当前 Phase 6 Files 与附件输入）

Phase 6 已完成并通过 deterministic、Docker、standalone authenticated E2E 与最终 combined Phase 3/4/5/6 real E2E：

- 五个 Files endpoint 均沿用现有 `/v1/*` Bearer authentication。
- `POST /v1/files` 使用 `@fastify/multipart` stream API；恰好一个 file + 一个已批准 purpose，拒绝 `expires_after`、额外字段、非法 filename 和超过 32 MiB 的文件。
- 公开 `file-<uuid-v4>` 与 SQLite internal UUID 分离；private inline attachment File 不进入公开 Files API。
- 逻辑 File 与 content-addressed SHA-256 Blob 分离；相同字节可有多个公开 File ID，但只保存一份 Blob。
- `GET /v1/files` 支持 `after`、`limit=1..10000`、`order=asc|desc`、`purpose`；只返回未删除 public File。
- metadata/content 可跨 Gateway runtime restart 恢复；content 从 Blob 流式返回，不暴露 storage path。
- `DELETE` 立即撤销公开访问；若历史 Conversation Attachment 仍引用该 File，内部 bytes 会保留以保证 REBUILD/恢复，不承诺立即 secure erase。
- Chat Completions 支持 `image_url` URL/Data URL、`file.file_data` 与 `file.file_id`；Responses 支持 `input_image.image_url/file_id` 与 `input_file.file_data/file_id`。两套协议共享 Attachment Resolver、multimodal Context、Conversation Engine 与 ChatGPT upload readiness。
- Gateway 防御性限制为单 File/附件 32 MiB、单请求最多 16 个附件、累计 64 MiB；这是本产品策略，不代表 OpenAI 或 ChatGPT Web 官方上限。
- 2026-08-26 combined real E2E 实际通过 Phase 3/4/5/6；Phase 6 场景返回 `imageDataUrl=true`、`imageFileId=true`、`txt=true`、`pdf=true`、`docx=true`、`xlsx=true`、`append=true`、`restore=true`、`streaming=true`。Remote URL fetch 的 SSRF/DNS/redirect 链有 deterministic coverage，但本轮没有使用公网 fixture 做 live remote-fetch E2E。

## Current Phase 5 Implementation（当前 Phase 5 实现）

当前代码已经支持 Chat Completions / Responses 的**纯文本非流式与 `stream=true` Streaming 执行链**：

- 两套 POST 都经过 TypeBox/Ajv → 统一 Normalizer → Conversation Engine；route 不直接实现浏览器逻辑。
- 有 `X-Conversation-Key` 时继续使用 Phase 4 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、Page affinity 和 SQLite `clean | in_flight` checkpoint。V0.1.3 对无 key、但每轮重发完整历史的客户端增加保守匿名续接：只在唯一一个 clean anonymous Conversation 能被现有 Context Sync planner 严格判定为 APPEND/RESTORE 时复用；0 个或多个匹配仍 FRESH，显式 key 始终优先。
- Phase 5 `stream=true` 与 non-stream 使用相同的 target Assistant turn ownership 和 completion 语义，不改变 Context Sync 规则。
- Streaming 以 ChatGPT DOM snapshot 为来源，约 200ms polling + 3-sample Stable Prefix，并默认保留最后 **64 个 Unicode code points** 作为 bounded commit tail；2026-08-26 real E2E 观测到一次 38-code-point Markdown 尾部回排后从 16 提升为 64。completion 最终确认后精确 flush。已经输出的 prefix 不撤回；若 DOM 重写穿过 committed prefix，返回/流出稳定 `chatgpt_stream_diverged`，不伪造 correction。
- Chat Completions SSE 使用 `chat.completion.chunk`：固定 stream id/created/model，Assistant role chunk、text delta、terminal `finish_reason="stop"`、单个 `[DONE]`；不伪造 token usage/reasoning。V0.1.x maintenance 严格兼容 `stream_options.include_usage?: boolean`；V0.1.3 继续显式接收 Cherry/Pi Assistant `reasoning_content` / `reasoning` / `reasoning_text` replay metadata、Pi singleton user text object `content:{type:"text",text:string}`，以及 Pi/OpenClaw/Hermes 常见 `store`、`reasoning_effort`、`parallel_tool_calls`、`service_tier`、prompt-cache/provider metadata 等字段。这些 compatibility-only 字段在 adapter 层消费/忽略并记录 diagnostics，不进入 `NormalizedRequest` 语义；未知顶层字段和未知 `stream_options` 成员仍返回 400。
- Responses 使用 typed SSE：`response.created`、`response.in_progress`、item/content added、`response.output_text.delta`、done events、`response.completed`；IDs 稳定，`sequence_number` 单调，`usage=null`。
- 首个 internal `started` 之前的错误仍返回普通 OpenAI-style 非 200 JSON；SSE 已开始后的错误使用协议流内 error，并且不发送成功 terminal。
- 成功 terminal 晚于最终 SQLite clean aggregate commit。final clean save 失败时不发送 `[DONE]` / `response.completed`，checkpoint 保持 `in_flight`。
- 客户端在生成中断开时，当前 turn best-effort Stop，不保存 partial Assistant，checkpoint 保持 `in_flight`；首个 SSE frame 后但 Send 前的断开会在 checkpoint/Driver Send 边界被取消，避免继续产生网页 turn。
- `UI_MODE=novnc` 的 Streaming 请求和 non-stream 一样在 SSE 开始前返回 `503 browser_maintenance_mode`。
- 附件、Tools、非默认 Tool Choice、Structured Output execution 和 image output 在 Phase 5 仍返回 `501 unsupported_phase5_request`。

**验收边界：** 上述纯文本 Streaming 行为已于 2026-08-17 完成 authenticated ChatGPT Web 真实验收：fresh `inspect:chatgpt` 为 authenticated，standalone Phase 5 real E2E 与 combined Phase 3/4/5 real E2E 均通过。该结论只覆盖当前纯文本范围，不能外推附件、Tools、Structured Output 或 image execution。

## Authentication and Conversation Extension（认证与会话扩展）

- `GET /health` 无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。
- 客户端可通过 `X-Conversation-Key` 提供稳定会话标识，并始终优先使用该标识。没有 key 时 Gateway 不生成客户端可见身份；仅当完整历史与唯一一个 persisted anonymous Conversation 被 Context Sync planner 严格证明为 APPEND/RESTORE 时保守复用，存在歧义就 FRESH。
- 同 key 整个 Streaming 生命周期（包含 abort cleanup）保持 FIFO；不同 key 在 Page capacity 允许时并行。

## Chat Completions（聊天补全）

| 能力 | V1 | 当前行为 |
|---|---:|---|
| `developer` / `system` | ✅ | ✅ 参与 Context Sync；通过 prompt envelope 近似映射，不声称网页有原生 privilege channel |
| `user` / `assistant` | ✅ | ✅ 参与上下文同步；历史不盲目重发；V0.1.3 严格兼容 singleton user text object，以及 Assistant `reasoning_content/reasoning/reasoning_text/reasoning_details` 等已知 replay metadata；兼容 metadata 不进入 Browser Prompt |
| 字符串 / text part `content` | ✅ | ✅ |
| `stream=false` | ✅ | ✅ 文本与 Phase 6 附件请求 |
| `stream=true` | ✅ | ✅ 文本与 Phase 6 附件请求均复用真实 DOM Streaming |
| `stream_options.include_usage` | 🟡 | ✅ V0.1.x maintenance 兼容接收 `boolean` 并忽略；对象保持 strict，未知字段/非 boolean 拒绝；不生成 fake usage chunk |
| `image_url` URL/Base64 | ✅ | ✅ Phase 6；URL 安全获取 + Data URL，authenticated E2E 覆盖 Data URL |
| file / `file_id` / Base64 file | ✅ | ✅ Phase 6 |
| `tools` / assistant `tool_calls` / `role=tool` | ✅ | ✅ Phase 7 function Tools；function `strict` 可作为客户端 metadata 接收；final policy-fingerprint + RESTORE-hydration deterministic/Docker、standalone 与 reduced combined authenticated acceptance 均通过 |
| `tool_choice` 非默认策略 | ✅ | ✅ `auto|none|required|function` |
| `response_format=json_object/json_schema` | 🟡 | ✅ prompt-constrained + 本地最终 JSON/Ajv 校验；不是原生 constrained decoding |
| `temperature/top_p/penalties/seed` | 🟡 | 接收并按既有诊断策略忽略 |
| `max_tokens/max_completion_tokens` | 🟡 | 接收但不承诺精确限制 |
| Agent compatibility metadata | 🟡 | ✅ V0.1.3 延续并扩展 V0.1.2 allowlist：显式接收 `store/reasoning_effort/reasoning/parallel_tool_calls/service_tier/prompt_cache_*`、provider/options 等已知 OpenAI-compatible 字段并忽略；仍保持顶层 strict unknown-field rejection |
| `logprobs` / `logit_bias` | ❌ | 稳定 unsupported error |
| 真实 Token Usage | ❌ | 不伪造 |

## Responses API（响应接口）

Responses 与 Chat Completions 映射到同一个 `NormalizedRequest` 与 Conversation Engine。

当前支持：

- `input` string。
- text message array / `input_text`。
- `input_image.image_url`（URL/Data URL）与 `input_image.file_id`。
- `input_file.file_data` 与 `input_file.file_id`。
- `stream=false`。
- `stream=true` typed SSE，包括 attachment Streaming 与 function-call events。
- function `tools` / `tool_choice`、`function_call` history 与 `function_call_output` continuation。
- V0.1.2 接受当前 Codex Responses metadata、带 `id/status` 的 message history、namespaced function calls、`custom`/freeform tools 与 `custom_tool_call(_output)` history。
- Responses `namespace` 内 function/custom 声明会扁平桥接到现有 external-function protocol；返回时恢复 `namespace + name`。`custom`/freeform tool 内部使用一个必填 string `input` 参数，非流式恢复为 `custom_tool_call`，流式恢复 `response.custom_tool_call_input.delta/done`。
- OpenAI-hosted `web_search` / `tool_search` 声明可按当前 Codex 请求形状接收，但在 adapter 层过滤并记录 ignored diagnostics；Gateway 不执行或伪造这些 server-side tools。

`input_file.file_url` 仍不支持；任意未知 built-in tool 类型仍拒绝。Responses `text.format=json_object/json_schema` 与 Chat Completions `response_format` 共用 Structured Output 执行/最终校验。Claude Code 原生 Anthropic Messages 不在 V0.1.2 范围。

## Stable Error Boundary（稳定错误边界）

主要 execution code：

| Code | Pre-stream HTTP | 含义 |
|---|---:|---|
| `auth_required` | 503 | ChatGPT 登录态不可用 |
| `browser_unavailable` | 503 | Browser runtime 不可用 |
| `browser_maintenance_mode` | 503 | maintenance 模式禁用产品执行链 |
| `page_capacity_exceeded` | 503 | 当前 Page 容量耗尽 |
| `selector_missing` / `selector_ambiguous` | 502 | 当前 ChatGPT DOM 与 Selector contract 不匹配 |
| `chatgpt_response_missing` | 502 | 未产生 target Assistant turn |
| `chatgpt_generation_timeout` | 504 | target turn 未在超时内完成 |
| `chatgpt_stream_diverged` | 502 | DOM 重写穿过已承诺的 Stable Prefix |
| `conversation_restore_failed` | 502 | 保存的 Conversation 无法恢复 |
| `file_not_found` | 404 | public File 不存在、已删除或不可公开访问 |
| `invalid_file_upload` | 400 | multipart / filename / purpose / file body 无效 |
| `file_too_large` | 413 | `/v1/files` 超过 Gateway 32 MiB 单文件上限 |
| `file_storage_error` | 500 | Gateway 本地 Blob/File 持久化失败 |
| `invalid_attachment` | 400 | attachment source/Base64/Data URL/type 无效或 URL SSRF policy 拒绝 |
| `attachment_too_large` | 413 | 单附件或请求累计附件超过 Gateway 上限 |
| `attachment_fetch_failed` | 400 | client-supplied remote image URL 无法安全获取 |
| `chatgpt_upload_failed` | 502 | ChatGPT 明确拒绝或附件上传失败 |
| `chatgpt_upload_timeout` | 504 | 本请求 owned attachment 未在规定时间 ready |
| `chatgpt_tool_required` | 502 | 当前 policy 要求 Tool Call，但 ChatGPT 返回普通文本 |
| `chatgpt_tool_protocol_invalid` | 502 | private sentinel/envelope/JSON framing 无效 |
| `chatgpt_tool_unknown` | 502 | ChatGPT 请求当前不存在的 function |
| `chatgpt_tool_forbidden` | 502 | ChatGPT 违反 `none` 或 forced function policy |
| `chatgpt_structured_output_invalid` | 502 | Assistant 最终文本不是所需 JSON object 或不符合请求 JSON Schema |
| `invalid_image_request` | 400 | Images 请求形状/字段无效 |
| `unsupported_image_request` | 400 | 当前只支持 `n=1` 等已批准 Images 子集 |
| `image_not_found` | 404 | persisted generated image 不存在 |
| `chatgpt_image_missing` / `chatgpt_image_ambiguous` | 502 | 本请求没有可读取生成图，或去重同一 `src` 后仍有多个不同图片资源 |
| `chatgpt_image_fetch_failed` | 502 | 最终图片 bytes 无法从 ChatGPT 页面取回 |
| `image_storage_error` | 500 | generated image 本地持久化/完整性失败 |
| `unsupported_phase7_request` | 501 | `input_file.file_url` 等当前 Conversation Engine 仍未实现能力 |
| `unsupported_phase6_request` | 501 | 仅保留旧 Phase 6 execution error 类型；当前公开 Conversation Engine 使用 Phase 7 capability gate |
| `unsupported_phase5_request` | 501 | 仅保留旧 Phase 5 execution error 类型 |
| `invalid_conversation_request` | 400 | 当前 Conversation 请求形状无效 |

SSE 已开始后 HTTP status 已固定为 200；相同稳定错误改用协议流内 error framing，并且不发送成功 terminal。

## Models（模型）

默认只暴露：

```text
chatgpt-web
```

`GET /v1/models` 同时暴露 Gateway 已实现的兼容扩展元数据：`name="ChatGPT Web"`、`capabilities=["reasoning","image-recognition","file-input","function-call","structured-output"]`、文本+图片输入、文本输出、Streaming 支持与 token-limit hints。V0.1.2 同时返回 snake_case 与 Cherry-compatible camelCase 别名：`input_modalities/inputModalities`、`output_modalities/outputModalities`、`supports_streaming/supportsStreaming`、`context_window/contextWindow`、`max_input_tokens/maxInputTokens`、`max_output_tokens/maxOutputTokens`。

`MODEL_CONTEXT_WINDOW` 默认 `128000`；`MODEL_MAX_INPUT_TOKENS` 默认跟随 context window；`MODEL_MAX_OUTPUT_TOKENS` 默认 `32768`。三者都只是客户端 **compatibility hint**，不是 ChatGPT 官方保证的 Web 后端固定 token limit。当前 Cherry Studio `openAICompatibleFetcher` 只把远端 OpenAI-style `/models` 项的 `id/name/owned_by` 传给它的本地 `toModel()`，并初始化 `capabilities=[]`；因此这些扩展 metadata 在 Gateway HTTP 层可正确返回，但当前 Cherry 通用 OpenAI provider 不会自动把它们写入截图中的模型能力/context/token 编辑字段。这是客户端拉取映射限制，不能由 Gateway 伪造其它标准字段绕过。对话模型不声明 `image-generation`：图片生成是独立 `POST /v1/images/generations` 能力，不等价于 Chat Completions/Responses 模型输出模态。

不伪装具体 OpenAI API 模型。

## Files / Images Generation（Files 与 Images）

Files 元数据/字节生命周期、Attachment Resolver、ChatGPT Web upload/readiness 与 `file_id` 模型输入已经在 Phase 6 完成并通过真实网页验收。`DELETE /v1/files/:id` 撤销公开访问，但为保证已持久化 Conversation 的 REBUILD/恢复，历史 Attachment 引用仍可保留内部 bytes。

Images Generation 当前实现 `POST /v1/images/generations`：`prompt` 必填，`n` 只支持 `1`，`response_format=url|b64_json`；`size` / `quality` / `style` 等兼容字段仅记录为 ignored metadata，不伪装成 ChatGPT 网页精确控制。每次请求使用 Fresh page turn；Send 前记录 conversation-turn 图片 baseline，只接受随后新增、可见、已加载且至少 256×256 的图片候选，不依赖文本 Assistant role 或 copy-action completion marker；重复 DOM 节点按 `currentSrc || src` 合并为同一图片资源，多个不同图片源仍稳定拒绝。最终 bytes 经 PNG/JPEG/WebP/GIF signature sniff 后原子保存到 `${DATA_DIR}/generated`，写入 `generated_images` SQLite record，并用 SHA-256 做读取完整性校验。URL 响应指向 authenticated `GET /v1/images/:id/content`；可选安全 `PUBLIC_BASE_URL` 只改变 URL base，不绕过 Bearer auth。最新 standalone Phase 8 已真实通过 `url/base64/persistence/restart=true`，并核对 SQLite、磁盘 bytes/SHA-256 和重启后读取；最终 combined Phase 3→8 仍待关闭。
