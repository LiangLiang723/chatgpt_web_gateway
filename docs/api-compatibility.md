# OpenAI Compatible API（OpenAI 兼容接口）矩阵

> 本文描述 **V1 已批准目标及实现后的预期兼容行为**。某项是否已经完成，必须再看 [`PROJECT_STATE.md`](PROJECT_STATE.md) 的 `Implemented Now（当前已实现）`。

## 状态

- ✅：V1 要求真实实现
- 🟡：协议接收，但只能近似映射或明确忽略
- ❌：V1 明确不支持

## Endpoint（接口端点）

| Endpoint | V1 |
|---|---:|
| `GET /health` | ✅ |
| `GET /v1/models` | ✅ |
| `POST /v1/chat/completions` | ✅ |
| `POST /v1/responses` | ✅ |
| `POST /v1/files` | ✅ |
| `GET /v1/files` | ✅ |
| `GET /v1/files/:id` | ✅ |
| `GET /v1/files/:id/content` | ✅ |
| `DELETE /v1/files/:id` | ✅ |
| `POST /v1/images/generations` | ✅ |
| Audio / Embeddings / Realtime / Batches / Fine-tuning / Vector Stores | ❌ |

## Current Phase 4 Implementation（当前 Phase 4 实现）

当前代码已经实现：

- `GET /health`：返回 Gateway HTTP 进程级健康状态，不代表 ChatGPT 已登录。
- `GET /v1/models`：认证后只返回 `chatgpt-web`。
- `POST /v1/chat/completions` / `POST /v1/responses`：完成 TypeBox/Ajv Schema 校验、统一 Normalizer、Conversation Executor、Browser/Page affinity/Driver 执行链和两套非流式文本响应 Encoder。
- Headless 生产 runtime 会启动 Persistent BrowserContext、Conversation Queue 与 Page affinity manager；`UI_MODE=novnc` 不启动产品 BrowserManager，ChatGPT POST 返回 `503 browser_maintenance_mode`。
- Phase 4 接受**非流式、纯文本、多轮**请求，要求最终消息是非空 `user`。system/developer instructions 继续通过 JSON prompt envelope 近似映射，这不是 OpenAI 原生 role privilege boundary。
- 有 `X-Conversation-Key` 时，Gateway 使用 SQLite 最后成功同步快照做 `FRESH | APPEND | RESTORE | REBUILD` 决策，同 key 串行、不同 key 可并行；未提供 key 时请求保持 ephemeral FRESH，不自动生成/推断会话身份。
- APPEND 只在“instructions 相同 + 持久化消息是当前请求严格前缀 + 恰好新增一个最终 user turn”时成立；否则 REBUILD。Page 丢失但持久化 `/c/...` URL 可用时 RESTORE。
- 成功执行后 `ConversationStore` 原子保存完整请求历史、新 Assistant 回复和 ChatGPT Conversation URL；失败不会覆盖最后一个成功快照。
- Streaming、附件、Tools、非默认 Tool Choice、Structured Output execution 和 image output 返回 `501 unsupported_phase4_request`。
- `conversation_restore_failed` 映射为 HTTP `502`；`auth_required` 使用 HTTP `503`，不会与 Gateway Bearer API Key 的 HTTP `401` 混淆。
- Chat Completions 不伪造 token usage；Responses 当前返回 `usage: null`。

Phase 4 的 Unit/Integration 与 Docker smoke 已通过；显式 real Phase 4 E2E 也已实际启动，但当前隔离 E2E Profile 在第 1 轮返回 `auth_required`，因此**尚不能把真实网页 APPEND/RESTORE 标记为已验收**。Phase 3 的 Fresh text real E2E 是历史已通过基线；Phase 4 需要重新人工认证隔离 Profile 后重跑多轮验收。下面的 V1 矩阵仍表示最终批准目标。

## Authentication and Conversation Extension（认证与会话扩展）

- `GET /health` 无需认证。
- 所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。
- 客户端可通过 `X-Conversation-Key` 提供稳定会话标识；Gateway 会先标准化为内部 `conversationKey`。
- Phase 4 中有 key 的请求使用 SQLite Conversation lifecycle、同 key Queue 和 Page affinity；Gateway 不把不同 key 放进全局串行锁。
- 未提供 `X-Conversation-Key` 时保持 ephemeral FRESH；Gateway 不自动生成 key，也不根据消息内容猜测跨请求会话身份。

## Chat Completions（聊天补全）

| 能力 | V1 | 行为 |
|---|---:|---|
| `developer` / `system` | ✅ | Phase 4 参与 Conversation Context Sync；通过 JSON prompt envelope 近似映射，不声称网页有原生 role 通道 |
| `user` / `assistant` | ✅ | 参与上下文同步；历史不盲目重发 |
| `tool` | ✅ | 转内部 Tool Result 格式 |
| 字符串 `content` | ✅ | 标准化为文本 part |
| `image_url` URL | ✅ | 下载后通过 ChatGPT 上传 |
| `image_url` Base64 Data URL | ✅ | 解码、落盘、上传 |
| `type: file` + `file_id` | ✅ | 查找本地 `/v1/files` 文件 |
| Base64 文件 | ✅ | 解码、落盘、上传 |
| `stream=true` | ✅ | 真 DOM Streaming（网页增量流） |
| `tools` | ✅ | Prompt + Parser 模拟 Tool Calling |
| `tool_choice=auto/none/required` | ✅ | 映射为 Gateway 工具策略 |
| 指定 function（函数） | ✅ | 强约束指定工具 |
| `response_format=json_object` | 🟡 | Prompt 约束，不声称原生 Structured Output（结构化输出） |
| `response_format=json_schema` | 🟡 | Prompt 约束 + 本地校验；不是 OpenAI 模型级硬约束 |
| `temperature/top_p/penalties/seed` | 🟡 | 接收但 V1 忽略 |
| `max_tokens/max_completion_tokens` | 🟡 | 接收但 V1 不承诺精确限制 |
| `image detail` | 🟡 | 接收但 V1 忽略 |
| `logprobs` / `logit_bias` | ❌ | 稳定 unsupported 错误 |
| 真实 Token Usage（令牌用量） | ❌ | 不伪造，未知时使用协议允许的 null / 缺失 |

## Responses API（响应接口）

必须映射到与 Chat Completions 相同的内部 `NormalizedRequest`。

V1 目标：

- `input` string
- message array
- `input_text`
- `input_image`
- `input_file`
- tools
- `stream=true`

Chat Completions SSE（服务器发送事件）与 Responses SSE 使用独立协议 Encoder（编码器），但共享同一内部流事件。

## Models（模型）

默认只暴露：

```text
chatgpt-web
```

不伪装具体 OpenAI API 模型。未来允许配置 Alias（别名），但 Alias 只表示“路由到 chatgpt-web”。

## Files（文件）

文件元数据进入 SQLite，字节保存到 `data/files/`。Gateway 通过配置设置安全上限，ChatGPT 网页自身限制以实际上传结果为准。

## Images Generation（图片生成）

| 参数 | V1 |
|---|---:|
| `prompt` | ✅ |
| `n=1` | ✅ |
| `n>1` | ❌ |
| `size` | 🟡 尽力映射 |
| `quality` | 🟡 尽力映射 |
| URL 输出 | ✅ |
| Base64 输出 | ✅ |
| Partial image Streaming（部分图片流式） | ❌ |
| Image Edit（图片编辑） | ❌ |
