# Phase 4 Conversation + Context Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 3 Fresh-only executor with a persistent Conversation Engine that supports keyed multi-turn `FRESH | APPEND | RESTORE | REBUILD`, same-key FIFO, Page affinity/LRU/idle recovery, and crash-safe SQLite sync checkpoints for non-streaming text requests.

**Architecture:** Keep `context/` pure and browser/database-free; put identity, queue, execution, Page affinity, and aggregate assembly in `conversations/`; keep `browser/` generic and `chatgpt/` DOM-only. SQLite is the recovery source of truth, ChatGPT URL is a restorable resource locator, and Page affinity is a disposable runtime cache.

**Tech Stack:** Node 24, TypeScript 6, Fastify 5, TypeBox/Ajv, Node `node:sqlite`, Playwright 1.62.1 bundled Chromium, Vitest 4, pnpm 11.21.0, Docker `linux/amd64`.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md`.
- Keep `playwright@1.62.1` and the current Playwright Docker image baseline; add no production dependency.
- Phase 4 execution remains non-streaming, text-only; attachments, Tools, Structured Output execution, image generation, and client-abort stop-generation stay unsupported.
- `X-Conversation-Key` is the only cross-request identity extension. No key means a new persisted `conversation_key = NULL` Conversation for every request; never infer identity from history fingerprints.
- Existing key supports both a single-user incremental request and a full-history request. A single user message is always incremental; multi-message or assistant/tool history is full.
- Full-history divergence, instructions change, uncertain checkpoint, missing/restoration-invalid URL, or multiple unsynced turns converge through REBUILD. Conversation key and local UUID stay stable.
- FRESH/REBUILD submit one Context Envelope; APPEND/RESTORE submit only a compact current-user envelope. Never replay historical user turns one by one.
- Same key is FIFO; different keys can overlap. Queued work must not acquire a Page or capture a stale SQLite snapshot before its turn.
- Sync writes use `clean | in_flight`; mark `in_flight` before the first possible ChatGPT turn write and never guess-roll it back after an unknown post-checkpoint failure.
- Persisted restore URLs must be `https://chatgpt.com` with a non-root pathname before navigation.
- Default `MAX_ACTIVE_PAGES=4`; add `PAGE_IDLE_TIMEOUT_MINUTES=30`, accepted range `1..1440`.
- Capacity-pressure eviction is LRU among non-busy affinity Pages; busy Pages are never evicted. All busy means `page_capacity_exceeded`.
- Ordinary `corepack pnpm verify` stays deterministic and must not access `chatgpt.com`.
- Real ChatGPT E2E remains explicit, uses an isolated profile, and must prove APPEND does not resend old history, restart RESTORE keeps the URL, and divergence REBUILD changes the URL.
- Do not call ChatGPT private `/backend-api`; all ChatGPT behavior stays DOM/Playwright based.
- Use repository commit convention: `<Emoji> <中文具体描述>`; do not skip hooks.

---

## Planned File Structure

### Create

- `migrations/002_add_conversation_sync_checkpoint.sql` — relational sync checkpoint columns.
- `src/context/types.ts` — canonical request/stored/plan types with no API/DB/Playwright imports.
- `src/context/canonicalize.ts` — canonical text/instruction helpers.
- `src/context/fingerprint.ts` — stable SHA-256 canonical fingerprint.
- `src/context/planner.ts` — pure `FRESH | APPEND | RESTORE | REBUILD` decision function.
- `src/conversations/request-context.ts` — Phase 4 capability validation and `NormalizedRequest` → context adapter.
- `src/conversations/conversation-queue.ts` — per-key FIFO Promise-tail queue.
- `src/conversations/page-registry.ts` — keyed Page affinity, transient leases, LRU and idle timer.
- `src/conversations/aggregate-builder.ts` — common-prefix Message identity reconciliation and final aggregate assembly.
- `src/conversations/prompts.ts` — Context Envelope and Append Envelope serialization.
- `src/conversations/errors.ts` — Phase 4 stable execution errors.
- `src/conversations/conversation-engine.ts` — orchestration and `NormalizedExecutionHandler` implementation.
- `src/chatgpt/conversation-url.ts` — safe persisted/result ChatGPT URL parsing and identity comparison.
- `tests/unit/context-canonicalize.test.ts`
- `tests/unit/context-planner.test.ts`
- `tests/unit/conversation-queue.test.ts`
- `tests/unit/conversation-page-registry.test.ts`
- `tests/unit/conversation-aggregate-builder.test.ts`
- `tests/unit/conversation-prompts.test.ts`
- `tests/unit/chatgpt-conversation-url.test.ts`
- `tests/integration/conversation-engine.test.ts`

### Modify

- `src/persistence/types.ts`
- `src/persistence/repositories/conversations.ts`
- `src/persistence/conversation-store.ts`
- `src/browser/types.ts`
- `src/browser/page-pool.ts`
- `src/chatgpt/driver.ts`
- `src/config/schema.ts`
- `src/config/index.ts`
- `src/api/errors.ts`
- `src/runtime.ts`
- `scripts/check-architecture.mjs`
- `scripts/docker-smoke.mjs`
- Docker Compose files that currently pass `MAX_ACTIVE_PAGES` into the Gateway service.
- `tests/unit/persistence-conversations-messages.test.ts`
- `tests/integration/persistence-recovery.test.ts`
- `tests/unit/page-pool.test.ts`
- `tests/unit/chatgpt-driver.test.ts`
- `tests/unit/config.test.ts`
- `tests/unit/phase3-executor.test.ts` or remove/replace Phase 3-only assertions when runtime stops using Phase3Executor.
- `tests/integration/post-routes.test.ts`
- `tests/integration/runtime-browser.test.ts`
- `tests/e2e/chatgpt-phase3.e2e.ts` — retain Phase 3 regression helper or split reusable helper.
- `tests/e2e/chatgpt-phase4.e2e.ts`
- `scripts/test-chatgpt-e2e.ts`
- `docs/api-compatibility.md`, `docs/architecture.md`, `docs/testing.md`, `docs/roadmap.md`, `docs/PROJECT_STATE.md` only when implementation facts actually change.

---

### Task 1: Add Persistent Conversation Sync Checkpoints

**Files:**
- Create: `migrations/002_add_conversation_sync_checkpoint.sql`
- Modify: `src/persistence/types.ts`
- Modify: `src/persistence/repositories/conversations.ts`
- Modify: `src/persistence/conversation-store.ts`
- Modify: `tests/unit/persistence-conversations-messages.test.ts`
- Modify: `tests/integration/persistence-recovery.test.ts`
- Test: `tests/unit/persistence-migrations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConversationSyncCheckpoint {
    status: 'clean' | 'in_flight';
    syncedMessageCount: number;
    startedAt?: number;
  }

  export interface ConversationRecord {
    // existing fields unchanged
    sync: ConversationSyncCheckpoint;
  }

  ConversationStore.markSyncInFlight(conversationId: string, startedAt: number): void;
  ```
- `ConversationStore.save()` remains the final full-aggregate transaction and persists the supplied checkpoint.

- [x] **Step 1: Write migration and mapping tests that fail against the Phase 3 schema**

Add assertions equivalent to:

```ts
expect(conversation.sync).toEqual({
  status: 'clean',
  syncedMessageCount: 0,
});
```

and after `markSyncInFlight(id, 9000)`:

```ts
expect(store.loadById(id)?.conversation.sync).toEqual({
  status: 'in_flight',
  syncedMessageCount: originalMessageCount,
  startedAt: 9000,
});
expect(store.loadById(id)?.messages).toEqual(before.messages);
```

Also extend migration tests to expect versions `[1, 2]` and checksum protection for `002`.

- [x] **Step 2: Run focused persistence tests and confirm red**

Run:

```bash
corepack pnpm exec vitest run \
  tests/unit/persistence-migrations.test.ts \
  tests/unit/persistence-conversations-messages.test.ts \
  tests/integration/persistence-recovery.test.ts
```

Expected: FAIL because sync columns/types and `markSyncInFlight` do not exist.

- [x] **Step 3: Add the exact forward-only migration**

`migrations/002_add_conversation_sync_checkpoint.sql`:

```sql
ALTER TABLE conversations
  ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (sync_status IN ('clean', 'in_flight'));

ALTER TABLE conversations
  ADD COLUMN synced_message_count INTEGER NOT NULL DEFAULT 0
  CHECK (synced_message_count >= 0);

ALTER TABLE conversations
  ADD COLUMN sync_started_at INTEGER;
```

Do not edit `001_initial.sql`.

- [x] **Step 4: Extend persistence types and repository SQL**

Map the three columns to nested `record.sync`. Add repository method:

```ts
updateSyncCheckpoint(
  conversationId: string,
  checkpoint: ConversationSyncCheckpoint,
): void;
```

Validate in TypeScript before SQL:

```ts
if (checkpoint.status === 'clean' && checkpoint.startedAt !== undefined) {
  throw new DataIntegrityError('Clean Conversation sync cannot have startedAt');
}
if (checkpoint.status === 'in_flight' && checkpoint.startedAt === undefined) {
  throw new DataIntegrityError('In-flight Conversation sync requires startedAt');
}
```

- [x] **Step 5: Add metadata-only `markSyncInFlight`**

Implement with the existing synchronous `transaction()` helper so no async work occurs inside SQLite transaction:

```ts
markSyncInFlight(conversationId: string, startedAt: number): void {
  const aggregate = this.loadById(conversationId);
  if (!aggregate) throw new DataIntegrityError(`Conversation ${conversationId} does not exist`);
  transaction(this.database, () => {
    this.repositories.conversations.updateSyncCheckpoint(conversationId, {
      status: 'in_flight',
      syncedMessageCount: aggregate.conversation.sync.syncedMessageCount,
      startedAt,
    });
  });
}
```

Keep child rows untouched.

- [x] **Step 6: Extend aggregate validation**

Reject `syncedMessageCount > aggregate.messages.length`, but deliberately do **not** require clean count to equal Message length because migrated legacy rows are allowed to load and must REBUILD later.

- [x] **Step 7: Run persistence tests green**

Run the same focused Vitest command. Expected: PASS.

- [x] **Step 8: Run typecheck for interface fallout**

```bash
corepack pnpm typecheck
```

Expected: FAIL only at existing ConversationRecord fixtures that have not yet supplied `sync`; update those fixture builders to default `{ status: 'clean', syncedMessageCount: messages.length-or-0-as-explicit-test-intent }`, then rerun to PASS.

- [x] **Step 9: Commit**

```bash
git add migrations/002_add_conversation_sync_checkpoint.sql src/persistence tests
 git commit -m "🗃️ 增加 Conversation 同步检查点"
```

2026-08-15 execution evidence: the focused persistence suite first failed on the missing `002` migration, missing sync mapping/methods and missing count validation (11 expected failures). After implementation, the same command passed 3 files / 20 tests; `corepack pnpm typecheck` then exposed three legacy fixture/build sites, which were updated with explicit clean checkpoints and rerun to PASS.

---

### Task 2: Build Pure Canonicalization and Context Planner

**Files:**
- Create: `src/context/types.ts`
- Create: `src/context/canonicalize.ts`
- Create: `src/context/fingerprint.ts`
- Create: `src/context/planner.ts`
- Create: `tests/unit/context-canonicalize.test.ts`
- Create: `tests/unit/context-planner.test.ts`

**Interfaces:**

```ts
export type ConversationRequestMode = 'incremental' | 'full';

export interface CanonicalTextMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface CanonicalInstructions {
  system: string[];
  developer: string[];
}

export interface CanonicalConversationRequest {
  instructions: CanonicalInstructions;
  messages: CanonicalTextMessage[]; // always ends in user
  mode: ConversationRequestMode;
}

export interface CanonicalStoredConversation {
  instructions: CanonicalInstructions;
  messages: CanonicalTextMessage[];
  conversationUrl?: string;
  sync: {
    status: 'clean' | 'in_flight';
    syncedMessageCount: number;
  };
}

export type RebuildReason =
  | 'checkpoint_uncertain'
  | 'checkpoint_mismatch'
  | 'instructions_changed'
  | 'history_diverged'
  | 'multiple_unsynced_turns'
  | 'conversation_url_missing';

export type ContextSyncPlan =
  | { mode: 'FRESH'; history: CanonicalTextMessage[]; currentUser: CanonicalTextMessage }
  | { mode: 'APPEND'; currentUser: CanonicalTextMessage }
  | { mode: 'RESTORE'; currentUser: CanonicalTextMessage }
  | {
      mode: 'REBUILD';
      reason: RebuildReason;
      history: CanonicalTextMessage[];
      currentUser: CanonicalTextMessage;
    };

export function planContextSync(input: {
  stored?: CanonicalStoredConversation;
  request: CanonicalConversationRequest;
  hasAffinityPage: boolean;
}): ContextSyncPlan;
```

- [x] **Step 1: Write canonicalization tests**

Cover exact behavior:

```ts
expect(canonicalizeText(['a', 'b'])).toBe('a\nb');
expect(canonicalizeInstructions([
  { role: 'developer', content: 'd1' },
  { role: 'system', content: 's1' },
  { role: 'developer', content: 'd2' },
])).toEqual({ system: ['s1'], developer: ['d1', 'd2'] });
expect(fingerprintCanonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
expect(fingerprintCanonical({ a: 1 })).toBe(fingerprintCanonical({ a: 1 }));
```

- [x] **Step 2: Write a table-driven planner test covering every approved mode/reason**

Cases must include:

```text
no stored -> FRESH
clean exact + affinity + incremental -> APPEND
clean exact + URL/no affinity -> RESTORE
full exact stored prefix + exactly one user -> APPEND/RESTORE
in_flight -> REBUILD checkpoint_uncertain
clean count mismatch -> REBUILD checkpoint_mismatch
instructions changed -> REBUILD instructions_changed
full edited history -> REBUILD history_diverged
full with user/assistant/current-user beyond stored -> REBUILD multiple_unsynced_turns
clean/no URL -> REBUILD conversation_url_missing
```

For `in_flight + incremental`, assert REBUILD history is `stored.messages.slice(0, syncedMessageCount)` and does not invent the previous uncertain turn.

- [x] **Step 3: Run the new tests red**

```bash
corepack pnpm exec vitest run tests/unit/context-canonicalize.test.ts tests/unit/context-planner.test.ts
```

Expected: FAIL because modules do not exist.

- [x] **Step 4: Implement canonical helpers without importing `api/`, `persistence/`, `chatgpt/`, or Playwright**

Use fixed-shape objects before `JSON.stringify()` and `createHash('sha256')`; do not add a dependency.

- [x] **Step 5: Implement planner with the spec priority order**

The core order must remain explicit:

```ts
if (!stored) return fresh(request);
if (stored.sync.status === 'in_flight') return rebuild('checkpoint_uncertain', confirmedPrefix(stored), request);
if (stored.sync.syncedMessageCount !== stored.messages.length) return rebuild('checkpoint_mismatch', confirmedPrefix(stored), request);
if (!stored.conversationUrl) return rebuild('conversation_url_missing', stored.messages, request);
if (!sameInstructions(stored.instructions, request.instructions)) return rebuild('instructions_changed', stored.messages, request);
// then full-history prefix/divergence logic
// then APPEND vs RESTORE by hasAffinityPage
```

For a full request, client history is authoritative on divergence. For incremental REBUILD reasons, stored confirmed prefix plus current user is authoritative.

- [x] **Step 6: Run new tests green and architecture checker**

```bash
corepack pnpm exec vitest run tests/unit/context-canonicalize.test.ts tests/unit/context-planner.test.ts
node scripts/check-architecture.mjs
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/context tests/unit/context-*.test.ts
 git commit -m "✨ 增加 Context Sync 纯规划器"
```

2026-08-15 execution evidence: both new test files first failed because the approved canonical/planner modules did not exist. The implemented pure modules then passed 2 files / 14 tests, including single-user incremental APPEND/RESTORE and all approved REBUILD reasons; `node scripts/check-architecture.mjs` also passed.

---

### Task 3: Add Phase 4 Request Adapter and Same-Key FIFO Queue

**Files:**
- Create: `src/conversations/errors.ts`
- Create: `src/conversations/request-context.ts`
- Create: `src/conversations/conversation-queue.ts`
- Create: `tests/unit/conversation-queue.test.ts`
- Create or extend: `tests/unit/phase4-request-context.test.ts`

**Interfaces:**

```ts
export type Phase4ExecutionErrorCode =
  | 'unsupported_phase4_request'
  | 'invalid_conversation_request';

export class Phase4ExecutionError extends Error {
  constructor(readonly code: Phase4ExecutionErrorCode, message: string);
}

export function toCanonicalConversationRequest(
  request: NormalizedRequest,
): CanonicalConversationRequest;

export interface ConversationQueue {
  run<T>(conversationKey: string, work: () => Promise<T>): Promise<T>;
  close(): void;
}

export function createConversationQueue(): ConversationQueue;
```

- [x] **Step 1: Write request capability tests**

Accept pure non-streaming text `user/assistant` histories. Reject each separately with `unsupported_phase4_request`:

```text
stream=true
output=image
attachments
nonempty tools
toolChoice != auto
structured output
tool message/toolCalls
non-text content part
```

Reject no trailing user / assistant-final full history with `invalid_conversation_request`.

Assert exactly one user Message is classified incremental; any multi-message accepted text request is full.

- [x] **Step 2: Write queue concurrency tests**

Use deferred Promises to assert:

```ts
expect(events).toEqual(['a1-start']);
// a2 has not started yet
releaseA1();
expect(events).toEqual(['a1-start', 'a1-end', 'a2-start']);
```

Also prove `key-a` and `key-b` both enter before either deferred Promise resolves, and a rejected first `key-a` work does not block the second.

- [x] **Step 3: Run red**

```bash
corepack pnpm exec vitest run tests/unit/phase4-request-context.test.ts tests/unit/conversation-queue.test.ts
```

Expected: FAIL because files do not exist.

- [x] **Step 4: Implement capability adapter**

Keep API knowledge here, not in `context/`. Convert accepted messages into canonical single text strings using the Task 2 helpers. Do not silently drop tool/attachment content.

- [x] **Step 5: Implement Promise-tail FIFO**

Required pattern:

```ts
const previous = tails.get(key) ?? Promise.resolve();
const start = previous.catch(() => undefined);
const current = start.then(work);
const tail = current.then(() => undefined, () => undefined);
tails.set(key, tail);
tail.finally(() => {
  if (tails.get(key) === tail) tails.delete(key);
});
return current;
```

`close()` marks the queue closed so new `run()` calls reject with a stable internal Error; already queued work drains.

- [x] **Step 6: Run green**

```bash
corepack pnpm exec vitest run tests/unit/phase4-request-context.test.ts tests/unit/conversation-queue.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/conversations/errors.ts src/conversations/request-context.ts src/conversations/conversation-queue.ts tests/unit/phase4-request-context.test.ts tests/unit/conversation-queue.test.ts
 git commit -m "✨ 增加同会话 FIFO 与 Phase 4 请求边界"
```

2026-08-15 execution evidence: the Request Adapter suite first failed on missing modules and the Queue close test failed on missing `close()`. After implementation, 2 files / 17 tests passed and `corepack pnpm typecheck` passed. The queue timing tests were adjusted to avoid assuming a one-microtask implementation detail of the approved Promise-tail pattern.

---

### Task 4: Extend PageLease and Add Conversation Page Registry

**Files:**
- Modify: `src/browser/types.ts`
- Modify: `src/browser/page-pool.ts`
- Modify: `tests/unit/page-pool.test.ts`
- Create: `src/conversations/page-registry.ts`
- Create: `tests/unit/conversation-page-registry.test.ts`

**Interfaces:**

```ts
export interface PageLease {
  readonly page: Page;
  release(): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationPageSession {
  readonly page: Page;
  complete(): Promise<void>;
  fail(): Promise<void>;
}

export interface ConversationPageRegistry {
  hasAffinity(conversationId: string): boolean;
  acquire(conversationId?: string): Promise<ConversationPageSession>;
  close(): Promise<void>;
}

export function createConversationPageRegistry(options: {
  pagePool: Pick<PagePool, 'acquire'>;
  idleTimeoutMs: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): ConversationPageRegistry;
```

- [x] **Step 1: Add PageLease terminal-state tests**

Assert:

- active `release()` returns Page to idle once.
- active `close()` closes/removes Page once.
- duplicate release/close is idempotent.
- `close()` after `release()` is a no-op and must **not** close a Page that could already be re-leased.
- `release()` after `close()` is a no-op.

- [x] **Step 2: Run PagePool test red**

```bash
corepack pnpm exec vitest run tests/unit/page-pool.test.ts
```

Expected: FAIL because `close()` is missing.

- [x] **Step 3: Implement PageLease terminal state**

Use `let state: 'active' | 'released' | 'closed' = 'active'`. Only active operations may mutate pool tracking.

- [x] **Step 4: Write Page Registry tests with fake clock/timer**

Cover:

```text
keyed successful session retains same Page
transient undefined conversationId always releases
busy affinity never evicted
capacity error + idle bindings -> oldest lastUsedAt released, acquire retried once
all busy -> page_capacity_exceeded preserved
idle deadline -> lease.close(), not release()
closed Page -> hasAffinity false on next cleanup/use
fail() -> unbind + release
registry.close() clears timer + releases all bindings
```

Tie-break equal `lastUsedAt` by `conversationId.localeCompare()`.

- [x] **Step 5: Run registry tests red**

```bash
corepack pnpm exec vitest run tests/unit/conversation-page-registry.test.ts
```

Expected: FAIL because registry does not exist.

- [x] **Step 6: Implement registry**

A keyed `acquire(id)` sets/creates `busy=true`. `complete()` sets `busy=false`, updates `lastUsedAt`, and reschedules one earliest-expiry timer. `fail()` removes binding and releases its active lease. A transient session never enters the bindings Map.

On PagePool `page_capacity_exceeded`, evict one non-busy LRU binding with `release()`, then call `pagePool.acquire()` exactly once more.

- [x] **Step 7: Run focused tests green**

```bash
corepack pnpm exec vitest run tests/unit/page-pool.test.ts tests/unit/conversation-page-registry.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/browser src/conversations/page-registry.ts tests/unit/page-pool.test.ts tests/unit/conversation-page-registry.test.ts
 git commit -m "✨ 增加 Conversation Page affinity 与回收"
```

2026-08-15 execution evidence: PagePool tests first failed because `PageLease.close()` did not exist; the new Registry test then failed because `page-registry.ts` did not exist. After implementing terminal-state leases and the one-timer Registry, the approved focused pair passed 2 files / 14 tests. Legacy partial Page-manager compatibility was adapted to the new lease terminal API; running it too produced 3 files / 21 tests, and `corepack pnpm typecheck` passed.

---

### Task 5: Split ChatGPT Fresh, Restore, and Send Operations Safely

**Files:**
- Create: `src/chatgpt/conversation-url.ts`
- Create: `tests/unit/chatgpt-conversation-url.test.ts`
- Modify: `src/chatgpt/driver.ts`
- Modify: `tests/unit/chatgpt-driver.test.ts`
- Keep: `src/chatgpt/auth.ts`, `completion.ts`, selector registry unchanged unless a test proves a needed adjustment.

**Interfaces:**

```ts
export interface SafeChatGptConversationUrl {
  href: string;
  pathname: string;
}

export function parseSafeChatGptConversationUrl(value: string): SafeChatGptConversationUrl | undefined;

export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;
  openConversation(page: Page, conversationUrl: string): Promise<'restored' | 'not_restorable'>;
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}
```

- [x] **Step 1: Write safe URL tests**

Accept:

```text
https://chatgpt.com/c/abc
https://chatgpt.com/c/abc?x=1
```

Reject before navigation:

```text
http://chatgpt.com/c/abc
https://example.com/c/abc
https://chatgpt.com/
not-a-url
```

Canonical identity compares origin + pathname and ignores query/hash.

- [x] **Step 2: Rewrite Driver unit tests around three operations**

Prove:

- `openFresh()` performs root navigation + auth/composer readiness.
- `openConversation()` on already matching pathname does not call `goto` but still probes auth/composer.
- different Page URL navigates to saved URL.
- saved URL root/foreign/invalid returns `not_restorable` without `goto`.
- final redirect to root returns `not_restorable`.
- `auth_required`, selector ambiguity/missing, and browser runtime failures remain errors, not `not_restorable`.
- `sendText()` itself never calls `goto` and preserves Phase 3 Assistant baseline/completion ownership.

- [x] **Step 3: Run Driver tests red**

```bash
corepack pnpm exec vitest run tests/unit/chatgpt-conversation-url.test.ts tests/unit/chatgpt-driver.test.ts
```

Expected: FAIL because old `sendText()` owns navigation and new methods do not exist.

- [x] **Step 4: Implement URL helper and Driver split**

Factor the existing root navigation/AuthProbe block into `openFresh`. Reuse one readiness helper from both navigation methods. Keep existing `waitForAssistantCompletion` logic in `sendText` unchanged except removing navigation/Auth setup.

Before returning a successful `conversationUrl`, validate the resulting `page.url()` with `parseSafeChatGptConversationUrl`; if invalid, throw a stable Driver error rather than persisting it.

- [x] **Step 5: Run regression tests green**

```bash
corepack pnpm exec vitest run \
  tests/unit/chatgpt-conversation-url.test.ts \
  tests/unit/chatgpt-driver.test.ts \
  tests/unit/chatgpt-auth.test.ts \
  tests/unit/chatgpt-completion.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/chatgpt tests/unit/chatgpt-*.test.ts
 git commit -m "♻️ 拆分 ChatGPT Fresh 与会话恢复驱动"
```

2026-08-15 execution evidence: the new URL suite failed because `conversation-url.ts` did not exist and all 14 rewritten Driver tests failed against the old target-owning Driver. After splitting navigation/readiness from submission, the approved Driver/URL/Auth/Completion regression plus Phase 3 Executor and legacy partial Conversation regression passed 7 files / 56 tests; `corepack pnpm typecheck` passed. A deprecated optional `target` field is temporarily retained only for legacy executor test compatibility; the real Driver ignores it and all navigation is now exclusively `openFresh/openConversation`.

---

### Task 6: Add Context/Append Prompts and Aggregate Reconciliation

**Files:**
- Create: `src/conversations/prompts.ts`
- Create: `tests/unit/conversation-prompts.test.ts`
- Create: `src/conversations/aggregate-builder.ts`
- Create: `tests/unit/conversation-aggregate-builder.test.ts`

**Interfaces:**

```ts
export function buildContextPrompt(input: {
  instructions: CanonicalInstructions;
  history: CanonicalTextMessage[];
  currentUser: CanonicalTextMessage;
}): string;

export function buildAppendPrompt(currentUser: CanonicalTextMessage): string;

export function buildFinalConversationAggregate(input: {
  stored?: ConversationAggregate;
  conversation: ConversationRecord;
  authoritativeMessages: CanonicalTextMessage[]; // includes current user, excludes new assistant
  assistantText: string;
  conversationUrl: string;
  completedAt: number;
}): ConversationAggregate;
```

- [x] **Step 1: Write prompt serialization tests**

Use malicious-looking text containing quotes, `</json>`, newlines, and braces. Parse the substring after the stable prelude with `JSON.parse()` and assert exact recovery.

Context payload must be exactly:

```ts
{
  version: 1,
  instructions: { system: [...], developer: [...] },
  history: [...],
  current_user: { text: '...' },
}
```

Append payload must contain only `version` and `current_user`; assert it does not contain old-history tokens or `instructions`.

- [x] **Step 2: Write aggregate reconciliation tests**

Given stored `u1/a1/u2/a2`, assert:

- instructions-only REBUILD reuses all four existing Message IDs.
- full divergence at `a1` reuses only `u1`, generates new IDs for changed suffix/current/assistant.
- APPEND reuses all stored IDs and appends two new UUID v4 records.
- final checkpoint is `{ status: 'clean', syncedMessageCount: messages.length }` with no `startedAt`.
- final Conversation URL is the validated result URL.

- [x] **Step 3: Run red**

```bash
corepack pnpm exec vitest run tests/unit/conversation-prompts.test.ts tests/unit/conversation-aggregate-builder.test.ts
```

Expected: FAIL because modules do not exist.

- [x] **Step 4: Implement prompts with `JSON.stringify()` only**

Use stable fixed prelude strings. Do not hand-escape user content and do not claim prompt-level role separation is a security boundary.

- [x] **Step 5: Implement longest-common-prefix reconciliation**

Compare canonical role/text. Reuse exact-prefix stored records, then generate `randomUUID()` for the authoritative suffix and generated Assistant. Normalize stored Phase 4 content to one text part.

- [x] **Step 6: Run green**

```bash
corepack pnpm exec vitest run tests/unit/conversation-prompts.test.ts tests/unit/conversation-aggregate-builder.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/conversations/prompts.ts src/conversations/aggregate-builder.ts tests/unit/conversation-prompts.test.ts tests/unit/conversation-aggregate-builder.test.ts
 git commit -m "✨ 增加 Conversation 重建与 Prompt 封装"
```

2026-08-15 execution evidence: both approved tests first failed because the new modules did not exist. After implementing versioned JSON-only Context/Append envelopes and canonical longest-common-prefix Message reconciliation, 2 files / 5 tests passed and `corepack pnpm typecheck` passed.

---

### Task 7: Implement Conversation Engine FRESH and APPEND

**Files:**
- Create: `src/conversations/conversation-engine.ts`
- Create: `tests/integration/conversation-engine.test.ts`
- Modify as needed: `src/conversations/types.ts` if a focused public internal type file is required.

**Interfaces:**

```ts
export interface CreateConversationEngineOptions {
  pageRegistry: ConversationPageRegistry;
  queue: ConversationQueue;
  driver: ChatGptTextDriver;
  conversationStore: ConversationStore;
  now?: () => number;
  randomUuid?: () => string;
}

export function createConversationEngine(
  options: CreateConversationEngineOptions,
): NormalizedExecutionHandler;
```

- [x] **Step 1: Build a fake Driver/Page integration harness**

The fake Driver records calls:

```ts
calls.push({ type: 'openFresh', pageId });
calls.push({ type: 'openConversation', url });
calls.push({ type: 'sendText', prompt });
```

and returns deterministic Assistant text and conversation URLs.

Use a real temporary SQLite DB/PersistenceContext, not an in-memory fake Store.

- [x] **Step 2: Write first-key FRESH integration test**

POST-level or Engine-level input with `conversationKey='thread-1'`, one user Message. Assert:

```text
openFresh exactly once
send Context Envelope exactly once
no openConversation
saved key thread-1
saved messages = user + assistant
saved URL is fake /c/one
sync clean/count=2
keyed Page session complete() retains affinity
```

- [x] **Step 3: Write keyed APPEND tests for both client styles**

Case A full history:

```text
request = stored u1/a1 + new u2
```

Case B incremental:

```text
request = [u2]
```

For both, assert the second prompt is Append Envelope and does not include a unique token from `u1` or `a1`.

- [x] **Step 4: Run red**

```bash
corepack pnpm exec vitest run tests/integration/conversation-engine.test.ts
```

Expected: FAIL because Conversation Engine does not exist.

- [x] **Step 5: Implement keyed queue/load/plan/page preparation**

Inside `queue.run(key, async () => ...)`, load `conversationStore.loadByKey(key)` **after** entering the queue. Build canonical stored state and call Planner.

For a new Conversation, create/save a minimal in-flight aggregate only after `openFresh()` succeeds and immediately before `sendText()`.

For an existing APPEND, call `openConversation(savedUrl)` on the affinity Page, then `markSyncInFlight()` immediately before `sendText()`.

- [x] **Step 6: Implement final success commit**

Use `buildFinalConversationAggregate()` and one `conversationStore.save(finalAggregate)`, then `pageSession.complete()`.

On any error after acquiring a session, call `pageSession.fail()` in `catch/finally` without modifying an already in-flight checkpoint back to clean.

- [x] **Step 7: Implement unkeyed FRESH persistence**

Do not enter `ConversationQueue`. Create a new `conversation_key = undefined` aggregate, run FRESH, save complete data, and ensure the transient Page session releases instead of retaining affinity.

- [x] **Step 8: Run FRESH/APPEND tests green**

```bash
corepack pnpm exec vitest run tests/integration/conversation-engine.test.ts
```

Expected: FRESH, full-history APPEND, incremental APPEND, and unkeyed persistence cases PASS.

- [x] **Step 9: Commit**

```bash
git add src/conversations/conversation-engine.ts tests/integration/conversation-engine.test.ts
 git commit -m "✨ 接入 Conversation FRESH 与 APPEND"
```

2026-08-15 execution evidence: the integration file first failed because the new Engine module did not exist. The first implementation produced one test failure because the test's full-history fixture did not match the actually persisted tokenized history; after correcting that test input, the Engine suite passed 1 file / 4 tests and `corepack pnpm typecheck` passed. The tests observe real temporary SQLite state at `sendText()`: new FRESH is already `in_flight/count=0`, existing APPEND is `in_flight` with the old confirmed count, success atomically becomes clean, and unkeyed requests persist a NULL-key aggregate without using the keyed queue.

---

### Task 8: Add RESTORE, REBUILD, and Crash-Convergence Paths

**Files:**
- Modify: `src/conversations/conversation-engine.ts`
- Modify: `tests/integration/conversation-engine.test.ts`

**Interfaces:**
- Consumes Task 2 Planner reasons and Task 5 `openConversation()` result.
- Produces no new public API; completes the four-mode engine.

- [x] **Step 1: Add RESTORE test**

Persist a clean Conversation with URL but start a fresh Page Registry with no affinity. Assert:

```text
plan/effect uses openConversation(savedUrl)
openFresh not called
Append Envelope sent
final URL unchanged
```

- [x] **Step 2: Add `not_restorable → REBUILD` test**

Fake `openConversation()` returns `'not_restorable'`. Assert same request then calls `openFresh()`, sends Context Envelope containing confirmed history + current user, and saves a new URL while key/Conversation UUID remain unchanged.

- [x] **Step 3: Add full divergence and instructions-change REBUILD tests**

Full divergence must use request history as authoritative. Incremental instructions change must use stored confirmed history + current user with the new instructions.

- [x] **Step 4: Add checkpoint uncertainty tests**

Persist:

```ts
sync: { status: 'in_flight', syncedMessageCount: 2, startedAt: 123 }
```

with two confirmed Messages. Send incremental `u2`; assert `openFresh()` and Context Envelope history includes only those two confirmed Messages.

Also persist clean `syncedMessageCount < messages.length`; assert the same REBUILD safety behavior.

- [x] **Step 5: Add post-checkpoint failure test**

Configure fake Driver `sendText()` to throw after Engine calls `markSyncInFlight`. Assert response rejects and reopened SQLite state is still `in_flight`; no Assistant row was fabricated.

- [x] **Step 6: Run red then implement the missing branches**

Run:

```bash
corepack pnpm exec vitest run tests/integration/conversation-engine.test.ts
```

Expected initially: new RESTORE/REBUILD cases FAIL. Implement explicit branches; do not use a catch-all rebuild around Driver errors.

- [x] **Step 7: Run green**

Run the same test file. Expected: all four modes and crash convergence PASS.

- [x] **Step 8: Commit**

```bash
git add src/conversations/conversation-engine.ts tests/integration/conversation-engine.test.ts
 git commit -m "✨ 接入 RESTORE 与 REBUILD 恢复"
```

2026-08-15 execution evidence: after adding all approved recovery/crash cases, 10 of 11 tests passed immediately; the sole red case was the missing `not_restorable → Fresh REBUILD` branch. Implementing only that explicit status branch (without catching auth/selector/browser errors) plus authoritative context-history selection produced 1 file / 11 passing tests and `corepack pnpm typecheck` passed. The post-checkpoint failure test closes and reopens the real SQLite database and proves the row remains `in_flight` with no fabricated Assistant.

---

### Task 9: Wire Phase 4 Errors, Config, Runtime, and HTTP Routes

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/index.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `src/api/errors.ts`
- Modify: `tests/unit/response-encoders.test.ts` or add focused API error tests.
- Modify: `src/runtime.ts`
- Modify: `tests/integration/runtime-browser.test.ts`
- Modify: `tests/integration/post-routes.test.ts`
- Update/remove runtime use of: `src/conversations/phase3-executor.ts`

**Interfaces:**

```ts
AppConfig.pageIdleTimeoutMinutes: number;
```

`gatewayErrorFromExecution()` must map per-code HTTP status **and** OpenAI error type.

- [x] **Step 1: Add config tests**

Assert default `30`, explicit `1` and `1440`, reject `0`, `1441`, non-integer.

- [x] **Step 2: Add error mapping tests**

Expected mappings:

```ts
unsupported_phase4_request -> 501 / server_error
invalid_conversation_request -> 400 / invalid_request_error
```

Keep all existing Browser/Driver mappings unchanged.

- [x] **Step 3: Add runtime integration expectations**

Headless runtime must create Page Registry + Queue + Conversation Engine using `persistence.conversationStore`; maintenance mode must still use `browserMaintenanceModeExecution` and never create product BrowserManager/Engine browser work.

Shutdown expectation:

```text
app.close
→ queue/registry close
→ browser close
→ persistence close
```

- [x] **Step 4: Run focused tests red**

```bash
corepack pnpm exec vitest run \
  tests/unit/config.test.ts \
  tests/integration/runtime-browser.test.ts \
  tests/integration/post-routes.test.ts
```

Expected: FAIL on missing config/Engine behavior.

- [x] **Step 5: Implement config and API mapping**

Parse:

```ts
pageIdleTimeoutMinutes: parseInteger(
  'PAGE_IDLE_TIMEOUT_MINUTES',
  env.PAGE_IDLE_TIMEOUT_MINUTES,
  30,
  1,
  1440,
),
```

Change the execution error map entries to carry `type`, rather than hard-coding `server_error` for every execution error.

- [x] **Step 6: Replace production Phase3Executor wiring**

Headless runtime constructs:

```text
createConversationQueue()
createConversationPageRegistry({ pagePool: browser.pages, idleTimeoutMs: config.pageIdleTimeoutMinutes * 60_000 })
createConversationEngine({ queue, pageRegistry, driver, conversationStore: persistence.conversationStore })
```

Keep `phase3-executor.ts` only if still used by an isolated regression test; otherwise remove it and replace its tests with Phase 4 capability tests. Do not leave dead production wiring.

- [x] **Step 7: Run focused tests green**

Run the Step 4 command; expected PASS.

- [x] **Step 8: Run all deterministic tests once**

```bash
corepack pnpm test
```

Expected: PASS, no network access.

- [x] **Step 9: Commit**

```bash
git add src/config src/api/errors.ts src/runtime.ts src/conversations tests/unit tests/integration
 git commit -m "✨ 接入 Phase 4 Conversation Runtime"
```

2026-08-15 execution evidence: focused Task 9 tests first failed only on the missing `invalid_conversation_request` public mapping and old runtime composition. After switching runtime to Queue + Page Registry + Conversation Engine and making execution error entries carry their own OpenAI error type, the focused suite passed 3 files / 30 tests. The first full deterministic run exposed only stale regression assertions against the removed Driver `target` navigation surface plus a Phase 2-only migration expectation; after moving those assertions to `openFresh/openConversation` and expecting migrations 001+002, `corepack pnpm test` passed 41 files / 248 tests and `corepack pnpm typecheck` passed.

---

### Task 10: Prove FIFO, Parallel Keys, LRU, Restart, and Cross-Protocol Semantics End-to-End Locally

**Files:**
- Modify: `tests/integration/conversation-engine.test.ts`
- Modify: `tests/integration/persistence-recovery.test.ts`
- Modify: `tests/integration/post-routes.test.ts`
- Modify: `tests/integration/runtime-browser.test.ts`

**Interfaces:**
- No new production interface unless a test exposes an actual missing seam.

- [x] **Step 1: Add same-key HTTP/Engine concurrency test**

Use deferred fake Driver. Fire two same-key requests without awaiting the first. Prove the second Driver call does not start until the first success has committed; then prove the second planner sees the first Assistant in Store.

- [x] **Step 2: Add different-key parallelism test**

With capacity ≥2, fire `key-a` and `key-b`; prove both fake Driver sends start before either is released.

- [x] **Step 3: Add capacity-pressure test**

With Page capacity 2, complete A and B so both hold idle affinities, then start C. Assert A (oldest `lastUsedAt`) is released/reused and B remains bound. Then make A/B both busy and assert C gets `page_capacity_exceeded`.

- [x] **Step 4: Add real SQLite close/reopen RESTORE integration**

Run first request, close Persistence/Engine runtime objects, reopen the same temporary DB, create a fresh Registry, send incremental request, and assert fake Driver receives saved URL through `openConversation()`.

- [x] **Step 5: Add Chat Completions ↔ Responses parity test with same key**

Start with one protocol, continue with the other using canonical-equivalent history/incremental input. Assert both route adapters hit the same persisted Conversation and Engine rather than creating protocol-specific browser logic.

- [x] **Step 6: Run the integration group**

```bash
corepack pnpm exec vitest run tests/integration
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add tests/integration
 git commit -m "🧪 补充 Context Sync 并发与重启测试"
```

2026-08-15 execution evidence: the existing HTTP integration was strengthened so a second same-key request is already queued as single-user incremental before the first completes; when it reaches the Driver it observes the first Assistant in SQLite and sends only the new turn. Restart continuation was also changed to single-user incremental. A new PagePool+Registry integration proves capacity-2 LRU reuse and busy protection, and a Chat Completions → Responses test proves protocol adapters share one persisted Conversation. The complete integration group passed 8 files / 53 tests without requiring new production seams.

---

### Task 11: Enforce Architecture and Extend Docker Smoke for Phase 4 State

**Files:**
- Modify: `scripts/check-architecture.mjs`
- Modify: `scripts/docker-smoke.mjs`
- Modify: Docker Compose file(s) carrying Gateway environment.
- Verify: `.env.example` already contains `PAGE_IDLE_TIMEOUT_MINUTES=30`; change only if implementation needs formatting/comment alignment.

**Interfaces:**
- Architecture checker rules from governing spec §29.
- Container environment passes `PAGE_IDLE_TIMEOUT_MINUTES` into Gateway.

- [x] **Step 1: Add architecture-check failure fixtures/rules**

Checker must reject:

```text
context/ -> api/
context/ -> persistence/
context/ -> chatgpt/
context/ -> playwright
browser/ -> conversations/
chatgpt/ -> conversations/page-registry or conversation-engine
```

Keep existing selector/process.env/node:sqlite checks.

- [x] **Step 2: Run architecture checker**

```bash
node scripts/check-architecture.mjs
```

Expected before rule implementation: command may pass without enforcing new cases; after adding rules it must pass current valid source tree.

- [x] **Step 3: Extend Docker environment and smoke assertions**

Pass:

```yaml
PAGE_IDLE_TIMEOUT_MINUTES: ${PAGE_IDLE_TIMEOUT_MINUTES:-30}
```

After container startup, verify database migration history contains exactly `001_initial` and `002_add_conversation_sync_checkpoint`, and `conversations` has the three checkpoint columns.

Keep all existing Xvfb/Chromium/noVNC/sandbox/Profile single-owner checks.

- [x] **Step 4: Run repository deterministic verification**

```bash
corepack pnpm verify
```

Expected: PASS.

- [x] **Step 5: Build and run fresh Docker smoke**

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS on `linux/amd64`; smoke remains network-independent and does not contact ChatGPT.

- [x] **Step 6: Commit**

```bash
git add scripts docker-compose*.yml .env.example
 git commit -m "🐳 验证 Phase 4 Conversation 持久化运行边界"
```

2026-08-15 execution evidence: architecture import rules were extracted into a unit-testable rule module; the synthetic rule suite first failed because that module did not exist, then passed together with the real source-tree architecture checker. After applying repository formatting and one test-only lint/type declaration fix, `corepack pnpm verify` passed 43 test files / 271 tests plus format/lint/typecheck/build/governance. Fresh `linux/amd64` image `sha256:d31206e5d39b5493d11563fc034fb30c0f9f5909d0454162cdc2c3d645f867a1` built successfully; Docker smoke passed while explicitly validating migration history 001+002, all three Conversation checkpoint columns, non-default `PAGE_IDLE_TIMEOUT_MINUTES=12`, and all existing normal/maintenance non-root/Profile/sandbox/seccomp/RFB/restart boundaries.

---

### Task 12: Add Explicit Real ChatGPT Phase 4 E2E

**Files:**
- Create: `tests/e2e/chatgpt-phase4.e2e.ts`
- Modify: `scripts/test-chatgpt-e2e.ts`
- Reuse: `tests/e2e/environment.ts`
- Reuse/modify carefully: `tests/e2e/chatgpt-phase3.e2e.ts`

**Interfaces:**

```ts
export interface Phase4ChatGptE2EResult {
  append: true;
  restore: true;
  rebuild: true;
}
```

- [x] **Step 1: Keep the E2E safety gate red/green locally without network**

Extend unit tests around the E2E CLI so Phase 4 still requires:

```text
E2E_CHATGPT=1
explicit non-production CHATGPT_PROFILE_DIR
optional validated CHATGPT_PROXY_SERVER
```

Ordinary `corepack pnpm verify` must skip real access.

- [x] **Step 2: Implement keyed FRESH + full-history APPEND challenge**

Use random key/token A/token B. First HTTP request establishes a Conversation. Read SQLite aggregate and capture URL.

Second request sends exact returned `user1 + assistant1 + user2`. Assert:

```text
HTTP 200
same persisted URL
second Web user turn contains token B
second Web user turn does NOT contain token A
```

Read the live user-turn collection through centralized selectors; do not save DOM by default.

- [x] **Step 3: Implement runtime restart RESTORE challenge**

Close runtime, keep the same temp data dir and E2E Profile, recreate runtime, then send only one incremental user Message asking for a value established earlier. Assert answer is correct and persisted URL remains exactly the prior URL.

- [x] **Step 4: Implement divergence REBUILD challenge**

Send a full request with an intentionally modified prior history plus new user. Assert:

```text
HTTP 200
local Conversation key unchanged
local Conversation UUID unchanged
new persisted ChatGPT URL != old URL
answer follows modified history challenge
```

- [x] **Step 5: Run deterministic verify before external E2E**

```bash
corepack pnpm verify
```

Expected: PASS.

- [!] **Step 6: Run explicit real E2E using the already authenticated isolated profile**

Use the environment appropriate to the actual DevSpace/NAS path, preserving the existing proxy requirement where direct network is unavailable:

```bash
E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/absolute/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://192.168.3.163:7890 \
corepack pnpm test:e2e:chatgpt
```

Expected: Phase 3 regression plus Phase 4 `append=true`, `restore=true`, `rebuild=true`.

If authentication/Cloudflare/current DOM blocks this command, stop and record the real blocker in `PROJECT_STATE`; do not mark Phase 4 complete.

- [x] **Step 7: Commit the E2E harness after successful deterministic tests**

```bash
git add tests/e2e scripts/test-chatgpt-e2e.ts tests/unit
 git commit -m "🧪 增加 Phase 4 Conversation 真实 E2E"
```

2026-08-15 execution evidence: the E2E safety gate remains explicit; both real commands reject execution without `E2E_CHATGPT=1`, and the gate/profile unit suite passes 2 files / 5 tests including isolated Profile and credential-bearing proxy rejection. The Phase 4 harness now verifies full-history APPEND via live centralized user-turn selectors (marker B present, original token A absent), restart with a single-user incremental RESTORE, and divergence REBUILD while preserving local key/UUID and requiring a new ChatGPT URL. `corepack pnpm verify` passed 43 files / 271 tests before external access. The combined real command using `/tmp/cwg-phase3-e2e-data/e2e-browser-profile` and proxy `http://192.168.3.163:7890` stopped in the Phase 3 regression with `Expected authenticated, got auth_required`; standalone Phase 4 then independently reached Gateway turn 1 and returned HTTP 503 `auth_required`. The isolated Profile login has expired, so APPEND/RESTORE/REBUILD real DOM behavior could not be exercised. Per spec, Task 12 remains blocked and Phase 4 must not be marked complete until manual re-authentication followed by rerunning the explicit real command succeeds.

---

### Task 13: Final Documentation, Project Memory, and Completion Verification

**Files:**
- Modify: `docs/api-compatibility.md`
- Modify: `docs/architecture.md`
- Modify: `docs/testing.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/PROJECT_STATE.md`
- Review: `README.md` and change only if user-visible configuration/usage text is actually affected.
- Update this plan checkboxes as Tasks complete.

**Interfaces:**
- `PROJECT_STATE` is the final current-fact source.

- [x] **Step 1: Update API compatibility only to implemented truth**

After real Phase 4 E2E passes, change current implementation from Fresh-only to:

```text
non-stream text
keyed full-history/incremental
APPEND
RESTORE
REBUILD
```

Keep Streaming/attachments/Tools/Structured Output/image generation explicitly unimplemented.

- [x] **Step 2: Update project state machine fields**

Successful final state:

```text
PHASE=phase-4-complete
STATUS=ready-for-phase-5-design
GOVERNING_SPEC=docs/superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md
ACTIVE_PLAN=none
NEXT_TASK=write-phase-5-streaming-spec
```

If real E2E is blocked, instead keep Phase 4 implementation active and record the precise blocker; do not use the success state above.

- [x] **Step 3: Run complete deterministic verification fresh**

```bash
corepack pnpm verify
```

Expected: PASS with zero test failures.

- [x] **Step 4: Run fresh Docker build/smoke after final code/docs state**

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS.

- [x] **Step 5: Re-run real Phase 4 E2E if any post-E2E code affecting Browser/Conversation behavior changed**

Use the explicit command from Task 12. If only prose changed, do not create unnecessary external ChatGPT turns.

2026-08-16 blocking-state finalization evidence: public/state/architecture/testing/roadmap/README prose was updated to distinguish "Phase 4 implementation complete" from "real ChatGPT four-mode E2E not accepted". A fresh `corepack pnpm verify` passed 43 test files / 272 tests plus format/lint/typecheck/build/governance. A fresh `linux/amd64` build reproduced image `sha256:d31206e5d39b5493d11563fc034fb30c0f9f5909d0454162cdc2c3d645f867a1`, and `corepack pnpm docker:smoke` passed. No Browser/Conversation product code changed after the blocked real E2E run, so Step 5 correctly avoids generating redundant external ChatGPT turns; the recorded `auth_required` blocker remains the current external fact.

- [x] **Step 6: Run Git/repository hygiene checks**

```bash
git status --short --branch
git diff --check
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
node scripts/check-version.mjs
```

Inspect staged diff and verify no Profile, Cookie, SQLite DB, diagnostic HTML/screenshot, generated image, or real uploaded file is staged.

2026-08-16 hygiene evidence: `git diff --check` passed; project-memory/docs/architecture/version checks all passed. The writeback diff contains only README/project documentation/active plan files. Filename and diff-content scans found no Profile, Cookie, SQLite DB, diagnostic artifact, generated/uploaded data or real credentials; the only credential-like text is the documented placeholder `Authorization: Bearer <GATEWAY_API_KEY>`.

- [x] **Step 7: Commit final writeback**

```bash
git add docs README.md
 git commit -m "📝 完成 Phase 4 Conversation Sync 验收回写"
```

- [x] **Step 8: Push the feature branch without force**

```bash
git push -u origin phase-4-context-sync
```

Expected: fast-forward/new-branch push succeeds; do not create a Release or Docker registry image unless explicitly requested.

2026-08-16 Git completion evidence: final blocking-state writeback committed as `644736a` (`📝 回写 Phase 4 认证阻塞验收状态`). A fresh fetch showed the local branch 0 commits behind / 26 commits ahead of `origin/phase-4-context-sync`; `git push -u origin phase-4-context-sync` then fast-forwarded the remote from `4c6eaf8` to `644736a` without force. No Release or registry image was published.

---

## Plan Self-Review Checklist

Before implementation starts, verify the plan against the governing spec:

- [x] Every spec acceptance criterion maps to at least one Task above.
- [x] No task introduces attachments, Tools, Streaming, Structured Output execution, images, multi-process locking, or private ChatGPT APIs.
- [x] `context/` stays API/DB/Playwright-free.
- [x] Page Pool stays Conversation-unaware; affinity/LRU stays in `conversations/`.
- [x] Unknown post-checkpoint failure remains `in_flight`; no rollback guessing exists.
- [x] Real E2E is explicit and separate from `verify`.
- [x] Final docs cannot mark Phase 4 complete unless real APPEND + restart RESTORE + divergence REBUILD have passed.
