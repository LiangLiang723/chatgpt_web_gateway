# OpenAI Compatible API（OpenAI 兼容接口）矩阵

> 本文同时记录 **V1 已批准目标** 与当前已经实现的公开协议行为。阶段是否完成、哪些外部 E2E 已真实运行，以 [`PROJECT_STATE.md`](PROJECT_STATE.md) 为准。

## Endpoint（接口端点）

| Endpoint | V1 目标 | 当前 |
|---|---:|---:|
| `GET /health` | ✅ | ✅ |
| `GET /v1/models` | ✅ | ✅ |
| `POST /v1/chat/completions` | ✅ | ✅ 纯文本 |
| `POST /v1/responses` | ✅ | ✅ 纯文本 |
| `POST /v1/files` | ✅ | ❌ Phase 6 |
| `GET /v1/files` | ✅ | ❌ Phase 6 |
| `GET /v1/files/:id` | ✅ | ❌ Phase 6 |
| `GET /v1/files/:id/content` | ✅ | ❌ Phase 6 |
| `DELETE /v1/files/:id` | ✅ | ❌ Phase 6 |
| `POST /v1/images/generations` | ✅ | ❌ Phase 8 |
| Audio / Embeddings / Realtime / Batches / Fine-tuning / Vector Stores | ❌ | ❌ |

## Current Phase 5 Implementation（当前 Phase 5 实现）

当前代码已经支持 Chat Completions / Responses 的**纯文本非流式与 `stream=true` Streaming 执行链**：

- 两套 POST 都经过 TypeBox/Ajv → 统一 Normalizer → Conversation Engine；route 不直接实现浏览器逻辑。
- 有 `X-Conversation-Key` 时继续使用 Phase 4 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、Page affinity 和 SQLite `clean | in_flight` checkpoint；无 key 时仍为独立 FRESH `conversation_key = NULL`。
- Phase 5 `stream=true` 与 non-stream 使用相同的 target Assistant turn ownership 和 completion 语义，不改变 Context Sync 规则。
- Streaming 以 ChatGPT DOM snapshot 为来源，约 200ms polling + 3-sample Stable Prefix；已经输出的 prefix 不撤回。若 DOM 重写穿过 committed prefix，返回/流出稳定 `chatgpt_stream_diverged`，不伪造 correction。
- Chat Completions SSE 使用 `chat.completion.chunk`：固定 stream id/created/model，Assistant role chunk、text delta、terminal `finish_reason="stop"`、单个 `[DONE]`；不伪造 token usage。
- Responses 使用 typed SSE：`response.created`、`response.in_progress`、item/content added、`response.output_text.delta`、done events、`response.completed`；IDs 稳定，`sequence_number` 单调，`usage=null`。
- 首个 internal `started` 之前的错误仍返回普通 OpenAI-style 非 200 JSON；SSE 已开始后的错误使用协议流内 error，并且不发送成功 terminal。
- 成功 terminal 晚于最终 SQLite clean aggregate commit。final clean save 失败时不发送 `[DONE]` / `response.completed`，checkpoint 保持 `in_flight`。
- 客户端在生成中断开时，当前 turn best-effort Stop，不保存 partial Assistant，checkpoint 保持 `in_flight`；首个 SSE frame 后但 Send 前的断开会在 checkpoint/Driver Send 边界被取消，避免继续产生网页 turn。
- `UI_MODE=novnc` 的 Streaming 请求和 non-stream 一样在 SSE 开始前返回 `503 browser_maintenance_mode`。
- 附件、Tools、非默认 Tool Choice、Structured Output execution 和 image output 在 Phase 5 仍返回 `501 unsupported_phase5_request`。

**验收边界：** 上述行为已有 deterministic integration、真实本地 TCP SSE 测试、fresh Docker build/smoke 证据；Phase 5 authenticated ChatGPT Web Streaming E2E harness 已实现，但本次实现后尚未在隔离已登录 Profile 上真实运行。因此这里描述的是当前代码/API 行为，不能据此声称“当前 ChatGPT DOM 真 Streaming 已完成真实网页验收”。

## Authentication and Conversation Extension（认证与会话扩展）

- `GET /health` 无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。
- 客户端可通过 `X-Conversation-Key` 提供稳定会话标识；Gateway 不自动猜测或生成匿名跨请求身份。
- 同 key 整个 Streaming 生命周期（包含 abort cleanup）保持 FIFO；不同 key 在 Page capacity 允许时并行。

## Chat Completions（聊天补全）

| 能力 | V1 | 当前行为 |
|---|---:|---|
| `developer` / `system` | ✅ | ✅ 参与 Context Sync；通过 prompt envelope 近似映射，不声称网页有原生 privilege channel |
| `user` / `assistant` | ✅ | ✅ 参与上下文同步；历史不盲目重发 |
| 字符串 / text part `content` | ✅ | ✅ |
| `stream=false` | ✅ | ✅ 非流式纯文本 |
| `stream=true` | ✅ | ✅ 代码已实现 DOM Streaming；真实 authenticated Phase 5 E2E 待运行 |
| `image_url` URL/Base64 | ✅ | ❌ Phase 6 |
| file / `file_id` / Base64 file | ✅ | ❌ Phase 6 |
| `tools` / tool messages | ✅ | ❌ Phase 7 |
| `tool_choice` 非默认策略 | ✅ | ❌ Phase 7 |
| `response_format=json_object/json_schema` | 🟡 | ❌ Phase 5 execution 仍拒绝 |
| `temperature/top_p/penalties/seed` | 🟡 | 接收并按既有诊断策略忽略 |
| `max_tokens/max_completion_tokens` | 🟡 | 接收但不承诺精确限制 |
| `logprobs` / `logit_bias` | ❌ | 稳定 unsupported error |
| 真实 Token Usage | ❌ | 不伪造 |

## Responses API（响应接口）

Responses 与 Chat Completions 映射到同一个 `NormalizedRequest` 与 Conversation Engine。

当前纯文本支持：

- `input` string。
- text message array / `input_text`。
- `stream=false`。
- `stream=true` typed SSE。

`input_image`、`input_file`、tools 仍属于后续 Phase。

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
| `unsupported_phase5_request` | 501 | 请求需要附件/Tools/Structured/Image 等后续能力 |
| `invalid_conversation_request` | 400 | 当前 Conversation 请求形状无效 |

SSE 已开始后 HTTP status 已固定为 200；相同稳定错误改用协议流内 error framing，并且不发送成功 terminal。

## Models（模型）

默认只暴露：

```text
chatgpt-web
```

不伪装具体 OpenAI API 模型。

## Files / Images Generation（后续目标）

文件元数据/字节生命周期属于 Phase 6；ChatGPT 图片生成属于 Phase 8。V1 已批准范围不等于当前实现。
