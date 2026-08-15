# Phase 4 Conversation + Context Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement durable keyed multi-turn Conversation execution with pure Context Sync planning, same-key serialization, warm Page affinity, idle Page reclaim, URL restore and rebuild recovery while preserving Phase 3 browser/auth behavior.

**Architecture:** A pure planner under `src/context/` decides `FRESH | APPEND | RESTORE | REBUILD` from normalized caller history plus the last successful SQLite snapshot. A keyed queue and Conversation Page manager under `src/conversations/` serialize one Conversation, retain warm Page leases and reclaim idle Pages, while a new Conversation executor coordinates Driver navigation targets, persistence and RESTORE→REBUILD fallback. Unkeyed requests remain ephemeral Fresh executions.

**Tech Stack:** Node 24, TypeScript, Fastify, TypeBox/Ajv, `node:sqlite`, Playwright 1.62.1, Vitest, Docker/Compose.

## Global Constraints

- SQLite remains the durable Conversation source of truth; no Phase 4 database migration is required.
- `X-Conversation-Key` is the only durable Conversation identity input; absent key means ephemeral Fresh execution and no Conversation row.
- Same Conversation requests serialize; different Conversation keys do not share a global lock.
- Context Sync planning is pure and has no Playwright/SQLite/clock dependency.
- Only `FRESH | APPEND | RESTORE | REBUILD` are valid sync modes.
- Phase 4 remains non-streaming, text-only, attachment-free, tool-free, structured-output-free and image-output-free.
- `MAX_ACTIVE_PAGES=4` remains the default Page Pool capacity.
- `PAGE_IDLE_TIMEOUT_MINUTES=30` becomes an active runtime setting.
- ChatGPT selectors stay centralized in `src/chatgpt/selectors.ts`.
- Real ChatGPT E2E remains explicit and separate from deterministic `corepack pnpm verify`.
- Production behavior changes use failing test → observed expected failure → minimal implementation → green verification.

---

### Task 1: Activate idle-timeout config and explicit Page discard

**Files:**
- Modify: `tests/unit/config.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/index.ts`
- Modify: `tests/unit/page-pool.test.ts`
- Modify: `src/browser/types.ts`
- Modify: `src/browser/page-pool.ts`
- Modify: `compose.yaml`

**Interfaces:**
- Produces: `AppConfig.pageIdleTimeoutMinutes: number`.
- Produces: `PageLease.release(options?: { discard?: boolean }): Promise<void>`.
- Existing no-argument `release()` behavior remains compatible.
- Later Page-affinity code consumes explicit discard to make idle reclaim reduce `PagePool.openCount`.

- [x] **Step 1: Add failing config tests**

Add assertions that the default config includes `pageIdleTimeoutMinutes: 30`, an explicit `PAGE_IDLE_TIMEOUT_MINUTES: '12'` becomes `12`, and `0` / values above `1440` are rejected.

- [x] **Step 2: Run the config test and confirm RED**

Run:

```bash
corepack pnpm vitest run tests/unit/config.test.ts
```

Expected failure: returned config has no `pageIdleTimeoutMinutes`.

- [x] **Step 3: Implement the config field**

Add to `AppConfigSchema`:

```ts
pageIdleTimeoutMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
```

Add to `loadConfig()`:

```ts
pageIdleTimeoutMinutes: parseInteger(
  'PAGE_IDLE_TIMEOUT_MINUTES',
  env.PAGE_IDLE_TIMEOUT_MINUTES,
  30,
  1,
  1440,
),
```

Pass through Compose:

```yaml
PAGE_IDLE_TIMEOUT_MINUTES: ${PAGE_IDLE_TIMEOUT_MINUTES:-30}
```

- [x] **Step 4: Re-run the config test and confirm GREEN**

Run the same Vitest command and require PASS.

- [x] **Step 5: Add a failing Page Pool discard test**

Extend `tests/unit/page-pool.test.ts` with a case that acquires a Page, calls:

```ts
await lease.release({ discard: true });
```

and asserts the fake Page was closed and `openCount`, `leasedCount`, `idleCount` are all zero. Call release again and require idempotence.

- [x] **Step 6: Run the Page Pool test and confirm RED**

Run:

```bash
corepack pnpm vitest run tests/unit/page-pool.test.ts
```

Expected failure: current `release()` does not accept/perform discard.

- [x] **Step 7: Implement explicit discard**

Change the lease type to:

```ts
export interface PageLeaseReleaseOptions {
  discard?: boolean;
}

export interface PageLease {
  readonly page: Page;
  release(options?: PageLeaseReleaseOptions): Promise<void>;
}
```

When `discard` is true, remove the Page from pool tracking and close it if it is still open instead of returning it to the idle set.

- [x] **Step 8: Run Task 1 tests and typecheck**

```bash
corepack pnpm vitest run tests/unit/config.test.ts tests/unit/page-pool.test.ts
corepack pnpm typecheck
```

- [x] **Step 9: Update this plan checkbox state and commit**

```bash
git add src/config src/browser tests/unit/config.test.ts tests/unit/page-pool.test.ts compose.yaml docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 激活 Page idle 配置与租约回收"
```

---

### Task 2: Implement pure Context Sync planning and Phase 4 prompt mapping

**Files:**
- Create: `src/context/sync.ts`
- Create: `tests/unit/context-sync.test.ts`
- Create: `src/conversations/phase4-request.ts`
- Create: `tests/unit/phase4-request.test.ts`

**Interfaces:**
- Produces: `ContextSyncMode`, `ContextSyncPlan`, `planContextSync()`.
- Produces: `validatePhase4Request()`, `buildFullContextPrompt()`, `buildAppendPrompt()`.
- Planner consumes only normalized semantic data plus persisted semantic snapshot and `hasWarmPage`.
- Executor in Task 5 consumes these functions without re-implementing equality or capability checks.

- [x] **Step 1: Write failing planner tests**

Cover these exact cases:

```text
no persisted snapshot                                      → FRESH
same instructions + stored prefix + one new user + warm   → APPEND
same prefix + one new user + no warm + URL                → RESTORE
same prefix + one new user + no warm + no URL             → REBUILD
changed instruction                                       → REBUILD
edited prior user/assistant message                       → REBUILD
rolled-back/forked history                                 → REBUILD
more than one unsynchronized message                      → REBUILD
```

Also prove that two semantically equal normalized message arrays compare equal independent of persistence ids/timestamps by keeping those values outside planner inputs.

- [x] **Step 2: Run planner tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/context-sync.test.ts
```

Expected failure: module/functions do not exist.

- [x] **Step 3: Implement the pure planner**

Use public types equivalent to:

```ts
export type ContextSyncMode = 'FRESH' | 'APPEND' | 'RESTORE' | 'REBUILD';

export interface PersistedContextSnapshot {
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  conversationUrl?: string;
}

export interface ContextSyncPlan {
  mode: ContextSyncMode;
  appendMessages: NormalizedMessage[];
}

export function planContextSync(options: {
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  persisted?: PersistedContextSnapshot;
  hasWarmPage: boolean;
}): ContextSyncPlan;
```

Implement explicit semantic equality for instructions, roles, ordered content parts, `toolCallId` and `toolCalls`; do not compare JSON persistence text, request ids or timestamps.

- [x] **Step 4: Run planner tests and confirm GREEN**

Run the Task 2 planner test command and require PASS.

- [x] **Step 5: Write failing Phase 4 request/prompt tests**

Prove:

- a request ending in one non-empty user text turn is accepted;
- assistant text history before the final user is accepted;
- stream/image/attachments/tools/structured output/tool messages/tool calls/non-text content are rejected with code `unsupported_phase4_request`;
- a request ending in assistant or blank user text is rejected with the same stable Phase 4 capability code;
- full prompt uses `JSON.stringify()` and includes all normalized system/developer instructions and ordered text messages;
- append prompt contains only the one new user turn and not old assistant/history text.

- [x] **Step 6: Run prompt tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/phase4-request.test.ts
```

Expected failure: Phase 4 request module is missing.

- [x] **Step 7: Implement validation and prompt builders**

Define:

```ts
export class Phase4ExecutionError extends Error {
  readonly code = 'unsupported_phase4_request';
}
```

Keep full and append prompt templates exactly centralized in this module. Convert each text-only normalized message to `{ role, text }`; never concatenate unescaped JSON manually.

- [x] **Step 8: Run Task 2 tests and typecheck**

```bash
corepack pnpm vitest run tests/unit/context-sync.test.ts tests/unit/phase4-request.test.ts
corepack pnpm typecheck
```

- [x] **Step 9: Update plan and commit**

```bash
git add src/context src/conversations/phase4-request.ts tests/unit/context-sync.test.ts tests/unit/phase4-request.test.ts docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 新增四态 Context Sync 纯规划器"
```

---

### Task 3: Add same-key queue and Conversation Page affinity manager

**Files:**
- Create: `src/conversations/conversation-queue.ts`
- Create: `tests/unit/conversation-queue.test.ts`
- Create: `src/conversations/conversation-pages.ts`
- Create: `tests/unit/conversation-pages.test.ts`

**Interfaces:**
- Produces: `ConversationQueue.run<T>(conversationKey, task)`.
- Produces: `createConversationPageManager({ pagePool, idleTimeoutMs, now, setInterval, clearInterval })`.
- Produces lease `{ page, reused, release({ discard? }) }`.
- Page manager retains underlying Page Pool leases only for keyed Conversations.

- [x] **Step 1: Write failing queue tests**

Use deferred promises to prove:

1. two tasks under `alpha` never overlap and preserve arrival order;
2. `alpha` and `beta` can both reach their deferred body before either resolves;
3. a rejected `alpha` task does not block the next `alpha` task;
4. queue bookkeeping returns to zero after the last waiter using a test-visible `pendingKeyCount` getter.

- [x] **Step 2: Run queue tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/conversation-queue.test.ts
```

- [x] **Step 3: Implement keyed serialization**

Use a per-key Promise tail. The current task waits for the prior tail after converting prior rejection to settlement, while a separate completion Promise becomes the new tail. Delete the map entry only if it still points at the current tail.

- [x] **Step 4: Run queue tests and confirm GREEN**

Run the same queue test command.

- [x] **Step 5: Write failing Page-affinity tests**

Use a fake `PagePool`/`PageLease` and fake clock to prove:

- first `alpha` acquire returns `reused=false`; release retains underlying lease;
- second `alpha` acquire gets the same Page with `reused=true`;
- a closed retained Page is discarded and next acquire returns `reused=false`;
- expired idle `alpha` is discarded/closed during sweep;
- when capacity error occurs and an idle `alpha` exists, least-recent idle affinity is discarded then new `beta` acquisition retries successfully;
- an active affinity is never selected for eviction;
- if all capacity is active, `page_capacity_exceeded` propagates;
- `close()` clears the sweep timer and discards every retained affinity;
- release is idempotent.

- [x] **Step 6: Run Page-affinity tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/conversation-pages.test.ts
```

- [x] **Step 7: Implement the Conversation Page manager**

The manager stores per key:

```ts
{
  poolLease: PageLease;
  active: boolean;
  lastUsedAt: number;
}
```

Start one `setInterval` sweep with an interval no larger than `min(idleTimeoutMs, 60_000)` and `unref()` it when supported. `sweepIdle()` may also be exposed for deterministic tests.

On Page Pool capacity error, discard exactly one least-recent idle affinity and retry acquire once. Do not implement a global request wait queue.

- [x] **Step 8: Run Task 3 tests and typecheck**

```bash
corepack pnpm vitest run tests/unit/conversation-queue.test.ts tests/unit/conversation-pages.test.ts tests/unit/page-pool.test.ts
corepack pnpm typecheck
```

- [x] **Step 9: Update plan and commit**

```bash
git add src/conversations/conversation-queue.ts src/conversations/conversation-pages.ts tests/unit/conversation-queue.test.ts tests/unit/conversation-pages.test.ts docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 增加同会话队列与 Page affinity"
```

---

### Task 4: Extend ChatGPT Driver with Fresh/current/restore targets

**Files:**
- Modify: `src/chatgpt/errors.ts`
- Modify: `src/chatgpt/driver.ts`
- Modify: `tests/unit/chatgpt-driver.test.ts`
- Modify: `tests/e2e/chatgpt-phase3.e2e.ts`

**Interfaces:**
- Produces: `ChatGptTextTarget`.
- Produces: `ChatGptDriver.sendText(page, { prompt, target })`.
- Adds Driver error code `conversation_restore_failed`.
- Existing Phase 3 real E2E caller is updated to pass `{ kind: 'fresh' }`; no selector/completion behavior is changed.

- [x] **Step 1: Add failing Driver target tests**

Prove:

- `fresh` calls `page.goto('https://chatgpt.com/')`;
- `current` performs no navigation when current URL identifies the expected `/c/<id>` Conversation;
- `restore` navigates to the persisted URL;
- query/hash differences do not fail identity validation;
- wrong origin/path or redirect from expected `/c/<id>` to Fresh root throws `conversation_restore_failed` before composer submission;
- existing auth, selector and completion tests remain valid with the new target argument.

- [x] **Step 2: Run Driver tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/chatgpt-driver.test.ts
```

- [x] **Step 3: Implement navigation targets and identity validation**

Use:

```ts
export type ChatGptTextTarget =
  | { kind: 'fresh' }
  | { kind: 'current'; conversationUrl: string }
  | { kind: 'restore'; conversationUrl: string };
```

Create a helper that parses expected/actual URLs and requires:

```text
origin === https://chatgpt.com
pathname === expected pathname
pathname starts with /c/
```

Ignore search/hash. Never infer Conversation identity from page content.

- [x] **Step 4: Update deterministic and Phase 3 explicit E2E callers**

Every Fresh-only caller passes:

```ts
target: { kind: 'fresh' }
```

No real E2E is run yet in this step.

- [x] **Step 5: Run Driver/Phase 3 executor tests and typecheck**

```bash
corepack pnpm vitest run tests/unit/chatgpt-driver.test.ts tests/unit/phase3-executor.test.ts tests/unit/chatgpt-e2e-gate.test.ts
corepack pnpm typecheck
```

- [x] **Step 6: Update plan and commit**

```bash
git add src/chatgpt tests/unit/chatgpt-driver.test.ts tests/e2e/chatgpt-phase3.e2e.ts src/conversations/phase3-executor.ts tests/unit/phase3-executor.test.ts docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 扩展 ChatGPT Driver 会话导航目标"
```

---

### Task 5: Build the Phase 4 Conversation executor and persistence lifecycle

**Files:**
- Create: `src/conversations/conversation-executor.ts`
- Create: `tests/unit/conversation-executor.test.ts`
- Modify: `src/api/errors.ts`
- Modify: `tests/integration/post-routes.test.ts`

**Interfaces:**
- Produces: `createConversationExecutor({ pagePool, pageManager, queue, driver, conversationStore, now, randomUUID })` as `NormalizedExecutionHandler`.
- Consumes Task 2 planner/prompt functions and Task 3 queue/Page manager.
- Persists only successful keyed requests.

- [ ] **Step 1: Write failing keyed executor tests for FRESH and APPEND**

Use in-memory persistence from `tests/helpers/persistence.ts`, fake Driver and fake Page layers.

First keyed request:

- no aggregate exists;
- Driver target is Fresh;
- full prompt contains caller context;
- success saves one Conversation with the key, URL and caller messages plus generated assistant.

Second keyed request with full history:

- same aggregate id is reused;
- warm Page reports `reused=true`;
- planner selects APPEND;
- Driver prompt contains only the new user text, not turn-1 text;
- persisted URL remains the returned conversation URL;
- snapshot now contains turn 1 user/assistant + turn 2 user/assistant.

- [ ] **Step 2: Run executor tests and confirm RED**

```bash
corepack pnpm vitest run tests/unit/conversation-executor.test.ts
```

- [ ] **Step 3: Implement successful keyed/unkeyed execution**

Use `crypto.randomUUID` by default and allow injection for deterministic tests.

Convert caller normalized messages to `MessageRecord[]` with sequential zero-based `sequence`. Append generated assistant as:

```ts
{
  role: 'assistant',
  content: [{ type: 'text', text: result.text }],
}
```

Unkeyed Fresh execution uses ordinary Page Pool acquire/release and never calls `ConversationStore.save()`.

- [ ] **Step 4: Add failing RESTORE/REBUILD/error atomicity tests**

Prove:

- no warm Page + saved URL → Driver restore target + append prompt;
- saved URL absent → Fresh REBUILD full prompt;
- modified prior history → Fresh REBUILD full prompt and same local id/key;
- Driver `conversation_restore_failed` during RESTORE causes exactly one Fresh REBUILD attempt on the same acquired Page;
- browser/auth/selector/timeout error does not trigger rebuild;
- any failed execution leaves the pre-request aggregate unchanged;
- failed keyed execution discards its affinity;
- success releases affinity without discard.

- [ ] **Step 5: Run executor tests and confirm RED for the new cases**

Run the same executor test command and verify failures correspond to missing restore/rebuild behavior.

- [ ] **Step 6: Implement restore/rebuild fallback and atomic save boundary**

Catch only `ChatGptDriverError` with `code === 'conversation_restore_failed'` from a RESTORE attempt and retry once with `target: { kind: 'fresh' }` plus full prompt. Save only after the final Driver result exists.

For an APPEND `current` identity failure, retry once using the persisted URL as a RESTORE target when available; if that restore identity also fails, perform the one REBUILD fallback.

- [ ] **Step 7: Update stable API error mapping tests first**

Change route/error expectations from `unsupported_phase3_request` normal execution to `unsupported_phase4_request` and add mapping for escaped `conversation_restore_failed` as HTTP 502.

- [ ] **Step 8: Implement stable error mapping**

Update `src/api/errors.ts` without changing existing auth/browser/selector/page-capacity mappings.

- [ ] **Step 9: Run Task 5 focused tests and typecheck**

```bash
corepack pnpm vitest run tests/unit/conversation-executor.test.ts tests/integration/post-routes.test.ts tests/unit/response-encoders.test.ts
corepack pnpm typecheck
```

- [ ] **Step 10: Update plan and commit**

```bash
git add src/conversations/conversation-executor.ts src/api/errors.ts tests/unit/conversation-executor.test.ts tests/integration/post-routes.test.ts docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 接入持久化 Conversation 执行引擎"
```

---

### Task 6: Wire Phase 4 runtime and prove HTTP concurrency/restart behavior

**Files:**
- Modify: `src/runtime.ts`
- Modify: `tests/integration/runtime-browser.test.ts`
- Create: `tests/integration/conversation-context-sync.test.ts`

**Interfaces:**
- Headless runtime uses the Phase 4 Conversation executor.
- Runtime owns and closes one Conversation Page manager before BrowserManager close.
- Maintenance mode behavior remains unchanged.

- [ ] **Step 1: Write failing runtime wiring tests**

Extend runtime tests to require:

- configured `pageIdleTimeoutMinutes` is converted to milliseconds for Page manager construction;
- runtime close closes app → Conversation Page manager → browser → persistence without timer leaks;
- maintenance mode never creates BrowserManager/Page manager and still returns `browser_maintenance_mode`.

Expose constructor injection points only when needed for deterministic tests; do not add public runtime config abstractions beyond the task.

- [ ] **Step 2: Run runtime tests and confirm RED**

```bash
corepack pnpm vitest run tests/integration/runtime-browser.test.ts
```

- [ ] **Step 3: Wire the new runtime**

Replace `createPhase3Executor()` in normal headless runtime with the Phase 4 queue/Page manager/executor stack. Keep Phase 3 executor source only if still directly covered by historical unit tests; it is no longer production wiring.

- [ ] **Step 4: Write failing HTTP integration tests**

Use `buildServer` or runtime with fake Driver boundaries to prove both Chat Completions and Responses:

- keyed first turn persists;
- second full-history turn sends only the new user turn;
- two same-key requests serialize;
- two different-key requests overlap;
- close/reopen persistence plus an empty Page-affinity manager selects saved-URL RESTORE;
- changed prior history selects REBUILD.

Use deferred Driver calls for concurrency assertions instead of wall-clock sleeps.

- [ ] **Step 5: Run HTTP integration tests and confirm RED**

```bash
corepack pnpm vitest run tests/integration/conversation-context-sync.test.ts
```

- [ ] **Step 6: Add only the minimal injection/wiring required for GREEN**

Do not duplicate protocol logic in Chat Completions/Responses routes. Both continue to call the shared `NormalizedExecutionHandler`.

- [ ] **Step 7: Run Task 6 focused integration tests**

```bash
corepack pnpm vitest run tests/integration/runtime-browser.test.ts tests/integration/conversation-context-sync.test.ts tests/integration/post-routes.test.ts
corepack pnpm typecheck
```

- [ ] **Step 8: Update plan and commit**

```bash
git add src/runtime.ts tests/integration/runtime-browser.test.ts tests/integration/conversation-context-sync.test.ts docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "✨ 将 Phase 4 Conversation Engine 接入运行时"
```

---

### Task 7: Add Phase 4 explicit real E2E and Docker/config regression coverage

**Files:**
- Create: `tests/e2e/chatgpt-phase4.e2e.ts`
- Modify: `package.json`
- Modify: Docker smoke script identified by repository search
- Modify: `README.md` only for commands/config needed to run the new E2E before final docs pass

**Interfaces:**
- Produces an explicit Phase 4 E2E command that is not part of deterministic `verify`.
- Uses existing `CHATGPT_E2E`, isolated profile, proxy and Gateway API key gates.

- [ ] **Step 1: Inspect the existing Phase 3 E2E gate and Docker smoke script**

Reuse its profile safety checks, proxy handling and diagnostic isolation. Do not invent another browser ownership model.

- [ ] **Step 2: Write the gated Phase 4 E2E test**

The test must:

1. create a unique token and Conversation key;
2. send turn 1 through Gateway HTTP asking ChatGPT to remember the token;
3. load SQLite state and capture the saved Conversation URL;
4. send turn 2 using the same key and full turn-1 history, asking ChatGPT to return the token;
5. assert response contains the token and URL is unchanged;
6. close/recreate the Gateway runtime while preserving DB/Profile;
7. send turn 3 with full history and assert the token is still returned;
8. assert the persisted URL remains a ChatGPT `/c/...` URL after RESTORE.

The test must not claim DOM proof of APPEND solely from response text; deterministic fake-Driver tests provide the exact prompt non-replay proof, while this real E2E proves the resulting web Conversation continuity.

- [ ] **Step 3: Add an explicit package script**

Add a script such as:

```json
"test:e2e:chatgpt:phase4": "vitest run --config vitest.e2e.config.ts tests/e2e/chatgpt-phase4.e2e.ts"
```

Keep it outside `verify`.

- [ ] **Step 4: Extend Docker smoke for active idle-timeout config**

The smoke test must pass a non-default `PAGE_IDLE_TIMEOUT_MINUTES` value and verify the Gateway starts successfully with it. Do not add external ChatGPT network requirements to Docker smoke.

- [ ] **Step 5: Run deterministic E2E gate/unit checks and Docker smoke**

Run the existing E2E gate unit test, repository verify, a fresh Docker build if smoke requires it, then the project’s documented Docker smoke command.

- [ ] **Step 6: Run explicit real Phase 4 ChatGPT E2E**

Use the already authenticated isolated E2E Profile and the configured LAN proxy when required by the environment. If the real environment exposes an external blocker, record the exact boundary and do not mark Phase 4 complete.

- [ ] **Step 7: Update plan with actual evidence and commit**

Record deterministic test counts, Docker image/smoke evidence and real E2E result in this plan before committing.

```bash
git add tests/e2e package.json README.md scripts docker compose.yaml docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "🧪 增加 Phase 4 多轮恢复真实验收"
```

Only add paths that actually changed.

---

### Task 8: Final docs, project memory, full verification, commit and push

**Files:**
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/api-compatibility.md`
- Modify: `docs/testing.md`
- Modify: `docs/roadmap.md`
- Modify: `README.md`
- Modify: `.env.example` only if wording/defaults need alignment
- Modify: this plan

**Interfaces:**
- If every Phase 4 acceptance gate including real E2E passes, machine state becomes:

```text
PHASE=phase-4-complete
STATUS=ready-for-phase-5-design
GOVERNING_SPEC=docs/superpowers/specs/2026-08-15-phase-4-conversation-context-sync-design.md
ACTIVE_PLAN=none
NEXT_TASK=write-phase-5-streaming-spec
UPDATED_AT=2026-08-15
```

- If real E2E is externally blocked, keep Phase 4 active/incomplete, record the blocker and point `NEXT_TASK` to the smallest executable unblock/retest action.

- [ ] **Step 1: Run project-memory Writeback Decision**

Update only current facts: implemented Phase 4 behavior, API compatibility, architecture, testing evidence, runtime config, roadmap status and next task.

- [ ] **Step 2: Mark every completed plan checkbox and append closure evidence**

Do not mark a check that lacks current-run evidence.

- [ ] **Step 3: Run focused tests after final code/doc edits**

```bash
corepack pnpm vitest run tests/unit/context-sync.test.ts tests/unit/conversation-queue.test.ts tests/unit/conversation-pages.test.ts tests/unit/chatgpt-driver.test.ts tests/unit/conversation-executor.test.ts tests/integration/conversation-context-sync.test.ts tests/integration/runtime-browser.test.ts
```

- [ ] **Step 4: Run full deterministic repository verification**

```bash
corepack pnpm verify
```

- [ ] **Step 5: Run repository governance checks explicitly**

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
node scripts/check-version.mjs
```

- [ ] **Step 6: Run Git safety checks**

```bash
git status --short --branch
git diff --check
git diff
git diff --staged
```

Verify no browser Profile, Cookie, SQLite DB, real uploads, generated media, logs or credentials are staged.

- [ ] **Step 7: Commit final docs/state**

```bash
git add README.md .env.example docs/PROJECT_STATE.md docs/architecture.md docs/api-compatibility.md docs/testing.md docs/roadmap.md docs/superpowers/plans/2026-08-15-phase-4-conversation-context-sync.md
git commit -m "📝 关闭 Phase 4 并回写项目状态"
```

Only add files that actually changed.

- [ ] **Step 8: Verify clean branch and push**

```bash
git status --short --branch
git log -8 --oneline --decorate
git push -u origin phase-4-context-sync
```

Report the actual commit(s), push result, deterministic verification, Docker smoke, real E2E result and any unverified boundary.
