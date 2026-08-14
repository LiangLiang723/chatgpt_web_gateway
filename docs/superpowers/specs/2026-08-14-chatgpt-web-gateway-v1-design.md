# ChatGPT Web Gateway V1 Design

**Date:** 2026-08-14
**Status:** Approved product design; implementation not started

## 1. Product Goal（产品目标）

构建一个长期运行在 NAS（网络附加存储）上的 ChatGPT Web Gateway（网页网关）：上游只看到 OpenAI Compatible API（OpenAI 兼容接口），下游通过 Playwright（浏览器自动化框架）自带 Chromium（浏览器）操作已登录的 `chatgpt.com`。

Gateway 不绑定 Hermes 或任何特定 Agent（智能体）。只要客户端能够调用支持范围内的 OpenAI 风格 API，就应走同一套协议和会话逻辑。

## 2. Hard Boundaries（硬边界）

V1 固定：

- ChatGPT Web only（仅 ChatGPT 网页）。
- OpenAI Compatible API only（仅 OpenAI 兼容接口）。
- Playwright 自带 Chromium 为主浏览器。
- 不使用 Google Chrome / Edge / Firefox / WebKit 兼容层。
- 不使用 ChatGPT 私有 `/backend-api`、Sentinel、Arkose 等内部接口作为执行路径。
- noVNC（网页远程桌面）不作为核心依赖。
- 不做 Claude / Gemini / Grok Provider（服务商）框架。
- 允许保存完整对话，不以“避免落盘”为设计目标。

## 3. V1 API Scope（接口范围）

必须实现：

```text
GET    /health
GET    /v1/models
POST   /v1/chat/completions
POST   /v1/responses
POST   /v1/files
GET    /v1/files
GET    /v1/files/:id
GET    /v1/files/:id/content
DELETE /v1/files/:id
POST   /v1/images/generations
```

明确不做：Audio（音频）、Embeddings（向量嵌入）、Realtime（实时接口）、Batches（批处理）、Fine-tuning（微调）、Vector Stores（向量存储）以及无法自然映射到 ChatGPT Web 的其他 OpenAI 平台能力。

详细字段兼容策略以 [`../../api-compatibility.md`](../../api-compatibility.md) 为准。

## 4. Shared Internal Model（统一内部模型）

Chat Completions（聊天补全）和 Responses API（响应接口）只负责协议 Adapter（适配器），不能各自写一套浏览器逻辑。

目标内部模型：

```ts
interface NormalizedRequest {
  requestId: string;
  conversationKey?: string;
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  attachments: NormalizedAttachment[];
  output: {
    mode: 'text' | 'image';
    stream: boolean;
    structured?: NormalizedStructuredOutput;
  };
}
```

协议变化停留在 API Adapter，Conversation Engine（会话引擎）和 ChatGPT Driver（网页驱动）保持稳定。

## 5. Conversation Identity（会话标识）

内部统一使用 `ConversationKey`，不识别具体 Agent 品牌。

客户端如果能提供稳定会话 ID，Gateway 使用受控兼容扩展 Header `X-Conversation-Key` 传入并标准化为内部 `conversationKey`。客户端未提供时，协议层保持 `undefined`，后续 Conversation / Context Sync 阶段再实现保守的自动策略。扩展不能破坏标准 OpenAI 请求的基本兼容性。

每个 Conversation 本地保存：

- Gateway conversation id。
- ChatGPT conversation URL。
- 完整 Message（消息）。
- System / Developer 指令。
- Tool Schema（工具结构）和 fingerprint（指纹）。
- Tool Call / Tool Result。
- Attachment（附件）引用。
- 同步位置和最近使用时间。

## 6. Context Sync（上下文同步）

Agent 通常每轮会重新发送完整历史，但 ChatGPT 网页已经保留旧历史，因此 Gateway 不能无条件把整个 `messages[]` 重发。

同步只允许四种模式：

### FRESH

没有本地或网页会话，新建 ChatGPT Conversation 并注入当前有效初始化上下文。

### APPEND

上游历史与本地已同步历史一致，只发送 ChatGPT 尚未知的新用户内容、Tool Result 或附件。

### RESTORE

Gateway / Page 重启，但本地状态和 ChatGPT conversation URL 可用；重新打开原网页会话后继续。

### REBUILD

以下情况优先重建，而不是向旧会话打补丁：

- 上游历史被压缩、修改、回滚或分叉。
- System / Developer 指令发生影响行为的变化。
- Tool Schema 发生不安全变化。
- 原 ChatGPT Conversation 无法恢复。

Context Sync 的规划逻辑必须是纯函数，可脱离 Playwright 做 Unit（单元）测试。

## 7. Concurrency（并发）

- 同一 Conversation 内请求必须串行，防止两个请求同时写同一网页会话。
- 不同 Conversation 可以并行。
- 不允许一个全局 Lock（锁）把所有客户端串行化。
- Page Pool（网页池）配置最大活跃 Page；空闲 Page 可以关闭，本地 Conversation 状态继续保留。

初始建议配置：

```text
MAX_ACTIVE_PAGES=4
PAGE_IDLE_TIMEOUT_MINUTES=30
```

配置值可调整，不视为协议承诺。

## 8. Browser Runtime（浏览器运行时）

Docker 从 Phase 1 起作为正式运行边界。目标平台先锁定 `linux/amd64`，完整镜像以官方 Playwright Node Docker 镜像为基础并固定明确版本。项目 Playwright package 与镜像浏览器版本必须匹配；Node LTS 独立校验，不能假设基础镜像内置 Node 永远与项目批准 LTS 一致。

正常运行默认 `UI_MODE=headless`。首次登录、重新认证或人工排障时使用基础 Compose + noVNC 维护 overlay，临时启动 Xvfb / VNC / noVNC 并发布维护端口；正常模式不启动这些进程，也不发布 noVNC 端口。两种模式复用 `/data/browser-profile/`。

V1：

```text
Playwright
  └── bundled Chromium
      └── Persistent BrowserContext
          ├── Page A
          ├── Page B
          └── Page C
```

使用项目专用 `data/browser-profile/` 保存 ChatGPT 登录状态，不使用个人日常浏览器 Profile。

开发/首次认证可使用 headed（有界面）模式，NAS 正式运行使用 headless（无界面）模式。noVNC 不是正常运行所需组件。

## 9. ChatGPT Driver（网页驱动）

Driver 封装所有 ChatGPT DOM（文档对象模型）行为：

- 打开/新建 Conversation。
- 输入消息。
- 上传附件。
- 识别新 Assistant Turn（回复节点）。
- 读取回复 Snapshot（快照）。
- 判断生成状态。
- 停止生成。
- 图片生成和最终资源提取。

所有 Selector（选择器）集中在 `src/chatgpt/selectors.ts`。关键 Selector 至少有主路径和可解释 fallback（降级），但不允许危险的“附近第一个按钮”。

必须提供 DOM 诊断命令，用于 ChatGPT UI 改版后的快速定位。

## 10. Send State Machine（发送状态机）

文本/附件发送采用显式状态，而不是散落固定 sleep（休眠）：

```text
READY
→ PREPARING
→ UPLOADING
→ COMPOSING
→ SUBMITTING
→ WAITING_FOR_TURN
→ STREAMING
→ COMPLETED
```

异常状态：`FAILED`、`CANCELLED`。

附件必须等 ChatGPT 网页显示上传完成/预览就绪后才能发送文本。

## 11. True Streaming（真流式）

`stream=true` 必须在 ChatGPT 仍生成时开始向客户端发送内容，不能等待完整回答后再伪切片。

V1 使用约 200ms DOM polling（网页轮询），保留近期 Snapshot 并计算 Stable Prefix（稳定前缀）。不能只用：

```ts
currentText.slice(previousText.length)
```

因为 Markdown（标记语言）和 React（前端框架）可能重排 DOM。

完成检测综合：

- 新 Assistant Turn 已出现。
- Stop / generating 状态消失。
- 不在 Thinking / Searching / Generating 状态。
- 文本连续稳定若干轮。
- 图片/附件相关生成状态不再变化。

确认完成后必须 flush（刷新）尚未发送的最终尾部。

Chat Completions SSE（服务器发送事件）和 Responses SSE 使用各自 Encoder，但共享内部流事件。

客户端主动断开流式连接时，V1 停止 ChatGPT 当前生成，避免客户端历史与网页历史分叉。

## 12. Tool Calling（工具调用）

Gateway 接收 OpenAI `tools` / `tool_choice`，但 ChatGPT Web 不提供同一套原生协议，因此 V1 使用：

```text
Tool Schema
→ Canonicalize + Fingerprint
→ Tool Prompt
→ ChatGPT
→ Tool Detection Buffer
→ Tool Parser
→ OpenAI tool_calls
```

工具定义没变时不需要每轮重复灌入完整 Tool Schema。

存在 tools 时，Streaming 前先缓冲足够前缀判断是普通文本还是 Tool Call，禁止把内部工具 JSON 当作普通 `content` 流出去。

Agent 回传 `role=tool` / `tool_call_id` 时，Gateway 转换成内部 ChatGPT 可理解的 Tool Result 表达；该内部格式不能泄漏成公共协议。

## 13. Images and Files Input（图片和文件输入）

支持：

- `image_url` 网络图片。
- Base64 Data URL 图片。
- OpenAI 风格文件 content part。
- `/v1/files` 上传后通过 `file_id` 复用。
- 常见 ChatGPT 网页可接受的 PDF、文本、Office 和图片文件。

统一 Attachment Pipeline（附件流水线）：

```text
OpenAI input
→ resolve URL / Base64 / file_id
→ validate size/type
→ persistent file store
→ SHA-256 metadata
→ Playwright upload
→ wait upload ready
→ send Prompt
```

Gateway 设置自己的安全上限，但不伪造 ChatGPT Web 实际支持的大小/格式；ChatGPT 拒绝时返回稳定 Upload Error（上传错误）。

## 14. ChatGPT Image Generation（图片生成）

V1 同时支持 `POST /v1/images/generations`：

```text
OpenAI image request
→ Image Adapter
→ ChatGPT webpage prompt
→ wait final image
→ fetch/download image
→ data/generated/
→ URL or Base64 response
```

V1：

- `prompt`：支持。
- `n=1`：支持。
- `n>1`：不支持。
- `size` / `quality`：只能在网页能力允许时尽力映射。
- URL / Base64 输出：支持。
- partial image Streaming：不支持。
- Image Edit：不在 V1。

## 15. Persistence（持久化）

使用 SQLite + 文件系统：

```text
data/
├── gateway.db
├── browser-profile/
├── files/
├── generated/
├── temp/
└── logs/
```

SQLite 目标实体：Conversation、Message、Tool Call、Attachment、File、Generated Image 和必要同步状态。

磁盘状态是恢复事实来源；内存结构只用于运行时加速。

## 16. OpenAI Compatibility Honesty（兼容真实性）

网页无法真实控制的字段不能假装实现：

- `temperature` / `top_p` / penalties / `seed`：V1 可接收但忽略。
- `response_format`：只能 Prompt 约束/本地校验时明确标记为近似。
- `logprobs` / `logit_bias`：明确 unsupported。
- Token Usage：无法可靠获得时不伪造。
- 默认模型名只暴露 `chatgpt-web`；Alias 只作为客户端兼容映射，不宣称等于某个真实 OpenAI API 模型。

## 17. Error Handling and Recovery（错误和恢复）

`GET /health` 无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。缺少正式 Gateway API Key 时服务启动失败，密钥与 Authorization Header 不得写入普通日志。

对外返回稳定 OpenAI 风格错误，不暴露 Playwright 原始堆栈。

恢复逐级升级：

```text
Selector retry
→ Page reload
→ reopen conversation URL
→ new Page
→ rebuild BrowserContext
→ restart Chromium
```

单会话故障不能默认影响其他会话。

需识别至少：登录失效、网络错误、限流、Conversation 不存在、发送失败、上传失败、生成超时和 ChatGPT 通用页面错误。

## 18. Testing（测试）

- Unit：协议标准化、Context Sync、Stable Prefix、Tool Parser、附件解析、错误映射。
- Integration：API → Conversation Engine → fake Driver、SQLite、Queue、Page Pool 策略。
- E2E：真实登录、文本、多轮、RESTORE、Streaming、图片、文件、Tools、图片生成。

真实 E2E 默认关闭，必须显式开启；普通 `verify` 不依赖外网和 ChatGPT 登录。

## 19. Deployment（部署）

最终目标为 NAS 上单服务容器化运行，Docker 从 Phase 1 起就是正式运行边界，而不是后期附加包装。

仓库提供单一完整镜像、基础 Compose 和按需 noVNC 维护 overlay。`/data` 默认使用宿主机目录 Bind Mount，Browser Profile、SQLite、文件、生成资源和日志均位于该持久边界。长期 Gateway / Chromium 进程必须非 root，并支持 `PUID/PGID` 与 NAS 权限对齐。

后续生产 Phase 继续完善恢复、诊断、安全加固和 NAS 运维，不再负责第一次容器化。

## 20. V1 Success Criteria（V1 成功标准）

一个通用 OpenAI-compatible Agent 能够：

1. 通过 Chat Completions 或 Responses 与 ChatGPT Web 多轮对话。
2. 获得真正边生成边输出的文本 Streaming。
3. 上传图片/文件并让 ChatGPT 分析。
4. 完成 Tool Calling 闭环。
5. 调用图片生成并获得图片资源。
6. 在 Gateway 重启/Page 回收后恢复 Conversation。
7. 多个不同 Conversation 同时使用，而不会被一个全局锁全部串行。
8. 通过仓库文档和项目状态继续维护，而不依赖原聊天会话。
