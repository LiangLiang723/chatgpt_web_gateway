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

## Container Runtime（容器运行时）

Docker 从 Phase 1 起就是正式运行边界，而不是后期附加包装。目标平台先锁定 `linux/amd64`。

仓库提供单一完整镜像。Phase 1 当前正常模式只启动 Gateway；镜像已经包含 Playwright bundled Chromium，但产品级 Browser Manager / ChatGPT Driver 要到后续 Phase 才会在正常模式启动 headless Chromium。首次登录、重新认证或人工排障时，通过 Compose noVNC overlay 显式启动 Xvfb / x11vnc / noVNC 和独立 headed maintenance browser。正常模式不启动这些维护进程，也不发布 noVNC 端口。

镜像以官方 Playwright Node Docker 镜像为基础并固定明确版本。Phase 1 实现固定 `mcr.microsoft.com/playwright:v1.62.1-noble` 与 `playwright@1.62.1`；实测镜像运行时为 Node `v24.18.1` / `linux/amd64`。后续升级仍必须重新检查 package / image / Node LTS 组合，不能把这次结果当作永久事实。

持久状态统一通过宿主机目录 Bind Mount 到 `/data`；Browser Profile 固定在 `/data/browser-profile/`，未来正常 browser runtime 与当前 noVNC maintenance browser 复用。长期 Gateway / Chromium 进程必须非 root，并支持 `PUID/PGID` 与 NAS 文件权限对齐。noVNC overlay 默认只把维护端口绑定到宿主机 `127.0.0.1`；需要远程 NAS 访问时必须显式调整绑定并自行保证网络访问控制。

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

Page 数有上限，空闲 Page 可关闭；SQLite 保留会话状态，需要时重新打开 conversation URL。

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

浏览器同步使用真实可观察状态，不用任意固定 sleep（休眠）猜网页已经准备好。

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

业务实体使用 UUID v4 主键和 Unix 毫秒时间；需要查询/约束的字段关系化，复杂 content/instructions/tools/source 使用 JSON `TEXT`。上层只依赖 Repository / `ConversationStore`，`node:sqlite` 不能泄漏到 `src/persistence/` 外。完整 Conversation aggregate 的保存必须在单个同步事务中完成；进程关闭并重新打开同一数据库后应能恢复语义一致的结构化状态。

## API Authentication（接口认证）

`GET /health` 保持无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。配置集中在 `src/config/`，业务模块不得分散读取环境变量。缺失 Gateway API Key 时正式服务启动失败。

兼容扩展 `X-Conversation-Key` 可把客户端稳定会话标识传入 `NormalizedRequest.conversationKey`；未提供时保持 `undefined`，自动会话策略由后续 Conversation / Context Sync 阶段实现。

## 错误边界

内部使用稳定错误类型；API 层映射为 OpenAI 风格错误。不得把 Playwright 原始堆栈、Cookie、API Key、Authorization Header、文件系统敏感路径直接返回客户端或写入普通日志。

## 可执行架构约束

`scripts/check-architecture.mjs` 会随着产品源码出现逐步收紧：

- `api/` 不直接导入 `playwright`。
- `context/` 不依赖 `playwright`、`api/` 或 `chatgpt/`。
- `stream/` 不直接导入 `chatgpt/selectors`。
- `persistence/` 不依赖 `playwright`。
- ChatGPT Selector 只允许定义在 `src/chatgpt/selectors.ts`。
