# Phase 2 SQLite and Conversation Persistence Design

**Date:** 2026-08-14
**Status:** Approved; implementation may proceed
**Scope:** Phase 2

## 1. Goal（目标）

Phase 2 建立 ChatGPT Web Gateway 的结构化持久化事实来源，使后续 Browser / Conversation / Context Sync 阶段能够在进程重启后恢复完整 Conversation 状态，而不依赖内存缓存或聊天历史。

本阶段交付：

1. `node:sqlite` 数据库边界。
2. 单向、顺序编号 SQL migration（迁移）。
3. Conversation / Message / Tool Call / Attachment / File / Generated Image Repository（仓储）。
4. 一次事务内保存和加载完整 Conversation aggregate（聚合）。
5. Gateway 启动时创建/迁移 `${DATA_DIR}/gateway.db`，关闭时安全关闭数据库。
6. close → reopen 后完整结构化 Conversation 可恢复的确定性测试。
7. Docker smoke 验证 `/data/gateway.db` 真实创建并在容器重启后继续可用。

Phase 2 不访问真实 ChatGPT，也不实现 Browser Manager、Context Sync 策略或真实聊天执行。

## 2. Approved Decisions（已批准决策）

### 2.1 SQLite Driver（驱动）

使用 Node.js 24 内置 `node:sqlite`，不增加 `better-sqlite3`、ORM 或其他数据库依赖。

当前批准运行时 Node 24.18.x 的 `node:sqlite` 已提供本项目需要的 `DatabaseSync`、prepared statement（预编译语句）、timeout（超时）和同步数据库 API。项目升级 Node LTS 时，`node:sqlite` 兼容性属于“升级项目依赖”验证范围。

### 2.2 Migration（迁移）

使用单向、顺序编号 SQL migration：

```text
migrations/
├── 001_initial.sql
├── 002_example_future_change.sql
└── ...
```

只允许向前迁移，不自动 downgrade（降级）。回退使用数据库备份恢复，而不是维护 `down.sql`。

### 2.3 IDs（主键）

所有持久化实体使用 UUID v4 字符串主键，由 Node `crypto.randomUUID()` 生成。

SQLite 自增行号不得成为公共 API ID 或跨模块身份。

### 2.4 Timestamps（时间）

所有 `created_at`、`updated_at`、`last_used_at` 等持久化时间统一存 Unix 毫秒 `INTEGER`，由 `Date.now()` 或显式注入时钟产生。

### 2.5 Data Model Style（数据模型风格）

使用“关系型核心字段 + JSON payload（载荷）”混合模型：

- 需要索引、排序、唯一约束、外键和状态判断的字段使用正式列。
- `content`、instructions、tools、tool choice、attachment source 等结构化但变化较快的数据保存为 JSON `TEXT`。
- Tool Call、Attachment、File、Generated Image 等有独立生命周期或引用关系的对象使用独立表。
- 不把整个 Conversation 存成单个大 JSON。
- 不为每一个 content part 过度拆表。

### 2.6 Connection Model（连接模型）

一个 Gateway Node 进程只维护一个 `DatabaseSync` 连接。各 Repository 共用同一个数据库边界，不各自打开连接，也不实现连接池。

数据库打开后固定配置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

文件数据库固定为：

```text
${DATA_DIR}/gateway.db
```

## 3. Non-Goals（本阶段明确不做）

Phase 2 不实现：

- Playwright Browser Manager。
- ChatGPT Driver 或真实网页登录。
- `FRESH | APPEND | RESTORE | REBUILD` Context Sync 决策。
- 同 Conversation Queue 或跨 Conversation 并发调度。
- `/v1/files` HTTP 生命周期和真实文件写入流程。
- URL/Base64 附件解析、SHA-256 文件落盘闭环。
- Tool Prompt / Parser / Tool execution。
- ChatGPT 图片生成。
- 数据库自动备份、在线压缩、远程复制或多节点同步。
- 自动 down migration。

Phase 2 只提供这些后续能力需要的稳定持久化边界。

## 4. Module Boundaries（模块边界）

目标结构：

```text
src/persistence/
├── database.ts
├── migrations.ts
├── transaction.ts
├── json.ts
├── errors.ts
├── types.ts
├── conversation-store.ts
└── repositories/
    ├── conversations.ts
    ├── messages.ts
    ├── tool-calls.ts
    ├── attachments.ts
    ├── files.ts
    └── generated-images.ts

migrations/
└── 001_initial.sql
```

职责：

- `database.ts`：打开/配置/关闭单一 `DatabaseSync`，组合 migration 和 repositories。
- `migrations.ts`：发现、校验、checksum、执行 migration。
- `transaction.ts`：同步事务边界。
- `json.ts`：JSON encode/decode 和稳定错误包装。
- `errors.ts`：PersistenceError / MigrationError / DataIntegrityError。
- `types.ts`：上层可见的 persistence record 类型。
- `repositories/*`：单实体 SQL 和映射。
- `conversation-store.ts`：在一个事务内保存/加载完整 Conversation aggregate。

### 4.1 Import Boundary（导入边界）

上层模块不能直接依赖 `node:sqlite`。

```text
Conversation Engine / Files / Images
                ↓
        Repository / Store interfaces
                ↓
          src/persistence/
                ↓
             node:sqlite
```

架构检查应新增规则：`node:sqlite` 只能在 `src/persistence/` 中导入。

Persistence 模块继续禁止直接依赖 Playwright。

## 5. Database Lifecycle（数据库生命周期）

Gateway 正常启动顺序：

```text
loadConfig()
    ↓
resolve ${DATA_DIR}/gateway.db
    ↓
open DatabaseSync
    ↓
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
    ↓
runMigrations()
    ↓
construct repositories / ConversationStore
    ↓
build/start Fastify
```

任一数据库打开或 migration 失败时，Gateway 启动失败，不进入“部分可用”状态。

关闭顺序：

```text
stop Fastify
    ↓
close persistence context / DatabaseSync
```

Phase 2 不把数据库健康状态扩展到公开 `/health` 响应；`/health` 仍保持已经批准的最小协议，避免阶段内改变公开接口。

## 6. Migration System（迁移系统）

### 6.1 File Naming（文件命名）

合法 migration 文件名：

```text
001_initial.sql
002_add_sync_state.sql
003_add_file_status.sql
```

规则：

- 文件名严格匹配 `^([0-9]{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$`。
- 三位正整数版本，从 `001` 开始。
- 版本严格递增且连续，不允许同版本重复或中间断层。
- 已执行 migration 只追加，不修改历史文件。

### 6.2 Migration History（迁移历史）

Runner（运行器）自己 bootstrap（引导）以下表：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;
```

`checksum` 是 migration SQL 原始字节的 SHA-256 hex。

启动时：

1. 扫描 migration 文件并解析版本。
2. 验证文件版本连续、无重复。
3. 读取 `schema_migrations`。
4. 对已执行版本重新计算 checksum；不一致立即失败。
5. 数据库记录了仓库中不存在的版本时立即失败。
6. 按版本顺序执行未应用 migration。

### 6.3 Transaction Semantics（事务语义）

每一个 migration 使用自己的同步事务：

```text
BEGIN IMMEDIATE
→ execute migration SQL
→ insert schema_migrations row
→ COMMIT
```

任一步失败：

```text
ROLLBACK
→ throw MigrationError
→ Gateway startup fails
```

Migration SQL 文件本身不得负责 `BEGIN` / `COMMIT`；事务所有权属于 runner。

## 7. Initial Schema（初始 Schema）

所有业务表使用 SQLite `STRICT` mode（严格模式）。JSON 字段使用 `CHECK(json_valid(...))` 保护语法完整性。

### 7.1 `conversations`

```text
id                         TEXT PRIMARY KEY (UUID v4)
conversation_key           TEXT NULL UNIQUE
chatgpt_conversation_url   TEXT NULL
instructions_json          TEXT NOT NULL JSON
 tools_json                TEXT NOT NULL JSON
 tool_choice_json          TEXT NOT NULL JSON
 tool_fingerprint          TEXT NULL
created_at                 INTEGER NOT NULL
updated_at                 INTEGER NOT NULL
last_used_at               INTEGER NOT NULL
```

语义：

- `conversation_key` 对应未来稳定 Conversation identity；SQLite UNIQUE 允许多个 `NULL`。
- `chatgpt_conversation_url` Phase 2 可以为空，Phase 3/4 写入。
- instructions/tools/tool choice 保存当前 Conversation aggregate 的完整协议状态。
- `tool_fingerprint` 为未来 Tool Context Sync 保留稳定查询字段；Phase 2 不定义 fingerprint 算法。
- 不提前加入尚未设计清楚的 `FRESH/APPEND/RESTORE/REBUILD` 状态列；Phase 4 如需要使用新 migration 增加。

### 7.2 `messages`

```text
id                 TEXT PRIMARY KEY
conversation_id    TEXT NOT NULL FK → conversations.id ON DELETE CASCADE
sequence           INTEGER NOT NULL >= 0
role               TEXT NOT NULL CHECK user|assistant|tool
content_json       TEXT NOT NULL JSON
tool_call_id       TEXT NULL
created_at         INTEGER NOT NULL
updated_at         INTEGER NOT NULL
UNIQUE(conversation_id, sequence)
```

Message 顺序只由 `sequence` 决定，不依赖 UUID 或时间排序。

System / Developer 指令保存在 Conversation `instructions_json`，不混入消息角色表。

### 7.3 `tool_calls`

```text
id                    TEXT PRIMARY KEY
conversation_id       TEXT NOT NULL FK → conversations.id ON DELETE CASCADE
message_id            TEXT NOT NULL FK → messages.id ON DELETE CASCADE
external_call_id      TEXT NOT NULL
name                  TEXT NOT NULL
arguments_text        TEXT NOT NULL
created_at            INTEGER NOT NULL
UNIQUE(conversation_id, external_call_id)
```

`arguments_text` 保留原始 function arguments 字符串，不强制 `json_valid()`。原因是模型或上游可能产生需要诊断的无效 JSON；持久化层不能悄悄修改原始内容。

Tool Result 仍由 `messages.role='tool'` + `tool_call_id` 表达；Repository 在聚合保存时校验它引用同一 Conversation 中存在的 `external_call_id`。

### 7.4 `files`

```text
id             TEXT PRIMARY KEY
filename       TEXT NOT NULL
mime_type      TEXT NULL
size_bytes     INTEGER NOT NULL >= 0
sha256         TEXT NOT NULL
storage_path   TEXT NOT NULL UNIQUE
created_at     INTEGER NOT NULL
updated_at     INTEGER NOT NULL
```

File row 是文件系统字节的结构化元数据，不把大文件字节存进 SQLite BLOB。

Phase 2 不实现 `/v1/files` API，因此暂不加入 delete/status/purpose 等尚未需要的字段；Phase 6 通过 migration 扩展。

`sha256` 建普通索引但不设 UNIQUE，因为两个不同逻辑 File 可以引用相同内容，去重策略属于 Phase 6。

### 7.5 `attachments`

```text
id                    TEXT PRIMARY KEY
conversation_id       TEXT NOT NULL FK → conversations.id ON DELETE CASCADE
message_id            TEXT NOT NULL FK → messages.id ON DELETE CASCADE
local_attachment_id   TEXT NOT NULL
kind                  TEXT NOT NULL CHECK image|file
source_json           TEXT NOT NULL JSON
file_id               TEXT NULL FK → files.id
created_at            INTEGER NOT NULL
UNIQUE(message_id, local_attachment_id)
```

`local_attachment_id` 保留 `NormalizedMessage.content` 中使用的请求内 attachment identity，例如 `attachment-1`。持久化 row 自己仍使用 UUID 主键。

这样保存/加载 aggregate 时无需改写 message content 中的 attachment reference。

Phase 2 的 Repository 可以保存 Phase 1 descriptor；真实 URL/Base64 resolve、落盘和 file linkage 在 Phase 6 完成。

### 7.6 `generated_images`

```text
id                 TEXT PRIMARY KEY
conversation_id    TEXT NULL FK → conversations.id ON DELETE SET NULL
message_id         TEXT NULL FK → messages.id ON DELETE SET NULL
prompt             TEXT NOT NULL
mime_type          TEXT NULL
size_bytes         INTEGER NOT NULL >= 0
sha256             TEXT NOT NULL
storage_path       TEXT NOT NULL UNIQUE
created_at         INTEGER NOT NULL
```

Generated Image metadata 先建立稳定 Repository 边界；Phase 8 再接真实 ChatGPT 图片生成和公开 API。

## 8. Indexes（索引）

初始 migration 除约束产生的索引外至少建立：

```text
messages(conversation_id, sequence)
tool_calls(conversation_id, external_call_id)
attachments(conversation_id, message_id)
attachments(file_id)
files(sha256)
generated_images(conversation_id, created_at)
```

不为尚未有查询证据的列提前增加大量索引。

## 9. Persistence Types（持久化类型）

Persistence 类型与 API `NormalizedRequest` 类型分离。

推荐核心类型：

```ts
interface ConversationRecord {
  id: string;
  conversationKey?: string;
  chatgptConversationUrl?: string;
  instructions: NormalizedInstruction[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  toolFingerprint?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

interface MessageRecord {
  id: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  content: NormalizedContentPart[];
  toolCallId?: string;
  createdAt: number;
  updatedAt: number;
}
```

ToolCall / Attachment / File / GeneratedImage 使用对应 record 类型。

`ConversationAggregate` 包含：

```text
conversation
messages[]
toolCalls[]
attachments[]
generatedImages[]
```

Files 不放进 aggregate，因为 File 可以被多个 Conversation / Attachment 复用；File 通过 `FileRepository` 独立读取。

## 10. Repository Interfaces（Repository 接口）

每个 Repository 只负责自己实体的 SQL 和 row mapping。

### ConversationRepository

至少提供：

```text
insert(record)
update(record)
getById(id)
getByKey(conversationKey)
```

### MessageRepository

```text
insert(record)
listByConversation(conversationId)
deleteByConversation(conversationId)
```

### ToolCallRepository

```text
insert(record)
listByConversation(conversationId)
deleteByConversation(conversationId)
```

### AttachmentRepository

```text
insert(record)
listByConversation(conversationId)
deleteByConversation(conversationId)
```

### FileRepository

```text
insert(record)
getById(id)
findBySha256(sha256)
```

### GeneratedImageRepository

```text
insert(record)
getById(id)
listByConversation(conversationId)
deleteByConversation(conversationId)
```

Repository methods are synchronous，因为底层 `DatabaseSync` 是同步 API。

## 11. ConversationStore（聚合 Store）

`ConversationStore` 是 Phase 2 的核心验收边界。

### 11.1 Save（保存）

提供：

```ts
save(aggregate: ConversationAggregate): void
```

语义：

1. 在单个 `BEGIN IMMEDIATE` 事务中执行。
2. 新 Conversation 插入；已有 Conversation 更新 metadata。
3. aggregate 被视为该 Conversation 的完整结构化快照。
4. 现有 Message/Tool Call/Attachment/Generated Image 子记录按 FK 安全顺序替换。
5. 使用 caller 提供的 UUID，不在 save 时偷偷重生成 identity。
6. 验证：
   - Message sequence 唯一且按加载结果排序。
   - Tool Call message 属于同一 Conversation。
   - Tool Result `tool_call_id` 在同一 aggregate 中可解析。
   - Attachment message 属于同一 Conversation。
7. 任一 SQL/约束/验证失败，整个 aggregate 保存 rollback。

Phase 2 选择“完整 aggregate snapshot save”是为了先获得简单、可证明的恢复语义。Phase 4 如需要高频增量 append，可在不破坏现有 Store 接口的情况下增加专用增量方法。

### 11.2 Load（加载）

提供：

```text
loadById(id)
loadByKey(conversationKey)
```

返回完整 `ConversationAggregate | undefined`。

加载规则：

- Messages 严格按 `sequence ASC`。
- Tool Calls / Attachments / Generated Images 使用稳定顺序（created_at，再 id）供测试和诊断。
- JSON payload 解析失败时抛 `DataIntegrityError`，不能静默返回部分结构。

## 12. Transaction Boundary（事务边界）

提供同步 helper：

```ts
transaction<T>(database, work: () => T): T
```

实现语义：

```text
BEGIN IMMEDIATE
→ work()
→ COMMIT
```

异常：

```text
ROLLBACK
→ rethrow original persistence error
```

事务 callback 必须是同步函数。不得在数据库 transaction 内 `await`，防止在一个未提交事务中把 Node event loop 交回其他请求。

Repository 自身不偷偷开启互相嵌套事务；由 aggregate Store 或调用者拥有跨 Repository 事务。

## 13. JSON Encoding（JSON 编码）

JSON columns 通过统一 helper 读写：

```text
encodeJson(value) → string
 decodeJson<T>(columnName, value) → T
```

要求：

- 不使用自定义 replacer 改写语义。
- `undefined` 不作为顶层 JSON 值写入。
- JSON decode 失败包装为 `DataIntegrityError`，包含表/字段上下文但不泄漏用户完整正文。
- 数据库 `CHECK(json_valid(...))` 是第一层保护；应用 decode error 是第二层保护。

## 14. Error Model（错误模型）

内部至少定义：

```text
PersistenceError
MigrationError
DataIntegrityError
```

Migration error 包含：

- migration version/name。
- checksum mismatch / missing migration / sequence gap / SQL failure 类型。

不得在普通日志或 API 错误中包含：

- 完整 Conversation 正文。
- Base64 attachment payload。
- API Key / Cookie。
- 数据库文件字节。

Phase 2 尚未把 persistence error 映射为新的公开 API 错误，因为公开 POST execution backend 仍未启用。

## 15. Startup Integration（启动集成）

`src/index.ts` 在 Fastify listen 前打开 persistence context。

长期进程启动后，即使 Phase 2 的 HTTP route 尚未使用 Repository，也必须保证：

- `/data/gateway.db` 已创建。
- migration 已完成。
- DB 连接保持到 Gateway shutdown。

`SIGINT` / `SIGTERM` shutdown 必须关闭 Fastify 和 SQLite。关闭逻辑应幂等，避免双 signal 导致重复 close 崩溃。

测试用 `buildServer()` 继续保持无数据库依赖，避免 HTTP unit/integration test 被真实文件 IO 污染。

## 16. Docker Integration（Docker 集成）

现有 `/data` Bind Mount 已经是正式运行边界，因此 Phase 2 不增加新 volume。

Docker runtime 需要把 `migrations/` 复制进最终镜像。

Docker smoke 增加：

1. Gateway 启动后 `/data/gateway.db` 存在。
2. `schema_migrations` 已包含 `001_initial`。
3. 数据库文件 owner 与 Gateway `PUID/PGID` 一致或至少由该运行用户可持续写入。
4. 容器 restart 后 Gateway 仍可启动，migration 不重复失败，数据库文件仍存在。

Docker smoke 仍不访问真实 ChatGPT。

## 17. Testing Strategy（测试策略）

### 17.1 Unit — Migration

覆盖：

- 空数据库执行 `001_initial.sql`。
- 第二次启动不重复应用。
- checksum 相同通过。
- 已执行 migration 被修改 → `MigrationError`。
- migration 版本断层/重复 → 启动失败。
- migration SQL 失败 → 事务 rollback，不写 history row。

### 17.2 Unit — Repository

使用独立临时/in-memory SQLite，覆盖：

- 每个实体 insert/get/list。
- UUID 和外键约束。
- `(conversation_id, sequence)` 唯一。
- `conversation_key` 唯一且允许多个 null。
- JSON columns round-trip。
- invalid role/kind/JSON 被数据库拒绝。
- File SHA-256 lookup。

### 17.3 Integration — Conversation Aggregate Recovery

使用真实临时文件数据库：

```text
open temp/gateway.db
→ migrate
→ save complete aggregate
→ close database
→ create a new persistence context on same path
→ migrate again
→ load aggregate
→ deepEqual(original semantic state)
```

Conversation aggregate 至少包含：

- system/developer instructions。
- user + assistant + tool messages。
- assistant tool call 与 tool result。
- image/file attachment descriptors，其中至少一个 attachment 引用独立 File row。
- generated image metadata。
- conversation key 和 ChatGPT URL。

同时通过 `FileRepository` 保存一条 File metadata，关闭并重新打开数据库后分别验证 aggregate 与 File row 都能恢复。File 不并入 Conversation aggregate，因为它允许跨 Conversation 复用。

再覆盖 atomic failure：故意插入 invalid reference，save 失败后旧 aggregate 保持不变。

### 17.4 Full Verification

Phase 2 完成仍要求：

```text
corepack pnpm verify
corepack pnpm docker:build
corepack pnpm docker:smoke
```

真实 ChatGPT E2E 不属于 Phase 2 验收。

## 18. Acceptance Criteria（Phase 2 验收）

Phase 2 完成必须同时满足：

1. 项目使用 `node:sqlite`，未新增第三方 SQLite driver/ORM。
2. `${DATA_DIR}/gateway.db` 在 Gateway 启动时打开并完成 migration。
3. PRAGMA `foreign_keys=ON`、WAL、5000ms busy timeout 有自动测试或 runtime smoke 证明。
4. migration history + SHA-256 checksum 可以检测历史 SQL 被篡改。
5. `001_initial.sql` 建立 Conversation / Message / Tool Call / File / Attachment / Generated Image schema 和约束。
6. 所有持久化业务实体主键为 UUID v4，时间为 Unix 毫秒 INTEGER。
7. Repository 隐藏 SQL；`node:sqlite` 不泄漏到 `src/persistence/` 外。
8. `ConversationStore.save()` 在一个事务内保存完整 aggregate，失败时不留下半状态。
9. `loadById` / `loadByKey` 能恢复与保存语义一致的完整 aggregate。
10. 真实文件 DB close → reopen 后完整 Conversation 恢复测试通过。
11. Docker 最终镜像包含 migrations，`/data/gateway.db` 在 bind mount 中持久存在且 restart 后可继续启动。
12. `corepack pnpm verify` 通过。
13. 真实 ChatGPT Web E2E 未运行时，项目状态和最终汇报继续明确标记未验证。

## 19. Risks and Constraints（风险与约束）

- `DatabaseSync` 是同步 API；单条 SQL 应保持短小，Phase 2 不允许在事务内进行网络、文件下载或浏览器 IO。
- WAL 会产生 `gateway.db-wal` / `gateway.db-shm` 旁文件；它们属于 SQLite 正常运行状态，必须留在 `/data`，不得提交 Git。
- `node:sqlite` 随 Node LTS 演进，因此未来 Node major 升级必须运行完整 migration/repository/reopen/Docker 验证。
- Full snapshot save 在超长 Conversation 上最终可能比增量 append 成本高；Phase 2 优先可证明的正确恢复语义，Phase 4 有真实性能需求时再增加增量 API。
- Attachment `source_json` 在 Phase 2 是结构描述边界，不代表已经安全完成 Base64/URL 文件持久化；实际字节管理仍属于 Phase 6。
- Generated Image Repository 在 Phase 2 只保存结构化 metadata，不代表图片生成能力已经实现。
