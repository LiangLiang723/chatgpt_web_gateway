# Phase 6 Attachments and Files Design

**Date:** 2026-08-17
**Status:** Approved for implementation planning
**Scope:** Phase 6 — image/file input and `/v1/files`

## 1. Goal（目标）

Phase 6 在 Phase 5 已完成的 Conversation ownership、Context Sync、SQLite checkpoint、ChatGPT target-turn ownership 与 True Streaming 基础上，交付**图片和文件输入的完整本地生命周期 + ChatGPT Web 上传闭环**。

本阶段必须同时满足：

1. `POST /v1/files`、`GET /v1/files`、`GET /v1/files/:id`、`GET /v1/files/:id/content`、`DELETE /v1/files/:id` 形成可重启恢复的 OpenAI-compatible Files 生命周期。
2. Chat Completions 支持 `image_url` 的 HTTPS/HTTP URL 与 Base64 Data URL，以及 `file.file_id` / `file.file_data`。
3. Responses 支持 `input_image.image_url` / `input_image.file_id` 与 `input_file.file_id` / `input_file.file_data`。
4. URL、Data URL、Base64 与 `file_id` 最终统一解析成 Gateway 自己拥有的持久化 File；ChatGPT Driver 不处理网络下载、Base64、数据库或 Files API ID。
5. 文件字节保存在 `${DATA_DIR}/files/`，SQLite 保存逻辑 File、Blob 与 Attachment 元数据；相同 SHA-256 内容物理去重，但仍允许多个逻辑 File identity。
6. Browser 上传只接收已经准备好的本地文件，并在点击 Send 前等待**真实 ChatGPT DOM 上传就绪证据**，不得依赖固定 sleep。
7. Attachment 与 Phase 4 `FRESH | APPEND | RESTORE | REBUILD` 语义结合：APPEND/RESTORE 只上传新增 user turn 附件；FRESH/REBUILD 根据当前完整有效上下文重新上传需要的附件。
8. Attachment 同时支持 `stream=false` 与 `stream=true`；Send 之后继续复用 Phase 5 target Assistant turn 和 Stable Prefix，不复制一套 Streaming 实现。
9. 任何已经可能产生 ChatGPT 上传副作用的未知失败保持 SQLite `in_flight`，discard Page，并由下一 same-key 请求通过 REBUILD 收敛。
10. URL 获取必须有 SSRF、重定向、大小、超时、内容类型和日志泄漏边界；用户文件名不得控制永久文件系统路径。
11. 真实 ChatGPT E2E 必须覆盖图片理解以及 PDF / TXT / DOCX / XLSX 代表性文档输入，不能用 deterministic test 或 Docker smoke 代替。

Phase 6 完成后，后续 Tool Calling 和 Image Generation 可以复用统一文件存储、附件生命周期、Browser upload readiness 与 Conversation 附件恢复语义，而无需再次设计文件字节所有权。

## 2. Current Foundation（当前基础）

Phase 6 不重新设计 Phase 4/5 已经验证的 Conversation 与 Streaming 基础。以下事实直接作为前提：

- `NormalizedRequest` 已有 `attachments: NormalizedAttachment[]`，消息 content 用 `{ type: 'attachment', attachmentId }` 保留内容位置。
- Chat Completions Normalizer 已能描述 image URL/Data URL、`file_id` 与 Base64 file；Responses Normalizer 已能描述 `input_image` / `input_file` 的现有 Phase 1 子集。
- Phase 2 已建立 `files`、`attachments` SQLite 表及 `FileRepository` / `AttachmentRepository`，但只保存元数据/descriptor，没有真实文件字节生命周期。
- `files.sha256` 当前只是普通索引，允许不同逻辑 File 使用相同 hash；Phase 2 明确把真实去重策略留给 Phase 6。
- File 不属于 `ConversationAggregate`；一个 File 可以被多个 Conversation / Attachment 复用。
- SQLite `clean | in_flight` checkpoint 是 Conversation 恢复事实源。
- same-key FIFO 覆盖一个 Conversation 的整个请求生命周期，不同 key 可以并行。
- FRESH / APPEND / RESTORE / REBUILD 的 Planner 已稳定，并通过 deterministic + authenticated real E2E。
- Phase 5 `stream=true` 已共享相同 Context Sync、Page affinity、target Assistant turn ownership 与 final clean commit。
- ChatGPT Selector 只允许定义在 `src/chatgpt/selectors.ts`；当前 `inspect:chatgpt` 尚未把 File Input / attachment preview 纳入 contract。
- Docker 是正式运行边界；真实 ChatGPT E2E 是证明当前 DOM 上传能力的唯一验收来源。

Phase 6 的设计重点是把这些已经存在但未连通的 descriptor、持久化和 Browser 边界闭环，而不是建立另一套 Conversation 或 Streaming 系统。

## 3. Protocol Reference Baseline（协议参考基线）

本规格在 2026-08-17 重新核对当前 OpenAI 官方 API reference，并锁定 Gateway 只实现 V1 需要的兼容子集：

- Files 公开资源包含 list / create / retrieve / delete / content 五类操作。
- `POST /files` 当前是 multipart file + `purpose`，官方 `purpose` 枚举包含 `assistants`、`batch`、`fine-tune`、`vision`、`user_data`、`evals`。
- 官方 Files 现在还提供 `expires_after`；Phase 6 **明确不实现**自动过期，不伪造 retention 语义。
- 当前 Responses `input_image` 支持 `image_url` 或 `file_id`；`input_file` 当前还支持 `file_url`。仓库现有 V1 protocol schema 没有 `file_url`，因此 Phase 6 明确把 `input_file.file_url` 留到后续兼容扩展，不在本阶段静默加入。

这里的官方上限或用途语义不等于 ChatGPT Web 的上传能力。Gateway 使用自己的资源安全上限；ChatGPT 当前网页最终能接受什么格式只能由真实 E2E 证明。

## 4. Non-Goals（本阶段明确不做）

Phase 6 不实现：

- Tool Calling Prompt / Parser / Tool Result。
- Structured Output execution。
- ChatGPT 图片生成或 `/v1/images/generations`。
- OpenAI Uploads multipart/chunk resource（`/v1/uploads`）。
- Vector Store、File Search、Assistant file tool、Batch、Fine-tune 或 Eval 业务能力。
- `expires_after` 自动过期或后台 retention scheduler。
- Responses `input_file.file_url`。
- 任意本地路径作为客户端输入。
- 文件内容本地解析、OCR、Office/PDF 文本抽取、向量化或索引。
- 病毒扫描/内容安全扫描引擎。
- 向客户端公开 Gateway 内部 Blob id、SQLite UUID 或本地路径。
- 对 ChatGPT Web 实际文件大小/格式上限做伪装或硬编码声明。
- 无限文件大小、无限附件数或无限 URL 下载。
- 多 Gateway 进程对同一 `${DATA_DIR}` 的分布式 Blob lock/lease。
- 将 URL query、Data URL、Base64 原文或文件正文写入普通日志、SQLite source JSON 或 API error。
- 自动处理 CAPTCHA、MFA、未知 modal 或其它 authentication challenge。

## 5. Locked Product Semantics（锁定产品语义）

1. **所有外部 attachment source 先变成本地持久 File。** URL、Data URL、Base64 与公开 `file_id` 进入 Conversation Browser side effect 前都必须 resolve 成 Gateway-owned bytes。
2. **逻辑 File identity 与物理 Blob 分离。** 相同内容可以有不同文件名、purpose 和公开 File ID，但只存一份内容 Blob。
3. **`file_id` 是 Gateway 的公开 identity，不是 SQLite UUID。** 客户端永远只看到 `file-...` 形式的 opaque public id。
4. **永久 Blob 路径不包含用户文件名。** 防止 path traversal、Unicode/保留字符和同名覆盖问题。
5. **Attachment persistence 不保存敏感原始 source。** historical REBUILD 使用已经解析的 File，不重新下载原 URL，也不重新解析历史 Base64。
6. **Context fingerprint 比较语义附件，不比较 source transport。** 同样的字节、kind、有效文件名/MIME 通过 URL、Data URL 或 `file_id` 输入时，应被视为同一附件语义。
7. **内容顺序必须保留。** `text → image → text → file` 不能规范化成“所有 text + 所有附件”。
8. **final user 可以只有附件。** 只要至少有一个有效附件，用户不必再提供非空文本；Gateway 自己的 Context Envelope 仍产生安全的非空 Composer 内容。
9. **APPEND/RESTORE 不重复上传已同步附件。** 只上传新增 user turn 当前需要的附件。
10. **FRESH/REBUILD 重新上传完整有效上下文中需要的附件。** historical Attachment 已由本地 File 事实源恢复，不依赖原 URL 仍可访问。
11. **Browser upload 是 Conversation side effect。** 第一次 `setInputFiles` 之前必须已经把 checkpoint 持久化为 `in_flight`。
12. **上传 readiness 必须来自当前 DOM。** 不使用任意 `sleep(1000)`、network idle 或“文件名出现过”作为唯一成功证据。
13. **Streaming attachment validation 在 stream start 前完成。** 可预先验证/resolve 的 4xx/413 应保持普通 HTTP error；真正 Browser upload 失败发生在 stream 已开始后时使用 Phase 5 protocol stream error framing。
14. **Browser upload 成功但 Send/Completion 未确认时不得保存成功 history。** 未知状态保持 `in_flight`，discard Page。
15. **Files DELETE 先撤销公开访问，不破坏已持久化 Conversation 的恢复能力。** 已被历史 Attachment 引用的 bytes 允许继续保留，直到没有任何引用和 active lease。
16. **公开 File purpose 只做兼容元数据。** 接受 purpose 不代表 Gateway 实现 Assistants/Batch/Fine-tune/Vision training/Evals 等平台能力。
17. **Image `detail` 继续是 accepted-but-ignored diagnostic。** ChatGPT Web 没有稳定可验证的一对一控制时，不声称它生效。
18. **ChatGPT format rejection 是显式 upload failure。** Gateway 只对自己能可靠验证的输入做预校验，不把网页外部限制假装成本地支持矩阵。

## 6. Considered Approaches（方案比较）

### 6.1 方案 A：Resolver + Persistent File Store + Prepared Browser Upload（三层分离）

```text
OpenAI protocol
      │
      ▼
NormalizedAttachment
      │
      ▼
Attachment Resolver
 URL / Data URL / Base64 / file_id
      │
      ▼
File Service + Blob Store
      │ PreparedAttachment
      ▼
Conversation Engine
 plan + checkpoint + upload selection
      │
      ▼
ChatGPT Driver
 local staged paths only
```

优点：

- `attachments/` 可以独立测试下载、Base64、MIME、hash、文件名和安全规则。
- `chatgpt/` 只负责 DOM，不读取 SQLite、不下载网络资源。
- Conversation Engine 继续拥有 checkpoint / Page / queue / recovery。
- URL 与 Base64 在 REBUILD 时不会重复获取。
- Files API 和 inline attachment 复用同一 File/Blob 存储。
- physical dedup 与 logical identity 可以分别建模。

缺点：

- Phase 2 `files` schema 需要 migration。
- 需要增加 request-scoped staging/lease 生命周期。

**选择方案 A。**

### 6.2 方案 B：ChatGPT Driver 直接解析 URL/Base64/file_id

优点：初始代码路径短。

拒绝原因：

- Driver 会同时依赖网络、SQLite、文件系统和 DOM，破坏 `chatgpt/` 隔离。
- REBUILD 必须重新下载历史 URL 或保存原始敏感 source。
- Files API 与 inline attachment 会复制存储逻辑。
- 无法在 Browser side effect 前统一做安全验证。

### 6.3 方案 C：所有 File bytes/metadata 都塞进 ConversationAggregate

优点：Conversation save 看似“一次保存所有东西”。

拒绝原因：

- 同一个公开 File 可以跨多个 Conversation 复用。
- 大文件不应进 SQLite BLOB/aggregate JSON。
- DELETE、物理去重和 lease 生命周期不属于 Conversation aggregate 单一职责。
- 与 Phase 2 已锁定的“Files 独立 Repository”事实冲突。

## 7. Module Boundaries（模块边界）

### 7.1 `src/attachments/`

负责纯附件/文件业务边界：

- source validation。
- URL policy、DNS/IP validation 与 redirect policy。
- Data URL / Base64 decode。
- MIME/image signature 检查。
- filename normalization。
- resource limits。
- SHA-256 streaming hash。
- Blob/File service orchestration。
- logical File lease。
- request-scoped Browser staging。
- `PreparedAttachment` 构造。

不得：

- 导入 Playwright。
- 定义 ChatGPT Selector。
- 理解 SSE/OpenAI response framing。
- 决定 FRESH/APPEND/RESTORE/REBUILD。

### 7.2 `src/persistence/`

负责：

- migration 003。
- Blob / File row CRUD。
- Attachment row 与 resolved File linkage。
- tombstone/refcount 查询所需 SQL。

不得：

- 下载 URL。
- 解码 Base64。
- 操作 ChatGPT DOM。

### 7.3 `src/conversations/`

负责：

- same-key 生命周期。
- attachment resolve 调用时机。
- canonical multimodal request 建立。
- Planner。
- 本轮实际 upload set 选择。
- checkpoint 时机。
- final aggregate + AttachmentRecord commit。
- abort/failure cleanup。

### 7.4 `src/chatgpt/`

只接收准备好的：

```ts
interface ChatGptPreparedUpload {
  localAttachmentId: string;
  kind: 'image' | 'file';
  path: string;
  displayFilename: string;
}
```

Driver 不知道：

- URL。
- Base64。
- public file id。
- SHA 去重。
- SQLite。
- purpose。

### 7.5 `src/api/`

负责：

- Files HTTP schema/route/object encoder。
- multipart streaming adapter。
- Chat Completions / Responses protocol normalization。
- stable error mapping。

不得直接操作 Browser/Selector。

## 8. Public Files API（公开 Files API）

### 8.1 Endpoints

Phase 6 实现：

```text
POST   /v1/files
GET    /v1/files
GET    /v1/files/:id
GET    /v1/files/:id/content
DELETE /v1/files/:id
```

全部沿用现有 `/v1/*` Bearer authentication。

### 8.2 Public File ID

内部 SQLite 主键继续使用 UUID v4，公开 ID 独立保存：

```text
file-<uuid-v4-without-semantic-meaning>
```

客户端 `file_id` 只接受公开 ID。任何内部 UUID、Blob id 或 storage path 都不能被当作公开兼容 ID。

### 8.3 Create

`POST /v1/files` 使用 multipart/form-data：

- 恰好一个 `file` part。
- 必填 `purpose`。
- Phase 6 接受当前官方 purpose enum：
  - `assistants`
  - `batch`
  - `fine-tune`
  - `vision`
  - `user_data`
  - `evals`
- purpose 仅保存/返回，不驱动额外产品能力。
- `expires_after` 不在 Phase 6；如果客户端发送，返回稳定 unsupported/invalid request，而不是忽略后假装生效。

实现不得自己手写 multipart parser。计划阶段必须选择与当前 Fastify major 兼容的官方 Fastify multipart plugin，并锁定明确版本。

上传必须流式写 temp file + 增量 SHA/size；禁止为了方便直接把允许的最大文件一次 `toBuffer()` 到内存。

### 8.4 File object

Phase 6 返回最小真实对象：

```json
{
  "id": "file-...",
  "object": "file",
  "bytes": 1234,
  "created_at": 1786900000,
  "filename": "notes.txt",
  "purpose": "user_data"
}
```

`created_at` 使用 Unix seconds 对外编码；SQLite 内部继续使用 Unix milliseconds。

不返回伪造 `status`。不实现 expiry 时也不返回伪造 `expires_at`。

### 8.5 List

`GET /v1/files` Phase 6 支持：

- `after` cursor。
- `limit`。
- `order=asc|desc`。
- `purpose` filter。

只列出：

- `public_id IS NOT NULL`。
- `deleted_at IS NULL`。

inline URL/Base64 attachment 产生的 private logical File 不进入公开 list。

返回 OpenAI-style list object：

```json
{
  "object": "list",
  "data": [],
  "first_id": null,
  "last_id": null,
  "has_more": false
}
```

cursor 只使用公开 File ID，不泄漏数据库 offset/rowid。

### 8.6 Retrieve / Content

`GET /v1/files/:id`：

- public File 存在且未删除 → File object。
- private / deleted / unknown → `file_not_found` 404。

`GET /v1/files/:id/content`：

- 从 Blob path 流式返回内容。
- `Content-Type` 使用已验证/记录 MIME；未知时 `application/octet-stream`。
- `Content-Disposition` 使用安全编码的逻辑 filename。
- 不把 storage path 暴露给 header/error/log。

如果数据库指向的 Blob 缺失，属于 Gateway data integrity/storage failure，不伪装成 404。

### 8.7 Delete

`DELETE /v1/files/:id` 的产品语义：

1. 立即设置 `deleted_at`，公开 list/retrieve/content 和新的 `file_id` resolve 都不可再访问。
2. 返回：

```json
{
  "id": "file-...",
  "object": "file",
  "deleted": true
}
```

3. 如果当前没有 active lease，且没有任何 persisted AttachmentRecord 继续引用此 logical File，可删除 logical File row。
4. Blob 只有在没有任何 logical File 引用时才能删除。
5. 如果 File 已被历史 Conversation Attachment 引用，DELETE **不破坏历史 REBUILD**；bytes 可以作为内部 retained data 继续存在，直到历史引用消失。

这意味着 Phase 6 的 DELETE 是“撤销公开 File resource + 尽可能 GC”，不是“不顾 Conversation 一致性立即 secure erase”。README/API 文档不得把它描述成不可恢复擦除。

## 9. Persistence Schema（持久化设计）

### 9.1 Migration 003

新增 `003_add_file_blob_lifecycle.sql`（具体文件名在实施计划锁定），引入物理 Blob 与逻辑 File 分离。

推荐目标 schema：

```text
file_blobs
  id             TEXT PRIMARY KEY UUID v4
  sha256         TEXT NOT NULL UNIQUE
  size_bytes     INTEGER NOT NULL >= 0
  storage_path   TEXT NOT NULL UNIQUE
  created_at     INTEGER NOT NULL

files
  id             TEXT PRIMARY KEY UUID v4
  public_id      TEXT NULL UNIQUE
  blob_id        TEXT NOT NULL FK -> file_blobs(id)
  filename       TEXT NOT NULL
  mime_type      TEXT NULL
  purpose        TEXT NULL
  deleted_at     INTEGER NULL
  created_at     INTEGER NOT NULL
  updated_at     INTEGER NOT NULL
```

`files` 不再重复保存 Blob 的 `sha256/size/storage_path`；Repository join 后仍可以给上层提供完整 `FileRecord` projection。

### 9.2 Migrating Existing Rows

即使 Phase 2 目前没有产品路径写入真实文件，migration 也必须正确迁移理论上已经存在的 `files` row：

1. 按旧 row 的 `sha256 + size_bytes + storage_path` 建 Blob。
2. 旧 schema 允许相同 SHA 使用多个 storage path；migration 不得假设已经物理去重。
3. 如果相同 SHA 对应不同 size，视为数据完整性冲突并让 migration 明确失败。
4. 如果相同 SHA/size 有多个旧 path，选择一个 canonical existing path 作为 Blob，并把其它 logical File 指向同一 Blob；旧 duplicate bytes 的清理只能在成功 migration/验证后做 best-effort cleanup。
5. 现有 `attachments.file_id` 必须继续引用同一个内部 File UUID。

migration 测试必须包含旧 schema duplicate-hash rows，不能只测空数据库。

### 9.3 Blob Path

canonical Blob path：

```text
${DATA_DIR}/files/blobs/<64-char-lowercase-sha256>
```

用户 filename 永不进入该路径。

### 9.4 Logical File Types

两种 logical File：

- **public file**：来自 `/v1/files`，有 `public_id` + `purpose`。
- **private attachment file**：来自 URL/Data URL/Base64 inline input，`public_id = NULL`、`purpose = NULL`。

两者可以共享同一 Blob。

## 10. Atomic File Storage and Dedup（原子存储与去重）

### 10.1 Write Flow

新 bytes 统一经过：

```text
incoming stream / decoded bytes
          │
          ▼
${DATA_DIR}/temp/<random>.part
  incremental size + SHA-256
          │
          ▼
validate final size/content
          │
          ▼
lookup sha256 Blob
   ├── exists -> discard temp
   └── absent -> atomically adopt canonical blob path
          │
          ▼
transaction: Blob + logical File metadata
```

数据库不得在 bytes 尚未可靠落盘时先产生 authoritative File row。

### 10.2 Physical Dedup

- `file_blobs.sha256` UNIQUE 是 physical dedup 边界。
- 多个 File row 可指向同一个 Blob。
- same hash 必须再验证 size；hash 相同但 size 不同属于 integrity error。
- 并发同 hash resolve 需要 FileService 进程内协调；单 Gateway 进程是当前 V1 前提。

### 10.3 Crash Cleanup

启动/受控 cleanup 允许：

- 删除过期 `${DATA_DIR}/temp/*.part`。
- 删除没有任何 File row 引用的 orphan Blob。
- 完成已经 tombstone 且没有 Attachment/lease 的 deferred File cleanup。

不得仅因文件“看起来旧”就删除仍有数据库引用的 Blob。

## 11. Gateway Resource Limits（Gateway 自己的资源上限）

Phase 6 锁定初始安全上限：

```text
MAX_FILE_BYTES = 32 MiB
MAX_ATTACHMENTS_PER_REQUEST = 16
MAX_TOTAL_ATTACHMENT_BYTES_PER_REQUEST = 64 MiB
MAX_REMOTE_REDIRECTS = 5
REMOTE_CONNECT_TIMEOUT = 10 s
REMOTE_TOTAL_TIMEOUT = 30 s
```

这些是 Gateway 防御性限制，不代表 OpenAI API 或 ChatGPT Web 的官方上限。

理由：

- NAS / 单进程 Gateway 需要可预测的磁盘、内存、Browser upload 压力。
- Base64 JSON 输入会产生编码膨胀，32/64 MiB 可把请求内存上限控制在合理范围。
- 后续如真实 E2E 证明需要更大范围，可以通过新设计/配置扩展，不在 Phase 6 一开始暴露大量未经验证的 tuning 环境变量。

实施时所有数值必须集中在 attachment policy module，不散落 magic number。

## 12. Filename Policy（文件名策略）

客户端 filename：

- 必须非空。
- 只取一个逻辑 basename，禁止 `/`、`\\` 路径穿越语义。
- 禁止 NUL 与控制字符。
- UTF-8 编码后最多 255 bytes。
- 允许正常 Unicode 文件名。
- 永远不用于 permanent Blob path。

没有 filename 的 inline image：

- 根据已验证 image type 生成稳定名字，例如 `image.png` / `image.jpg`。

没有 filename 的 generic Base64 file：

- Phase 6 视为 `invalid_attachment`；不猜测扩展名和业务文件类型。

如果同一次 Browser upload set 中多个附件 display filename 冲突：

- request staging 生成 deterministic collision-safe 名称，例如 `notes.txt`、`notes (2).txt`。
- Context Envelope 明确记录 logical filename 与 upload filename 的映射。
- fingerprint 仍使用 logical filename，不使用 collision suffix。

## 13. URL Image Security（URL 图片安全）

Phase 6 只允许 URL image，不支持 generic document `file_url`。

### 13.1 Scheme

只接受：

- `https:`
- `http:`

拒绝：

- `file:`
- `ftp:`
- `data:`（Data URL 走独立 parser）
- `blob:`
- 用户信息 `user:pass@host`
- 非标准本地协议。

### 13.2 SSRF Guard

每一次初始 URL 和 redirect 都必须：

1. 解析 hostname。
2. DNS resolve。
3. 检查所有 resolved addresses。
4. 只允许 global unicast/public address。
5. 明确拒绝 loopback、private、link-local、carrier-grade NAT、multicast、unspecified、IPv6 ULA/link-local 等非公网地址。
6. 建立连接时不能重新落回一个未经验证的不同地址。

不能只检查字符串 `localhost` 或只检查 redirect 第一个 URL。

### 13.3 Redirect

- 最多 5 次。
- 每个 Location 都重新跑 scheme + SSRF + DNS policy。
- 不自动携带 Authorization/Cookie 等敏感 header；Gateway 本来也不接受 URL credential。

### 13.4 Download

- connect timeout 10s，总下载 timeout 30s。
- streaming 读取，超过 32 MiB 立即 abort。
- 不依赖 `Content-Length` 作为唯一大小证据。
- 不记录完整 signed URL query；日志最多记录经过 redaction 的 origin/host + path summary。

## 14. Base64 / Data URL / MIME Validation（解码与类型验证）

### 14.1 Base64 File

- strict Base64；拒绝非法字符/错误 padding。
- 在 decode 前根据 encoded length 做快速 oversized rejection。
- decode 后以真实 bytes 再做 size limit。
- 必须有安全 filename。

### 14.2 Image Data URL

只接受：

```text
data:image/<supported-type>;base64,<payload>
```

Phase 6 初始 image signature allowlist：

- PNG
- JPEG
- WEBP
- GIF

Gateway 必须同时验证声明 MIME 与 bytes signature 一致；不能只相信 `data:image/...` 字符串。

### 14.3 `file_id` Used as Image

如果一个公开 File 被 `input_image.file_id` 或 Chat Completions image semantic 引用：

- 必须实际 sniff 为支持的 image type。
- 仅 filename `.png` 或 stored MIME `image/png` 不够。

### 14.4 Generic Documents

对于 generic `file` / `input_file`：

- Gateway 验证安全 filename、非空 bytes、大小和基本 MIME metadata。
- 不建立“ChatGPT 永久支持 PDF/TXT/DOCX/XLSX”的静态 allowlist。
- Phase 6 real E2E 以 PDF/TXT/DOCX/XLSX 为代表性验收集合。
- 当前 ChatGPT 如果拒绝某格式，映射成稳定 `chatgpt_upload_failed`，并在 Project State 中记录真实限制，而不是改写客户端文件假装成功。

## 15. Sensitive Source Redaction（敏感 source 不落盘）

当前 Phase 2 `AttachmentRecord.source` 复用了 `NormalizedAttachment['source']`，会允许 raw URL/Base64 被保存。Phase 6 必须收紧为 persistence-specific source provenance：

```ts
type AttachmentSourceRecord =
  | { type: 'url' }
  | { type: 'data_url' }
  | { type: 'base64' }
  | { type: 'file_id' };
```

每个成功 AttachmentRecord 必须有 resolved internal `fileId`。

不得保存：

- remote URL 原文/query/token。
- Data URL 原文。
- Base64 payload。
- request-local temp path。
- Browser staging path。

这样 historical REBUILD 只依赖 `AttachmentRecord.fileId -> File -> Blob`，没有网络重放和敏感 source 泄漏。

## 16. File Lease and Delete Race（文件租约与删除竞态）

FileService 提供进程内 logical File lease：

```text
acquire(file)
  ↓
resolve/stage/upload/request lifecycle
  ↓
release()
```

规则：

- `file_id` resolve 在确认 `deleted_at IS NULL` 后获取 lease。
- DELETE 设置 tombstone 后新的 acquire 失败。
- 已经获得 lease 的请求可以完成当前 Browser upload；DELETE 不从正在使用的请求脚下删 bytes。
- lease 释放后再检查 Attachment refs / logical File refs，决定 deferred GC。
- private inline File 在请求失败且从未进入成功 Conversation Attachment 时，lease 释放后可以立即清理 logical File；共享 Blob 仍按引用判断。

## 17. Request-Scoped Browser Staging（浏览器上传 staging）

Blob permanent basename 是 SHA，不应直接传给 `setInputFiles(path)`，否则 ChatGPT 看到的 filename 会丢失。

每次实际 Browser upload 建立：

```text
${DATA_DIR}/temp/attachments/<request-id>/<n>/<safe-display-filename>
```

staging 内容：

1. 优先 hardlink canonical Blob（同文件系统）。
2. hardlink 不支持时 fallback copy。
3. lifetime 只覆盖当前请求 Browser upload。
4. request finally 必须清理 staging tree。

`PreparedAttachment` 包含：

```ts
interface PreparedAttachment {
  localAttachmentId: string;
  kind: 'image' | 'file';
  fileId: string;
  sha256: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  stagingPath: string;
  uploadFilename: string;
}
```

`stagingPath` 只在 attachments/conversations -> chatgpt runtime 之间存在，不进入 SQLite message content、API response 或普通日志。

## 18. Canonical Multimodal Conversation（多模态规范上下文）

### 18.1 Why Text-only Canonical Model Must Evolve

当前 `CanonicalTextMessage { role, text }` 无法表达附件顺序，也无法判断 full-history 中附件是否分叉。Phase 6 将其扩展为 protocol-neutral multimodal canonical message。

推荐：

```ts
type CanonicalContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'attachment';
      kind: 'image' | 'file';
      sha256: string;
      filename: string;
      mimeType?: string;
    };

interface CanonicalMessage {
  role: 'user' | 'assistant';
  content: CanonicalContentPart[];
}
```

### 18.2 Fingerprint

attachment fingerprint 使用：

- `kind`
- `sha256`
- canonical logical filename
- canonical MIME（存在时）

不使用：

- attachment request-local id。
- public file id。
- internal File UUID。
- URL。
- Base64。
- storage path。
- upload collision suffix。

### 18.3 Text Regression

纯文本请求 canonicalization 必须保持 Phase 4 已验证的语义：

- instructions canonicalization 不变。
- text normalization 不变。
- 纯文本 full-history / incremental Planner 结果不得因类型扩展而漂移。

必须有回归测试证明 Phase 3/4/5 的 text-only cases fingerprint/plan 等价。

### 18.4 Final User Validation

有效 final user：

- 至少一个 non-empty canonical text part；或
- 至少一个 attachment part。

空文本 + 无附件仍是 `invalid_conversation_request`。

## 19. Attachment Resolution Timing（解析时机）

### 19.1 Same-key Queue

对于有 Conversation Key 的请求：

1. 进入 same-key FIFO。
2. 轮到后重新读取 SQLite 当前 Conversation/File facts。
3. resolve 当前请求所有 external attachment descriptors 到 local File/Blob。
4. 构建 canonical multimodal request。
5. 运行 Context Planner。
6. 获取 Page lease。
7. stream 请求在所有 pre-browser attachment validation 成功后 emit internal `started`。
8. 第一次 Browser upload 前写 `in_flight` checkpoint。
9. Browser upload -> Prompt -> Send -> target Assistant lifecycle。

把 URL download 放在 same-key queue 内意味着同 key 后续请求不会在前一个附件尚未 resolve 时抢先规划；不同 key 仍可并行下载/解析。

### 19.2 Pre-stream Error Boundary

以下发生在 `started` 前：

- invalid Data URL/Base64。
- invalid filename。
- `file_id` not found/deleted。
- URL SSRF rejection/fetch error。
- attachment/file size limit。
- image signature mismatch。

因此这些错误保持普通 HTTP non-200 JSON。

实际 ChatGPT upload/readiness 在 `started` + checkpoint 后发生；此后失败按照 Phase 5 post-start stream error framing。

## 20. Context Sync + Upload Selection（上下文同步与上传选择）

Planner 继续只有：

- FRESH
- APPEND
- RESTORE
- REBUILD

不增加 `UPLOAD` 或其它第五种 Context mode。

### 20.1 APPEND / RESTORE

只上传当前 unsynced user message 中引用的附件。

已同步历史附件：

- APPEND：仍存在当前 bound ChatGPT conversation。
- RESTORE：通过同一个 safe ChatGPT Conversation URL 恢复网页 history。

因此不重复上传。

### 20.2 FRESH / REBUILD

需要将当前有效 full context 表达给新的 ChatGPT conversation。Phase 6 继续使用 Context Envelope，而不是把历史逐 turn 重放。

FRESH/REBUILD upload set = 当前有效 `history + current_user` 中所有 attachment semantic refs 对应的 local File。

Context Envelope 记录每个 message 的有序 content：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "compare these" },
    {
      "type": "attachment",
      "kind": "file",
      "filename": "a.pdf",
      "upload_filename": "a.pdf"
    }
  ]
}
```

不放：

- sha256。
- File ID。
- URL。
- Base64。
- local path。

hash 只用于内部 identity/fingerprint，不需要告诉模型。

### 20.3 Known Approximation

REBUILD 时 historical attachments 被重新附着到一个 synthetic Context Envelope turn，而不是严格复现它们最初出现在 ChatGPT Web 哪个历史 turn。

这是 ChatGPT Web gateway 的明确兼容近似，必须通过 real E2E 验证“模型能从 Envelope + attachments 正确理解当前问题”，但不能声称等价于原生 OpenAI conversation item storage。

## 21. ChatGPT Driver Upload Contract（网页上传契约）

### 21.1 Inspect Before Implement

Phase 6 实现代码在锁定具体 attachment Selector 前，必须先扩展 authenticated `inspect:chatgpt`，实际观察当前 ChatGPT DOM，并报告至少：

- attachment trigger / file input 是否存在。
- file input 是 unique 还是 collection。
- input 是否允许 multiple。
- attachment preview/item collection。
- per-item pending/uploading/ready/error 可观察状态。
- 上传失败 UI 的稳定边界。
- 删除/重试 control（只诊断，不自动操作未知 UI）。

本设计**不猜当前 selector 字符串**。只有真实 DOM inspection 后才把 selector 加入 `src/chatgpt/selectors.ts`。

如果当前 DOM 无法找到可靠 upload readiness 证据，Phase 6 实施必须标记 blocker；不能用固定 sleep 替代并声称通过。

### 21.2 Start Turn Ordering

目标 Driver 顺序：

```text
assert AbortSignal
↓
Assistant baseline
↓
locate exact attachment input contract
↓
setInputFiles(prepared staging paths)
↓
wait every owned upload item READY
↓
fill prompt
↓
re-check upload ownership/readiness
↓
click Send
↓
existing target Assistant turn observe/completion
```

如果真实 DOM 要求“先 fill 再 upload”，允许实施阶段根据 inspection 调整 fill/upload 的无副作用顺序；但必须保持：

- checkpoint 在第一次 browser upload 前。
- Send 必须晚于所有附件 ready。
- target Assistant baseline 在 Send 前确定。
- abort signal 穿透每个异步边界。

### 21.3 Upload Ownership

Driver 不能把页面上已有历史附件 preview 当成本请求上传。

需要像 Assistant turn ownership 一样建立 attachment baseline/owned item contract，例如：

- upload 前 snapshot 当前 preview collection count/identity。
- upload 后只等待本次新增 items。
- 数量必须精确匹配 upload set。
- ready/error 必须来自本次 owned items。

具体可用 DOM identity 由 real inspection 决定。

## 22. Checkpoint, Abort and Failure Semantics（checkpoint / 取消 / 失败）

### 22.1 Before Checkpoint

attachment resolve/staging 发生失败：

- 无 Browser side effect。
- 不把 Conversation checkpoint 改为 `in_flight`。
- 释放 File lease。
- 删除 request staging/temp。
- 返回普通 request error。

### 22.2 After Checkpoint, Before Send

包括：

- `setInputFiles` failure。
- upload timeout。
- ChatGPT attachment rejection。
- client abort during upload。
- Composer/Selector failure after upload。

处理：

- 不保存新 User/Assistant/Attachment 为 clean。
- checkpoint 保持 `in_flight`。
- discard Page affinity。
- best-effort 清理 request staging；不能依赖网页删除按钮恢复 Page。
- release File lease。
- 下一 same-key 请求 REBUILD。

### 22.3 During Generation

一旦 Send 成功，继续完全使用 Phase 5 abort：

- best-effort Stop owned generation。
- no partial Assistant persistence。
- checkpoint `in_flight`。
- discard Page。
- next request REBUILD。

### 22.4 Success

成功 final aggregate 一次保存：

- canonical User content（含 attachment refs）。
- resolved AttachmentRecords，每个链接 internal File。
- final Assistant text。
- safe ChatGPT Conversation URL。
- sync checkpoint `clean`。

只有 clean save 成功后，stream 才发送成功 terminal。

## 23. Attachment Persistence in Conversation（Conversation 附件持久化）

每个 request-local normalized attachment `attachment-N` 在成功 aggregate 中得到 AttachmentRecord：

```ts
interface AttachmentRecord {
  id: string;                  // internal UUID
  conversationId: string;
  messageId: string;
  localAttachmentId: string;   // attachment-N
  kind: 'image' | 'file';
  source: AttachmentSourceRecord;
  fileId: string;              // resolved internal File UUID, required in Phase 6
  createdAt: number;
}
```

`MessageRecord.content` 继续用 request-local `attachmentId` 保留该 message 内顺序；load aggregate 时 Repository 校验每一个 attachment content ref 都存在对应 AttachmentRecord/File。

历史 Attachment canonicalization 由 Conversation layer 在 load 后 join File metadata 构造，不让 `context/` 直接访问 Repository。

## 24. Error Boundary（稳定错误边界）

Phase 6 新增/锁定：

| Code | Pre-stream HTTP | 含义 |
|---|---:|---|
| `file_not_found` | 404 | public File 不存在、已删除或不可公开访问 |
| `invalid_file_upload` | 400 | multipart/filename/purpose/file body 无效 |
| `file_too_large` | 413 | `/v1/files` 超过 Gateway 上限 |
| `invalid_attachment` | 400 | attachment source/Base64/Data URL/type 无效 |
| `attachment_too_large` | 413 | 单附件或请求累计附件超过上限 |
| `attachment_fetch_failed` | 400 | client-supplied remote image URL 无法安全获取 |
| `chatgpt_upload_failed` | 502 | ChatGPT 明确拒绝/上传失败 |
| `chatgpt_upload_timeout` | 504 | owned attachment 未在规定时间 ready |
| `file_storage_error` | 500 | Gateway 本地 Blob/File 持久化失败 |
| `unsupported_phase6_request` | 501 | Tools/Structured/Image output/file_url 等 Phase 6 外能力 |

说明：

- URL SSRF rejection 归 `invalid_attachment`，message 不透露 DNS/IP 细节。
- `attachment_fetch_failed` 不回显完整 signed URL。
- raw filesystem error/path 不返回客户端。
- stream 已开始后，稳定 code 沿用协议内 error framing，不能再改变 HTTP 200，也不能发送成功 terminal。

## 25. Streaming Integration（Streaming 集成）

附件只改变**Send 之前**：

```text
resolve + validate attachments
↓
started (stream only)
↓
checkpoint in_flight
↓
upload + readiness
↓
prompt + Send
↓
Phase 5 target Assistant turn
↓
Stable Prefix deltas
↓
final clean aggregate including attachments
↓
protocol success terminal
```

Phase 5 的以下内容不变：

- Assistant baseline ownership。
- target turn observer。
- Stable Prefix / 16-code-point tail holdback。
- completion marker。
- post-Send Stop behavior。
- backpressure。
- Chat Completions / Responses SSE encoder。
- success terminal after clean commit。

不得增加“attachment-specific text streaming core”。

## 26. Filesystem and Container Boundary（文件系统 / 容器）

Phase 6 正式目录：

```text
/data/
├── gateway.db
├── browser-profile/
├── files/
│   └── blobs/
├── generated/
├── temp/
│   └── attachments/
└── logs/
```

要求：

- `/data/files` 与 `/data/temp` 由配置的 `PUID/PGID` 可读写。
- Gateway 长期进程非 root。
- 浏览器 staging path 只在同一 container namespace 内使用。
- Docker restart 后 public File metadata/content 仍可读。
- Docker smoke 验证 migration 003 与持久目录，但**不声称 ChatGPT upload 已验证**。

## 27. Security and Privacy（安全与隐私）

### 27.1 Never Log

普通日志禁止：

- file bytes。
- Base64/Data URL。
- remote URL query/fragment。
- Browser staging path。
- permanent storage path。
- Authorization/Gateway API Key。
- ChatGPT Cookie/Profile 数据。

允许日志：

- request id。
- internal error code。
- attachment count。
- total bytes。
- hash 的短不可逆诊断前缀（仅确有需要；默认不输出）。
- redacted remote host/origin。

### 27.2 No Path Injection

- user filename 不进 permanent path。
- temp staging 的 filename 经过 sanitizer，parent directory 由 Gateway 创建。
- content response header 使用安全 Content-Disposition encoding。

### 27.3 SSRF

SSRF policy 是 Phase 6 security gate，不是 optional hardening。URL input 在没有全链路 redirect/DNS/IP 验证前不得进入产品支持矩阵。

### 27.4 Data Retention Honesty

Phase 6 没有 automatic expiration，也没有 secure erase 承诺。公开 DELETE 的 retained historical Attachment 语义必须写入 API/deployment docs。

## 28. Deterministic Unit Tests（确定性单元测试）

至少覆盖：

### 28.1 Source Parsing

- valid/invalid Base64。
- encoded-size precheck + decoded-size check。
- valid/invalid image Data URL。
- MIME/signature mismatch。
- PNG/JPEG/WEBP/GIF sniff。
- filename Unicode/basename/control/NUL/byte-length。
- URL scheme/credential rejection。
- IPv4/IPv6 private/link-local/loopback/CGNAT/ULA 等 SSRF ranges。
- redirect 每跳重新校验。
- max redirect/timeout/stream size。

### 28.2 File/Blob

- SHA-256 streaming hash。
- two logical Files same bytes -> one Blob。
- different filename/purpose -> distinct public IDs。
- private File 不进入 list。
- delete tombstone visibility。
- active lease prevents cleanup。
- Attachment ref retains deleted public File bytes。
- last ref release removes eligible Blob。
- orphan temp/blob cleanup。

### 28.3 Migration 003

- empty database migration。
- old File row migration。
- duplicate SHA old rows。
- existing Attachment FK preserved。
- checksum/history/reopen。
- integrity conflict rollback。

### 28.4 Files API

- multipart one-file requirement。
- purpose enum。
- object shape/seconds timestamp。
- list order/limit/after/purpose。
- content headers。
- unknown/private/deleted 404。
- file too large 413。

### 28.5 Canonical Conversation

- content part order preserved。
- same bytes from URL/Data URL/file_id canonical equivalence。
- same bytes different filename changes fingerprint。
- image/file kind changes fingerprint。
- attachment-only final user valid。
- empty final user invalid。
- pure-text Phase 4/5 planner regression unchanged。
- FRESH/REBUILD upload set includes historical attachments。
- APPEND/RESTORE upload set includes only current user attachments。

### 28.6 Driver Contract

使用 fake DOM/Page boundary 测：

- exact upload count ownership。
- multiple files ready。
- one file error。
- readiness timeout。
- abort during upload。
- no Send before all ready。
- checkpoint callback/order tests at Conversation level。

## 29. Deterministic Integration Tests（确定性集成测试）

### 29.1 Files Lifecycle

真实 temp SQLite + temp filesystem：

```text
POST file
→ GET metadata
→ GET list
→ GET content exact bytes
→ close runtime
→ reopen same data dir
→ GET content exact bytes
→ DELETE
→ public 404
```

并验证两次相同 bytes 上传得到两个 public IDs，但共享一个 Blob。

### 29.2 Attachment Resolver

- local controlled HTTP fixture 模拟 public URL policy 时，不放宽生产 SSRF；网络层通过 injectable resolver/transport 测 redirect/address policy。
- Data URL image -> File/Blob。
- Base64 document -> File/Blob。
- public `file_id` -> lease + prepared attachment。
- invalid/deleted File fail before Browser。

### 29.3 Conversation Engine

fake Driver + real SQLite/File store 覆盖：

- Chat Completions image URL/Data URL。
- Chat Completions file data/file_id。
- Responses input_image/input_file。
- non-stream + stream。
- FRESH historical upload selection。
- full-history APPEND no duplicate upload。
- restart RESTORE current-only upload。
- history divergence REBUILD full upload。
- same-key FIFO during slow attachment resolve/upload。
- different-key parallel。
- pre-start resolver failure ordinary HTTP error。
- post-start upload failure stream error/no terminal。
- upload abort keeps `in_flight` + discard Page。
- final save failure does not send success terminal。

## 30. Authenticated Real ChatGPT E2E（真实网页验收）

Phase 6 必须新增独立命令，例如：

```text
corepack pnpm test:e2e:chatgpt:phase6
```

并把 Phase 6 加入 combined `test:e2e:chatgpt` regression。真实命令继续要求：

- `E2E_CHATGPT=1`。
- 独立非生产 `CHATGPT_PROFILE_DIR`。
- 当前环境需要时显式 `CHATGPT_PROXY_SERVER`。
- 不自动处理账号密码/MFA/CAPTCHA。

### 30.1 DOM Inspection Gate

先运行 fresh：

```text
corepack pnpm inspect:chatgpt
```

必须报告：

- authenticated。
- composer unique。
- attachment input contract 可判定。
- upload preview/readiness contract 可判定。

未通过时不运行“盲上传”测试。

### 30.2 Image Understanding

使用 deterministic small PNG/JPEG fixture，其中包含唯一 marker（fixture 可在测试准备阶段生成，不新增生产图片处理依赖）。

至少证明：

- 一条 direct Data URL/image input 成功。
- 一条通过 `/v1/files` 获得的 image `file_id` 成功。
- ChatGPT 最终回答包含 fixture 的唯一可读信息/marker。
- SQLite Attachment -> File/Blob linkage 与 final Conversation clean。

### 30.3 Representative Documents

至少：

- PDF
- TXT
- DOCX
- XLSX

每个 fixture 放不同唯一 token，提示 ChatGPT 返回 token，证明不是“UI 显示文件名”而是真实内容可用。

至少一个 document 走 `/v1/files` `file_id`，至少一个走 direct Base64 file path。

### 30.4 Context Sync

真实验证至少一条：

1. 首轮上传附件并得到答案。
2. 第二轮 same-key APPEND 不重新上传旧附件，但能基于旧附件继续回答。
3. restart 后 RESTORE 仍能继续基于旧 attachment context。

如果当前 ChatGPT Web 对某类附件在恢复后无法保留可用语义，应记录为真实 blocker/限制，不把 deterministic Planner 通过冒充网页能力。

### 30.5 Streaming

至少一个 attachment request 使用 `stream=true`，证明：

- upload ready 后才 Send。
- meaningful delta 仍早于 target completion marker。
- final delta concat == authoritative live DOM == SQLite Assistant text。
- AttachmentRecords 与 final clean commit 同时存在。

### 30.6 URL Fetch

产品必须实现 URL image；真实 ChatGPT E2E 的重点是 upload 后网页理解。remote URL download 安全逻辑主要由 deterministic resolver tests 证明。

如果验收环境有稳定的公网 fixture，可额外跑真实 URL source；如果没有，不允许通过访问 localhost/private address 绕过 SSRF。最终验收需明确 real remote fetch 是否实际运行。

## 31. Docker Acceptance（Docker 验收）

Phase 6 deterministic/Docker 验收至少增加：

- migration history 包含 `001`、`002`、`003`，checksum 正确。
- `/data/files/blobs` 可由 PUID/PGID Gateway 写入。
- `/data/temp` staging 可创建/清理。
- 通过 Gateway `/v1/files` 上传一个小 fixture。
- restart container 使用同一 Bind Mount 后 metadata/content 可恢复。
- DELETE 后 public access 消失。
- normal/maintenance Browser owner、Chrome sandbox/seccomp、noVNC RFB 等既有 smoke regression 继续通过。

Docker smoke 不访问真实 ChatGPT，因此不能证明 attachment selector/readiness/文件实际进入 ChatGPT。

## 32. Architecture Checks（架构检查）

Phase 6 应收紧 `scripts/check-architecture.mjs`：

- `attachments/` 不允许导入 `playwright`、`api/`、`chatgpt/`。
- `chatgpt/` 不允许导入 `persistence/` 或 attachment FileRepository 实现。
- `api/` 不允许导入 Playwright/ChatGPT selector。
- File/Blob filesystem logic 不应散落到 API route/Driver。
- ChatGPT attachment selectors 仍只允许定义在 `src/chatgpt/selectors.ts`。

## 33. API Compatibility Update on Completion（完成时兼容矩阵更新）

只有 Phase 6 deterministic + Docker + authenticated real E2E 全部达到验收后，才把 `docs/api-compatibility.md` 更新为：

- Files 五个 endpoint ✅。
- Chat Completions image URL/Data URL ✅。
- Chat Completions file data/file_id ✅。
- Responses input_image ✅。
- Responses input_file data/file_id ✅。
- `input_file.file_url` 仍 ❌ / unsupported。
- Tools / Structured Output / Image Generation 仍 ❌。

在 real E2E 之前，不能因为代码存在就把“ChatGPT 当前网页 upload works”写成已验证事实。

## 34. Implementation Sequence（建议实施顺序）

Phase 6 后续实施计划应拆成至少以下可独立验收 Task：

1. **File/Blob migration + FileService**：migration 003、atomic store、SHA dedup、lease/delete/GC。
2. **Files HTTP API**：multipart create、list/retrieve/content/delete、auth/error。
3. **Attachment Resolver**：URL SSRF、Data URL/Base64、image sniff、limits、staging。
4. **Canonical Multimodal Context**：ordered parts、fingerprint、Planner regression、upload selection。
5. **Authenticated DOM inspection + Driver upload**：先 inspect，再锁 selectors/readiness，TDD upload ownership/abort。
6. **Conversation Engine attachment lifecycle**：resolve → started/checkpoint → upload → Send → final aggregate，non-stream + stream。
7. **Deterministic integration / API tests**：协议双入口、Context modes、failure semantics。
8. **Docker acceptance**：persistent File lifecycle + migration + existing smoke regression。
9. **Real Phase 6 E2E**：image + PDF/TXT/DOCX/XLSX + APPEND/RESTORE + streaming。
10. **Final docs / Project State writeback**：只有上述证据完成后关闭 Phase 6。

每个行为 Task 遵循：红测试 → 最小实现 → 绿测试 → 更大范围验证。

## 35. Acceptance Criteria（完成门槛）

Phase 6 只有同时满足以下条件才可标记完成：

### Protocol / Storage

- Files 五个 endpoint 实际工作并可 restart recovery。
- physical SHA-256 dedup + distinct logical File identity 被测试证明。
- DELETE visibility + retained historical Attachment 语义被测试证明。
- inline source 不把 URL/Base64 secret 持久化。

### Security

- SSRF redirect/DNS/IP guard 有 deterministic coverage。
- path traversal / filename / size limits 有 coverage。
- API/log 不泄漏 raw file/Base64/signed URL/local path。

### Conversation

- ordered multimodal canonicalization + fingerprint 正确。
- FRESH/APPEND/RESTORE/REBUILD attachment upload selection 正确。
- same-key FIFO / different-key parallel regression 正确。
- upload side effect 前 checkpoint `in_flight`。
- abort/unknown upload failure 下一请求 REBUILD 收敛。

### Streaming

- attachment `stream=true` 使用 Phase 5 true DOM streaming。
- final clean commit 晚于完整 Assistant + Attachment persistence，早于 success terminal。

### Deterministic / Docker

- fresh `corepack pnpm verify` 全绿。
- fresh `linux/amd64` Docker build 全绿。
- full `docker:smoke` 全绿并覆盖 migration 003/file persistence restart。

### Authenticated Real E2E

- fresh `inspect:chatgpt` authenticated + attachment DOM contract。
- standalone Phase 6 E2E：图片理解 + PDF/TXT/DOCX/XLSX 代表性文档。
- at least one `file_id` path + one direct data/base64 path。
- same-key attachment context follow-up/recovery。
- at least one attachment Streaming path。
- combined Phase 3/4/5/6 real E2E 全绿。

任何一项真实网页验收未运行，都必须在最终汇报写成未验证，Phase 6 不得被标为 fully complete。

## 36. Risks and Explicit Limits（风险与明确限制）

1. **ChatGPT DOM 会变化。** attachment input/preview/readiness selector 必须以当次 authenticated inspection 为准。
2. **ChatGPT upload semantics 可能变化。** 文件名/preview 显示不等于内容已被模型 ingest；real E2E 必须要求模型返回 fixture token。
3. **REBUILD attachment placement 是近似。** historical attachments 被集中附着到 synthetic Context Envelope，不是原 turn replay。
4. **DELETE 不等于立即擦除。** historical Conversation 为保证恢复可保留 bytes。
5. **URL SSRF 防护复杂。** DNS rebinding/redirect 是 security-critical；不得以简单 hostname blacklist 上线。
6. **单进程 lease。** V1 仍是一个 Gateway process；未来多进程共享 `${DATA_DIR}` 需要跨进程锁新设计。
7. **Gateway 32/64 MiB 限制是本产品策略。** 不是 OpenAI/ChatGPT 最大能力声明。
8. **`file_url` 暂不兼容。** 当前 upstream Responses 具备该字段，但仓库 V1 Phase 6 明确只做现有已批准 source shape。
9. **Office/PDF support 依赖 ChatGPT Web。** representative E2E 是当次事实，不保证第三方未来格式永远可用。

## 37. Outcome（设计结果）

Phase 6 锁定的核心边界是：

```text
External attachment source
        ↓
resolve + validate + persist once
        ↓
Logical File → content-addressed Blob
        ↓
Canonical multimodal Conversation
        ↓
existing FRESH/APPEND/RESTORE/REBUILD
        ↓
request-scoped staged filenames
        ↓
owned ChatGPT attachment upload + readiness
        ↓
existing target Assistant + True Streaming
        ↓
final clean Conversation + Attachment/File linkage
```

下一步是编写详细 Phase 6 implementation plan。规格批准前的“附件只是 descriptor”状态到此结束；**但代码能力仍未实现，Project State 必须继续明确区分“Phase 6 design complete”与“Phase 6 implementation complete”。**
