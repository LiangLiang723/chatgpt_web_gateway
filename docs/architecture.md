# Architecture（架构）

## 目标

把 ChatGPT Web（ChatGPT 网页）通过 Playwright（浏览器自动化框架）自带 Chromium（浏览器）转换为稳定、可测试、通用的 OpenAI Compatible API（OpenAI 兼容接口）。

项目不模拟整个 OpenAI 平台，只实现 Agent（智能体）常用且可以自然映射到 ChatGPT Web 的能力。

## 顶层数据流

```text
OpenAI Compatible Client / Agent
              │
              ▼
          API Layer
              │
              ▼
      Request Normalizer
              │
              ▼
       NormalizedRequest
              │
              ▼
       Conversation Engine
   ┌──────────┼───────────┐
   ▼          ▼           ▼
Context     Tools     Attachments
   └──────────┼───────────┘
              ▼
        ChatGPT Driver
              │
              ▼
        Browser Manager
              │
              ▼
     Playwright Chromium
              │
              ▼
          chatgpt.com
```

## 模块职责

```text
src/
├── api/             OpenAI HTTP 协议、认证、Schema、输入输出 Adapter
├── browser/         Chromium 生命周期、BrowserContext、Page Pool、健康检查
├── chatgpt/         ChatGPT DOM 行为、Selector、发送、提取、上传、图片生成
├── conversations/   Conversation 生命周期、队列、Page 绑定和恢复
├── context/         FRESH / APPEND / RESTORE / REBUILD 纯逻辑
├── tools/           Tool Schema 标准化、Prompt、Parser、Tool Result
├── attachments/     图片/文件解析、下载、去重、落盘、上传准备
├── stream/          Snapshot、Stable Prefix、Delta、内部流事件
├── persistence/     SQLite Repository 与文件元数据
├── config/          环境变量、默认值、配置验证
└── observability/   结构化日志、诊断和错误上下文
```

## 内部统一请求模型

`/v1/chat/completions`、`/v1/responses` 不得各自实现浏览器执行链。入口 Adapter（适配器）统一转换为内部模型：

```ts
interface NormalizedRequest {
  requestId: string;
  conversationKey?: string;
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  attachments: NormalizedAttachment[];
  output: {
    mode: 'text' | 'image';
    stream: boolean;
    structured?: NormalizedStructuredOutput;
  };
  diagnostics: {
    ignoredParameters: string[];
  };
}
```

图片生成可以有独立 `ImageRequestAdapter`，但浏览器生命周期、错误、持久化和生成资源管理仍复用公共基础设施。

## Conversation（对话）和 Context Sync（上下文同步）

每个 Conversation 有稳定 `ConversationKey`，本地保存完整消息和 ChatGPT conversation URL。

同步只允许四种模式：

- `FRESH`：没有已知会话，创建新 ChatGPT Conversation。
- `APPEND`：输入历史与本地已同步前缀一致，只发送新增内容。
- `RESTORE`：进程/Page 已丢失，但 ChatGPT conversation URL 和本地状态可恢复。
- `REBUILD`：历史被压缩、修改、回滚，或原网页会话不可恢复，根据当前有效历史建立新会话。

同一 Conversation 请求串行，不同 Conversation 可以并行。禁止全局锁串行所有用户。

Phase 4 已批准设计以 SQLite `ConversationStore` + `clean | in_flight` sync checkpoint 作为恢复事实源，并把请求确定性分为 `incremental | full`：单条 user message 是 incremental；多条消息或 assistant/tool history 是 full。只有能够证明已确认历史与当前请求一致时才 APPEND/RESTORE；历史分叉、instructions 变化、checkpoint 不确定/不匹配、URL 缺失或确认不可恢复时统一 REBUILD。无 `X-Conversation-Key` 时仍为独立 Fresh Conversation 并完整持久化 `conversation_key = NULL`，但绝不跨请求做隐式身份绑定。

有稳定 key 的请求通过 keyed FIFO Queue 串行化；排队期间不占 Page，轮到时重新读取 SQLite 最新状态。第一次可能写入 ChatGPT turn 之前先把 checkpoint 置 `in_flight`；成功后一次性保存 reconciled aggregate 并恢复 `clean`。任何发生在 checkpoint 之后且无法证明网页副作用的失败都不得猜测回滚为 clean，下一请求通过 REBUILD 收敛。普通认证、Selector、Browser runtime 错误不得被伪装成“可安全重建”的 restore failure。

## Container Runtime（容器运行时）

Docker 从 Phase 1 起就是正式运行边界，而不是后期附加包装。目标平台先锁定 `linux/amd64`。

仓库提供单一完整镜像。Phase 3 起正常 `UI_MODE=headless` 会先启动仅供浏览器使用的 Xvfb，再由 Gateway BrowserManager 以 `headless:false` 启动 full Playwright bundled Chromium / Persistent BrowserContext；**headless 在这里表示无可访问 UI，而不是 Chromium 的 `--headless` 指纹**。真实环境验证表明 Playwright headless-shell 与 Chromium new-headless 都会长期停在 ChatGPT Cloudflare challenge，而 Xvfb 上的 full Chromium 可进入正常 ChatGPT 页面，因此这是实现强制调整。正常模式不启动 x11vnc/websockify/noVNC，也不发布维护端口。首次登录、重新认证或人工排障时，通过 Compose noVNC overlay 启动 Xvfb / x11vnc / noVNC 和独立 headed maintenance browser。maintenance browser 使用镜像内固定版本的 **Google Chrome Stable**，由 Node 直接 spawn，不创建 Playwright BrowserContext、不开 `--remote-debugging-pipe`；真实 A/B 验证中 Chrome for Testing 在 `auth.openai.com` Turnstile 持续循环，而 Google Chrome Stable 完成人工验证并保存可供产品 Playwright Chromium 复用的 Profile 登录态。maintenance 模式不启动产品 BrowserManager，ChatGPT POST 返回稳定 `browser_maintenance_mode`，从而保证同一 Profile 只有一个 browser owner。

镜像以官方 Playwright Node Docker 镜像为基础并固定明确版本。Phase 1 实现固定 `mcr.microsoft.com/playwright:v1.62.1-noble` 与 `playwright@1.62.1`；实测镜像运行时为 Node `v24.18.1` / `linux/amd64`。后续升级仍必须重新检查 package / image / Node LTS 组合，不能把这次结果当作永久事实。

持久状态统一通过宿主机目录 Bind Mount 到 `/data`；normal BrowserManager 的生产 Profile 固定在 `/data/browser-profile/`。**同一 Profile 同时只能有一个 browser owner**：Phase 3 起 `UI_MODE=headless` 由产品 BrowserManager / Playwright Chromium 占用生产 Profile；`UI_MODE=novnc` 则明确禁用产品 BrowserManager，只启动 headed maintenance Google Chrome Stable。maintenance 默认仍使用 `/data/browser-profile/`，但显式 real E2E 可通过 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile` 切到隔离测试 Profile；该 override 不改变 normal headless 的生产 Profile。maintenance shutdown 由 entrypoint 有序监督：等待 Chrome Profile lock ready，停机时请求 Chrome 退出后再停止 Gateway；若 Chrome 已退出但当前容器自己的 Linux `SingletonLock/Cookie/Socket` 仍残留，只在 lock hostname 匹配当前容器且 PID 已确认不存在时清理 stale marker，避免下一模式因容器 hostname 改变误报 Profile 仍被占用。maintenance 的 x11vnc 0.9.16 固定使用 `-threads`：真实复现中默认单线程模式会高 CPU 且不发送 RFB banner，而 threaded 模式能立即完成 `RFB 003.008` 握手。maintenance overlay 使用 vendored Playwright seccomp profile 开放 Chromium user-namespace 所需 syscall，让非 root Google Chrome 保持 Linux sandbox；不添加 `SYS_ADMIN`，也不使用 `--no-sandbox`。长期 Gateway / Browser 进程必须非 root，并支持 `PUID/PGID` 与 NAS 文件权限对齐。noVNC overlay 默认只把维护端口绑定到宿主机 `127.0.0.1`；需要远程 NAS 访问时必须显式调整绑定并自行保证网络访问控制。

ChatGPT 浏览器网络可通过可选 `CHATGPT_PROXY_SERVER` 配置。该值只允许 `http` / `https` / `socks5` proxy server origin，URL 内禁止用户名/密码；同一值必须传给 normal BrowserManager、maintenance browser、`inspect:chatgpt` 和 real E2E，避免四条路径出现不同网络行为。未配置时 Chromium 保持直连。

## Browser（浏览器）

V1：

```text
Playwright
  └── Chromium
      └── Persistent BrowserContext
          ├── Page A → Conversation A
          ├── Page B → Conversation B
          └── Page C → Conversation C
```

Page 数有上限。Phase 3 建立 bounded Page Pool；Phase 4 已在其上增加 Conversation → Page affinity、idle timeout 与容量压力下的 LRU idle eviction。默认 `PAGE_IDLE_TIMEOUT_MINUTES=30`，只回收 idle affinity，不抢占 active Conversation。Conversation 请求失败时对应 lease 会 discard，避免把未知状态 Page 继续绑定给该 key；本地 SQLite 状态仍保留，因此后续可通过 conversation URL RESTORE。

故障恢复逐级升级：

1. 重新定位 Selector（选择器）。
2. reload（刷新）当前 Page。
3. 重新打开 conversation URL。
4. 新建 Page。
5. 重建 BrowserContext。
6. 最后才重启 Chromium。

单 Page 故障不得无条件杀掉其他 Conversation。

## ChatGPT Driver（网页驱动）

上层只依赖稳定接口，不依赖 DOM 细节。所有 ChatGPT Selector 必须集中在 `src/chatgpt/selectors.ts`。

Phase 3 建立了 Fresh text Driver 的发送/完成观察基础；Phase 4 将导航/readiness 与提交彻底拆分为 `openFresh(page)`、`openConversation(page, savedUrl)` 和纯 `sendText(page, { prompt })`。`openConversation` 只接受安全 `https://chatgpt.com` non-root Conversation URL，以 canonical pathname 比较 identity（忽略 query/hash）；确认无法恢复时返回显式 `not_restorable`，auth/selector/browser 异常继续作为错误传播。所有路径仍复用 Auth Probe、Assistant Turn baseline ownership 和 completion observer。2026-08-16 真实 DOM 验收发现全局 `stop-button` 可能在答案可见文本已经稳定后继续滞留，因此它不再是唯一完成条件；Driver 现在绑定本次新 Assistant turn，并等待该 turn 的 `copy-turn-action-button` completion marker 出现，再结合非空文本连续稳定采样确认完成。固定约 250ms 只是 polling cadence，不把任意 sleep、`networkidle` 或全局按钮瞬时状态当作完成证据。

Selector Registry 区分 `unique` 与 `collection`。Unique selector primary 多匹配立即 `selector_ambiguous`，不会通过 `.first()` / `.nth()` 掩盖；collection 才允许按明确业务索引访问新 turn。Phase 5 authenticated real E2E 进一步确认 Fresh 会短暂进入 `/c/WEB:<uuid>` provisional route，APPEND 也可能先挂载没有 `.markdown` 正文的临时 Assistant placeholder；Driver 因此只有在正式安全 Conversation URL 与 owned turn 唯一 `.markdown` 正文同时成立后才暴露 authoritative snapshot。若 ChatGPT 生成 writing-block/editor 导致多个正文节点，继续严格 `selector_ambiguous`，不截断结构化 UI 冒充纯文本。

Phase 5 Conversation Engine 继续复用 Phase 4 的 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、Page affinity 与 SQLite `clean | in_flight` checkpoint，并提供 protocol-neutral `{ execute, stream }` 两条纯文本执行入口。`stream=true` 不改变 Context Sync：FRESH/REBUILD 仍发送完整 Context Envelope，APPEND/RESTORE 仍只发送 `current_user`。附件、Tools、Structured Output 与 image execution 仍由 `unsupported_phase5_request` 明确拒绝。Streaming 整个生命周期（包含 abort cleanup）都在 same-key Queue 内；不同 key 仍可并行。

浏览器/Driver 原始异常不会直接成为公共 API；未知 Page/Playwright runtime/navigation failure 映射为稳定 `browser_unavailable`。`src/chatgpt/inspect.ts` 只检查已经拥有的 Page，不创建 BrowserManager；显式 CLI 才负责独立 E2E Profile 的 Browser 生命周期。当前 ChatGPT 还可能显示明确 `data-testid="modal-conversation-history-rate-limit"` 的通知 overlay；真实隔离实验已证明其唯一 `Got it` 只是关闭提示、关闭后同一 Conversation 请求仍可立即成功，因此 Driver 只对这个精确 testid + 唯一按钮做确认。CAPTCHA、MFA、其它 modal 与未知 challenge 仍绝不自动处理。

Phase 3 authenticated ChatGPT DOM 与 Fresh 文本链已于 2026-08-15 完成真实验收：独立 Profile 先通过 maintenance Google Chrome Stable 人工登录，再由产品同版本族的 Playwright Chromium 复用该 Profile；`inspect:chatgpt` 实际得到 `auth=authenticated` 与唯一 Composer。真实运行还发现 Composer 在 `domcontentloaded` 后可能延迟挂载，因此 Auth Probe 在首次 strict probe 为 unknown 时会使用 Locator `waitFor({ state: 'attached' })` 等待 Composer/Login signal 后重新 strict probe，而不是固定 sleep。随后 `test:e2e:chatgpt` 实际通过 Fresh Driver challenge 与 Gateway HTTP → ChatGPT Web → Chat Completions challenge。

Phase 4 于 2026-08-16 完成真实 authenticated ChatGPT Web E2E：新的干净隔离 Profile 经 maintenance Google Chrome Stable 登录后，`inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`；修复上述 completion marker 回归后，combined `test:e2e:chatgpt` 同时通过 Phase 3 regression 与 Phase 4 full-history APPEND、runtime restart RESTORE、history divergence REBUILD。APPEND 的 live DOM 断言证明第二个 Web user turn 只包含新 marker、不重发第一轮历史；RESTORE 保持持久化 Conversation URL；REBUILD 保持本地 key/UUID 但获得新的 ChatGPT Conversation URL。

## Streaming（流式输出）

Phase 5 已实现纯文本真 Streaming 的代码路径：

```text
Target Assistant DOM Turn
   ↓ observe() ~200ms
AssistantSnapshot
   ↓ CRLF/CR normalize
3-sample Stable Prefix
   ↓ non-empty Delta
Protocol-neutral TextStreamEvent
   ├── Chat Completions SSE Encoder
   └── Responses SSE Encoder
```

`src/stream/` 是纯逻辑层，不依赖 Playwright、`api/`、`browser/`、`chatgpt/`、`persistence/` 或 `node:sqlite`。Assistant ownership 仍由发送前 `assistantTurns.count()` 的 baseline 决定；Driver 的 `ChatGptTextTurn` 只观察固定 target turn，并提供 `observe()`、严格唯一 Stop 的 `stop()` 和安全 `conversationUrl()`。

Stable Prefix 使用最近 3 个 snapshot 的 longest common prefix，并在普通生成阶段默认把最后 16 个 Unicode code points 作为 bounded commit-tail holdback 留在内存；authenticated real Markdown E2E 证明当前 renderer 会在 `<pre>` 挂载/重排期间短距离改写尾部。最终 completion 确认后再精确 flush 被保留的完整尾部。已经发送的 prefix 永不撤回；若后续 DOM rewrite 穿过已 committed prefix，仍进入稳定 `chatgpt_stream_diverged`，不发送 correction/backspace。Completion 以 target turn 自身的 `copy-turn-action-button` marker + 连续稳定 final text + final reread 为终态，不把可能滞留的全局 Stop control 当成功必要条件。

Conversation Engine 在首个 protocol-neutral `started` 后、第一次可能写网页 turn 前持久化 `in_flight`。若客户端在首帧后立即断开，Engine 会在 checkpoint 前检查 AbortSignal；若断开发生在 checkpoint 后但 Send 前，Driver 在 baseline/composer/fill/send 异步边界继续检查同一个 signal，保证不继续点击 Send。生成中 abort 会 best-effort Stop、不保存 partial Assistant、保持 `in_flight` 并 discard 当前 Page；下一 keyed request 通过 REBUILD 收敛。

成功流只有在 final Assistant text、安全 Conversation URL 和完整 aggregate 已经原子保存为 clean 后才发送成功 terminal。final save 失败不发送 `[DONE]` / `response.completed`；clean commit 后才发生的 terminal transport close 不回滚已经确定完成的网页 turn。

HTTP 层第一次收到 internal `started` 才通过 Fastify `reply.hijack()` 接管 raw SSE。SSE writer 尊重 Node writable backpressure；pre-start error 保持普通 OpenAI-style 非 200 JSON，post-start error 使用协议内 error framing 且不伪造成功终止。

Chat Completions 与 Responses 使用独立 Encoder，但共享同一 internal stream event。2026-08-17 Phase 5 authenticated real E2E 已在隔离登录 Profile + 显式 LAN proxy 上完成：standalone harness 真实通过长 Chat Completions、Markdown/code、Responses typed lifecycle 与 client abort→Stop→`in_flight`→REBUILD；随后 combined harness 同时通过 Phase 3、Phase 4 与 Phase 5。真实断言要求首个 meaningful delta 早于 target completion marker，并要求最终 `delta concat == authoritative live DOM == SQLite`。

## Tool Calling（工具调用）

V1 使用 Gateway 自己的 Prompt + Parser：

```text
OpenAI Tool Schema
   ↓
Canonicalize + Fingerprint
   ↓
Tool Prompt
   ↓
ChatGPT
   ↓
Tool Detection Buffer
   ↓
Tool Parser
   ↓
OpenAI tool_calls
```

存在 tools 时，先缓冲足够前缀判断普通文本还是工具调用，防止内部 JSON（结构化数据）泄漏到普通 content 流。

## Attachments（附件）

Phase 6 已完成设计、尚未实现；Governing Spec 见 [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。批准的数据流是：

```text
OpenAI content part / file_id
          ↓
Attachment Resolver
          ↓
URL Download / Base64 Decode / File Lookup
          ↓
Persistent Logical File → content-addressed SHA-256 Blob
          ↓
Canonical multimodal Conversation + Context Planner
          ↓
request-scoped PreparedAttachment staging
          ↓
Playwright setInputFiles
          ↓
等待本请求 owned ChatGPT 附件预览和真实 upload readiness
          ↓
发送 Prompt
```

Phase 6 锁定逻辑 File 与物理 Blob 分离：公开 `/v1/files` 和 inline URL/Data URL/Base64 都最终解析成本地 File；相同 bytes 可以有不同逻辑 File identity，但共享一个 SHA-256 Blob。永久 Blob path 不包含用户 filename，raw URL/Base64 不进入 Attachment persistence。`chatgpt/` 只接收已经准备好的本地 staging path，不下载网络、不解码 Base64、不访问 SQLite。

Context Sync 仍只有 `FRESH | APPEND | RESTORE | REBUILD`：APPEND/RESTORE 只上传当前新增 user turn 附件；FRESH/REBUILD 从本地 File 事实源重新上传当前有效 full context 所需附件。第一次 Browser upload side effect 前必须先持久化 `in_flight`；upload/readiness 的未知失败保持 `in_flight` 并 discard Page。stream/non-stream 在 Send 后继续共享 Phase 5 target Assistant / completion / Stable Prefix。

SQLite 保存 File/Blob/Attachment 元数据和引用，大文件字节保存在 `data/files/`。具体 migration、Files DELETE retention、SSRF/资源限制与 authenticated real E2E 边界以 Phase 6 spec 为准；在实现和真实验收完成前，公开附件能力仍保持未实现。

## 图片生成

`POST /v1/images/generations` 通过 ChatGPT 网页触发图片生成，等待最终图片就绪后下载到 `data/generated/`，再返回 URL 或 Base64。V1 不做 partial image（部分图片）流式，也不做 `n>1`。

## Persistence（持久化）

目标数据目录：

```text
data/
├── gateway.db
├── browser-profile/
├── files/
├── generated/
├── temp/
└── logs/
```

SQLite 保存 Conversation、Message、Tool Call、Attachment、File、Generated Image 等结构化记录。磁盘持久化是恢复事实来源，内存只做运行时缓存。

Phase 2 使用 Node 24 内置 `node:sqlite` 的单 `DatabaseSync` 连接，不引入 ORM 或第三方 SQLite driver。数据库固定 `${DATA_DIR}/gateway.db`，启用 `foreign_keys=ON`、WAL 和 5000ms busy timeout。Schema 通过单向顺序编号 migration 管理，并保存 SHA-256 checksum 防止已执行历史 SQL 被静默改写。

业务实体使用 UUID v4 主键和 Unix 毫秒时间；需要查询/约束的字段关系化，复杂 content/instructions/tools/source 使用 JSON `TEXT`。上层只依赖 Repository / `ConversationStore`，`node:sqlite` 不能泄漏到 `src/persistence/` 外。完整 Conversation aggregate 的保存必须在单个同步事务中完成；事务 helper 会拒绝 async callback。进程关闭并重新打开同一数据库后应能恢复语义一致的结构化状态。

Phase 2 已把 persistence lifecycle 接到生产 Gateway：Fastify listen 前创建/迁移 `${DATA_DIR}/gateway.db`，shutdown 时幂等关闭数据库。最终 Docker 镜像包含 `migrations/`；Docker smoke 会验证数据库 owner、`001_initial` migration history 和同一 Bind Mount 下 Gateway restart 后继续可用。

## API Authentication（接口认证）

`GET /health` 保持无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。配置集中在 `src/config/`，业务模块不得分散读取环境变量。缺失 Gateway API Key 时正式服务启动失败。

兼容扩展 `X-Conversation-Key` 可把客户端稳定会话标识传入 `NormalizedRequest.conversationKey`。Phase 4 中有 key 的请求使用 SQLite Conversation lifecycle、同 key FIFO 与 Page affinity；未提供时仍保持 `undefined`，每个请求创建独立持久化 Fresh Conversation（`conversation_key = NULL`），Gateway 不自动创建客户端可见 key，也不推断或跨请求绑定匿名 Conversation identity。

## 错误边界

内部使用稳定错误类型；API 层映射为 OpenAI 风格错误。不得把 Playwright 原始堆栈、Cookie、API Key、Authorization Header、文件系统敏感路径直接返回客户端或写入普通日志。

## 可执行架构约束

`scripts/check-architecture.mjs` 会随着产品源码出现逐步收紧：

- `api/` 不直接导入 `playwright`。
- `context/` 不依赖 `playwright`、`api/` 或 `chatgpt/`。
- `stream/` 不直接导入 `chatgpt/selectors`。
- `persistence/` 不依赖 `playwright`。
- `node:sqlite` 只允许在 `src/persistence/` 中导入；checker 同时识别普通、动态、require 和 side-effect import。
- ChatGPT Selector 只允许定义在 `src/chatgpt/selectors.ts`。
- `browser/` 不依赖 `api/`、`persistence/` 或 `chatgpt/`；`chatgpt/` 不依赖 `api/`、`persistence/` 或 BrowserManager/PagePool 实现。
