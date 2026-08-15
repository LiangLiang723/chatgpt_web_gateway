# Phase 4 Conversation + Context Sync Design

## 1. Goal

Phase 4 turns the Phase 3 Fresh-only text path into a durable Conversation runtime while preserving the existing OpenAI-compatible adapters and ChatGPT Web-only execution boundary.

The phase must deliver:

- stable `ConversationKey` handling through the existing `X-Conversation-Key` extension;
- same-conversation serialization without a global lock;
- different-conversation parallel execution within the existing bounded Page capacity;
- pure `FRESH | APPEND | RESTORE | REBUILD` context planning;
- Conversation → Page affinity while a Page remains warm;
- idle affinity eviction and Page close;
- persisted ChatGPT conversation URL restore after Page/process loss;
- successful-turn persistence through the Phase 2 `ConversationStore` aggregate;
- deterministic tests plus explicit real ChatGPT E2E evidence for the Phase 4 lifecycle.

Phase 4 remains non-streaming, text-only, attachment-free and tool-free. Streaming, Files/Images input, Tool Calling and image generation remain later phases.

## 2. Governing constraints

The design keeps these existing repository facts unchanged:

- SQLite is the durable Conversation source of truth.
- `NormalizedRequest` is the only request shape consumed by Conversation runtime code.
- Chat Completions and Responses do not implement separate browser logic.
- one Persistent BrowserContext owns a bounded Page Pool;
- same Conversation is serialized; different Conversations may run concurrently;
- Context Sync planning is pure and independent from Playwright;
- ChatGPT DOM selectors remain centralized in `src/chatgpt/selectors.ts`;
- Browser/Profile ownership, maintenance mode and real E2E isolation remain the Phase 3 model.

No Phase 4 database migration is required. `conversations.chatgpt_conversation_url`, the persisted normalized instructions and the ordered persisted messages already contain the durable state needed for the first Context Sync implementation. The saved aggregate represents the last successfully synchronized prefix.

## 3. Conversation identity

### 3.1 Keyed requests

When `NormalizedRequest.conversationKey` is present, it is the durable local Conversation identity.

The first successful request for a key creates one local Conversation record with a UUID v4 id. Later successful requests reuse the same local id and key.

A failed browser/ChatGPT execution must not replace the last successful aggregate.

### 3.2 Requests without a key

When `conversationKey` is absent, Phase 4 stays conservative:

- execute as an ephemeral `FRESH` request;
- allow the request to contain text history and rebuild that history into one Fresh prompt envelope;
- do not create a durable Conversation row;
- do not infer identity from API key, request id, IP address, model, browser Page URL or request content.

Clients that need durable multi-turn APPEND/RESTORE behavior must provide `X-Conversation-Key`.

This avoids accidental conversation merging and preserves standard OpenAI clients that do not know the extension.

## 4. Phase 4 capability boundary

Phase 4 accepts:

- `output.mode === 'text'`;
- `output.stream === false`;
- `attachments.length === 0`;
- `tools.length === 0`;
- `toolChoice.mode === 'auto'`;
- `output.structured === undefined`;
- any normalized system/developer instructions;
- normalized user/assistant text history;
- a final non-empty user text turn.

Phase 4 rejects:

- Streaming;
- image output;
- attachments or attachment content parts;
- tools, tool choice other than default auto, assistant tool calls or tool-result messages;
- structured output execution;
- requests whose last message is not a non-empty user text turn.

The stable execution error for these future capabilities becomes `unsupported_phase4_request`.

## 5. Durable synchronized snapshot

For a keyed Conversation, the stored aggregate after a successful request contains:

- the stable local Conversation id and `conversationKey`;
- the current normalized system/developer instructions;
- the ChatGPT conversation URL returned by the successful Driver execution;
- all normalized user/assistant messages represented by the caller request plus the newly generated assistant response;
- `createdAt` preserved from the original Conversation;
- `updatedAt` and `lastUsedAt` set to the successful completion time.

Phase 4 has no tool calls, attachments or generated images in its successful aggregate.

Message ids are persistence-internal UUID v4 values. Aggregate snapshot replacement may regenerate message ids because Phase 4 has no external message-id contract and no tool/attachment foreign-key state to preserve.

## 6. Pure Context Sync planner

The planner lives under `src/context/` and has no Playwright, SQLite or clock dependency.

Inputs:

- current normalized instructions;
- current normalized messages;
- optional persisted synchronized instructions/messages/URL;
- whether the Conversation currently has a warm bound Page.

Output:

```ts
export type ContextSyncMode = 'FRESH' | 'APPEND' | 'RESTORE' | 'REBUILD';

export interface ContextSyncPlan {
  mode: ContextSyncMode;
  appendMessages: NormalizedMessage[];
}
```

The planner never performs I/O.

### 6.1 FRESH

Choose `FRESH` when no persisted Conversation exists.

The Fresh prompt contains the complete effective text context supplied by the current request. This supports both a one-turn first request and a client that starts using a Conversation key after it already has local history.

### 6.2 APPEND

Choose `APPEND` only when all of the following are true:

1. persisted instructions exactly equal current instructions;
2. every persisted message exactly matches the same-position prefix of the current request;
3. the only unsynchronized tail is exactly one final non-empty user text message;
4. the Conversation currently owns a warm bound Page.

Only that final new user turn is sent to ChatGPT. The prior history is not replayed.

### 6.3 RESTORE

Choose `RESTORE` when the same safe append conditions are true, no warm Page is bound, and the persisted ChatGPT conversation URL exists.

The Driver opens the saved URL, verifies that navigation remained on the requested ChatGPT Conversation, then sends only the new user turn.

### 6.4 REBUILD

Choose `REBUILD` for any existing Conversation that cannot safely APPEND/RESTORE, including:

- instructions changed;
- stored messages are not an exact prefix of the caller history;
- caller history was edited, compressed, rolled back or forked;
- more than one unsynchronized turn appears;
- the persisted URL is absent after the warm Page was lost;
- a RESTORE navigation proves that the saved ChatGPT Conversation is no longer available.

REBUILD opens the Fresh ChatGPT start page and sends one full-context reconstruction envelope. After success, the local Conversation keeps its stable id/key but replaces its persisted ChatGPT URL and synchronized snapshot.

Transient browser/auth/selector failures do not silently trigger REBUILD. Only a specific restore-identity failure may fall back to REBUILD; other Driver failures propagate and leave persistence unchanged.

## 7. Context equality

Phase 4 compares normalized semantic fields, not persistence ids or timestamps.

Instruction equality compares ordered `{ role, content }` values.

Message equality compares ordered:

- role;
- text content parts and their order;
- `toolCallId` / `toolCalls` shape, although the Phase 4 validator rejects tool-bearing messages before execution.

The pure equality helpers do not compare `requestId`, diagnostics, Conversation URL, persistence UUIDs or timestamps.

## 8. Prompt envelopes

The Phase 3 role mapping remains an approximation implemented through JSON-serialized text prompts.

### 8.1 Full context envelope

Used for `FRESH` and `REBUILD`:

```text
You are processing an API request through ChatGPT Web Gateway.
Treat the JSON below as the complete effective conversation context for this request.
System instructions have priority over developer instructions;
developer instructions have priority over conversation messages.
Continue from that context and answer the final user message.

<JSON>
```

Payload:

```json
{
  "system": ["..."],
  "developer": ["..."],
  "messages": [
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." },
    { "role": "user", "text": "..." }
  ]
}
```

### 8.2 Append envelope

Used for `APPEND` and successful URL preparation in `RESTORE`:

```text
Continue the existing conversation with the following next user message.

<JSON>
```

Payload:

```json
{ "user": "..." }
```

Both payloads use `JSON.stringify()`. They are prompt mappings, not a claim of native OpenAI system/developer privilege semantics.

## 9. Same-conversation queue

A keyed serial queue lives under `src/conversations/`.

```ts
run<T>(conversationKey: string, task: () => Promise<T>): Promise<T>
```

Requirements:

- tasks for the same key run strictly in arrival order;
- tasks for different keys begin independently;
- rejection of one task does not poison later tasks for the same key;
- queue bookkeeping is removed after the last waiter finishes;
- unkeyed ephemeral requests do not share a synthetic global key.

The queue wraps load → page acquisition → planning → Driver execution → persistence so two requests cannot race on the same synchronized snapshot.

## 10. Conversation Page affinity

A `ConversationPageManager` sits above the existing Page Pool.

For a keyed Conversation, acquiring a page returns whether the page is a retained warm affinity:

```ts
interface ConversationPageLease {
  page: Page;
  reused: boolean;
  release(options?: { discard?: boolean }): Promise<void>;
}
```

Behavior:

- first request for a key acquires a Page Pool lease and retains it after request completion;
- the next same-key request reuses that Page and reports `reused=true`;
- while a request is active, that affinity cannot be evicted;
- release after success marks the affinity idle but keeps the underlying Page Pool lease retained;
- release with `discard=true` removes the affinity and closes the underlying Page;
- if a retained Page closed externally, the next acquire drops the stale affinity and obtains a new Page;
- a manager close clears its timer and discards all retained affinities.

Unkeyed requests continue to use ordinary Page Pool acquire/release and are never retained by Conversation key.

## 11. Idle reclaim and capacity pressure

`PAGE_IDLE_TIMEOUT_MINUTES` is activated in Phase 4 with default `30`.

A retained Conversation Page tracks `lastUsedAt` after request release.

The Page manager:

- periodically sweeps retained idle affinities;
- closes affinities idle for at least the configured timeout;
- sweeps before allocating a new affinity;
- if Page Pool capacity is still exhausted, evicts the least-recently-used retained **idle** affinity and retries once;
- never evicts an active affinity;
- if all capacity is actively executing, preserves the existing stable `page_capacity_exceeded` error.

Closing an idle affinity does not delete SQLite Conversation state. The next request can therefore select `RESTORE` using the persisted URL.

The Page Pool lease interface gains an explicit discard/close option so idle reclaim actually reduces `openCount` rather than merely returning a Page to the generic idle set.

## 12. Driver navigation targets

The text Driver is extended without receiving `NormalizedRequest` or Context Sync policy.

```ts
type ChatGptTextTarget =
  | { kind: 'fresh' }
  | { kind: 'current'; conversationUrl: string }
  | { kind: 'restore'; conversationUrl: string };

interface ChatGptTextRequest {
  prompt: string;
  target: ChatGptTextTarget;
}
```

Behavior:

- `fresh`: navigate to `https://chatgpt.com/` before auth/composer checks;
- `current`: do not navigate, but verify the current Page still identifies the expected conversation;
- `restore`: navigate to the saved URL, then verify the final Page still identifies the expected conversation;
- all modes reuse the existing auth probe, strict selector handling, Assistant baseline ownership and completion observer.

Conversation identity verification compares ChatGPT URL origin and `/c/...` pathname while ignoring harmless query/hash differences.

A failed `current` identity check is treated like losing the warm Page; the Conversation engine may retry once through `RESTORE` if the persisted URL exists. A failed `restore` identity check raises stable Driver code `conversation_restore_failed`, which the engine converts into one `REBUILD` attempt on the same acquired Page.

## 13. Conversation Engine execution flow

### 13.1 Keyed request

```text
validate Phase 4 capability
  ↓
queue.run(conversationKey)
  ↓
load aggregate by key
  ↓
ConversationPageManager.acquire(key)
  ↓
planContextSync(..., page.reused)
  ↓
FRESH / APPEND / RESTORE / REBUILD Driver target + prompt
  ↓
RESTORE identity failure? → one Fresh REBUILD fallback
  ↓
append generated assistant to caller-effective history
  ↓
ConversationStore.save(successful snapshot)
  ↓
release retained affinity as idle
```

Any non-restore execution failure discards the currently acquired affinity, preserves the old SQLite snapshot and propagates the stable error.

### 13.2 Unkeyed request

```text
validate Phase 4 capability
  ↓
PagePool.acquire()
  ↓
FRESH full-context prompt
  ↓
Driver
  ↓
ordinary PagePool release
```

No local Conversation row is created.

## 14. Runtime lifecycle

Headless runtime creates, in order:

1. persistence context;
2. BrowserManager / Page Pool;
3. ChatGPT Driver;
4. ConversationQueue;
5. ConversationPageManager;
6. Phase 4 Conversation executor;
7. Fastify server.

Shutdown closes:

1. Fastify;
2. ConversationPageManager timer/affinities;
3. BrowserManager;
4. persistence.

Maintenance mode continues to inject `browserMaintenanceModeExecution` and does not create the Conversation Page manager.

## 15. Errors

Public stable mappings added/changed in Phase 4:

| Code | HTTP | Meaning |
|---|---:|---|
| `conversation_restore_failed` | 502 if it escapes engine fallback | Saved ChatGPT Conversation could not be restored |
| `unsupported_phase4_request` | 501 | Request needs a later-phase capability |

`conversation_sync_not_implemented` and `unsupported_phase3_request` are removed from the normal headless Phase 4 execution path. They may remain only in historical Phase 3 test/spec code until obsolete code is deleted.

## 16. Testing strategy

### 16.1 Unit

Add deterministic tests for:

- semantic normalized-history equality;
- all four Context Sync modes;
- changed instructions, rollback/fork and multi-turn tail → REBUILD;
- keyed queue same-key serialization, cross-key parallelism, rejection recovery and cleanup;
- Conversation Page warm reuse, stale closed Page replacement, timeout close, LRU idle eviction, active-capacity error and close lifecycle;
- Driver fresh/current/restore navigation behavior and conversation URL identity failure;
- Phase 4 prompt envelopes and capability validation;
- keyed execution persistence and failed-request snapshot preservation.

Every production behavior change follows red → green TDD.

### 16.2 Integration

Add/extend integration tests for:

- Chat Completions first keyed request then second request APPEND without replaying prior history;
- Responses equivalent behavior;
- same-key requests serialize while different keys can overlap;
- persistence close/reopen causes RESTORE with the saved URL;
- modified caller history causes REBUILD and replaces the persisted URL/snapshot;
- runtime wiring uses the Phase 4 executor and the configured idle timeout.

### 16.3 Deterministic repository verification

`corepack pnpm verify` remains the deterministic completion gate and must not require external ChatGPT access.

### 16.4 Explicit real ChatGPT E2E

Phase 4 completion requires a new explicit real E2E scenario using the isolated authenticated E2E Profile:

1. create a unique Conversation key and send turn 1 through Gateway HTTP;
2. send turn 2 with the same key and full caller history;
3. verify the second request succeeds and the persisted Conversation URL remains the same, proving APPEND on the warm conversation;
4. restart only the Gateway/runtime while preserving SQLite/Profile state;
5. send turn 3 with the same key and full history;
6. verify success through persisted URL RESTORE;
7. include a deterministic challenge phrase so the response can prove earlier context was retained.

Real E2E failure at an external ChatGPT/auth/network boundary must be reported as such and must not be hidden by deterministic tests.

## 17. Documentation and project memory

Phase 4 completion updates:

- `docs/PROJECT_STATE.md` to `phase-4-complete` and the next Phase 5 design task;
- `docs/architecture.md` with implemented Conversation Engine/Page affinity facts;
- `docs/api-compatibility.md` with keyed multi-turn behavior and the no-key Fresh rule;
- `docs/testing.md` with Phase 4 deterministic and real E2E coverage;
- `README.md` and `.env.example` for active `PAGE_IDLE_TIMEOUT_MINUTES` behavior;
- `docs/roadmap.md` Phase 4 status;
- this Phase 4 plan checkboxes/evidence.

No version bump is required because the repository remains at the unreleased `V0.0.1` development baseline and the user did not request a release.

## 18. Success criteria

Phase 4 is complete only when all are true:

1. a keyed first request persists a ChatGPT Conversation URL and synchronized snapshot;
2. the second same-key full-history request selects APPEND and sends only the new user turn;
3. same-key concurrent requests serialize, while different keys can execute concurrently;
4. idle Page affinity is actually closed and a later request selects RESTORE;
5. process/runtime restart with persisted SQLite state selects RESTORE;
6. caller history mutation selects REBUILD and creates a new ChatGPT Conversation URL;
7. failed execution does not overwrite the last successful aggregate;
8. deterministic `corepack pnpm verify` passes;
9. Docker smoke still passes the affected runtime/config boundary;
10. the explicit Phase 4 real ChatGPT E2E passes, or any remaining external blocker is recorded truthfully and Phase 4 is not marked complete;
11. project-memory, docs, Git diff checks, commit and branch push are complete.
