# Phase 2 SQLite and Conversation Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic SQLite persistence with checksum migrations, typed repositories, atomic Conversation aggregate save/load, restart recovery, and Docker persistence verification.

**Architecture:** Use Node 24 built-in `node:sqlite` with one synchronous `DatabaseSync` connection. SQL stays inside `src/persistence/`; repositories expose typed records and `ConversationStore` coordinates cross-table aggregate transactions. Database migrations are append-only SQL files with SHA-256 history checksums, and Gateway startup opens/migrates `${DATA_DIR}/gateway.db` before listening.

**Tech Stack:** Node.js 24.x LTS, built-in `node:sqlite`, TypeScript 6, Vitest, existing Docker/Compose runtime.

## Global Constraints

- Use only Node built-in `node:sqlite`; do not add an ORM or third-party SQLite driver.
- Runtime database path is `${DATA_DIR}/gateway.db`.
- Use one `DatabaseSync` connection per Gateway process.
- Enable `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, and `PRAGMA busy_timeout = 5000`.
- Business entity primary keys are UUID v4 strings; timestamps are Unix milliseconds.
- Migrations are append-only, sequential, filename-matched by `^([0-9]{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$`, and checksum verified.
- SQL and `node:sqlite` imports remain inside `src/persistence/`.
- Persistence transactions are synchronous; no `await` inside a DB transaction.
- Files remain filesystem-backed metadata records; do not store file bytes in SQLite BLOBs.
- Phase 2 does not implement Browser Manager, ChatGPT Driver, Context Sync decisions, `/v1/files`, Tool execution, or image generation.
- Real ChatGPT E2E remains out of scope.

---

### Task 1: Database primitives, migrations, and initial schema

**Files:**
- Create: `migrations/001_initial.sql`
- Create: `src/persistence/errors.ts`
- Create: `src/persistence/transaction.ts`
- Create: `src/persistence/json.ts`
- Create: `src/persistence/migrations.ts`
- Create: `src/persistence/database.ts`
- Create: `tests/helpers/persistence.ts`
- Create: `tests/unit/persistence-migrations.test.ts`

**Interfaces:**
- Produces: `PersistenceError`, `MigrationError`, `DataIntegrityError`.
- Produces: `transaction<T>(database: DatabaseSync, work: () => T): T`.
- Produces: `encodeJson(value: unknown): string` and `decodeJson<T>(context: string, value: string): T`.
- Produces: `runMigrations(database, options): MigrationRecord[]`.
- Produces: `openDatabase(path: string): DatabaseSync` and `closeDatabase(database): void`.
- Later tasks consume the migrated schema and one shared `DatabaseSync`.

- [x] **Step 1: Write failing database/migration tests**

Create tests that prove configuration and initial migration behavior:

```ts
const db = openDatabase(databasePath);
expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });

const applied = runMigrations(db, { migrationsDir, now: () => 1_786_714_000_000 });
expect(applied).toEqual([
  expect.objectContaining({ version: 1, name: 'initial', appliedAt: 1_786_714_000_000 }),
]);
expect(runMigrations(db, { migrationsDir, now: () => 1_786_714_000_001 })).toEqual([]);
```

Also test:

- all six business tables exist;
- `schema_migrations` has version `1` and a 64-character SHA-256 checksum;
- a copied migration modified after first application throws `MigrationError` with a checksum code;
- files `001_initial.sql` + `003_gap.sql` throw a sequence-gap migration error;
- a syntactically broken pending migration rolls back both its schema changes and history row.

- [x] **Step 2: Run focused migration tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-migrations.test.ts
```

Expected: FAIL because `src/persistence/*` and `migrations/001_initial.sql` do not exist.

- [x] **Step 3: Add persistence error and JSON helpers**

Implement stable internal errors with non-sensitive metadata:

```ts
export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PersistenceError';
  }
}

export class MigrationError extends PersistenceError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, cause);
    this.name = 'MigrationError';
  }
}

export class DataIntegrityError extends PersistenceError {
  constructor(message: string, cause?: unknown) {
    super(message, 'data_integrity_error', cause);
    this.name = 'DataIntegrityError';
  }
}
```

`encodeJson` rejects top-level `undefined`; `decodeJson` catches `JSON.parse` failures and throws `DataIntegrityError` without embedding the raw JSON value in the message.

- [x] **Step 4: Implement synchronous transaction helper**

Use exactly one transaction owner:

```ts
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}
```

Do not accept `Promise` callbacks.

- [x] **Step 5: Implement database open/configure/close**

`openDatabase(path)` must create parent directories when the path is file-backed, instantiate `DatabaseSync`, then execute:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Verify each PRAGMA after setting it. If any required setting is not active, close the DB and throw `PersistenceError('database_configuration_error')`.

`closeDatabase` should close once; callers own idempotence at the context level.

- [x] **Step 6: Implement strict migration discovery/checksum runner**

Migration discovery must:

```ts
const MIGRATION_FILE = /^([0-9]{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
```

- ignore no `.sql` file silently only when it does not end in `.sql`;
- reject malformed `.sql` filenames;
- sort by integer version;
- require versions `1..N` without gaps;
- SHA-256 the exact SQL bytes;
- bootstrap `schema_migrations` as a STRICT table;
- reject DB-applied versions absent from disk;
- reject checksum mismatch;
- execute each pending migration in its own `BEGIN IMMEDIATE` transaction and insert history in that same transaction.

Return only migrations applied during the current invocation.

- [x] **Step 7: Create `001_initial.sql` with the approved schema**

The migration must create STRICT tables and explicit constraints for:

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  conversation_key TEXT UNIQUE,
  chatgpt_conversation_url TEXT,
  instructions_json TEXT NOT NULL CHECK (json_valid(instructions_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  tool_choice_json TEXT NOT NULL CHECK (json_valid(tool_choice_json)),
  tool_fingerprint TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_used_at INTEGER NOT NULL CHECK (last_used_at >= 0)
) STRICT;
```

Add `messages`, `tool_calls`, `files`, `attachments`, and `generated_images` exactly as specified in the governing Phase 2 spec, including FK actions and CHECK/UNIQUE constraints. Add indexes on message sequence, tool-call lookup, attachments, file SHA-256, and generated-image chronology.

- [x] **Step 8: Run migration tests and static checks**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-migrations.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 9: Commit Task 1**

Commit message:

```text
🗃️ 建立 SQLite 数据库与迁移基础
```

---

### Task 2: Persistence record types and Conversation/Message repositories

**Files:**
- Create: `src/persistence/types.ts`
- Create: `src/persistence/repositories/conversations.ts`
- Create: `src/persistence/repositories/messages.ts`
- Create: `tests/unit/persistence-conversations-messages.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync`, JSON helpers, migrated schema from Task 1.
- Produces: `ConversationRecord`, `MessageRecord`, common UUID/time helpers if needed.
- Produces: `ConversationRepository` with `insert`, `update`, `getById`, `getByKey`.
- Produces: `MessageRepository` with `insert`, `listByConversation`, `deleteByConversation`.

- [x] **Step 1: Write failing Conversation/Message repository tests**

Use an isolated migrated database and records such as:

```ts
const conversation: ConversationRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  conversationKey: 'agent-thread-1',
  chatgptConversationUrl: 'https://chatgpt.com/c/example',
  instructions: [{ role: 'developer', content: 'Be concise.' }],
  tools: [],
  toolChoice: { mode: 'auto' },
  toolFingerprint: undefined,
  createdAt: 1_000,
  updatedAt: 2_000,
  lastUsedAt: 3_000,
};
```

Assert:

- insert/getById/getByKey round-trip semantic objects;
- multiple rows may have `conversationKey: undefined`;
- duplicate non-null conversation key fails;
- `update` changes URL/instructions/tools/tool choice/timestamps but preserves id;
- messages load in `sequence ASC` even if inserted out of chronological timestamp order;
- duplicate `(conversation_id, sequence)` fails;
- invalid role inserted through raw SQL is rejected by SQLite.

- [x] **Step 2: Run focused tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-conversations-messages.test.ts
```

Expected: FAIL because types/repositories do not exist.

- [x] **Step 3: Define persistence record types**

Define exact interfaces for all Phase 2 entities in `types.ts`, importing existing normalized protocol types where useful:

```ts
export interface MessageRecord {
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

Also define `ConversationRecord`, `ToolCallRecord`, `AttachmentRecord`, `FileRecord`, `GeneratedImageRecord`, and later `ConversationAggregate`.

- [x] **Step 4: Implement ConversationRepository with prepared statements**

Repository accepts the shared `DatabaseSync` in its constructor. Store optional values as SQL `NULL`; serialize JSON through `encodeJson`; decode through `decodeJson`.

`update(record)` must update by primary key and throw `DataIntegrityError` if no row was changed rather than silently inserting.

- [x] **Step 5: Implement MessageRepository**

Use prepared statements. `listByConversation` must include `ORDER BY sequence ASC`. `deleteByConversation` deletes only rows for that conversation and relies on FK cascade for message-owned Tool Calls/Attachments.

- [x] **Step 6: Run focused and full unit/static checks**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-conversations-messages.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 7: Commit Task 2**

Commit message:

```text
🗃️ 增加 Conversation 与 Message Repository
```

---

### Task 3: Tool Call and Attachment repositories

**Files:**
- Create: `src/persistence/repositories/tool-calls.ts`
- Create: `src/persistence/repositories/attachments.ts`
- Create: `tests/unit/persistence-tools-attachments.test.ts`

**Interfaces:**
- Consumes: `ToolCallRecord`, `AttachmentRecord`, shared DB/JSON helpers.
- Produces: `ToolCallRepository.insert/listByConversation/deleteByConversation`.
- Produces: `AttachmentRepository.insert/listByConversation/deleteByConversation`.

- [x] **Step 1: Write failing Tool Call/Attachment repository tests**

Create one conversation and messages, then assert:

```ts
expect(toolCalls.listByConversation(conversationId)).toEqual([
  expect.objectContaining({
    externalCallId: 'call_weather_1',
    name: 'lookup_weather',
    argumentsText: '{"city":"Tokyo"}',
  }),
]);
```

Also cover:

- invalid JSON-like `argumentsText='{'` is preserved exactly and accepted;
- duplicate `(conversation_id, external_call_id)` fails;
- Tool Call referencing a message from another conversation is rejected by Repository validation before insert;
- Attachment round-trips image URL, image `file_id`, and base64-file descriptor JSON;
- duplicate `(message_id, local_attachment_id)` fails;
- Attachment `fileId` may point to an existing File row and FK rejects unknown File id;
- Attachment raw `kind='video'` is rejected by SQLite.

- [x] **Step 2: Run tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-tools-attachments.test.ts
```

Expected: FAIL because repositories do not exist.

- [x] **Step 3: Implement ToolCallRepository**

Persist `argumentsText` as raw TEXT, not JSON. Before insert, verify `message_id` belongs to the same `conversation_id` using a prepared lookup; throw `DataIntegrityError` on mismatch.

Stable listing order:

```sql
ORDER BY created_at ASC, id ASC
```

- [x] **Step 4: Implement AttachmentRepository**

Persist `source` using JSON helper and optional `fileId` separately. Validate message/conversation ownership before insert. Listing order:

```sql
ORDER BY created_at ASC, id ASC
```

- [x] **Step 5: Run focused and static checks**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-tools-attachments.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 6: Commit Task 3**

Commit message:

```text
🗃️ 增加 Tool Call 与 Attachment Repository
```

---

### Task 4: File and Generated Image repositories

**Files:**
- Create: `src/persistence/repositories/files.ts`
- Create: `src/persistence/repositories/generated-images.ts`
- Create: `tests/unit/persistence-files-images.test.ts`

**Interfaces:**
- Consumes: `FileRecord`, `GeneratedImageRecord`.
- Produces: `FileRepository.insert/getById/findBySha256`.
- Produces: `GeneratedImageRepository.insert/getById/listByConversation/deleteByConversation`.

- [x] **Step 1: Write failing File/Generated Image tests**

Cover:

- File insert/get round-trip;
- two different File rows may share the same SHA-256;
- `findBySha256` returns all matching logical files in stable `created_at, id` order;
- duplicate `storage_path` fails;
- negative `size_bytes` is rejected;
- Generated Image round-trip with conversation/message references;
- listing by Conversation is ordered `created_at, id`;
- deleting a Conversation leaves Generated Image row with nullable conversation/message references because FKs use `ON DELETE SET NULL`.

- [x] **Step 2: Run tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-files-images.test.ts
```

Expected: FAIL because repositories do not exist.

- [x] **Step 3: Implement FileRepository**

`findBySha256(sha256)` returns `FileRecord[]`, never silently deduplicates. Do not read or write file bytes.

- [x] **Step 4: Implement GeneratedImageRepository**

Keep all behavior metadata-only. No Playwright/network/filesystem image operations belong in this repository.

- [x] **Step 5: Run focused and static checks**

Run:

```bash
corepack pnpm vitest run tests/unit/persistence-files-images.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 6: Commit Task 4**

Commit message:

```text
🗃️ 增加 File 与 Generated Image Repository
```

---

### Task 5: Atomic ConversationStore and restart recovery

**Files:**
- Create: `src/persistence/conversation-store.ts`
- Create: `src/persistence/index.ts`
- Create: `tests/integration/persistence-recovery.test.ts`

**Interfaces:**
- Consumes: all repositories and `transaction`.
- Produces: `ConversationAggregate` type if not already exported from `types.ts`.
- Produces: `ConversationStore.save(aggregate): void`, `loadById(id)`, `loadByKey(key)`.
- Produces: `createPersistenceContext({ databasePath, migrationsDir? }): PersistenceContext` and idempotent `context.close()`.

- [x] **Step 1: Write failing close/reopen aggregate recovery test**

Build a complete semantic fixture:

```text
Conversation
├── developer + system instructions
├── user message with image attachment
├── assistant message with tool call
├── tool result message
├── second assistant message
├── file attachment referencing a separately stored File row
└── generated image metadata
```

Test sequence:

```ts
const first = createPersistenceContext({ databasePath });
first.files.insert(file);
first.conversationStore.save(aggregate);
first.close();

const second = createPersistenceContext({ databasePath });
expect(second.conversationStore.loadById(aggregate.conversation.id)).toEqual(aggregate);
expect(second.conversationStore.loadByKey('agent-thread-1')).toEqual(aggregate);
expect(second.files.getById(file.id)).toEqual(file);
second.close();
```

- [x] **Step 2: Write failing atomic replacement test**

Save a valid aggregate, then attempt a replacement aggregate containing a Tool Result whose `toolCallId` is missing. Assert `save()` throws and reopening/loading still returns the original aggregate unchanged.

Also assert duplicate message sequences and attachment references to messages outside the aggregate are rejected before destructive child replacement begins.

- [x] **Step 3: Run recovery tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/integration/persistence-recovery.test.ts
```

Expected: FAIL because `ConversationStore` / persistence context do not exist.

- [x] **Step 4: Implement aggregate validation**

Before opening the replacement transaction validate in memory:

- every message belongs to the aggregate Conversation;
- message sequences are unique;
- every Tool Call belongs to a message in the aggregate and same Conversation;
- every Tool Result `toolCallId` matches an aggregate Tool Call `externalCallId`;
- every Attachment belongs to a message in the aggregate and same Conversation;
- every Generated Image non-null messageId belongs to an aggregate message.

Throw `DataIntegrityError` without deleting current rows if validation fails.

- [x] **Step 5: Implement atomic snapshot save**

Inside one `transaction`:

1. insert or update Conversation;
2. delete existing generated images for the Conversation;
3. delete existing messages for the Conversation, letting message cascades remove old Tool Calls/Attachments;
4. insert Messages;
5. insert Tool Calls;
6. insert Attachments;
7. insert Generated Images.

Do not mutate shared File rows.

- [x] **Step 6: Implement aggregate load**

`loadById` / `loadByKey` first load the Conversation, then child repositories in stable order. Missing Conversation returns `undefined`; child corruption throws rather than returning partial data.

- [x] **Step 7: Implement persistence context**

```ts
export interface PersistenceContext {
  readonly database: DatabaseSync;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly toolCalls: ToolCallRepository;
  readonly attachments: AttachmentRepository;
  readonly files: FileRepository;
  readonly generatedImages: GeneratedImageRepository;
  readonly conversationStore: ConversationStore;
  close(): void;
}
```

`createPersistenceContext` opens DB, runs migrations, creates one instance of each repository sharing that DB, and returns an idempotent close method.

Default migrations directory must resolve correctly both from `tsx src/...` and compiled `dist/...` against repository/runtime root `migrations/`.

- [x] **Step 8: Run recovery, full tests, and static checks**

Run:

```bash
corepack pnpm vitest run tests/integration/persistence-recovery.test.ts
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

Commit message:

```text
🗃️ 增加 Conversation 原子持久化与重启恢复
```

---

### Task 6: Gateway startup/shutdown and Docker persistence smoke

**Files:**
- Modify: `src/index.ts`
- Modify: `Dockerfile`
- Modify: `scripts/docker-smoke.mjs`
- Create: `tests/integration/persistence-startup.test.ts`

**Interfaces:**
- Consumes: `createPersistenceContext` from Task 5 and `AppConfig.dataDir`.
- Produces: production process opens `${dataDir}/gateway.db` before Fastify listen and closes DB during graceful shutdown.
- Docker image contains `/app/migrations/`.

- [ ] **Step 1: Write failing startup integration test**

Extract the process composition needed to test startup without opening a TCP port if necessary. Assert a temp `DATA_DIR` creates `gateway.db` and applies migration before the server is considered ready. Assert calling shutdown twice is safe.

Do not make `buildServer()` itself require persistence; existing HTTP injection tests must remain file-IO free.

- [ ] **Step 2: Run startup test and verify red**

Run:

```bash
corepack pnpm vitest run tests/integration/persistence-startup.test.ts
```

Expected: FAIL because production startup does not open persistence yet.

- [ ] **Step 3: Integrate persistence into process lifecycle**

Production startup sequence:

```ts
const config = loadConfig();
const persistence = createPersistenceContext({
  databasePath: path.join(config.dataDir, 'gateway.db'),
});
const app = buildServer({ config, logger: true });
```

If DB/migration setup fails, close any opened resources and exit non-zero. Graceful shutdown closes Fastify then persistence, with an idempotence guard.

- [ ] **Step 4: Copy migrations into runtime Docker image**

Add to runtime stage:

```dockerfile
COPY migrations ./migrations
```

The compiled application must resolve that directory without requiring source files.

- [ ] **Step 5: Extend Docker smoke before implementation verification**

After the normal Compose starts, smoke must prove:

```text
/data/gateway.db exists
schema_migrations contains version 1 / name initial
PRAGMA foreign_keys reports 1 from the running application database context or a safe Node sqlite probe
Gateway process can create/write its database under requested PUID/PGID
```

Restart the Gateway service with the same bind mount, wait for `/health`, and confirm the same database still has one migration row (not a duplicate/failure).

Do not inspect/modify real user data; smoke uses its existing temporary bind mount.

- [ ] **Step 6: Run application and fresh Docker verification**

Run:

```bash
corepack pnpm verify
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS. Real ChatGPT E2E remains unrun.

- [ ] **Step 7: Commit Task 6**

Commit message:

```text
🐳 接入 Gateway SQLite 生命周期与 Docker 持久化验证
```

---

### Task 7: Architecture enforcement, documentation, and Phase 2 acceptance

**Files:**
- Modify: `scripts/check-architecture.mjs`
- Modify: `docs/architecture.md` only if implementation facts differ from current design text.
- Modify: `docs/testing.md`
- Modify: `README.md` if runtime database behavior is useful to operators.
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/superpowers/plans/2026-08-14-phase-2-sqlite-conversation-persistence.md`
- Modify: `docs/superpowers/specs/2026-08-14-phase-2-sqlite-conversation-persistence-design.md` only for implementation-forced clarifications.

**Interfaces:**
- Produces: executable architecture rule preventing `node:sqlite` outside `src/persistence/`.
- Produces: project memory showing Phase 2 actual status and Phase 3 as the next design task only when all Phase 2 acceptance criteria have evidence.

- [ ] **Step 1: Add failing architecture guard evidence**

Before changing the checker, temporarily reason against/inspect a representative forbidden import pattern. Implement a checker rule equivalent to:

```text
if source file is outside src/persistence/ and imports node:sqlite → architecture failure
```

Keep existing Playwright and `process.env` rules intact.

- [ ] **Step 2: Run full deterministic verification**

Run:

```bash
corepack pnpm verify
```

Expected: format, lint, typecheck, all tests, build, project-memory, docs, architecture, and version checks pass.

- [ ] **Step 3: Run fresh Docker verification**

Run:

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS with DB creation/migration/restart persistence checks.

- [ ] **Step 4: Verify all 13 Phase 2 acceptance criteria line by line**

Record evidence in this plan for:

1. no third-party SQLite driver/ORM;
2. startup DB + migration;
3. required PRAGMAs;
4. checksum tamper detection;
5. initial six-entity schema;
6. UUID/timestamp policy;
7. Repository/sqlite import boundary;
8. atomic aggregate save/rollback;
9. aggregate load by id/key;
10. close/reopen recovery;
11. Docker migrations + bind-mounted DB restart;
12. deterministic `verify`;
13. explicit real ChatGPT E2E unverified statement.

Any unmet item keeps `PROJECT_STATE` in Phase 2 active/blocker status.

- [ ] **Step 5: Apply documentation/project-memory writeback**

If all acceptance criteria pass:

```text
PHASE=phase-2-complete
STATUS=ready-for-phase-3-design
GOVERNING_SPEC=docs/superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md
ACTIVE_PLAN=none
NEXT_TASK=write-phase-3-browser-driver-spec
```

`Implemented Now` may mark SQLite/migrations/repositories/restart recovery as complete, but must keep Browser Manager/ChatGPT Driver/Context Sync/Streaming/files execution/tools execution/images generation as not implemented.

- [ ] **Step 6: Run Git hygiene checks**

Run:

```bash
corepack pnpm verify:repo
git diff --check
git status --short --branch
git diff
git diff --staged
```

Confirm no `gateway.db`, `gateway.db-wal`, `gateway.db-shm`, `.env`, Browser Profile, uploaded file, generated image, or secret is staged.

- [ ] **Step 7: Commit Phase 2 completion/writeback**

Commit message:

```text
📝 记录 Phase 2 SQLite 持久化实施结果
```

- [ ] **Step 8: Push feature branch**

Push `phase-2-persistence` normally to `origin`; do not force-push. Record actual result in final report.
