# Phase 7 Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver OpenAI-compatible function Tool Calling across Chat Completions and Responses, including Tool Result continuation, Context Sync, persistence, safe streaming classification, authenticated real ChatGPT E2E, and Phase 7 closure.

**Architecture:** Reuse the existing shared `NormalizedRequest` and Conversation Engine. A new pure `src/tools/` layer canonicalizes tool schemas, builds the private Gateway tool protocol, parses ChatGPT output, and classifies streaming output without Playwright dependencies. Context/Persistence gain first-class assistant Tool Call and tool-result messages; API encoders map one internal union result/event model to Chat Completions and Responses.

**Tech Stack:** Node 24, TypeScript, Fastify, TypeBox/Ajv, `node:sqlite`, Vitest, Playwright Chromium, pnpm 11, Docker `linux/amd64`.

**Spec:** `docs/superpowers/specs/2026-08-26-phase-7-tool-calling-design.md`

## Global Constraints

- Gateway never executes caller-defined functions; it only returns tool calls and accepts tool results.
- Only OpenAI function tools are supported in Phase 7; built-in/MCP/custom tools remain unsupported.
- Tool definition changes conservatively cause `REBUILD(reason='tools_changed')`; tool declaration order alone does not.
- Private marker is fixed as `<<<CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>` / `<<<END_CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>`.
- Tool payload JSON is never exposed as public text content.
- `tool_choice=none|auto|required|function` must have deterministic validation and prompt behavior.
- Tool-call IDs are Gateway-owned and persisted; Responses output item IDs are encoder-owned.
- Text Streaming remains true DOM streaming; tool protocol is safely buffered until completion and then emitted as tool-call protocol chunks.
- Successful stream terminal frames remain later than final SQLite clean commit.
- No new production dependency or database migration is planned unless implementation evidence proves one is required.
- Real ChatGPT E2E is independent acceptance evidence and is not part of deterministic `corepack pnpm verify`.
- No force push, PR, GitHub Release, or Docker registry publish without separate user instruction.

---

## File Map（文件职责）

New files:

- `src/tools/canonicalize.ts` — canonical function tool representation, validation, stable fingerprint.
- `src/tools/protocol.ts` — sentinel constants and shared private protocol types.
- `src/tools/prompt.ts` — tool context/policy/result prompt data builders.
- `src/tools/parser.ts` — strict final Assistant output parser.
- `src/tools/detection-buffer.ts` — stream prefix classifier that never emits private protocol as text.
- `tests/unit/tool-canonicalize.test.ts`
- `tests/unit/tool-prompt.test.ts`
- `tests/unit/tool-parser.test.ts`
- `tests/unit/tool-detection-buffer.test.ts`
- `tests/integration/conversation-tool-calling.test.ts`
- `scripts/test-chatgpt-phase7-e2e.ts`

Primary modified files:

- `src/context/types.ts`, `src/context/multimodal.ts`, `src/context/planner.ts`
- `src/conversations/request-context.ts`, `src/conversations/prompts.ts`, `src/conversations/aggregate-builder.ts`, `src/conversations/conversation-engine.ts`, `src/conversations/errors.ts`
- `src/api/execution.ts`, `src/stream/events.ts`
- `src/api/encode/chat-completions.ts`, `chat-completions-stream.ts`, `responses.ts`, `responses-stream.ts`
- request schemas/normalizers only where deterministic validation or compatibility requires it
- route/integration tests and package scripts for Phase 7 E2E
- docs and Project Memory at closure

---

### Task 1: Canonical Tool Context, Fingerprint, Prompt, and Strict Parser

**Files:**
- Create: `src/tools/canonicalize.ts`
- Create: `src/tools/protocol.ts`
- Create: `src/tools/prompt.ts`
- Create: `src/tools/parser.ts`
- Create: `tests/unit/tool-canonicalize.test.ts`
- Create: `tests/unit/tool-prompt.test.ts`
- Create: `tests/unit/tool-parser.test.ts`
- Modify: `src/conversations/errors.ts`

**Interfaces:**
- Produces: `canonicalizeTools(tools)`, `fingerprintTools(tools)`, `validateToolChoice(tools, choice)`.
- Produces: `TOOL_PROTOCOL_START`, `TOOL_PROTOCOL_END`.
- Produces: `buildToolContext(tools, choice)`, `buildToolPolicy(choice)`, `buildToolResultData(...)` as JSON-safe values used by Conversation prompts.
- Produces: `parseAssistantOutput(text, { tools, toolChoice }) -> {type:'text',text} | {type:'tool_calls',calls:[{name,arguments}]}`.
- Errors must surface through stable Phase 7 conversation errors; no raw parser exceptions escape API routes.

- [ ] **Step 1: Write failing canonicalization tests**

Cover exact semantic invariants:

```ts
expect(fingerprintTools([toolB, toolA])).toBe(fingerprintTools([toolA, toolB]));
expect(fingerprintTools([toolA])).not.toBe(fingerprintTools([changedDescription]));
expect(() => canonicalizeTools([toolA, toolA])).toThrow(/duplicate/i);
expect(() => validateToolChoice([], { mode: 'required' })).toThrow();
expect(() => validateToolChoice([toolA], { mode: 'function', name: 'missing' })).toThrow();
```

Run: `corepack pnpm vitest run tests/unit/tool-canonicalize.test.ts`
Expected: FAIL because `src/tools/canonicalize.ts` does not exist.

- [ ] **Step 2: Implement deterministic canonicalization and fingerprint**

Use existing `fingerprintCanonical()` for SHA-256 stable JSON. Sort object keys recursively and sort top-level tools by name; preserve arrays. Do not include `tool_choice` in tool fingerprint.

- [ ] **Step 3: Run canonicalization tests**

Run: `corepack pnpm vitest run tests/unit/tool-canonicalize.test.ts`
Expected: PASS.

- [ ] **Step 4: Write failing Prompt tests**

Assert `auto`, `none`, `required`, and named-function policies are explicit; assert JSON data contains schemas without string interpolation corruption; assert Tool Result data resolves the persisted function name and keeps output as a JSON data field.

Run: `corepack pnpm vitest run tests/unit/tool-prompt.test.ts`
Expected: FAIL because prompt helpers do not exist.

- [ ] **Step 5: Implement private protocol constants and prompt helpers**

The prompt contract must require the exact envelope:

```text
<<<CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>
{"calls":[{"name":"tool_name","arguments":{}}]}
<<<END_CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>
```

It must explicitly forbid prose/fences around tool calls and forbid fabricating tool results.

- [ ] **Step 6: Run Prompt tests**

Run: `corepack pnpm vitest run tests/unit/tool-prompt.test.ts`
Expected: PASS.

- [ ] **Step 7: Write failing strict Parser tests**

Cover text, one call, multiple calls, malformed start/end markers, leading/trailing non-whitespace, Markdown fences, invalid JSON, extra root/call keys, non-object arguments, unknown tool, `none`, forced wrong tool, required-text response, and 17 calls.

- [ ] **Step 8: Implement `parseAssistantOutput`**

Parser rules are exactly those in spec §8. Re-stringify argument objects to produce legal external JSON argument strings. Do not repair malformed model output.

- [ ] **Step 9: Run Task 1 tests and regression subset**

Run:

```bash
corepack pnpm vitest run \
  tests/unit/tool-canonicalize.test.ts \
  tests/unit/tool-prompt.test.ts \
  tests/unit/tool-parser.test.ts \
  tests/unit/chat-completions-normalizer.test.ts \
  tests/unit/responses-normalizer.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

Commit: `✨ 新增工具规范化与严格解析协议`

---

### Task 2: First-Class Tool Messages in Canonical Context and Planner

**Files:**
- Modify: `src/context/types.ts`
- Modify: `src/context/multimodal.ts`
- Modify: `src/context/planner.ts`
- Modify: `src/conversations/request-context.ts`
- Modify: `src/conversations/prompts.ts`
- Modify: `tests/unit/context-planner.test.ts`
- Modify: `tests/unit/conversation-prompts.test.ts`
- Create/Modify: focused request-context tests under `tests/unit/`

**Interfaces:**
- Canonical messages must represent user, assistant text/attachments, assistant Tool Calls, and tool results without protocol-specific wrappers.
- Planner output changes from a single `currentUser` to `pending: CanonicalMessage[]` while retaining `FRESH|APPEND|RESTORE|REBUILD`.
- Planner input adds current/stored `toolFingerprint?: string` and can return `REBUILD reason='tools_changed'`.
- `selectUploadAttachmentReferences(plan)` scans `history + pending` for FRESH/REBUILD and only `pending` for APPEND/RESTORE.

- [ ] **Step 1: Add failing canonical fingerprint tests**

Prove assistant call ID/name/arguments and tool-result call ID/content affect fingerprints while attachment behavior remains unchanged.

- [ ] **Step 2: Add failing planner tests for tool tails and schema changes**

Cases:

```text
stored assistant tool call + incremental tool result + affinity => APPEND
same without affinity => RESTORE
full request stored prefix + two tool results => APPEND
unknown tool result => rejected before planner
mixed new tool result + user => rejected
tool fingerprint changed => REBUILD tools_changed
tool declaration reorder => equal fingerprint => APPEND
```

- [ ] **Step 3: Generalize canonical context types and planner**

Use `pending: CanonicalMessage[]`. Normal user execution has one pending user; tool continuation has one-or-more pending tool results. Generalize history/prefix helpers without changing Phase 4/5/6 semantics for text-only requests.

- [ ] **Step 4: Generalize request canonicalization and transcript validation**

Validate tool results against request/local call history where possible. Keep attachment semantic resolution unchanged. Reject Structured Output and image output with Phase 7-specific unsupported error once Phase 7 entry point is enabled.

- [ ] **Step 5: Upgrade Context/Append Prompt to version 2**

FRESH/REBUILD context includes full canonical tool context plus structured history/pending. APPEND/RESTORE includes current `tool_policy` plus pending messages and omits unchanged full schema.

- [ ] **Step 6: Run Task 2 tests plus Phase 4/6 context regressions**

Run:

```bash
corepack pnpm vitest run \
  tests/unit/context-planner.test.ts \
  tests/unit/conversation-prompts.test.ts \
  tests/integration/conversation-context-sync.test.ts \
  tests/integration/conversation-attachments.test.ts
```

Expected: PASS with unchanged text/attachment behavior.

- [ ] **Step 7: Commit Task 2**

Commit: `✨ 扩展工具调用上下文同步语义`

---

### Task 3: Persist Tool Calls and Tool Results in Conversation Aggregate

**Files:**
- Modify: `src/conversations/aggregate-builder.ts`
- Modify: `src/conversations/conversation-engine.ts` stored canonical conversion helpers
- Modify: `tests/unit/conversation-aggregate-builder.test.ts`
- Modify: `tests/unit/persistence-tools-attachments.test.ts`
- Modify: `tests/integration/persistence-recovery.test.ts`

**Interfaces:**
- Aggregate builder consumes assistant result union instead of `assistantText` only.
- It creates `ToolCallRecord[]` tied to the assistant MessageRecord and preserves reusable-prefix call records.
- Stored aggregate canonicalization joins `tool_calls` by `messageId` and preserves `externalCallId`.
- Tool-result MessageRecord retains `toolCallId` and is validated by existing repository aggregate checks.

- [ ] **Step 1: Write failing aggregate tests**

Build a canonical transcript with assistant Tool Call → tool result → final assistant text. Assert exact roles, sequences, external call IDs, argument text, message IDs, and prefix reuse.

- [ ] **Step 2: Implement Tool Call/Result record creation and stored reconstruction**

Do not add a DB migration. Reuse existing Phase 2 tables and repository validation.

- [ ] **Step 3: Add restart round-trip test**

Save aggregate, close/reopen SQLite, load by key, and prove call identity/result linkage survives.

- [ ] **Step 4: Run persistence and aggregate tests**

Run:

```bash
corepack pnpm vitest run \
  tests/unit/conversation-aggregate-builder.test.ts \
  tests/unit/persistence-tools-attachments.test.ts \
  tests/integration/persistence-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Commit: `✨ 持久化工具调用与结果会话记录`

---

### Task 4: Internal Execution Union and Non-Streaming Conversation Tool Loop

**Files:**
- Modify: `src/api/execution.ts`
- Modify: `src/stream/events.ts`
- Modify: `src/conversations/conversation-engine.ts`
- Modify: `src/conversations/errors.ts`
- Create: `tests/integration/conversation-tool-calling.test.ts`
- Modify: `tests/integration/conversation-engine.test.ts`

**Interfaces:**

```ts
type NormalizedExecutionResult = TextExecutionResult | ToolCallExecutionResult;
interface ToolCallExecutionResult {
  type: 'tool_calls';
  toolCalls: NormalizedToolCall[];
  conversationUrl: string;
  completedAt: number;
}
```

Engine generates external call IDs only after a strict parser success; final clean aggregate is saved before result return.

- [ ] **Step 1: Write failing non-stream engine tests**

Use fake Driver outputs containing the private protocol. Cover one call, multiple calls, auto text, required-text failure, malformed protocol, unknown tool, forced tool violation, and call-ID stability after persistence.

- [ ] **Step 2: Implement Phase 7 request entry/capability validation**

Tools and tool history become supported. Structured Output/image output remain `unsupported_phase7_request`. Keep Phase 4/5/6 public behavior unchanged through the same engine.

- [ ] **Step 3: Parse final Assistant DOM output and generate call IDs**

Call `parseAssistantOutput`; map parsed calls to `NormalizedToolCall` with Gateway IDs; build/save final aggregate; return union result.

- [ ] **Step 4: Implement Tool Result continuation prompt path**

Resolve each pending tool result against persisted/request assistant Tool Calls and include function name + result in private prompt data. Confirm fake Driver receives no repeated full schema on unchanged APPEND.

- [ ] **Step 5: Run engine integration subset**

Run:

```bash
corepack pnpm vitest run \
  tests/integration/conversation-tool-calling.test.ts \
  tests/integration/conversation-engine.test.ts \
  tests/integration/conversation-context-sync.test.ts \
  tests/integration/conversation-attachments.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Commit: `✨ 打通非流式工具调用与结果回传`

---

### Task 5: Chat Completions and Responses Non-Streaming Encoders

**Files:**
- Modify: `src/api/encode/chat-completions.ts`
- Modify: `src/api/encode/responses.ts`
- Modify: `tests/unit/response-encoders.test.ts`
- Modify: route integration tests for both endpoints

**Interfaces:**
- Chat Completions maps `tool_calls` result to `content:null`, function calls, `finish_reason:'tool_calls'`.
- Responses maps each internal Tool Call to a completed `function_call` output item with stable `call_id` and encoder-owned `fc_...` item ID.

- [ ] **Step 1: Write failing encoder tests with deterministic IDs/timestamps**

Assert exact JSON shapes for one and two calls and preserve existing text shapes.

- [ ] **Step 2: Implement union-aware non-stream encoders**

Do not add usage. Do not expose private protocol text.

- [ ] **Step 3: Add HTTP integration tests through both Normalizers and shared engine fake**

Assert Chat Completions and Responses represent semantically identical calls with the same internal call IDs.

- [ ] **Step 4: Run encoder/API subset**

Run:

```bash
corepack pnpm vitest run \
  tests/unit/response-encoders.test.ts \
  tests/integration/api-routes.test.ts \
  tests/integration/conversation-tool-calling.test.ts
```

If route tests use different filenames, run the exact existing route integration file discovered in the repo plus the new tool integration test.

- [ ] **Step 5: Commit Task 5**

Commit: `✨ 输出双协议工具调用响应`

---

### Task 6: Tool Detection Buffer and Streaming Encoders

**Files:**
- Create: `src/tools/detection-buffer.ts`
- Create: `tests/unit/tool-detection-buffer.test.ts`
- Modify: `src/stream/events.ts`
- Modify: `src/conversations/conversation-engine.ts`
- Modify: `src/api/encode/chat-completions-stream.ts`
- Modify: `src/api/encode/responses-stream.ts`
- Modify: `tests/unit/stream-encoders.test.ts`
- Modify: `tests/integration/conversation-streaming.test.ts`
- Modify: `tests/integration/stream-routes.test.ts`

**Interfaces:**
- `ToolDetectionBuffer` consumes stable text deltas and either emits safe public text deltas or buffers the complete private tool envelope.
- Internal stream gains `{type:'tool_calls', toolCalls}` before `{type:'completed', result}`.
- Tool protocol parse/generate/persist completes before tool-call stream event and success terminal.

- [ ] **Step 1: Write failing detection-buffer tests**

Cases: partial marker across many deltas, normal text diverging at byte/code-point 1 and later, full marker in first delta, private marker appearing after text classification, completion on partial marker, and no-tool bypass.

- [ ] **Step 2: Implement pure detection buffer**

No imports from Playwright/API/Persistence. Never emit any private marker character after a Tool classification. If marker appears after text classification, raise protocol-invalid before emitting marker/payload.

- [ ] **Step 3: Write failing stream encoder tests**

Chat Completions expected lifecycle: role → one/more `delta.tool_calls` → terminal `finish_reason:'tool_calls'` → `[DONE]`.

Responses expected lifecycle per call: `response.output_item.added` → `response.function_call_arguments.delta` → `.done` → `response.output_item.done`, then one `response.completed`.

- [ ] **Step 4: Implement tool-aware engine Streaming**

Keep `streamAssistantText` as DOM Stable Prefix source. Route deltas through detector only when tools exist. On Tool classification, buffer final DOM output, parse after generation completion, allocate IDs, save clean aggregate, then emit tool-call event and completed event.

- [ ] **Step 5: Implement union-aware stream encoders**

Text event shapes stay byte-for-byte compatible with Phase 5 where possible. Tool events use current OpenAI-compatible field/event names.

- [ ] **Step 6: Run streaming regression subset**

Run:

```bash
corepack pnpm vitest run \
  tests/unit/tool-detection-buffer.test.ts \
  tests/unit/stream-encoders.test.ts \
  tests/unit/text-stream.test.ts \
  tests/integration/conversation-streaming.test.ts \
  tests/integration/conversation-streaming-consistency.test.ts \
  tests/integration/stream-routes.test.ts
```

Expected: PASS; existing text Streaming tests remain green.

- [ ] **Step 7: Commit Task 6**

Commit: `✨ 增加工具调用流式检测与协议输出`

---

### Task 7: Full HTTP Capability Gate, Error Framing, and Cross-Feature Regression

**Files:**
- Modify: `src/conversations/request-context.ts`
- Modify: `src/conversations/errors.ts`
- Modify: API route error mapping files discovered by `rg "unsupported_phase6_request" src`
- Modify: `src/api/schemas/common.ts` only if current Phase 7 approved function-tool input needs a compatible field already represented by V1; do not broaden to built-in/custom/MCP tools.
- Modify: integration route tests
- Modify: `tests/integration/conversation-attachments.test.ts`

**Interfaces:**
- Tool requests no longer return `unsupported_phase6_request`.
- Remaining later-phase capabilities return `unsupported_phase7_request`.
- Pre-SSE invalid request/parser-prestart failures use HTTP OpenAI-style errors; post-start parser errors use protocol stream errors and no success terminal.

- [ ] **Step 1: Add failing real Fastify integration cases**

Cover both endpoints, stream/non-stream, tool results, malformed/unknown call reference, same-key slow FIFO, different-key parallel, tool + attachment request, and post-start malformed tool protocol.

- [ ] **Step 2: Update capability/error mapping**

Add Phase 7 stable codes from the spec and keep sensitive arguments/results out of error messages/logs.

- [ ] **Step 3: Prove attachments + tools coexist**

Fake Driver must receive expected staged attachments and tool schema/policy. APPEND tool result must not re-upload historical attachments unless Context Sync selects REBUILD.

- [ ] **Step 4: Run all deterministic tests**

Run: `corepack pnpm test`
Expected: all test files pass.

- [ ] **Step 5: Run type/lint/build/repo governance**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm verify:repo
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

Commit: `✨ 完成 Phase 7 工具调用 HTTP 集成`

---

### Task 8: Phase 7 Authenticated Real ChatGPT E2E Harness

**Files:**
- Create: `scripts/test-chatgpt-phase7-e2e.ts`
- Modify: `scripts/test-chatgpt-e2e.ts`
- Modify: `package.json`
- Modify: `docs/testing.md` only for harness invocation/rules that become true
- Add any deterministic fixture helper under `scripts/e2e/` following existing Phase 6 patterns

**Interfaces:**
- New package script: `test:e2e:chatgpt:phase7` using the same Xvfb/Profile/proxy conventions as Phase 3–6.
- Combined harness gains a separately opt-in Phase 7 stage and reuses one authenticated browser/runtime process where existing policy requires it.

- [ ] **Step 1: Read the full Phase 6 standalone and combined harness before editing**

Use existing profile, request-budget, retry/backoff, redaction, and clean shutdown patterns. Do not create a second incompatible harness framework.

- [ ] **Step 2: Add deterministic harness assertions before live execution**

The Phase 7 harness must verify at least:

```text
single tool non-stream
result -> final text
multiple calls
stream tool with zero private marker leak
stream auto text emits meaningful delta before completion
RESTORE tool result continuation
tool schema change REBUILD
```

Use simple deterministic pseudo-tools whose results are supplied by the harness itself; Gateway never executes them.

- [ ] **Step 3: Add package script and combined Phase 7 stage**

Run static/type tests for scripts before touching live ChatGPT.

- [ ] **Step 4: Run fresh authenticated inspect gate**

Run: `corepack pnpm inspect:chatgpt` with the project’s approved E2E environment/profile/proxy.
Expected: authenticated, unique Composer, no unresolved challenge.

- [ ] **Step 5: Run standalone Phase 7 real E2E**

Run: `corepack pnpm test:e2e:chatgpt:phase7` with the same approved environment.
Expected: exit code 0 and all seven semantic groups true.

If ChatGPT rate-limit/challenge appears, follow `docs/testing.md`; do not spam retries or weaken assertions.

- [ ] **Step 6: Commit E2E harness after standalone success**

Commit: `🧪 增加 Phase 7 真实工具调用验收`

---

### Task 9: Docker Regression and Combined Phase 3→7 Real E2E

**Files:**
- No product file change expected unless verification reveals a real defect.
- Update plan checkboxes/evidence after successful runs.

**Interfaces:**
- Produces closure evidence, not a new product abstraction.

- [ ] **Step 1: Run fresh deterministic full verify**

Run: `corepack pnpm verify`
Expected: format/lint/typecheck/all tests/build/repo checks pass.

- [ ] **Step 2: Build fresh `linux/amd64` Docker image**

Run: `corepack pnpm docker:build`
Record resulting image ID/digest in plan/Project State only after success.

- [ ] **Step 3: Run full Docker smoke**

Run: `corepack pnpm docker:smoke`
Expected: migrations, restart lifecycle, Browser/noVNC/seccomp, permissions and prior smoke assertions all pass.

- [ ] **Step 4: Run fresh authenticated inspect if enough time/session budget elapsed**

Run: `corepack pnpm inspect:chatgpt`.

- [ ] **Step 5: Run combined Phase 3/4/5/6/7 E2E**

Use the repository’s combined opt-in flag exactly as defined by the harness.
Expected: one process exits 0 with all prior phase assertions plus Phase 7 true.

- [ ] **Step 6: Fix only evidence-backed defects**

Any failure triggers `superpowers:systematic-debugging`, a focused failing deterministic regression where possible, minimal fix, standalone phase re-check, then combined re-check. Do not weaken existing assertions to make the run green.

- [ ] **Step 7: Commit any verification-driven fix separately**

Use a concrete `🐛` commit describing the actual defect. If no code changes were needed, no commit is required for this step.

---

### Task 10: Documentation, Project Memory, Final Verification, Plan Closure, and Push

**Files:**
- Modify: `README.md`
- Modify: `docs/api-compatibility.md`
- Modify: `docs/architecture.md`
- Modify: `docs/testing.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/specs/2026-08-26-phase-7-tool-calling-design.md`
- Modify: `docs/superpowers/plans/2026-08-26-phase-7-tool-calling.md`
- Modify: `docs/PROJECT_STATE.md`

**Interfaces:**
- Final Project State target after all evidence succeeds:

```text
PHASE=phase-7-complete
STATUS=ready-for-phase-8-design
GOVERNING_SPEC=docs/superpowers/specs/2026-08-26-phase-7-tool-calling-design.md
ACTIVE_PLAN=none
NEXT_TASK=write-phase-8-image-generation-spec
```

- [ ] **Step 1: Write back actual implemented compatibility**

Mark function Tools/Tool Result/tool choice current support accurately for both APIs. Document buffered tool-argument Streaming honestly and keep Structured Output/Image Generation unsupported.

- [ ] **Step 2: Update architecture/testing/roadmap/README**

Record canonical tool context, private protocol/parser, tool-result continuation, persisted call IDs, Streaming detector, exact deterministic test counts, Docker evidence, standalone/combined real-E2E evidence, and remaining limitations.

- [ ] **Step 3: Mark Tasks 1–10 evidence accurately**

No checkbox may be checked without corresponding current-session evidence or committed historical evidence produced by this Phase.

- [ ] **Step 4: Run fresh final verification after documentation changes**

Run:

```bash
corepack pnpm verify
git diff --check
corepack pnpm project:status
```

Expected: all green; project status matches Phase 7 finalizing/closure state.

- [ ] **Step 5: Inspect staged diff and commit final writeback**

Commit implementation/evidence writeback: `📝 完成 Phase 7 工具调用验收回写`.

- [ ] **Step 6: Close the Active Plan**

Set `ACTIVE_PLAN=none`, `PHASE=phase-7-complete`, `STATUS=ready-for-phase-8-design`, `NEXT_TASK=write-phase-8-image-generation-spec`; update this plan status to closed.

Run project-memory/docs/diff checks again, then commit: `📝 关闭 Phase 7 实施计划`.

- [ ] **Step 7: Push feature branch normally**

Run:

```bash
git status --short --branch
git log --oneline --decorate -12
git push -u origin phase-7-tool-calling
git status --short --branch
git rev-list --left-right --count origin/phase-7-tool-calling...phase-7-tool-calling
```

Expected: clean working tree and ahead/behind `0 0`; no force push.
