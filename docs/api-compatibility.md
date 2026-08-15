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

## Current Phase 3 Implementation（当前 Phase 3 实现）

当前已经真实实现：

- `GET /health`：返回 Gateway HTTP 进程级健康状态，不代表 ChatGPT 已登录。
- `GET /v1/models`：认证后只返回 `chatgpt-web`。
- `POST /v1/chat/completions` / `POST /v1/responses`：完成 TypeBox/Ajv Schema 校验、统一 Normalizer、Phase3Executor、Browser/Page Pool/Driver 执行链和两套非流式文本响应 Encoder。
- Headless 生产 runtime 会启动 Persistent BrowserContext；`UI_MODE=novnc` 不启动产品 BrowserManager，ChatGPT POST 返回 `503 browser_maintenance_mode`。
- Phase 3 只接受 **Fresh、非流式、纯文本**请求：恰好一个 user turn，可带 system/developer instructions。`X-Conversation-Key`、assistant/tool 历史或多个 user turn 返回 `501 conversation_sync_not_implemented`。
- Streaming、附件、Tools、非默认 Tool Choice、Structured Output execution 和 image output 返回 `501 unsupported_phase3_request`。
- system/developer instructions 通过一次 JSON-serialized prompt envelope 近似映射到 ChatGPT Web；这不是 OpenAI 原生 role privilege boundary。
- Chat Completions 不伪造 token usage；Responses 当前返回 `usage: null`。
- `auth_required` 使用 HTTP `503`，不会与 Gateway Bearer API Key 的 HTTP `401` 混淆。

Phase 2 的 SQLite 结构化持久化层仍完整存在：checksum migration、Conversation / Message / Tool Call / Attachment / File / Generated Image Repository，以及 `ConversationStore` 原子 aggregate 保存/加载和 close → reopen 恢复。Phase 3 尚未把这些 Repository 接入 Conversation lifecycle；该工作属于 Phase 4 Context Sync。

**真实 ChatGPT Web 验收当前仍被阻塞。** Phase 3 real E2E 命令已经实际执行；DevSpace 直连 `chatgpt.com` 的 DNS/HTTPS 路径不可用，但显式 `CHATGPT_PROXY_SERVER` + Xvfb/full Chromium 已稳定进入真实 ChatGPT Guest 页面并验证 `auth_required`。当前只待隔离 headed Profile 人工完成 ChatGPT 登录/MFA，再继续 authenticated Selector 和 Fresh 文本回答确认。下面的 V1 矩阵仍表示最终批准目标；Phase 3 当前实际支持范围以上述 Fresh text 边界为准。

## Authentication and Conversation Extension（认证与会话扩展）

- `GET /health` 无需认证。
- 所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。
- 客户端可通过 `X-Conversation-Key` 提供稳定会话标识；Gateway 会先标准化为内部 `conversationKey`。
- Phase 3 执行层不会忽略该标识：只要存在 `conversationKey` 就返回 `conversation_sync_not_implemented`，避免伪装已经保持会话身份。
- 未提供 `X-Conversation-Key` 时，Phase 3 每次执行 Fresh 单轮；自动绑定/APPEND/RESTORE 属于 Phase 4 Conversation / Context Sync。

## Chat Completions（聊天补全）

| 能力 | V1 | 行为 |
|---|---:|---|
| `developer` / `system` | ✅ | V1 目标参与 Conversation 控制；Phase 3 Fresh text 通过 JSON prompt envelope 近似映射，不声称网页有原生 role 通道 |
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
