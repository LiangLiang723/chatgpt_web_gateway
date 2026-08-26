# Phase 7 Tool Calling Design（工具调用设计）

**Date:** 2026-08-26
**Status:** Approved Phase design derived from the approved V1 architecture and current Phase 6 implementation baseline

## 1. Goal（目标）

Phase 7 把已经存在于协议模型和 SQLite（数据库）中的 Tool Calling（工具调用）结构真正接到 ChatGPT Web 执行链，完成：

```text
OpenAI tools / tool_choice
→ Tool canonicalization（规范化）+ fingerprint（指纹）
→ Gateway private Tool Prompt（私有工具提示协议）
→ ChatGPT Web
→ Tool Detection Buffer（工具检测缓冲）
→ strict Tool Parser（严格工具解析器）
→ OpenAI tool_calls / Responses function_call
→ client executes tool
→ role=tool / function_call_output
→ Gateway Tool Result Prompt
→ ChatGPT Web
→ final text or next tool call
```

Phase 7 完成后，Chat Completions（聊天补全）与 Responses API（响应接口）都必须支持单工具、多工具、工具结果回传、继续调用和最终文本回答；同一 Conversation（会话）仍共享 Phase 4/5/6 的 FRESH / APPEND / RESTORE / REBUILD、FIFO（先进先出）、附件与 Streaming（流式输出）基础。

Gateway **不执行客户端定义的函数**。Gateway 只负责把模型意图转换成 OpenAI-compatible（OpenAI 兼容）工具调用，并把客户端返回的 Tool Result（工具结果）重新注入 ChatGPT Web。

## 2. Baseline and hard boundaries（基线与硬边界）

Phase 7 从 `phase-6-complete` / commit `cbc7a5b` 开始。

已存在且必须复用：

- 两套 OpenAI request normalizer 已能表达 `tools`、`tool_choice`、assistant `tool_calls`、`role=tool`、Responses `function_call` / `function_call_output`。
- `NormalizedTool`、`NormalizedToolChoice`、`NormalizedToolCall` 已存在。
- SQLite 已有 `conversations.tools_json`、`tool_choice_json`、`tool_fingerprint` 与独立 `tool_calls` 表。
- Phase 4 已有 FRESH / APPEND / RESTORE / REBUILD Planner（规划器）、checkpoint（检查点）、Conversation queue（会话队列）。
- Phase 5 已有真实 DOM Streaming、Stable Prefix（稳定前缀）、abort（中止）与两个 SSE（服务器发送事件）编码器。
- Phase 6 已有附件 canonicalization、持久化和上传选择。

Phase 7 不做：

- Structured Output（结构化输出）执行；留给后续阶段。
- ChatGPT Image Generation（图片生成）；留给 Phase 8。
- OpenAI built-in tools（内置工具）、MCP（模型上下文协议）tool、custom/freeform tool。
- Gateway 主动执行任意客户端函数、Shell（命令行）、HTTP（网络请求）或插件。
- `parallel_tool_calls` 独立控制参数；V1 只支持 function tool，多调用由模型协议自然表达。
- 伪造 token usage（令牌用量）。

## 3. OpenAI compatibility target（兼容目标）

### 3.1 Chat Completions

请求继续使用当前支持的 function tool 结构：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather",
        "parameters": { "type": "object" }
      }
    }
  ],
  "tool_choice": "auto"
}
```

非流式工具调用返回：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Xiamen\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

客户端通过 `role=tool` + `tool_call_id` 回传结果。

### 3.2 Responses API

非流式工具调用使用独立 `function_call` output item：

```json
{
  "output": [
    {
      "type": "function_call",
      "id": "fc_...",
      "call_id": "call_...",
      "name": "get_weather",
      "arguments": "{\"city\":\"Xiamen\"}",
      "status": "completed"
    }
  ]
}
```

客户端通过 `function_call_output` + `call_id` 回传结果。

### 3.3 IDs（标识）

- `call_id` / Chat Completions `tool_calls[].id` 由 Gateway 生成，不信任 ChatGPT 网页生成稳定外部 ID。
- 格式使用 `call_` + UUID v4（随机唯一标识）去连字符后的十六进制文本。
- Responses `function_call.id` 属于 Response output item identity（响应输出项标识），由 Encoder（编码器）单独生成 `fc_...`。
- 同一持久化 Tool Call 在 RESTORE / full-history replay 后保持原 `externalCallId`。

## 4. Canonical Tool Model（规范工具模型）

新增 `src/tools/canonicalize.ts`，职责只包括确定性 Tool context（工具上下文）规范化，不包含 Prompt 或 DOM 行为。

规范结构：

```ts
interface CanonicalFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: unknown;
}
```

规则：

1. function name 必须非空且在一次请求内唯一。
2. object key（对象键）递归按 Unicode code-point（码点）稳定排序。
3. array（数组）顺序保留；Gateway 不擅自判断 JSON Schema（JSON 模式）数组是否语义无序。
4. tool list（工具列表）按 `name` 排序后参与 fingerprint，因此仅交换工具声明顺序不会触发 REBUILD。
5. `description` 与 `parameters` 都属于工具语义，变化会改变 fingerprint。
6. `tool_choice.mode=function` 的 name 必须存在于当前 tool set（工具集合）。
7. `required` / 指定函数但当前没有 tools 时返回 `invalid_conversation_request`。
8. `none` 允许 tools 存在，但本轮禁止模型发出 Tool Call。

Tool fingerprint：

```text
SHA-256(stable-json(canonical-tools))
```

`tool_choice` 不写入 tool fingerprint。它是**每轮策略**，而不是工具定义身份；每次 Prompt 都显式携带当前 choice。

## 5. Tool Context Sync（工具上下文同步）

### 5.1 Conversation state

`ConversationRecord` 必须保存：

- 当前 normalized `tools`。
- 当前 `toolChoice`。
- canonical tools 的 `toolFingerprint`；无 tools 时为 `undefined`。

### 5.2 Planner rules

Canonical Conversation（规范会话）新增真实 Tool Call / Tool Result 语义，fingerprint 必须包括：

- assistant tool call 的 `externalCallId`、name、arguments string。
- tool result 的 `toolCallId` 与内容。
- 原有 user/assistant 文本和附件语义。

Planner 比较时额外比较 stored/current tool fingerprint：

- 相同：可继续 APPEND / RESTORE。
- 不同：`REBUILD(reason='tools_changed')`。

任何工具新增、删除、描述变化、参数模式变化都保守 REBUILD。仅 tool declaration order 变化不 REBUILD。

### 5.3 Pending browser turn（待发送网页轮次）

Phase 4–6 的 Planner 假设请求最后只有一个 user message；Phase 7 改为“一次待发送浏览器 turn”可以是：

```text
A. exactly one user message
B. one or more consecutive tool-result messages
```

合法 tail（尾部）规则：

- user turn：最终只有一条新的 user message。
- tool-result turn：所有新消息都是 `role=tool`，每个 `tool_call_id` 必须能解析到同一 Conversation 中已存在的 assistant Tool Call。
- 同一 Tool Call 在一个请求 tail 中不能出现两个结果。
- tool-result turn 不允许混入新的 user message；客户端应先完成工具闭环再提交下一 user turn。
- full-history 请求仍必须让 stored confirmed history 成为 request history 的 canonical prefix（规范前缀）。
- 无 `X-Conversation-Key` 的 tool-result-only incremental request 无法解析 call identity，返回 `invalid_conversation_request`。

FRESH / REBUILD 可以携带完整历史，其中包括过去的 Tool Call / Tool Result；最后 pending turn 仍按上面两种形态确定。

## 6. Gateway Private Tool Protocol（网关私有工具协议）

ChatGPT Web 不提供 OpenAI function-calling wire protocol（线路协议），因此 Gateway 使用只存在于网页 Prompt/Assistant DOM 内的私有协议。

### 6.1 Sentinel（哨兵）

固定协议标记：

```text
<<<CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>
<JSON payload>
<<<END_CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>
```

Payload：

```json
{
  "calls": [
    {
      "name": "get_weather",
      "arguments": {
        "city": "Xiamen"
      }
    }
  ]
}
```

### 6.2 Model rules

Tool Prompt 必须告诉 ChatGPT：

- 普通回答直接输出普通文本，不能输出协议 marker（标记）。
- 需要调用工具时，整个 Assistant output（助手输出）只能是一个完整 Tool Protocol envelope（工具协议信封）。
- marker 之外只能有 whitespace（空白），不得有 Markdown fence（代码围栏）、解释或前后 prose（正文）。
- `calls` 至少一项。
- 每一项 name 必须来自当前工具列表。
- `arguments` 必须是 JSON object（JSON 对象）。
- 不得编造 Tool Result；调用后停止，等待客户端结果。
- `tool_choice=none`：绝不输出 Tool Protocol。
- `tool_choice=required`：必须输出至少一个 Tool Call。
- 指定 function：所有调用只允许该函数，且至少一个调用。

### 6.3 Why not Markdown JSON（为什么不用 Markdown JSON）

不使用“请输出一个 JSON code block”作为协议，因为普通回答也可能自然包含 JSON/代码块，无法可靠区分业务文本和 Tool Call。固定首部 marker + strict parser 提供显式 framing（分帧）。

## 7. Tool Prompt（工具提示）

新增 `src/tools/prompt.ts`。

Tool schema 只在需要建立/重建网页上下文时完整注入：

- FRESH：完整 tools + protocol rules。
- REBUILD：完整 tools + protocol rules。
- APPEND：如果 fingerprint 未变化，不重复完整 schema，只携带本轮 `tool_choice` 和当前输入。
- RESTORE：原网页 Conversation 保留 schema；与 APPEND 相同。

Context Prompt v2（上下文提示版本 2）必须同时表达：

```json
{
  "version": 2,
  "instructions": {},
  "tools": {},
  "history": [],
  "pending": []
}
```

其中 history 中的 Tool Call / Tool Result 使用 Gateway 私有**语义对象**序列化，不直接嵌入公共 Chat Completions/Responses payload，也不得包含数据库 ID、文件路径、hash 之外的敏感内部数据。

Append Prompt v2：

```json
{
  "version": 2,
  "tool_policy": {},
  "pending": []
}
```

Tool Result 发送给 ChatGPT 时必须包含：

- `tool_call_id`
- function name（从已持久化 call 解析，不能相信客户端重复提供）
- output text

这样 ChatGPT 能把结果和它上一轮请求的函数对应起来。

## 8. Strict Tool Parser（严格工具解析）

新增 `src/tools/parser.ts`。

解析结果：

```ts
type ParsedAssistantOutput =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; arguments: string }> };
```

规则：

1. tools 为空时直接视为 text，不启用 private protocol。
2. 输出不包含 sentinel：
   - `auto` / `none` → text。
   - `required` / 指定 function → `chatgpt_tool_required`。
3. 输出包含 sentinel：必须是“可选空白 + 完整 start marker + JSON + end marker + 可选空白”；否则 `chatgpt_tool_protocol_invalid`。
4. JSON 必须 parse 成 object，唯一根字段 `calls`，calls 为 1..16 个。
5. 每个 call 只允许 `name`、`arguments`；name 非空，arguments 是 JSON object。
6. name 不在当前 tools → `chatgpt_tool_unknown`。
7. `tool_choice=none` 却出现 calls → `chatgpt_tool_forbidden`。
8. 指定 function 时出现其他 name → `chatgpt_tool_forbidden`。
9. Parser 将 `arguments` 重新 `JSON.stringify()` 成协议需要的 arguments string，保证对外永远是合法 JSON。
10. Parser 不尝试自动修 Markdown fence、缺括号、单引号、未知函数或损坏 JSON；失败必须显式返回稳定错误。
11. Phase 7 不承诺本地 JSON-Schema semantic validation（语义校验）。`parameters` 用于 Prompt 约束与 fingerprint；模型仍可能给出语法合法但业务无效参数，和通用 function calling 一样应由工具执行方处理。

## 9. Tool Detection Buffer and Streaming（检测缓冲与流式）

Phase 5 的 DOM Stable Prefix 仍是网页文本事实来源。Phase 7 在 Stable Prefix 和公共 SSE encoder 之间加入 `ToolDetectionBuffer`。

### 9.1 Classification（分类）

有 tools 时，初始 stable delta 先缓冲：

```text
buffer is a prefix of START_SENTINEL
→ keep buffering

buffer starts with START_SENTINEL
→ classify TOOL

buffer can no longer become START_SENTINEL
→ classify TEXT and flush buffered text
```

如果已经分类为 TEXT，后续又出现完整 private sentinel，立即报 `chatgpt_tool_protocol_invalid`，不得把 sentinel 后的私有 JSON 当普通 `content` 继续发送。

### 9.2 Text streaming

一旦确定 TEXT：

- flush detection buffer。
- 后续沿用 Phase 5 `text.delta` 真流式。
- Stable Prefix holdback=64 code points 保持不变。

### 9.3 Tool-call streaming

一旦确定 TOOL：

- private protocol 的 DOM 文本完全留在内部，不发送 `text.delta`。
- 为了避免 Markdown/React DOM 回排导致半截 JSON 被误解析，Phase 7 **完整缓冲 Tool Protocol 到 ChatGPT generation completed 后再 strict parse**。
- parse 成功后，内部发出一个 `tool_calls` stream event；每个 call 的完整 arguments string 可以作为单个协议 delta 发出。
- 这意味着 text path 保持 true streaming；tool-call arguments 是“分类后安全缓冲，在完成时一次或少量 chunks 输出”，不伪装为 token-by-token 工具参数 Streaming。

### 9.4 Stream abort/error

- 客户端在 ChatGPT 仍生成时断开，继续沿用 Phase 5 stop-generation + in_flight checkpoint 语义。
- 如果公共 SSE 已开始后 Tool Parser 失败，发送当前协议的 in-stream error；不得发送成功 terminal frame。
- 如果 parser 成功并 SQLite clean commit 完成，才发送 `finish_reason=tool_calls` / Responses completed terminal。

## 10. Internal execution result（内部执行结果）

`src/api/execution.ts` 从 text-only 扩展：

```ts
interface ToolCallExecutionResult {
  type: 'tool_calls';
  toolCalls: NormalizedToolCall[];
  conversationUrl: string;
  completedAt: number;
}

type NormalizedExecutionResult = TextExecutionResult | ToolCallExecutionResult;
```

Streaming event 扩展：

```ts
{ type: 'tool_calls'; toolCalls: NormalizedToolCall[] }
```

`completed.result` 继续携带最终 union result（联合结果）。

Conversation Engine（会话引擎）负责：

1. 读取完整 DOM assistant output。
2. 按当前 tool context parse 成 text 或 tool_calls。
3. 为 tool calls 分配 external call ID。
4. **先**构建并原子保存最终 Conversation aggregate。
5. 保存成功后才允许 route/stream encoder 输出成功 terminal。

## 11. Persistence（持久化）

Phase 2 已预留数据库结构，Phase 7 默认**不新增 migration（迁移）**。

### 11.1 Assistant Tool Call turn

一个 Tool Call response 持久化为：

- `messages.role='assistant'`
- message `content=[]`（或真实存在的普通 assistant text；Phase 7 工具协议成功路径固定为空）
- 每个 call 写一条 `tool_calls`：
  - `external_call_id`
  - `name`
  - `arguments_text`
  - `message_id`

### 11.2 Tool Result turn

客户端结果持久化为：

- `messages.role='tool'`
- `tool_call_id=external_call_id`
- `content=[{type:'text', text: output}]`

Repository（仓储）已有同 Conversation 引用校验继续生效。

### 11.3 Reuse and rebuild

Aggregate Builder（聚合构建器）的 longest-common-prefix（最长公共前缀）比较扩展到 Tool Call / Tool Result，复用未变化的 Message/ToolCall identity。REBUILD 或 history divergence 只重建变化后的后缀，不让无关记录 identity 全量抖动。

## 12. Public Encoders（公共编码器）

### 12.1 Chat Completions non-stream

Text result 保持现状。

Tool result：

- `message.role='assistant'`
- `message.content=null`
- `message.tool_calls[]`
- `finish_reason='tool_calls'`
- `usage` 仍不伪造。

### 12.2 Chat Completions stream

- started：assistant role chunk。
- tool calls：每个 index 输出 `delta.tool_calls[index]`，包含 id/type/function name，arguments 可在同一 chunk 完整给出。
- terminal：`finish_reason='tool_calls'`。
- 然后 `[DONE]`。

### 12.3 Responses non-stream

Text result 保持现状。

Tool result：`output[]` 为一项或多项 `function_call`，字段至少：

- `id=fc_...`
- `type='function_call'`
- `call_id=call_...`
- `name`
- `arguments`
- `status='completed'`

### 12.4 Responses stream

对每个 function call 使用当前 Responses 风格事件：

1. `response.output_item.added`（function_call in_progress/completed-compatible item）。
2. `response.function_call_arguments.delta`（arguments 可一次完整 delta）。
3. `response.function_call_arguments.done`。
4. `response.output_item.done`。
5. 所有 calls 完成后 `response.completed`。

Gateway 不伪造 reasoning、usage 或 OpenAI server-only metadata。

## 13. Error model（错误模型）

新增稳定 Phase 7 错误：

| code | HTTP before SSE | meaning |
|---|---:|---|
| `unsupported_phase7_request` | 501 | Structured Output / image output 等 Phase 7 仍未实现能力 |
| `invalid_conversation_request` | 400 | tool choice、transcript、call reference 或 pending turn 不合法 |
| `chatgpt_tool_required` | 502 | choice 要求工具，但 ChatGPT 返回普通文本 |
| `chatgpt_tool_protocol_invalid` | 502 | sentinel / JSON / envelope 格式损坏 |
| `chatgpt_tool_unknown` | 502 | ChatGPT 请求不存在的工具 |
| `chatgpt_tool_forbidden` | 502 | ChatGPT 违反 `none` / 指定 function policy |

沿用 Phase 3–6 的错误映射原则：

- 不暴露 Playwright stack（堆栈）。
- SSE 开始前返回标准 HTTP OpenAI-style error。
- SSE 开始后发送协议内 error frame，且没有成功 terminal。
- Parser failure 保持 checkpoint `in_flight`，下一次同 key 请求走 REBUILD 保守恢复；不得把不确定网页 history 标记为 clean。

## 14. Security and prompt-injection boundary（安全与提示注入边界）

Tool schema 与 Tool Result 都是不可信输入。

必须：

- 使用 `JSON.stringify` 结构化注入，不字符串拼接“伪 JSON”。
- private protocol marker 固定由 Gateway 代码定义，客户端不能自定义。
- Tool Result 内容只作为 data field（数据字段），Prompt 明确其为工具输出而不是高优先级指令。
- 不执行 tool result 内的脚本、URL 或命令。
- 普通日志不记录完整 tool arguments/result；允许记录 call count、tool name、非敏感 fingerprint、error code。
- 工具定义、arguments/result 不进入普通错误消息。

## 15. Deterministic tests（确定性测试）

### Unit

至少覆盖：

1. canonical tool object-key sorting / tool-name sorting / fingerprint。
2. duplicate tool name / invalid forced tool。
3. Tool Prompt `auto/none/required/function`。
4. Parser text / one call / multiple calls。
5. malformed marker、Markdown fence、bad JSON、unknown/forbidden tool、>16 calls。
6. tool detection buffer prefix classification，确认 private JSON 不进入 text delta。
7. Chat Completions non-stream/stream tool encoding。
8. Responses non-stream/stream function-call encoding。
9. canonical Tool Call / Tool Result message fingerprint。
10. aggregate persistence round-trip and call IDs。

### Integration

至少覆盖：

1. FRESH user → Tool Call。
2. APPEND tool result → final text。
3. multiple Tool Calls → multiple results → final text。
4. second Tool Call after first results。
5. RESTORE tool result continuation。
6. tools unchanged does not rebuild；tool order only changes does not rebuild。
7. schema add/remove/change → REBUILD `tools_changed`。
8. tool result unknown ID / duplicate result / mixed user+tool tail rejected。
9. attachments + tools coexist without regressing Phase 6 upload selection。
10. same-key FIFO / different-key parallel remains true。
11. stream text remains incremental；stream tool private protocol never leaks as content。
12. post-SSE parser error has no success terminal。

## 16. Real ChatGPT E2E（真实网页验收）

Phase 7 不能复用 Phase 6 的 E2E 结论。新增 standalone Phase 7 harness，并最终加入 combined regression。

最低真实场景：

1. **single tool non-stream**：模型明确调用一个确定性测试工具；返回合法 tool call。
2. **tool result → final answer**：回传结果后 ChatGPT 使用结果回答，不再次重述私有协议。
3. **multiple tools**：一次返回至少两个 tool calls，call IDs 唯一。
4. **stream tool call**：SSE 中不出现 private marker/JSON content leak，最终 finish reason / Responses events 正确。
5. **stream text with tools=auto**：模型选择普通文本时仍在生成阶段出现至少一个公开 text delta。
6. **RESTORE**：释放/重新获取 page 后回传 tool result，继续原 Conversation。
7. **schema change REBUILD**：改变工具 schema 后使用新网页 Conversation 上下文，旧工具不可被继续调用。
8. **combined Phase 3 → 4 → 5 → 6 → 7**：最终候选回归退出码 0。

真实网页测试遵循 `docs/testing.md` 已有请求预算、退避、Profile（配置）与敏感信息规则。

## 17. Docker and regression（Docker 与回归）

Phase 7 没有计划新增生产依赖或数据库 migration，但正式关闭 Phase 前仍执行：

- fresh `corepack pnpm verify`。
- `git diff --check`。
- fresh `linux/amd64` Docker build。
- `corepack pnpm docker:smoke`。
- authenticated `inspect:chatgpt`。
- standalone Phase 7 real E2E。
- combined Phase 3/4/5/6/7 real E2E。

如果实现事实证明无需 Docker 层变化，仍把 fresh smoke 作为回归证据，而不是声称“代码没碰 Docker 所以不用测”。

## 18. Documentation writeback（文档回写）

Phase 7 验收后至少同步：

- `README.md`
- `docs/api-compatibility.md`
- `docs/architecture.md`
- `docs/testing.md`
- `docs/roadmap.md`
- 本 spec
- Phase 7 implementation plan（实施计划）
- `docs/PROJECT_STATE.md`

关闭状态目标：

```text
PHASE=phase-7-complete
STATUS=ready-for-phase-8-design
ACTIVE_PLAN=none
NEXT_TASK=write-phase-8-image-generation-spec
```

实际字段以验收时真实项目状态为准。

## 19. Acceptance criteria（验收标准）

Phase 7 只有同时满足以下条件才能关闭：

1. 两套 API 都能产生正确 function Tool Call 输出。
2. tool result 能继续同一 Conversation 并得到 final answer 或 next call。
3. 单工具、多工具、RESTORE、REBUILD、附件共存都被确定性测试覆盖。
4. Streaming 普通文本仍是真流式，private Tool Protocol 不泄漏到公共 content。
5. Tool Call 成功路径先持久化 clean aggregate，再发送成功 terminal。
6. parser/error path 不错误提交 clean checkpoint。
7. SQLite tool call / result 可重启恢复，external call ID 稳定。
8. standalone Phase 7 authenticated real E2E 通过。
9. combined Phase 3/4/5/6/7 authenticated real E2E 通过。
10. fresh verify + Docker smoke + repository governance 全绿。
11. 项目文档和 Project Memory（项目记忆）与真实实现同步。
12. feature branch 正常提交并 push；不 force-push，不创建 PR / Release / Docker registry publish，除非用户另行要求。
