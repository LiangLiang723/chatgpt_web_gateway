# Phase 5 True Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 4 Conversation/Context Sync 基础上实现真正从 ChatGPT DOM 增量读取的纯文本 Streaming，并通过 Chat Completions / Responses SSE 输出，同时保持 crash consistency、same-key FIFO 和 client abort 收敛语义。

**Architecture:** `chatgpt/` 负责目标 Assistant turn 的 DOM observation 与 Stop；纯 `stream/` 负责 Snapshot normalization、Stable Prefix、Completion 与 protocol-neutral event；`conversations/` 继续拥有 Queue、Page、checkpoint、最终 SQLite save；`api/` 只负责 SSE transport 与两套协议 Encoder。non-stream `sendText()` 与 stream 路径共享同一 turn ownership/completion primitive。

**Tech Stack:** TypeScript 6、Node 24、Fastify 5、Playwright 1.62.1、Vitest 4、Node `http.ServerResponse` SSE、SQLite `node:sqlite`。

**Execution status (2026-08-16):** Tasks 1–11 的设计激活、产品实现、TDD、deterministic integration、真实 TCP E2E harness 与 combined harness 接入均已完成；Task 12 的 fresh deterministic 与 Docker build/smoke 已通过。当前仅 authenticated `inspect:chatgpt`、Phase 5 real E2E 和 combined Phase 3/4/5 real E2E 因本会话无法访问隔离已登录 Browser Profile / LAN proxy 而阻塞，因此 Phase 5 保持开放。

## Global Constraints

- 只实现 Phase 5 纯文本 Streaming；附件、Tools、Structured Output、image execution 继续拒绝。
- DOM polling 默认约 `200ms`，Stable Prefix 默认 `3` 个 sample，generation timeout 保持 `120000ms`。
- 只观察发送前 `assistantTurns.count()` 所确定的 target Assistant turn；禁止 `.last()` 猜 ownership。
- completion 以 target turn `copy-turn-action-button` marker + final stable text 为成功边界；全局 Stop control 不是成功必要条件。
- `stream/` 不依赖 Playwright、API、Browser、ChatGPT、Persistence 或 `node:sqlite`。
- SSE success terminal 必须晚于 SQLite clean commit；post-checkpoint unknown failure 不保存 partial Assistant。
- client abort 在 completion 前 best-effort Stop 并保持 `in_flight`；completion 后 transport close 不阻止 authoritative final save。
- same-key Queue 覆盖整个 stream/abort cleanup 生命周期；different-key 仍可并行。
- 不新增数据库 migration、生产依赖或 Streaming 环境变量。
- 所有行为变化先写失败测试并确认 RED，再写最小实现。
- 真 Streaming 只有真实 TCP listener + authenticated ChatGPT Web E2E 能证明；`app.inject()` 不能替代。

---

### Task 1: 批准设计并激活实施计划

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md`
- Modify: `docs/PROJECT_STATE.md`
- Existing: `docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md`

**Interfaces:**
- Consumes: 已批准 Phase 5 spec。
- Produces: `ACTIVE_PLAN=docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md`，`STATUS=phase-5-implementation`。

- [x] **Step 1: 将 spec header 改为批准状态**

```markdown
**Status:** Approved; implementation in progress
```

- [x] **Step 2: 激活 PROJECT_STATE**

```text
PHASE=phase-5
STATUS=phase-5-implementation
ACTIVE_PLAN=docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md
NEXT_TASK=implement-phase-5-stream-core
```

正文同步写明 Streaming 尚未完成，只是实施已启动。

- [x] **Step 3: 运行仓库治理检查**

Run:

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
```

Expected: PASS。

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md docs/PROJECT_STATE.md docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md
git commit -m "📝 激活 Phase 5 真 Streaming 实施计划"
```

---

### Task 2: 纯 Streaming Snapshot + Stable Prefix + Completion Core

**Files:**
- Create: `src/stream/types.ts`
- Create: `src/stream/normalize.ts`
- Create: `src/stream/stable-prefix.ts`
- Create: `src/stream/completion.ts`
- Create: `src/stream/text-stream.ts`
- Create: `tests/unit/stream-normalize.test.ts`
- Create: `tests/unit/stable-prefix.test.ts`
- Create: `tests/unit/stream-completion.test.ts`
- Create: `tests/unit/text-stream.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AssistantSnapshot {
  exists: boolean;
  text: string;
  completionMarkerPresent: boolean;
}

export interface StreamClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type TextStreamEvent =
  | { type: 'started'; startedAt: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'completed'; result: TextExecutionResult };

export function normalizeAssistantText(text: string): string;
export function longestCommonPrefix(values: readonly string[]): string;
export function createStablePrefixState(options?: { stableSamples?: number }): StablePrefixState;
export function observeStablePrefix(state: StablePrefixState, text: string): { state: StablePrefixState; delta: string };
export function flushStablePrefix(state: StablePrefixState, finalText: string): { state: StablePrefixState; delta: string };
export async function waitForStreamingCompletion(options: WaitForStreamingCompletionOptions): Promise<string>;
```

- [x] **Step 1: RED — normalization + Unicode LCP tests**

Tests must assert:

```ts
expect(normalizeAssistantText('a\r\nb\rc')).toBe('a\nb\nc');
expect(normalizeAssistantText('  code  \n')).toBe('  code  \n');
expect(longestCommonPrefix(['😀abc', '😀abd', '😀abz'])).toBe('😀ab');
```

Run:

```bash
corepack pnpm vitest run tests/unit/stream-normalize.test.ts tests/unit/stable-prefix.test.ts
```

Expected: FAIL because modules/functions do not exist.

- [x] **Step 2: GREEN — implement normalization and code-point-safe LCP**

`normalizeAssistantText()` only normalizes CRLF/CR to LF. LCP iterates `Array.from(value)` code points and joins the common prefix.

- [x] **Step 3: RED — Stable Prefix state tests**

Cover:

```text
samples: a / ab / abc => emit a only after 3 samples
then ab / abc / abcd => emit b exactly once
tail rewrite after emitted prefix => delay but no duplicate
rewrite crossing emitted prefix => ChatGptStreamDivergedError
final flush => emit remaining tail exactly once
```

Run expected FAIL.

- [x] **Step 4: GREEN — Stable Prefix state**

State stores only `emitted`, bounded `samples`, `stableSamples`. Every observation verifies current/stable text starts with `emitted`; `flushStablePrefix` verifies final starts with `emitted`.

- [x] **Step 5: RED — Completion tests with fake clock**

Cover marker absent, marker present but changing text, marker + 3 stable samples + final re-read, no-turn timeout, existing-turn timeout, target disappears after appearing.

- [x] **Step 6: GREEN — Completion detector**

Default `pollIntervalMs=200`, `stableSamples=3`, `timeoutMs=120000`; do not inspect Stop control.

- [x] **Step 7: RED/GREEN — text streaming loop**

A scripted snapshot sequence must emit only stable non-empty deltas and flush final tail so `concat(delta) === finalText`.

- [x] **Step 8: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/stream-normalize.test.ts tests/unit/stable-prefix.test.ts tests/unit/stream-completion.test.ts tests/unit/text-stream.test.ts
corepack pnpm typecheck
git add src/stream tests/unit/stream-*.test.ts tests/unit/stable-prefix.test.ts tests/unit/text-stream.test.ts
git commit -m "✨ 增加 Streaming Stable Prefix 核心"
```

---

### Task 3: ChatGPT Target Turn Handle + Stop Contract

**Files:**
- Modify: `src/chatgpt/driver.ts`
- Modify: `src/chatgpt/completion.ts`
- Modify: `src/chatgpt/errors.ts`
- Modify: `tests/unit/chatgpt-driver.test.ts`
- Modify: `tests/unit/chatgpt-completion.test.ts`

**Interfaces:**
- Consumes: `AssistantSnapshot`, common completion primitive。
- Produces:

```ts
export interface ChatGptTextTurn {
  observe(): Promise<AssistantSnapshot>;
  stop(): Promise<'stopped' | 'already_complete'>;
  conversationUrl(): Promise<string>;
}

export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;
  openConversation(page: Page, conversationUrl: string): Promise<'restored' | 'not_restorable'>;
  startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn>;
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}
```

- [x] **Step 1: RED — `startText()` ownership test**

Assert baseline captured before fill/click and returned handle observes exactly `assistantTurns.nth(baseline)`.

- [x] **Step 2: GREEN — extract target turn handle**

`startText` captures baseline, fills, clicks, then returns closure-bound handle. `observe` returns missing snapshot before target exists and validates completion marker cardinality.

- [x] **Step 3: RED — safe final URL and non-stream reuse**

Test `conversationUrl()` validates safe ChatGPT URL and `sendText()` delegates through `startText()` + shared completion logic rather than reimplementing ownership.

- [x] **Step 4: GREEN — make existing `sendText()` use handle**

Preserve all Phase 3/4 success/error behavior.

- [x] **Step 5: RED — Stop semantics**

Cover:

```text
completion marker already present => already_complete, no click
still generating => unique Stop clicked exactly once
ambiguous Stop => selector_ambiguous
no target yet but Stop unique => click allowed
```

- [x] **Step 6: GREEN — `turn.stop()`**

Use strict Selector Registry semantics and bounded polling until target completion/stopped state. Do not persist partial text.

- [x] **Step 7: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/chatgpt-driver.test.ts tests/unit/chatgpt-completion.test.ts
corepack pnpm typecheck
git add src/chatgpt tests/unit/chatgpt-driver.test.ts tests/unit/chatgpt-completion.test.ts
git commit -m "♻️ 拆分 ChatGPT 可观察 Assistant Turn"
```

---

### Task 4: Streaming Execution Contract + Conversation Engine Lifecycle

**Files:**
- Modify: `src/api/execution.ts`
- Modify: `src/conversations/conversation-engine.ts`
- Modify: `src/conversations/request-context.ts`
- Modify: `src/conversations/phase4-request.ts` or replace capability naming at the active boundary
- Modify: `tests/unit/phase4-request-context.test.ts`
- Modify: `tests/integration/conversation-engine.test.ts`

**Interfaces:**
- Produces:

```ts
export type TextStreamSink = (event: TextStreamEvent) => Promise<void>;
export interface StreamingExecutionOptions { signal: AbortSignal; sink: TextStreamSink }
export type NormalizedStreamingExecutionHandler = (
  request: NormalizedRequest,
  options: StreamingExecutionOptions,
) => Promise<TextExecutionResult>;

export interface ConversationExecutionEngine {
  execute: NormalizedExecutionHandler;
  stream: NormalizedStreamingExecutionHandler;
}
```

- [x] **Step 1: RED — Phase 5 capability tests**

`stream=true` pure text must now validate; attachments/tools/structured/image remain `unsupported_phase5_request`.

- [x] **Step 2: GREEN — update capability boundary without changing Context Planner**

Keep full/incremental canonicalization identical for stream and non-stream.

- [x] **Step 3: RED — successful streaming Conversation test**

Fake driver snapshots must prove ordering:

```text
prepare page
started sink
mark in_flight
startText
text.delta...
completion
safe URL
ConversationStore.save(clean)
session.complete
completed sink
```

Assert final SQLite Assistant equals concatenated deltas.

- [x] **Step 4: GREEN — refactor shared prepare/finalize helpers**

Do not copy the entire Phase 4 state machine. Keep `execute` behavior unchanged; add `stream` using the same load/plan/page/prompt/final aggregate helpers.

- [x] **Step 5: RED — abort before completion**

After at least one delta, abort signal. Assert `turn.stop()` once, no partial Assistant saved, checkpoint remains `in_flight`, session fails, queue does not release until stop cleanup resolves.

- [x] **Step 6: GREEN — cancellation cleanup**

If completion not established, best-effort Stop and fail session. Do not convert `in_flight` to clean.

- [x] **Step 7: RED/GREEN — abort after completion**

Simulate sink transport close after completion established/final tail. Engine must continue safe URL + clean SQLite save and return final result without Stop.

- [x] **Step 8: RED/GREEN — final persistence failure**

If `ConversationStore.save(clean)` fails, completed event must not be delivered and checkpoint remains `in_flight`.

- [x] **Step 9: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/phase4-request-context.test.ts tests/integration/conversation-engine.test.ts
corepack pnpm typecheck
git add src/api/execution.ts src/conversations tests/unit/phase4-request-context.test.ts tests/integration/conversation-engine.test.ts
git commit -m "✨ 接入 Conversation 真 Streaming 生命周期"
```

---

### Task 5: SSE Writer + Backpressure/Abort Transport

**Files:**
- Create: `src/api/sse.ts`
- Create: `tests/unit/sse.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SseWriter {
  writeData(data: string): Promise<void>;
  writeEvent(event: string, data: string): Promise<void>;
  end(): void;
  readonly closed: boolean;
}

export function createSseWriter(response: ServerResponse, signal: AbortSignal): SseWriter;
```

- [x] **Step 1: RED — frame serialization tests**

Assert `data: ...\n\n` and `event: name\ndata: ...\n\n`, UTF-8 content preserved.

- [x] **Step 2: GREEN — minimal serializer/writer**

Use `ServerResponse.write()` and do not buffer application events.

- [x] **Step 3: RED — backpressure test**

Fake writable returns `false`; promise must wait for `drain`, but reject/stop waiting if abort/close occurs first.

- [x] **Step 4: GREEN — drain-aware write**

One in-flight write only; no `setInterval` or unbounded queue.

- [x] **Step 5: RED/GREEN — close semantics**

`close` before `writableFinished` triggers abort at route/controller boundary; normal `end()` close does not become client abort; `end()` idempotent.

- [x] **Step 6: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/sse.test.ts
corepack pnpm typecheck
git add src/api/sse.ts tests/unit/sse.test.ts
git commit -m "✨ 增加 SSE 反压写入边界"
```

---

### Task 6: Chat Completions Streaming Encoder

**Files:**
- Create: `src/api/encode/chat-completions-stream.ts`
- Modify: `tests/unit/response-encoders.test.ts`

**Interfaces:**
- Consumes: `TextStreamEvent`。
- Produces an encoder object with stable `chatcmpl_<uuid>`, `created`, `model='chatgpt-web'` and method that maps each internal event to SSE data frames.

- [x] **Step 1: RED — chunk lifecycle test**

Expected sequence:

```text
role assistant chunk
content delta chunks...
finish_reason=stop chunk
[DONE]
```

All chunks use same id/created/model; no usage.

- [x] **Step 2: GREEN — implement encoder**

`started` emits role/content-empty chunk once; `text.delta` emits content; `completed` emits finish chunk then `[DONE]`.

- [x] **Step 3: RED/GREEN — post-start error**

Encode `{error:{message,type,param:null,code}}` as `data:` and close without finish chunk or `[DONE]`.

- [x] **Step 4: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/response-encoders.test.ts
git add src/api/encode/chat-completions-stream.ts tests/unit/response-encoders.test.ts
git commit -m "✨ 增加 Chat Completions SSE 编码"
```

---

### Task 7: Responses Streaming Encoder

**Files:**
- Create: `src/api/encode/responses-stream.ts`
- Modify: `tests/unit/response-encoders.test.ts`

**Interfaces:**
- Stable response/message IDs, `output_index=0`, `content_index=0`, monotonically increasing `sequence_number`.

- [x] **Step 1: RED — typed lifecycle test**

Assert exact order:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta...
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

- [x] **Step 2: GREEN — implement minimal currently-supported Response object**

Final done/full text fields all equal `result.text`; `usage=null`.

- [x] **Step 3: RED/GREEN — error event**

After started, error maps to `event: error` with stable code/message/param and next sequence number; no `response.completed`.

- [x] **Step 4: Verify + Commit**

```bash
corepack pnpm vitest run tests/unit/response-encoders.test.ts
git add src/api/encode/responses-stream.ts tests/unit/response-encoders.test.ts
git commit -m "✨ 增加 Responses SSE 编码"
```

---

### Task 8: Fastify Routes + Runtime Streaming Injection

**Files:**
- Modify: `src/api/routes/chat-completions.ts`
- Modify: `src/api/routes/responses.ts`
- Modify: `src/api/server.ts`
- Modify: `src/api/errors.ts`
- Modify: `src/api/execution.ts`
- Modify: `src/runtime.ts`
- Modify: `tests/integration/post-routes.test.ts`
- Modify: `tests/integration/runtime.test.ts` or current runtime integration test file

**Interfaces:**
- `buildServer({ execute, stream })` injects both handlers.
- For `normalized.output.stream=false`, use existing JSON path.
- For `stream=true`, create AbortController; the first `started` event calls `reply.hijack()` + SSE headers and delegates event encoding.

- [x] **Step 1: RED — stream route uses streaming backend**

Chat Completions and Responses `stream=true` must not call non-stream execute handler.

- [x] **Step 2: GREEN — route branch after Normalizer**

Do not duplicate capability/Context logic in route.

- [x] **Step 3: RED — pre-start error remains normal HTTP JSON**

Maintenance/auth/capability failure before `started` must preserve mapped non-200 status and not hijack response.

- [x] **Step 4: GREEN — defer hijack until `started`**

Fastify owns errors until then. After hijack, route owns `reply.raw` lifecycle.

- [x] **Step 5: RED/GREEN — post-start error framing**

After headers are sent, stable execution error is encoded in protocol stream, success terminator omitted, response ended.

- [x] **Step 6: RED/GREEN — client close AbortSignal**

Premature raw close/write error aborts controller. Normal `writableFinished` close does not.

- [x] **Step 7: RED/GREEN — runtime injection and maintenance backend**

Headless runtime injects `{execute, stream}` from Conversation Engine. Maintenance mode streaming throws `browser_maintenance_mode` before start.

- [x] **Step 8: Verify + Commit**

```bash
corepack pnpm vitest run tests/integration/post-routes.test.ts tests/integration/conversation-system.test.ts
corepack pnpm typecheck
git add src/api src/runtime.ts tests/integration
git commit -m "✨ 接入 Gateway Streaming SSE 路由"
```

---

### Task 9: System Integration — Context Sync, FIFO, Persistence, Abort

**Files:**
- Modify: `tests/integration/conversation-context-sync.test.ts`
- Modify: `tests/integration/conversation-system.test.ts`
- Modify: `tests/integration/conversation-engine.test.ts`

**Interfaces:**
- Uses real temporary SQLite, fake Driver/Pages, real Fastify where appropriate.

- [x] **Step 1: RED/GREEN — full-history APPEND stream**

Second keyed stream sends only new current user prompt; final SQLite history contains prior assistant + new assistant once.

- [x] **Step 2: RED/GREEN — incremental RESTORE stream**

Runtime recreation with same DB uses saved ChatGPT URL and streams next user turn.

- [x] **Step 3: RED/GREEN — divergent full history REBUILD stream**

Preserve local key/UUID, use fresh web conversation, final clean aggregate represents authoritative rewritten history.

- [x] **Step 4: RED/GREEN — same-key stream holds FIFO**

Second request cannot enter driver after first delta; only after first completion or abort cleanup.

- [x] **Step 5: RED/GREEN — different-key parallel stream**

Both driver operations can overlap when page capacity allows.

- [x] **Step 6: RED/GREEN — divergence and persistence failure convergence**

Both leave `in_flight`, discard page binding, and next keyed request plans REBUILD.

- [x] **Step 7: Verify + Commit**

```bash
corepack pnpm vitest run tests/integration/conversation-engine.test.ts tests/integration/conversation-context-sync.test.ts tests/integration/conversation-system.test.ts
git add tests/integration
git commit -m "🧪 覆盖 Streaming 会话一致性与并发"
```

---

### Task 10: Architecture Rules + Deterministic Full Verification

**Files:**
- Modify: `scripts/check-architecture.mjs`
- Modify: architecture checker tests if present
- Modify: `docs/testing.md` only for deterministic Phase 5 tests already implemented

**Interfaces:**
- `src/stream/` forbidden imports: `playwright`, `api/`, `browser/`, `chatgpt/`, `persistence/`, `node:sqlite`.

- [x] **Step 1: RED — synthetic architecture violations**

Add fixture/source cases proving regular import, dynamic import, `require`, side-effect import cannot bypass `stream/` boundaries.

- [x] **Step 2: GREEN — extend checker**

Reuse existing import parser/rule pattern; do not create a second checker implementation.

- [x] **Step 3: Run Phase 5 deterministic suite**

```bash
corepack pnpm verify
```

Expected: all format/lint/typecheck/tests/build/governance pass.

- [x] **Step 4: Update deterministic test baseline in docs**

Record the fresh file/test counts from the actual Vitest output; do not guess.

- [x] **Step 5: Commit**

```bash
git add scripts/check-architecture.mjs tests docs/testing.md
git commit -m "👷 强化 Streaming 架构与确定性验证"
```

---

### Task 11: Real Phase 5 ChatGPT E2E Harness

**Files:**
- Create: `tests/e2e/chatgpt-phase5.e2e.ts`
- Create: `scripts/test-chatgpt-phase5-e2e.ts`
- Modify: `scripts/test-chatgpt-e2e.ts`
- Modify: `package.json`
- Modify: E2E safety/profile tests as needed

**Interfaces:**
- Adds `corepack pnpm test:e2e:chatgpt:phase5`.
- Uses existing isolated Profile clone and explicit `E2E_CHATGPT=1` safety gate.
- Starts real Fastify listener on `127.0.0.1:0`; reads actual response body incrementally.

- [x] **Step 1: RED/GREEN — E2E harness safety/unit boundary**

Missing `E2E_CHATGPT` / profile must fail fast exactly like existing Phase 3/4 harness; no credential automation.

- [x] **Step 2: Implement long Chat Completions streaming challenge**

Use a prompt requiring a long deterministic marker-rich response. On first meaningful content delta, inspect the runtime target Assistant turn and assert completion marker is still absent.

Final assertions:

```text
multiple non-empty deltas
concat(delta) == final live Assistant text == SQLite Assistant
finish chunk once
[DONE] once
```

- [x] **Step 3: Implement Markdown/code streaming challenge**

Require heading/list/fenced code and assert exact final delta concatenation equals DOM/SQLite text without duplicate fences/tail loss.

- [x] **Step 4: Implement Responses streaming challenge**

Assert typed event order, stable IDs, monotonic sequence number, multiple `response.output_text.delta`, all done/completed full text equals SQLite Assistant.

- [x] **Step 5: Implement real client abort challenge**

Start long stream, wait one meaningful delta, abort connection. Assert target generation stops/enters terminal state within bounded period, DB remains `in_flight`, affinity is not clean-success retained, and next same-key authoritative request REBUILDs successfully.

- [x] **Step 6: Extend combined harness**

Combined order:

```text
Phase 3 regression
→ Phase 4 regression
→ Phase 5 streaming
```

- [x] **Step 7: Deterministic verification + Commit**

```bash
corepack pnpm verify
git add tests/e2e scripts package.json
git commit -m "🧪 增加 Phase 5 真 Streaming 真实 E2E"
```

---

### Task 12: Docker + Real E2E Acceptance + Final Documentation Writeback

**Files:**
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/api-compatibility.md`
- Modify: `docs/architecture.md`
- Modify: `docs/testing.md`
- Modify: `docs/roadmap.md`
- Modify: this plan checkbox states

**Interfaces:**
- Closes Phase 5 only after deterministic, Docker and authenticated real E2E all have fresh evidence.

- [x] **Step 1: Fresh deterministic final verification**

```bash
corepack pnpm verify
```

Record exact fresh test counts.

- [x] **Step 2: Fresh Docker validation**

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Record final image digest and smoke result. Migrations must remain only `001_initial` + `002_add_conversation_sync_checkpoint`.

- [!] **Step 3: Authenticated DOM inspection**

```bash
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm inspect:chatgpt
```

Expected: current Profile authenticated and required selectors unique/valid.

- [!] **Step 4: Standalone Phase 5 real E2E**

```bash
E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase5
```

Expected: long live stream, Markdown/code, Responses, abort/rebuild all PASS.

- [!] **Step 5: Combined real E2E regression**

```bash
E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt
```

Expected: Phase 3 + Phase 4 + Phase 5 all PASS.

- [x] **Step 6: Final docs writeback**

Only after Steps 1–5 actually pass:

```text
PHASE=phase-5-complete
STATUS=ready-for-phase-6-design
ACTIVE_PLAN=none
NEXT_TASK=write-phase-6-attachments-spec
```

Update current implementation facts:

- Chat Completions / Responses `stream=true` ✅ for pure text.
- Stable Prefix/Completion/abort implementation facts.
- deterministic test counts.
- Docker image digest.
- real E2E exact scenarios and results.
- Phase 5 roadmap status complete.

If any real external boundary is blocked, mark `[!]`, keep Phase 5 open, and record the exact blocker instead of claiming completion.

- [ ] **Step 7: Repository governance and diff review**

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
node scripts/check-version.mjs
git diff --check
git status --short --branch
git diff
git diff --staged
```

- [x] **Step 8: Final documentation commit**

```bash
git add docs
git commit -m "📝 完成 Phase 5 真 Streaming 验收回写"
```

- [x] **Step 9: Push feature branch**

```bash
git push -u origin phase-5-streaming
```

Do not create Release or publish Docker images unless explicitly requested.
