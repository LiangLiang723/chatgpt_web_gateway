# Phase 3 Browser Runtime and Minimal ChatGPT Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing protocol-only Gateway into a real Fresh, non-streaming, text-only ChatGPT Web Gateway backed by a persistent Playwright Chromium runtime, with deterministic offline tests and explicit real ChatGPT E2E acceptance.

**Architecture:** `GatewayRuntime` owns persistence plus a headless `BrowserManager`; `BrowserManager` owns one Persistent BrowserContext and bounded `PagePool`. `Phase3Executor` validates the Fresh text-only capability boundary and leases a Page to `ChatGptDriver`, while ChatGPT DOM knowledge stays isolated behind a strict Selector Registry. `UI_MODE=novnc` disables the product BrowserManager so the headed maintenance browser remains the only owner of `/data/browser-profile/`.

**Tech Stack:** Node.js 24.x, TypeScript 6, Playwright 1.62.1 bundled Chromium, Fastify 5, Vitest 4, TypeBox/Ajv, Docker Compose, existing `node:sqlite` persistence.

## Global Constraints

- Keep `playwright@1.62.1` matched to `mcr.microsoft.com/playwright:v1.62.1-noble`; do not upgrade dependencies in this phase.
- Use only Playwright bundled Chromium; no external Chrome/Edge executable path or private ChatGPT `/backend-api` calls.
- Production profile is always `join(DATA_DIR, 'browser-profile')`.
- `UI_MODE=headless` owns the production Profile through `BrowserManager`; `UI_MODE=novnc` must not start the product BrowserManager.
- Default `MAX_ACTIVE_PAGES=4`; Phase 3 does not implement queueing, idle eviction, conversation affinity, URL restore, or Context Sync.
- ChatGPT selectors live only in `src/chatgpt/selectors.ts`; unique selectors never use `.first()`, `.last()`, or `.nth()` to hide ambiguity.
- Phase 3 accepts only Fresh, non-streaming, text-only requests. Conversation key/history, tools, attachments, structured output, image output, and streaming are explicit errors.
- Gateway never automates ChatGPT credentials, MFA, CAPTCHA, or risk challenges.
- `corepack pnpm verify` and `docker:smoke` remain deterministic and must not access real ChatGPT.
- Real E2E requires `E2E_CHATGPT=1` and an explicit non-production `CHATGPT_PROFILE_DIR`; it is the only evidence that current ChatGPT selectors/login/text execution work.
- Do not persist screenshots/DOM unless `CHATGPT_DIAGNOSTICS_DIR` is explicitly supplied.
- Do not commit Browser Profiles, cookies, DB files, real uploads, generated images, screenshots, DOM snapshots, or secrets.

---

### Task 1: Runtime browser configuration, BrowserManager, and bounded PagePool

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/index.ts`
- Create: `src/browser/errors.ts`
- Create: `src/browser/types.ts`
- Create: `src/browser/page-pool.ts`
- Create: `src/browser/browser-manager.ts`
- Modify: `tests/unit/config.test.ts`
- Create: `tests/unit/page-pool.test.ts`
- Create: `tests/unit/browser-manager.test.ts`

**Interfaces:**
- Produces: `AppConfig.maxActivePages: number` default `4`.
- Produces: `BrowserRuntimeError` with stable code `browser_unavailable | page_capacity_exceeded`.
- Produces: `PagePool.acquire(): Promise<PageLease>`, `PageLease.release(): Promise<void>`, `PagePool.close(): Promise<void>`.
- Produces: `createBrowserManager({ profileDir, maxActivePages, launchPersistentContext? }): Promise<BrowserManager>`.
- Later tasks consume only `PagePool` / `PageLease`, not raw BrowserManager internals.

- [x] **Step 1: Add failing config tests for `MAX_ACTIVE_PAGES`**

Extend `tests/unit/config.test.ts`:

```ts
expect(loadConfig({ GATEWAY_API_KEY: 'secret' }).maxActivePages).toBe(4);
expect(
  loadConfig({ GATEWAY_API_KEY: 'secret', MAX_ACTIVE_PAGES: '7' }).maxActivePages,
).toBe(7);
expect(() =>
  loadConfig({ GATEWAY_API_KEY: 'secret', MAX_ACTIVE_PAGES: '0' }),
).toThrow(/MAX_ACTIVE_PAGES/);
```

- [x] **Step 2: Run config test and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/config.test.ts
```

Expected: FAIL because `AppConfig` has no `maxActivePages`.

- [x] **Step 3: Implement config field**

Add schema field:

```ts
maxActivePages: Type.Integer({ minimum: 1, maximum: 32 }),
```

Load with:

```ts
maxActivePages: parseInteger('MAX_ACTIVE_PAGES', env.MAX_ACTIVE_PAGES, 4, 1, 32),
```

Do not add page idle timeout.

- [x] **Step 4: Write failing PagePool tests using fake Page/Context boundaries**

Tests must prove:

```ts
const first = await pool.acquire();
expect(pool.openCount).toBe(1);
expect(pool.leasedCount).toBe(1);
await first.release();
expect(pool.idleCount).toBe(1);

const reused = await pool.acquire();
expect(reused.page).toBe(first.page);
```

Also prove:

```ts
await pool.acquire(); // page 1
await pool.acquire(); // page 2, max=2
await expect(pool.acquire()).rejects.toMatchObject({ code: 'page_capacity_exceeded' });
```

And:

- PagePool adopts `context.pages()` existing pages as initial idle Pages rather than leaking/duplicating the Persistent Context startup Page;
- double `release()` is safe;
- a Page already closed before release is removed instead of returned idle;
- Page `close` event removes an idle Page;
- `pool.close()` closes all tracked Pages and rejects new acquire;
- one Page failure never closes sibling Pages.

- [x] **Step 5: Run PagePool tests and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/page-pool.test.ts
```

Expected: FAIL because `PagePool` does not exist.

- [x] **Step 6: Implement browser errors/types and PagePool**

Stable error shape:

```ts
export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: 'browser_unavailable' | 'page_capacity_exceeded',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'BrowserRuntimeError';
  }
}
```

`PagePool` must track open leases explicitly. Capacity is `openCount`, not “currently leased count”. A closed Page must be removed from all tracking sets.

- [x] **Step 7: Write failing BrowserManager tests with injected launcher**

Use an injected `launchPersistentContext` fake to assert exact launch boundary:

```ts
expect(launch).toHaveBeenCalledWith(profileDir, expect.objectContaining({
  headless: true,
  viewport: { width: 1440, height: 900 },
}));
```

Also assert:

- profile directory is created before launch;
- launcher failure becomes `{ code: 'browser_unavailable' }` without exposing profile contents;
- manager `close()` is idempotent;
- closing manager closes PagePool before BrowserContext.

- [x] **Step 8: Run BrowserManager test and verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/browser-manager.test.ts
```

Expected: FAIL because BrowserManager does not exist.

- [x] **Step 9: Implement BrowserManager**

Default launcher wrapper:

```ts
const defaultLaunch = (profileDir: string, options: LaunchPersistentContextOptions) =>
  chromium.launchPersistentContext(profileDir, options);
```

`createBrowserManager()` awaits the context, creates a `PagePool`, and returns an idempotent async `close()`.

Do not navigate to ChatGPT here.

- [x] **Step 10: Run Task 1 verification**

Run:

```bash
corepack pnpm vitest run tests/unit/config.test.ts tests/unit/page-pool.test.ts tests/unit/browser-manager.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 11: Update plan/state and commit Task 1**

Commit:

```text
🌐 建立 BrowserManager 与有界 Page Pool
```

---

### Task 2: Selector Registry, auth probe, and deterministic diagnostics

**Files:**
- Create: `src/chatgpt/errors.ts`
- Create: `src/chatgpt/selectors.ts`
- Create: `src/chatgpt/selector-registry.ts`
- Create: `src/chatgpt/auth.ts`
- Create: `tests/unit/chatgpt-selector-registry.test.ts`
- Create: `tests/unit/chatgpt-auth.test.ts`

**Interfaces:**
- Produces: `ChatGptDriverError` stable codes `auth_required | selector_missing | selector_ambiguous | chatgpt_generation_timeout | chatgpt_response_missing`.
- Produces: selector definitions from `src/chatgpt/selectors.ts` only.
- Produces: `resolveUnique(page, definition)` and `resolveCollection(page, definition)`.
- Produces: `probeAuth(page): Promise<ChatGptAuthState>`.

- [x] **Step 1: Write failing selector-registry tests**

Use narrow fake `Page` / `Locator` objects that implement only the candidate factory and `count()` behavior required by the registry. Default `verify` must not need a real browser binary just to test selector resolution.

Prove unique resolution semantics:

```ts
const resolved = await resolveUnique(page, composerDefinition);
expect(resolved.candidateName).toBe('primary');
```

Fallback:

```ts
expect((await resolveUnique(pageWithoutPrimary, definition)).candidateName).toBe('fallback');
```

Errors:

```ts
await expect(resolveUnique(missingPage, definition)).rejects.toMatchObject({
  code: 'selector_missing',
});
await expect(resolveUnique(ambiguousPage, definition)).rejects.toMatchObject({
  code: 'selector_ambiguous',
});
```

Collection resolution returns count without treating `count > 1` as ambiguity.

- [x] **Step 2: Run selector tests and verify red**

```bash
corepack pnpm vitest run tests/unit/chatgpt-selector-registry.test.ts
```

Expected: FAIL because selector modules do not exist.

- [x] **Step 3: Implement selector definitions and registry**

Definitions must cover at minimum:

```text
composer           unique
sendButton         unique
loginIndicator     unique
assistantTurns     collection
userTurns          collection
stopControl        unique-but-optional-at-idle
thinkingIndicator  collection/optional
```

Candidate implementation may use `getByRole`, `getByPlaceholder`, and stable attribute locators. All selector literal construction belongs in `selectors.ts`; registry consumes candidate factory functions and counts matches.

Do not mark any candidate “real verified” until Task 9 real inspection.

- [x] **Step 4: Write failing auth probe tests**

Prove:

```ts
expect(await probeAuth(authenticatedPage)).toEqual({ state: 'authenticated' });
expect(await probeAuth(loginPage)).toEqual({ state: 'auth_required' });
expect((await probeAuth(unknownPage)).state).toBe('unknown');
```

If composer itself is ambiguous, do not return `auth_required`; preserve selector ambiguity.

- [x] **Step 5: Run auth tests and verify red**

```bash
corepack pnpm vitest run tests/unit/chatgpt-auth.test.ts
```

Expected: FAIL because auth probe does not exist.

- [x] **Step 6: Implement `probeAuth`**

Order:

```ts
const composer = await inspectUnique(page, selectors.composer);
if (composer.status === 'unique') return { state: 'authenticated' };
if (composer.status === 'ambiguous') throw selectorAmbiguous(...);

const login = await inspectUnique(page, selectors.loginIndicator);
if (login.status === 'unique') return { state: 'auth_required' };
if (login.status === 'ambiguous') throw selectorAmbiguous(...);
return { state: 'unknown', reason: 'composer_and_login_indicator_missing' };
```

- [x] **Step 7: Run Task 2 verification**

```bash
corepack pnpm vitest run tests/unit/chatgpt-selector-registry.test.ts tests/unit/chatgpt-auth.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 8: Update plan/state and commit Task 2**

Commit:

```text
🌐 增加 ChatGPT Selector Registry 与认证探测
```

---

### Task 3: Completion observer and Fresh ChatGPT text Driver

**Files:**
- Create: `src/chatgpt/completion.ts`
- Create: `src/chatgpt/driver.ts`
- Create: `tests/unit/chatgpt-completion.test.ts`
- Create: `tests/unit/chatgpt-driver.test.ts`

**Interfaces:**
- Produces: `waitForAssistantCompletion(options): Promise<string>`.
- Produces: `ChatGptDriver.sendText(page, { prompt }): Promise<{ text; conversationUrl }>`.
- Consumes: Task 2 selectors/registry/auth.

- [x] **Step 1: Write failing completion-observer tests using scripted DOM snapshots**

Define an injectable observation clock so unit tests do not really wait 250ms:

```ts
interface CompletionClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
```

Test sequence:

```text
sample 1: generating=true, text='Hel'
sample 2: generating=false, text='Hello'
sample 3: generating=false, text='Hello'
sample 4: generating=false, text='Hello'
→ return 'Hello'
```

Also prove:

- empty stable text does not complete;
- text change resets stability count;
- timeout throws `chatgpt_generation_timeout`;
- missing target turn throws `chatgpt_response_missing`.

- [x] **Step 2: Run completion tests and verify red**

```bash
corepack pnpm vitest run tests/unit/chatgpt-completion.test.ts
```

Expected: FAIL because completion observer does not exist.

- [x] **Step 3: Implement completion observer**

Defaults:

```ts
pollIntervalMs: 250
stableSamples: 3
timeoutMs: 120_000
```

Every loop reads real state; `sleep()` is only polling cadence. Completion requires `!generating && text.length > 0 && consecutiveStable >= stableSamples`.

- [x] **Step 4: Write failing ChatGPTDriver orchestration tests**

Use fakes for `probeAuth`, registry, composer, send button, assistant collection, and completion observer.

Prove order and ownership:

```ts
expect(assistantTurns.count).toHaveBeenCalledBefore(composer.fill);
expect(completion).toHaveBeenCalledWith(expect.objectContaining({ turnIndex: baseline }));
```

Also prove:

- page first navigates to `https://chatgpt.com/` with `waitUntil: 'domcontentloaded'`;
- `auth_required` becomes `ChatGptDriverError('auth_required')`;
- unknown auth becomes selector error, not auth error;
- composer is filled with the exact prompt;
- send button click happens after fill;
- final result uses final completion text and `page.url()`;
- no `networkidle` wait is used.

- [x] **Step 5: Run Driver tests and verify red**

```bash
corepack pnpm vitest run tests/unit/chatgpt-driver.test.ts
```

Expected: FAIL because Driver does not exist.

- [x] **Step 6: Implement Fresh text Driver**

Core shape:

```ts
async sendText(page, request) {
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  const auth = await probeAuth(page);
  if (auth.state === 'auth_required') throw new ChatGptDriverError('auth_required', ...);
  if (auth.state !== 'authenticated') throw new ChatGptDriverError('selector_missing', ...);

  const turns = resolveCollection(page, selectors.assistantTurns);
  const baseline = await turns.count();
  const composer = await resolveUnique(page, selectors.composer);
  await composer.locator.fill(request.prompt);
  const send = await resolveUnique(page, selectors.sendButton);
  await send.locator.click();
  const text = await waitForAssistantCompletion({ page, assistantTurns: turns, turnIndex: baseline, ... });
  return { text, conversationUrl: page.url() };
}
```

Do not add upload/tool/streaming behavior.

- [x] **Step 7: Run Task 3 verification**

```bash
corepack pnpm vitest run tests/unit/chatgpt-completion.test.ts tests/unit/chatgpt-driver.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 8: Update plan/state and commit Task 3**

Commit:

```text
🌐 实现 Fresh ChatGPT 文本 Driver 与完成检测
```

---

### Task 4: Phase3Executor capability boundary and instruction envelope

**Files:**
- Create: `src/conversations/phase3-executor.ts`
- Create: `tests/unit/phase3-executor.test.ts`

**Interfaces:**
- Produces: `buildPhase3Prompt(request): string`.
- Produces: `createPhase3Executor({ pagePool, driver, now }): NormalizedExecutionHandler` returning `Phase3TextExecutionResult`.
- Produces stable execution errors `conversation_sync_not_implemented | unsupported_phase3_request`.

- [x] **Step 1: Write failing capability validation tests**

Build minimal normalized request fixture and prove accepted shape:

```ts
const result = await executor.execute(request({
  instructions: [
    { role: 'system', content: 'system one' },
    { role: 'developer', content: 'developer one' },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}));
```

Reject as `conversation_sync_not_implemented`:

```text
conversationKey present
assistant history
role=tool history
more than one user message
```

Reject as `unsupported_phase3_request`:

```text
stream=true
attachments
any attachment content part
tools
required/function toolChoice
structured output
output.mode=image
```

- [x] **Step 2: Run executor test and verify red**

```bash
corepack pnpm vitest run tests/unit/phase3-executor.test.ts
```

Expected: FAIL because executor does not exist.

- [x] **Step 3: Add envelope tests before implementation**

Assert exact JSON semantic content rather than hand-written escaping:

```ts
const prompt = buildPhase3Prompt(requestWithQuotesAndNewlines);
const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
expect(payload).toEqual({
  system: ['say "safe"'],
  developer: ['line 1\nline 2'],
  user: 'hello\nworld',
});
```

Multiple user text parts concatenate deterministically with newline separator; empty text-only user request is rejected as invalid Phase 3 input.

- [x] **Step 4: Implement validation + envelope + executor leasing**

Executor must acquire and release in `finally`:

```ts
const lease = await pagePool.acquire();
try {
  const driverResult = await driver.sendText(lease.page, { prompt });
  return {
    type: 'text',
    text: driverResult.text,
    conversationUrl: driverResult.conversationUrl,
    completedAt: now(),
  };
} finally {
  await lease.release();
}
```

Tests must prove release on success, auth error, selector error, and timeout.

- [x] **Step 5: Run Task 4 verification**

```bash
corepack pnpm vitest run tests/unit/phase3-executor.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 6: Update plan/state and commit Task 4**

Commit:

```text
✨ 增加 Phase 3 Fresh 文本执行边界
```

---

### Task 5: OpenAI-style response encoders and stable API error mapping

**Files:**
- Modify: `src/api/errors.ts`
- Modify: `src/api/execution.ts`
- Create: `src/api/encode/chat-completions.ts`
- Create: `src/api/encode/responses.ts`
- Modify: `src/api/routes/chat-completions.ts`
- Modify: `src/api/routes/responses.ts`
- Modify: `tests/integration/post-routes.test.ts`
- Create: `tests/unit/response-encoders.test.ts`

**Interfaces:**
- `NormalizedExecutionHandler` returns a typed protocol-neutral execution result instead of `unknown`.
- Produces `encodeChatCompletion(result, meta)` and `encodeResponse(result, meta)`.
- Produces Gateway errors for all Phase 3 stable codes, including `browser_maintenance_mode`.

- [x] **Step 1: Write failing response encoder tests**

Chat Completions expected essentials:

```ts
expect(encodeChatCompletion(result, { id: 'chatcmpl_test', created: 100 })).toEqual({
  id: 'chatcmpl_test',
  object: 'chat.completion',
  created: 100,
  model: 'chatgpt-web',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'hello' },
    finish_reason: 'stop',
  }],
});
```

Responses expected essentials:

```ts
expect(response).toMatchObject({
  object: 'response',
  status: 'completed',
  model: 'chatgpt-web',
  output: [{
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hello', annotations: [] }],
  }],
  usage: null,
});
```

No fake token usage in Chat Completions.

- [x] **Step 2: Run encoder tests and verify red**

```bash
corepack pnpm vitest run tests/unit/response-encoders.test.ts
```

Expected: FAIL because encoders do not exist.

- [x] **Step 3: Implement typed execution result and encoders**

Use Node `randomUUID()` to create Gateway-local IDs with `chatcmpl_`, `resp_`, and `msg_` prefixes. Timestamps exposed in OpenAI-style responses are Unix seconds; executor internal `completedAt` remains milliseconds.

- [x] **Step 4: Write failing API error mapping tests**

Extend HTTP tests so injected execution errors map exactly:

```text
auth_required                    → 503
browser_unavailable              → 503
browser_maintenance_mode         → 503
page_capacity_exceeded           → 503
selector_missing                 → 502
selector_ambiguous               → 502
chatgpt_generation_timeout       → 504
chatgpt_response_missing         → 502
conversation_sync_not_implemented→ 501
unsupported_phase3_request       → 501
```

401 remains only Gateway API key failure.

- [x] **Step 5: Implement error mapper**

Add API-layer GatewayError subclasses/factory without importing Playwright. Browser/chatgpt/executor error classes should be mapped at one execution adapter boundary, not in Fastify routes by inspecting raw Playwright strings.

- [x] **Step 6: Update POST routes to encode shared execution result**

Routes become:

```ts
const result = await execute(normalized);
return encodeChatCompletion(result, responseMeta);
```

and equivalent Responses encoder. Existing fake execution integration tests remain network/browser-free.

- [x] **Step 7: Run Task 5 verification**

```bash
corepack pnpm vitest run tests/unit/response-encoders.test.ts tests/integration/post-routes.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 8: Update plan/state and commit Task 5**

Commit:

```text
✨ 接入 Phase 3 文本响应编码与稳定错误映射
```

---

### Task 6: Gateway runtime integration, maintenance-mode exclusion, and inspect CLI

**Files:**
- Modify: `src/runtime.ts`
- Create: `src/chatgpt/inspect.ts`
- Create: `scripts/inspect-chatgpt.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `tests/integration/runtime-browser.test.ts`
- Create: `tests/unit/inspect-chatgpt.test.ts`

**Interfaces:**
- Headless `GatewayRuntime` owns `browser?: BrowserManager` and real Phase3 execution handler.
- Maintenance `GatewayRuntime` has no product BrowserManager and uses execution handler throwing `browser_maintenance_mode`.
- Produces `inspectChatGptPage(page, { diagnosticsDir? })` plus `pnpm inspect:chatgpt`; the CLI owns the isolated BrowserManager while `src/chatgpt/` stays independent from BrowserManager/PagePool implementations.
- Extends `CreateGatewayRuntimeOptions` with test-only `browserProfileDir?: string`; production callers omit it and always use `join(DATA_DIR, 'browser-profile')`.

- [x] **Step 1: Write failing runtime composition tests using injected BrowserManager factory**

Headless:

```ts
const runtime = await createGatewayRuntime({ config: headlessConfig, createBrowserManager: fakeFactory });
expect(fakeFactory).toHaveBeenCalledWith(expect.objectContaining({
  profileDir: join(config.dataDir, 'browser-profile'),
  maxActivePages: 4,
}));
```

Maintenance:

```ts
const runtime = await createGatewayRuntime({ config: novncConfig, createBrowserManager: fakeFactory });
expect(fakeFactory).not.toHaveBeenCalled();
const response = await runtime.app.inject({ method: 'POST', url: '/v1/chat/completions', ... });
expect(response.statusCode).toBe(503);
expect(response.json().error.code).toBe('browser_maintenance_mode');
```

Also verify runtime close order and idempotence without opening TCP.

- [x] **Step 2: Run runtime tests and verify red**

```bash
corepack pnpm vitest run tests/integration/runtime-browser.test.ts
```

Expected: FAIL because runtime has no BrowserManager composition.

- [x] **Step 3: Make `createGatewayRuntime` async and integrate BrowserManager**

Because Persistent Context launch is async, update production `src/index.ts` to:

```ts
const runtime = await createGatewayRuntime({ config, logger: true });
```

`CreateGatewayRuntimeOptions.browserProfileDir?: string` is an injection seam for tests/E2E only. Runtime resolves:

```ts
const profileDir = options.browserProfileDir ?? join(options.config.dataDir, 'browser-profile');
```

Production `src/index.ts` never supplies this option. On headless Browser startup failure, close Persistence before rethrow. On maintenance mode, do not launch BrowserManager.

- [x] **Step 4: Write failing inspect CLI safety tests**

Prove:

```ts
expect(() => parseInspectEnv({})).toThrow(/e2e_profile_required/);
```

And reject production profile equality when both `DATA_DIR` and `CHATGPT_PROFILE_DIR` resolve to the same path:

```text
CHATGPT_PROFILE_DIR === join(DATA_DIR, 'browser-profile') → e2e_profile_must_be_isolated
```

No diagnostics path means no screenshot/HTML write calls.

- [x] **Step 5: Implement inspect core and CLI**

`inspectChatGptPage` inspects an already-owned Page and optionally writes controlled screenshot + HTML diagnostics. `scripts/inspect-chatgpt.ts` alone launches the explicitly supplied isolated Persistent Context, leases a Page, invokes the ChatGPT inspection core, then closes BrowserManager.

`package.json`:

```json
"inspect:chatgpt": "tsx scripts/inspect-chatgpt.ts"
```

Prefer TypeScript `scripts/inspect-chatgpt.ts` so it can import source modules during development; build output need not include diagnostic CLI.

- [x] **Step 6: Extend `.gitignore` for diagnostic/test-profile artifacts**

Ensure patterns cover repository-local variants such as:

```text
/data/
/e2e-browser-profile/
/chatgpt-diagnostics/
```

Do not broadly ignore source fixture directories.

- [x] **Step 7: Run Task 6 verification**

```bash
corepack pnpm vitest run tests/integration/runtime-browser.test.ts tests/unit/inspect-chatgpt.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: PASS.

- [x] **Step 8: Update plan/state and commit Task 6**

Commit:

```text
🌐 接入 Gateway Browser 生命周期与 ChatGPT 诊断入口
```

---

### Task 7: Docker headless Browser smoke and architecture enforcement

**Files:**
- Modify: `scripts/docker-smoke.mjs`
- Modify: `scripts/check-architecture.mjs`
- Modify: `tests/integration/runtime-browser.test.ts`

**Interfaces:**
- Docker smoke proves production headless Chromium starts without accessing ChatGPT.
- Architecture checker enforces Browser/ChatGPT/API boundaries and selector-centralization.

- [x] **Step 1: Add failing Docker smoke expectations before changing runtime assertions**

Normal headless Compose must prove a product Chromium process exists under configured `PUID/PGID`, while maintenance-only processes remain absent.

Do not navigate to ChatGPT; BrowserManager itself should start with no page or only blank Context state until an API request.

Maintenance overlay must prove:

```text
headed maintenance browser exists
product headless BrowserManager does not exist as a second Chromium owner
```

If process-pattern differentiation needs an explicit Chromium argument marker, add one deterministic BrowserManager launch arg only if supported and safe; otherwise assert expected process count/profile lock behavior without relying on unstable command-line internals.

- [x] **Step 2: Run current Docker smoke and verify red**

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: new headless Chromium assertion fails before Browser runtime image is rebuilt/integrated.

- [x] **Step 3: Add architecture checker rules with failing evidence**

Temporarily demonstrate checker catches representative forbidden imports, then remove temporary violations. Rules:

```text
src/browser/** cannot import src/api, src/persistence, src/chatgpt
src/chatgpt/** cannot import src/api or src/persistence
src/api/** still cannot import playwright
selector-like literals outside src/chatgpt/selectors.ts fail
```

Keep side-effect import parsing fixed from Phase 2.

- [x] **Step 4: Run architecture check green**

```bash
node scripts/check-architecture.mjs
```

Expected: PASS on real tree after temporary evidence is removed.

- [x] **Step 5: Run fresh application + Docker verification**

```bash
corepack pnpm verify
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS; none of these commands contacts real ChatGPT.

- [x] **Step 6: Update plan/state and commit Task 7**

Commit:

```text
🐳 验证 Phase 3 Headless Chromium 运行边界
```

---

### Task 8: Explicit real ChatGPT E2E harness and current selector calibration

**Files:**
- Create: `tests/e2e/chatgpt-phase3.e2e.ts`
- Create: `scripts/test-chatgpt-e2e.ts`
- Modify: `package.json`
- Modify: `src/chatgpt/selectors.ts` only if real inspection proves current candidates need adjustment
- Modify: `docs/superpowers/plans/2026-08-15-phase-3-browser-driver.md`
- Modify: `docs/PROJECT_STATE.md` if blocked

**Interfaces:**
- Produces: `corepack pnpm test:e2e:chatgpt` explicit command.
- Requires: `E2E_CHATGPT=1`, explicit isolated `CHATGPT_PROFILE_DIR`.
- Performs real auth/selector inspection, real Driver Fresh text request, then one real Gateway HTTP Chat Completions request while using that isolated Profile.

- [x] **Step 1: Write E2E harness safety gate before real navigation**

CLI gate:

```ts
if (env.E2E_CHATGPT !== '1') {
  throw new Error('E2E_CHATGPT=1 is required for real ChatGPT E2E');
}
const profileDir = requireIsolatedProfile(env);
```

Reject missing or production Profile paths.

- [x] **Step 2: Add deterministic test for E2E gate**

```bash
corepack pnpm vitest run tests/unit/inspect-chatgpt.test.ts
```

Expected: PASS without network.

- [x] **Step 3: Implement real auth/selector inspection scenario**

The E2E must print a concise structured result and fail unless:

```text
auth == authenticated
composer == unique
assistantTurns collection is queryable
```

If actual DOM differs, use real evidence to update `selectors.ts`; do not add unsafe `.first()` fallbacks.

- [x] **Step 4: Implement real Driver Fresh challenge scenario**

Generate:

```ts
const token = `CWG_PHASE3_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
```

Send semantic prompt:

```text
Return exactly this token and nothing else: <token>
```

Assert:

```ts
expect(result.text).toContain(token);
expect(new URL(result.conversationUrl).hostname).toBe('chatgpt.com');
expect(result.conversationUrl).not.toBe('https://chatgpt.com/');
```

Close the E2E BrowserManager in `finally`.

- [x] **Step 5: Implement real Gateway HTTP scenario without sharing one Profile between two Chromium instances**

Run Driver scenario and close it first. Then create a GatewayRuntime using the same E2E Profile **sequentially**, not concurrently, by passing the Task 6 test-only `browserProfileDir` option. Production callers never set this option, so the production Profile rule remains fixed.

Inject POST:

```ts
const response = await runtime.app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers: { authorization: 'Bearer e2e-gateway-key' },
  payload: {
    model: 'chatgpt-web',
    messages: [{ role: 'user', content: `Return exactly this token and nothing else: ${token}` }],
  },
});
```

Assert HTTP 200 and challenge token in `choices[0].message.content`.

- [x] **Step 6: Add package script**

```json
"test:e2e:chatgpt": "tsx scripts/test-chatgpt-e2e.ts"
```

Do not add it to `verify`.

- [!] **Step 7: Run real inspect/auth E2E — blocked by DevSpace network access**

Run only with explicit environment available in the workspace:

```bash
E2E_CHATGPT=1 CHATGPT_PROFILE_DIR=<isolated-profile> corepack pnpm inspect:chatgpt
```

Expected for completion: authenticated + current selector diagnostics healthy.

If no authenticated isolated Profile exists, record `auth_required` as the real Phase 3 blocker; do not fake login.

2026-08-15 execution evidence: no pre-existing isolated E2E Profile was available. A fresh isolated `/tmp/cwg-phase3-e2e-profile` was created only for diagnostics. Bundled Chromium launched, but `page.goto('https://chatgpt.com/')` timed out after 60 seconds before auth/selector inspection. Independent Node `fetch('https://chatgpt.com/')` resolved DNS but failed with `ETIMEDOUT`. The inspect command therefore ended with stable `browser_unavailable`; no selector/auth calibration was possible.

- [!] **Step 8: Run full real Phase 3 E2E — blocked before auth inspection by the same network timeout**

```bash
E2E_CHATGPT=1 CHATGPT_PROFILE_DIR=<isolated-profile> corepack pnpm test:e2e:chatgpt
```

Expected for completion: auth inspection PASS, Fresh Driver challenge PASS, Gateway HTTP challenge PASS.

If blocked by auth/network/CAPTCHA/current DOM, update `PROJECT_STATE` to Phase 3 blocked with exact evidence and continue Task 9 documentation/verification without falsely closing Phase 3.

2026-08-15 execution evidence: `E2E_CHATGPT=1 CHATGPT_PROFILE_DIR=/tmp/cwg-phase3-e2e-profile corepack pnpm test:e2e:chatgpt` was actually run and failed in the initial real inspection navigation with stable `browser_unavailable`. Driver challenge and Gateway HTTP challenge were not reached and remain unverified.

- [x] **Step 9: Update plan/state and commit Task 8 implementation/evidence**

If E2E passes, commit selector calibration and E2E harness:

```text
🧪 增加 Phase 3 真实 ChatGPT 文本 E2E
```

If E2E is blocked, commit harness plus blocker evidence/state with a specific message such as:

```text
🧪 建立 Phase 3 真实 E2E 并记录登录阻塞
```

---

### Task 9: Documentation, final acceptance, project memory, and branch completion

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/api-compatibility.md`
- Modify: `docs/testing.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/superpowers/plans/2026-08-15-phase-3-browser-driver.md`
- Modify: `docs/superpowers/specs/2026-08-15-phase-3-browser-driver-design.md` only for implementation-forced clarification

**Interfaces:**
- If all real E2E passes: `PHASE=phase-3-complete`, `STATUS=ready-for-phase-4-design`, `ACTIVE_PLAN=none`, `NEXT_TASK=write-phase-4-context-sync-spec`.
- If real E2E is blocked: retain `PHASE=phase-3-implementation`, `STATUS=blocked`, keep active plan, and set exact next task to resolve the real E2E blocker.

- [ ] **Step 1: Re-read all 24 Phase 3 acceptance criteria and record evidence**

For each spec criterion, identify a source/test/command result. At minimum record:

```text
BrowserManager/headless/maintenance exclusion
PagePool capacity/lifecycle
Selector strictness
Auth Probe
Fresh Driver turn ownership/completion
Phase3Executor capability boundary
envelope escaping
API encoders/error mapping
inspect safety/diagnostics
architecture rules
deterministic verify
Docker headless browser smoke
real auth inspection
real Driver challenge
real Gateway HTTP challenge
```

Any missing real E2E item prevents complete state.

- [ ] **Step 2: Apply documentation writeback**

README/API docs must clearly distinguish:

```text
Implemented now: Fresh non-stream text only (only if real E2E passed)
Not implemented: conversation sync, streaming, attachments, tools, structured execution, images
```

Document manual auth recovery via noVNC and the headless/novnc Profile single-owner rule.

Testing docs must show explicit E2E command and isolated Profile requirement.

- [ ] **Step 3: Run fresh full deterministic verification after docs/state writeback**

```bash
corepack pnpm verify
```

Expected: PASS.

- [ ] **Step 4: Run fresh Docker verification after final tree**

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Expected: PASS.

- [ ] **Step 5: If Phase 3 is eligible for completion, rerun real E2E on final HEAD**

```bash
E2E_CHATGPT=1 CHATGPT_PROFILE_DIR=<isolated-profile> corepack pnpm test:e2e:chatgpt
```

Expected: PASS. A previous E2E run before final code/docs changes is not sufficient evidence for final completion.

If the real E2E cannot run/pass, keep blocked state and report the exact unverified external condition.

- [ ] **Step 6: Run Git hygiene checks**

```bash
corepack pnpm verify:repo
git diff --check
git status --short --branch
git diff
git diff --staged
```

Explicitly search changed/staged paths for:

```text
browser-profile
e2e-browser-profile
Cookie/storage state
gateway.db
screenshots
DOM snapshots
.env
logs
```

No sensitive artifact may be committed.

- [ ] **Step 7: Commit Phase 3 result**

If complete:

```text
📝 记录 Phase 3 浏览器与真实文本 E2E 实施结果
```

If blocked:

```text
📝 记录 Phase 3 实现与真实 E2E 阻塞状态
```

- [ ] **Step 8: Close plan only if eligible**

If complete, mark all plan checkboxes `[x]`, set `ACTIVE_PLAN=none`, commit:

```text
📝 关闭 Phase 3 实施计划
```

If blocked, do **not** mark blocked E2E steps complete and do not close the plan.

- [ ] **Step 9: Push feature branch normally**

```bash
git push -u origin phase-3-browser-driver
```

No force-push, no merge to default branch, no Docker Registry image, no GitHub Release unless separately requested.
