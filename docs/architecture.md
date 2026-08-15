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

SQLite 保存完整本地 Conversation；ChatGPT conversation URL 是可恢复的网页位置；Page 只是可丢弃的运行时缓存。

Phase 4 已批准、尚待实现的同步模型只允许四种模式：

- `FRESH`：没有已知本地 Conversation，新建 ChatGPT Conversation；已有完整历史通过一次 Context Envelope 注入。
- `APPEND`：输入历史与本地已确认历史一致，只发送新的 trailing user，不重复旧历史或 instructions。
- `RESTORE`：本地状态与 ChatGPT URL 可用但 Page 已丢失，重新打开原 URL 后继续 APPEND。
- `REBUILD`：历史被压缩、修改、回滚、分叉，instructions 变化，sync checkpoint 不确定，或原网页 Conversation 确认不可恢复时，根据当前 authoritative history 新建 ChatGPT Conversation。

Conversation identity 规则：

- `X-Conversation-Key` 存在时，它是跨请求稳定 identity；不存在的 key 自动创建，不增加单独 create API。
- 无 `X-Conversation-Key` 时不通过历史 fingerprint 猜身份；每个请求独立创建 `conversation_key = NULL` 的持久化 Conversation，请求后不保留跨请求 Page affinity。
- keyed Conversation 同时支持常见的 full-history 重发和 single-user incremental 输入。已有 key 下恰好一条 user message 按 incremental 解释；多条 message / assistant history 按 full 解释。
- full history 与已确认本地历史分叉时，以客户端当前 full history 为 authoritative source REBUILD，ConversationKey 与本地 UUID 不变。

同步安全规则：

- 只有 clean checkpoint、`synced_message_count == messages.length` 且存在安全 ChatGPT URL 时才允许 APPEND / RESTORE。
- 第一个可能写入网页 Conversation 的动作之前标记 `in_flight`；网页成功后才原子保存新 messages、URL 和 clean checkpoint。
- `in_flight` 或 count mismatch 表示不确定状态；下一请求不猜测网页副作用，直接 REBUILD。
- FRESH / REBUILD 通过单次版本化 Context Envelope 表示历史；不逐轮 replay 旧 user，也不让 ChatGPT 重新生成历史 assistant。

同一 Conversation 使用内存 FIFO 串行；排队请求不提前占 Page，轮到执行时重新读取 SQLite。不同 Conversation 没有全局 mutex，可以在 Page capacity 内并行。V1 仍是假定单 Gateway / Browser owner，不承诺多进程分布式 Conversation lock。

详细状态机见 [`superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md`](superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md)。当前产品仍停留在 Phase 3 Fresh-only executor，以上 Phase 4 行为不能在实现完成前视为已支持。

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

Page 数有上限。Phase 3 已实现通用 bounded Page Pool 的创建/租用/归还/关闭；它不理解 Conversation identity。

Phase 4 已批准、尚待实现的 `Conversation Page Registry` 位于 `conversations/`：keyed Conversation 成功后保留 Page affinity；默认 `PAGE_IDLE_TIMEOUT_MINUTES=30` 到期真正关闭 idle Page；当 PagePool 满时优先 LRU 释放最久未使用且非 busy 的 affinity Page，使新 Conversation 能复用物理 Page；所有 Page 都 busy 时继续返回稳定 `page_capacity_exceeded`。LRU/idle 策略不得进入 `browser/` 形成反向 Conversation 依赖。

SQLite 保留 Conversation 状态和 URL，因此 Page 被 idle/LRU 回收后，下次请求通过 RESTORE 恢复；单 Page 故障不得无条件杀掉其他 Conversation。

故障恢复逐级升级：

1. 重新定位 Selector（选择器）。
2. reload（刷新）当前 Page。
3. 重新打开 conversation URL。
4. 新建 Page。
5. 重建 BrowserContext。
6. 最后才重启 Chromium。

## ChatGPT Driver（网页驱动）

上层只依赖稳定接口，不依赖 DOM 细节。所有 ChatGPT Selector 必须集中在 `src/chatgpt/selectors.ts`。

Phase 3 已实现 Fresh-only text Driver：每次请求先导航到 ChatGPT Fresh 起点，Auth Probe 区分 `authenticated | auth_required | unknown`，发送前记录 Assistant Turn baseline，发送后只观察 index=`baseline` 的新 Assistant Turn。完成判断使用 generating/stop/thinking 可观察状态 + 非空文本连续稳定采样；固定约 250ms 只是 polling cadence，不把任意 sleep 或 `networkidle` 当作完成证据。

Selector Registry 区分 `unique` 与 `collection`。Unique selector primary 多匹配立即 `selector_ambiguous`，不会通过 `.first()` / `.nth()` 掩盖；collection 才允许按明确业务索引访问新 turn。

Phase 3 Executor 只接受 Fresh、非流式、纯文本请求；system/developer/user 通过一次 JSON-serialized prompt envelope 近似映射。Conversation Key/历史属于 Phase 4，Streaming/附件/Tools/Structured Output 属于后续 Phase。

Phase 4 已批准将 Driver 拆为 Fresh preparation、safe Conversation restore 和 current-page `sendText`：`sendText` 不再自己强制导航 Fresh。Persisted restore URL 必须先验证 `https://chatgpt.com` origin 和非 root pathname；明确 root/Fresh redirect 才返回 `not_restorable`，`auth_required`、selector error 和 Browser runtime failure 不允许被吞成 REBUILD。该拆分尚未实现。

浏览器/Driver 原始异常不会直接成为公共 API；未知 Page/Playwright runtime/navigation failure 映射为稳定 `browser_unavailable`。`src/chatgpt/inspect.ts` 只检查已经拥有的 Page，不创建 BrowserManager；显式 CLI 才负责独立 E2E Profile 的 Browser 生命周期。

Phase 3 authenticated ChatGPT DOM 与 Fresh 文本链已于 2026-08-15 完成真实验收：独立 Profile 先通过 maintenance Google Chrome Stable 人工登录，再由产品同版本族的 Playwright Chromium 复用该 Profile；`inspect:chatgpt` 实际得到 `auth=authenticated` 与唯一 Composer。真实运行还发现 Composer 在 `domcontentloaded` 后可能延迟挂载，因此 Auth Probe 在首次 strict probe 为 unknown 时会使用 Locator `waitFor({ state: 'attached' })` 等待 Composer/Login signal 后重新 strict probe，而不是固定 sleep。随后 `test:e2e:chatgpt` 实际通过 Fresh Driver challenge 与 Gateway HTTP → ChatGPT Web → Chat Completions challenge。

## Streaming（流式输出）

V1 采用约 200ms DOM polling（网页轮询）：

```text
Assistant DOM
   ↓
Snapshot
   ↓
Normalize
   ↓
Stable Prefix
   ↓
Delta
   ↓
Internal Stream Event
   ├── Chat Completions SSE Encoder
   └── Responses SSE Encoder
```

不能用 `currentText.slice(previousText.length)` 作为唯一增量算法，因为 Markdown（标记语言）和 React（前端框架）重排可能让 DOM 回写。

完成判断综合：新 Assistant Turn（回复节点）、生成停止状态、文本稳定、Thinking/Searching/Generating 状态和图片/附件生成状态；确认完成后 flush（刷新）最后尾部。

客户端主动断开流式连接时，V1 停止 ChatGPT 当前生成，避免网页历史和客户端历史分叉。

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

```text
OpenAI content part / file_id
          ↓
Attachment Resolver
          ↓
URL Download / Base64 Decode / File Lookup
          ↓
Persistent File Store
          ↓
PreparedAttachment
          ↓
Playwright setInputFiles
          ↓
等待 ChatGPT 附件预览和上传完成
          ↓
发送 Prompt
```

SQLite 保存元数据和引用，大文件字节保存在 `data/files/`。

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

Phase 4 已批准、尚待实现 `002_add_conversation_sync_checkpoint.sql`：Conversation 增加 `clean | in_flight`、`synced_message_count` 和可空 `sync_started_at`。网页 write 前使用短同步 metadata transaction 标记 `in_flight`，不在 SQLite transaction 内等待 Playwright；Assistant 成功后再通过完整 aggregate transaction 保存 messages/URL 并推进 clean checkpoint。Migration 不回填猜测旧 Message 已同步位置，legacy row 默认 count=0，因此不能误走 APPEND。

## API Authentication（接口认证）

`GET /health` 保持无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。配置集中在 `src/config/`，业务模块不得分散读取环境变量。缺失 Gateway API Key 时正式服务启动失败。

兼容扩展 `X-Conversation-Key` 可把客户端稳定会话标识传入 `NormalizedRequest.conversationKey`；未提供时保持 `undefined`。Phase 4 已批准：有 key 才建立跨请求稳定 identity；无 key 每次独立持久化，不自动 fingerprint 绑定。当前 Phase 3 产品仍会对 key 返回 `conversation_sync_not_implemented`，直到 Phase 4 实现完成。

## 错误边界

内部使用稳定错误类型；API 层映射为 OpenAI 风格错误。不得把 Playwright 原始堆栈、Cookie、API Key、Authorization Header、文件系统敏感路径直接返回客户端或写入普通日志。

Phase 4 实现后，unsupported future capabilities 使用稳定 `unsupported_phase4_request`；无法形成 trailing user 等 Conversation 语义错误使用 HTTP 400 `invalid_request_error`。`not_restorable` 是 RESTORE → REBUILD 的内部控制流，不应错误覆盖真实 auth/selector/browser failure。

## 可执行架构约束

`scripts/check-architecture.mjs` 会随着产品源码出现逐步收紧：

- `api/` 不直接导入 `playwright`。
- `context/` 不依赖 `playwright`、`api/`、`chatgpt/` 或 `persistence/`。
- `stream/` 不直接导入 `chatgpt/selectors`。
- `persistence/` 不依赖 `playwright`。
- `node:sqlite` 只允许在 `src/persistence/` 中导入；checker 同时识别普通、动态、require 和 side-effect import。
- ChatGPT Selector 只允许定义在 `src/chatgpt/selectors.ts`。
- `browser/` 不依赖 `api/`、`persistence/`、`chatgpt/` 或 `conversations/`。
- `chatgpt/` 不依赖 `api/`、`persistence/` 或 Conversation Engine/Page Registry 实现。

这些新增 Phase 4 约束属于已批准设计；对应 checker 只有在 Phase 4 实施任务中落地后才算可执行验证。
