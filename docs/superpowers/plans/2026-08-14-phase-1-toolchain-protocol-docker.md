# Phase 1 Toolchain, Protocol Model, and Docker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the deterministic Phase 1 foundation: Node/TypeScript/pnpm toolchain, Fastify + TypeBox/Ajv API boundary, shared request normalization, API-key authentication, and a complete `linux/amd64` Docker runtime with default headless and opt-in noVNC maintenance mode.

**Architecture:** Fastify routes validate requests with TypeBox JSON Schema and delegate protocol conversion to pure normalizers that produce one `NormalizedRequest`. HTTP execution remains behind an injected boundary so Phase 1 proves protocol behavior without pretending ChatGPT execution exists. Docker is the formal runtime boundary from this phase onward; the normal Compose path exposes only the Gateway while a second overlay enables the maintenance display stack.

**Tech Stack:** Node.js 24 LTS, pnpm 11.21.0, TypeScript 6.0.3, Fastify 5.11.3, TypeBox 1.3.13 + `@fastify/type-provider-typebox` 6.1.0, Ajv 8.20.0, Vitest 4.1.10, ESLint 10.8.1 + `typescript-eslint` 8.67.0, Prettier 3.9.6, Playwright 1.62.1, Docker/Compose, Xvfb + x11vnc + noVNC + websockify.

## Global Constraints

- Runtime baseline is Node.js 24.x LTS; the Docker implementation targets the current Node 24 LTS patch after verifying it against the official Node release page. Future dependency upgrades may move to a newer LTS major only through the documented upgrade workflow.
- The current compatible toolchain pins pnpm 11.21.0, TypeScript 6.0.3, Fastify 5.11.3, TypeBox 1.3.13, `@fastify/type-provider-typebox` 6.1.0, Ajv 8.20.0, Vitest 4.1.10, ESLint 10.8.1, `typescript-eslint` 8.67.0, Prettier 3.9.6, and Playwright 1.62.1. TypeScript 7.0.2 is intentionally not selected because the current `typescript-eslint` peer range is `<6.1.0`.
- Target container platform is `linux/amd64`.
- Pin pnpm exactly through `packageManager`; commit `pnpm-lock.yaml`.
- Pin the Playwright Docker image and project Playwright package to the same version.
- `HOST` is configurable and defaults to `0.0.0.0`; `PORT` is configurable and defaults to `3000`.
- `GET /health` is unauthenticated; all `/v1/*` routes require `Authorization: Bearer <GATEWAY_API_KEY>`.
- Missing `GATEWAY_API_KEY` is a startup error outside explicitly constructed test configuration.
- `X-Conversation-Key` is the only Phase 1 conversation identity extension; absence normalizes to `undefined`.
- API modules must not import Playwright; Phase 1 POST routes must not fabricate ChatGPT answers.
- Normal mode does not start or expose noVNC; maintenance mode is enabled only through the Compose overlay.
- `/data` is a bind-mounted persistence boundary. Long-running Gateway and Chromium processes must be non-root and support `PUID/PGID`.
- `pnpm verify` remains deterministic and must not access real ChatGPT or require a logged-in Browser Profile.
- Real ChatGPT selector/login/upload/image behavior is not a Phase 1 completion claim.

---

### Task 1: Toolchain, package manager, and deterministic config

**Files:**
- Modify: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `.env.example`
- Create: `src/config/schema.ts`
- Create: `src/config/index.ts`
- Create: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`
- Produces: `AppConfig` with `host`, `port`, `gatewayApiKey`, `uiMode`, `puid`, `pgid`, `dataDir`, `novncPort`, `novncPassword`.
- Consumes: only environment input; no API/browser dependencies.

- [x] **Step 1: Add exact toolchain metadata and dependencies**

Set `engines.node` to `>=24 <25`, `packageManager` to `pnpm@11.21.0`, add deterministic scripts (`dev`, `typecheck`, `lint`, `format`, `format:check`, `test`, `build`, `start`, repository checks, `verify`), and pin the compatible versions listed in Global Constraints. Keep `playwright@1.62.1` as a production dependency because the runtime image must contain the package that matches its bundled browsers. pnpm 11's default 24-hour release-age policy rejected the just-published Fastify 5.12.0 candidate, so the implementation pins the latest mature compatible Fastify 5.11.3 instead. `pnpm-workspace.yaml` explicitly allows only the reviewed `esbuild` install script.

- [x] **Step 2: Add TypeScript, ESLint, and Prettier configuration**

Use ESM/NodeNext compilation into `dist/`, strict type checking, `noEmit` only for the dedicated typecheck command, TypeScript-aware ESLint flat config, and Prettier checks over Phase 1 source/tests/config/new scripts while excluding build/runtime output, existing Markdown, and the four pre-Phase-1 governance scripts so enabling the formatter does not create unrelated churn.

- [x] **Step 3: Write failing configuration tests**

Test all of the following explicitly:

```ts
expect(loadConfig({ GATEWAY_API_KEY: 'secret' })).toMatchObject({
  host: '0.0.0.0',
  port: 3000,
  gatewayApiKey: 'secret',
  uiMode: 'headless',
  dataDir: '/data',
});

expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEY/);
expect(loadConfig({ GATEWAY_API_KEY: 'x', PORT: '4567' }).port).toBe(4567);
expect(() => loadConfig({ GATEWAY_API_KEY: 'x', PORT: '0' })).toThrow(/PORT/);
expect(() => loadConfig({ GATEWAY_API_KEY: 'x', UI_MODE: 'desktop' })).toThrow(/UI_MODE/);
```

- [x] **Step 4: Run the config test and verify red**

Run: `corepack pnpm vitest run tests/unit/config.test.ts`
Expected: FAIL because config modules do not exist yet.

- [x] **Step 5: Implement the minimal config parser**

Use TypeBox as the schema/type source for environment-derived configuration where practical and explicit parsing for numeric environment values. Do not allow other modules to read `process.env` directly; `loadConfig()` is the boundary.

- [x] **Step 6: Update `.env.example` to the approved names/defaults**

Required baseline:

```dotenv
HOST=0.0.0.0
PORT=3000
GATEWAY_API_KEY=change-me
DATA_DIR=/data
UI_MODE=headless
PUID=1000
PGID=1000
NOVNC_PORT=6080
NOVNC_PASSWORD=change-me-in-maintenance-mode
E2E_CHATGPT=0
```

Keep future browser tuning variables only when they remain approved architecture defaults.

- [x] **Step 7: Run focused and static checks**

Run: `corepack pnpm vitest run tests/unit/config.test.ts && corepack pnpm typecheck && corepack pnpm lint && corepack pnpm format:check`
Expected: PASS.

- [x] **Step 8: Commit Task 1**

Commit message: `🔧 建立 Phase 1 TypeScript 与配置工具链`

---

### Task 2: Error model, API-key authentication, health, and models

**Files:**
- Create: `src/api/errors.ts`
- Create: `src/api/auth.ts`
- Create: `src/api/execution.ts`
- Create: `src/api/server.ts`
- Create: `src/api/routes/health.ts`
- Create: `src/api/routes/models.ts`
- Create: `src/index.ts`
- Create: `tests/unit/auth.test.ts`
- Create: `tests/integration/health-models.test.ts`

**Interfaces:**
- Consumes: `AppConfig` from Task 1.
- Produces: `OpenAIErrorBody`, stable internal error classes, `authenticateBearer(header, expectedKey)`.
- Produces: `buildServer({ config, execute? }): FastifyInstance`.
- Produces: `NormalizedExecutionHandler` placeholder interface for later POST routes.

- [x] **Step 1: Write failing authentication tests**

Cover missing Authorization, wrong scheme, wrong key, and correct Bearer key. Assert errors never include the configured secret.

- [x] **Step 2: Run auth tests and verify red**

Run: `corepack pnpm vitest run tests/unit/auth.test.ts`
Expected: FAIL because auth/error modules do not exist.

- [x] **Step 3: Implement stable API errors and bearer authentication**

Use timing-safe comparison for equal-length secrets and return OpenAI-shaped errors at the Fastify boundary. Keep error classes free of Fastify types so they remain reusable.

- [x] **Step 4: Write failing route integration tests**

Use Fastify `inject()` and explicit test config. Assertions:

```ts
expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
expect((await app.inject({
  method: 'GET',
  url: '/v1/models',
  headers: { authorization: 'Bearer test-key' },
})).json().data[0].id).toBe('chatgpt-web');
```

Also assert `/health` returns exactly the Phase 1 process-level status contract and that error responses have the OpenAI error envelope.

- [x] **Step 5: Run route tests and verify red**

Run: `corepack pnpm vitest run tests/integration/health-models.test.ts`
Expected: FAIL because server/routes are missing.

- [x] **Step 6: Implement server composition and two GET routes**

`buildServer` owns error mapping, auth hooks for `/v1/*`, and route registration. `/health` must not imply browser/login health. `/v1/models` exposes only `chatgpt-web`.

- [x] **Step 7: Add executable process entrypoint**

`src/index.ts` loads config, builds the server, listens on `config.host/config.port`, logs startup metadata without secrets, and performs graceful close on `SIGTERM`/`SIGINT`.

- [x] **Step 8: Run focused checks**

Run: `corepack pnpm vitest run tests/unit/auth.test.ts tests/integration/health-models.test.ts && corepack pnpm typecheck`
Expected: PASS.

- [x] **Step 9: Commit Task 2**

Commit message: `✨ 增加 Gateway 认证与基础 HTTP 路由`

---

### Task 3: Shared normalized protocol types and common OpenAI schemas

**Files:**
- Create: `src/api/normalized.ts`
- Create: `src/api/schemas/common.ts`
- Create: `src/api/schemas/chat-completions.ts`
- Create: `src/api/schemas/responses.ts`
- Create: `src/api/normalize/common.ts`
- Create: `tests/unit/normalized-common.test.ts`
- Create: `tests/unit/request-schemas.test.ts`

**Interfaces:**
- Produces: `NormalizedRequest`, `NormalizedInstruction`, `NormalizedMessage`, `NormalizedContentPart`, `NormalizedTool`, `NormalizedAttachment`, `NormalizedStructuredOutput`, `NormalizedToolChoice`.
- Produces: TypeBox request schemas and inferred request types for both public POST endpoints.
- Produces pure common helpers used by Tasks 4 and 5.

- [x] **Step 1: Write failing tests for common canonicalization**

Cover text parts, instructions, tool definition canonicalization, tool-choice variants, structured output descriptions, image/file attachment descriptors, and ignored parameter recording. Tests must compare semantic structures, not JSON string formatting accidents.

- [x] **Step 2: Run tests and verify red**

Run: `corepack pnpm vitest run tests/unit/normalized-common.test.ts`
Expected: FAIL because normalized model/helpers do not exist.

- [x] **Step 3: Define focused internal types**

Use discriminated unions. Example shape:

```ts
type NormalizedContentPart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachmentId: string };

type NormalizedAttachment =
  | { id: string; kind: 'image'; source: { type: 'url'; url: string } }
  | { id: string; kind: 'image'; source: { type: 'data_url'; dataUrl: string } }
  | { id: string; kind: 'file'; source: { type: 'file_id'; fileId: string } }
  | { id: string; kind: 'file'; source: { type: 'base64'; data: string; filename?: string } };
```

Use deterministic local attachment IDs derived from request traversal order, not persistence IDs.

- [x] **Step 4: Define TypeBox request schemas**

Schemas must be broad enough for the approved V1 subset but strict enough to reject malformed role/content/tool structures. Model ignored parameters explicitly so accepted-but-ignored values pass validation. Model unsupported parameters so the normalizer can return stable `UnsupportedParameterError` instead of generic schema rejection when practical.

- [x] **Step 5: Implement common pure normalizer helpers**

No Fastify, filesystem, network, Playwright, or process environment access.

- [x] **Step 6: Run focused tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/normalized-common.test.ts && corepack pnpm typecheck`
Expected: PASS.

- [x] **Step 7: Commit Task 3**

Commit message: `✨ 建立 OpenAI 统一协议内部模型`

---

### Task 4: Chat Completions normalizer

**Files:**
- Create: `src/api/normalize/chat-completions.ts`
- Create: `tests/unit/chat-completions-normalizer.test.ts`

**Interfaces:**
- Consumes: `ChatCompletionsRequest` schema type and common helpers from Task 3.
- Produces: `normalizeChatCompletions(request, meta): NormalizedRequest` where `meta` includes `requestId` and optional `conversationKey`.

- [x] **Step 1: Write representative failing normalization tests**

Cover:

1. string user content;
2. system + developer instructions;
3. multi-turn user/assistant/tool messages;
4. URL image and data-URL image descriptors;
5. file-id and base64 file descriptors in the approved Chat Completions extension shape;
6. tools and all approved `tool_choice` forms;
7. `response_format` json object/json schema;
8. `stream` default/true;
9. ignored sampling/token-limit/detail parameters;
10. `logprobs` and `logit_bias` stable unsupported errors;
11. propagation of `X-Conversation-Key` metadata.

- [x] **Step 2: Run the normalizer test and verify red**

Run: `corepack pnpm vitest run tests/unit/chat-completions-normalizer.test.ts`
Expected: FAIL because the normalizer does not exist.

- [x] **Step 3: Implement minimal pure Chat Completions normalization**

Do not download attachments or execute tools. Preserve tool-call/result identity needed by later phases without inventing browser formatting.

- [x] **Step 4: Run focused tests**

Run: `corepack pnpm vitest run tests/unit/chat-completions-normalizer.test.ts tests/unit/normalized-common.test.ts`
Expected: PASS.

- [x] **Step 5: Commit Task 4**

Commit message: `✨ 增加 Chat Completions 请求标准化`

---

### Task 5: Responses API normalizer and semantic parity

**Files:**
- Create: `src/api/normalize/responses.ts`
- Create: `tests/unit/responses-normalizer.test.ts`
- Create: `tests/unit/normalizer-parity.test.ts`

**Interfaces:**
- Consumes: `ResponsesRequest` schema type and common helpers from Task 3.
- Produces: `normalizeResponses(request, meta): NormalizedRequest`.
- Semantic parity test is the contract proving equivalent Chat Completions and Responses requests converge on the same internal meaning.

- [x] **Step 1: Write failing Responses normalization tests**

Cover `input` string, message array, `input_text`, `input_image`, `input_file`, tools, tool choice, streaming, structured output, ignored values, unsupported values, and conversation header propagation.

- [x] **Step 2: Write a failing semantic parity test**

Construct one Chat Completions request and one Responses request representing the same instruction + user text + image + tool schema. Normalize both and compare the semantic fields after excluding endpoint-specific request IDs and deterministic attachment IDs where necessary.

- [x] **Step 3: Run tests and verify red**

Run: `corepack pnpm vitest run tests/unit/responses-normalizer.test.ts tests/unit/normalizer-parity.test.ts`
Expected: FAIL because Responses normalization is missing.

- [x] **Step 4: Implement minimal Responses normalization**

Keep all transformation pure and reuse common helpers; do not copy browser or execution logic.

- [x] **Step 5: Run all normalizer unit tests**

Run: `corepack pnpm vitest run tests/unit/*normalizer*.test.ts tests/unit/normalized-common.test.ts`
Expected: PASS.

- [x] **Step 6: Commit Task 5**

Commit message: `✨ 增加 Responses 请求标准化与语义对齐`

---

### Task 6: POST route validation and injected execution boundary

**Files:**
- Modify: `src/api/execution.ts`
- Modify: `src/api/server.ts`
- Create: `src/api/routes/chat-completions.ts`
- Create: `src/api/routes/responses.ts`
- Create: `src/api/request-meta.ts`
- Create: `tests/integration/post-routes.test.ts`

**Interfaces:**
- Consumes: both TypeBox schemas and both normalizers.
- Produces: POST routes that pass only validated `NormalizedRequest` objects to `NormalizedExecutionHandler`.
- Default production execution handler returns a stable “backend not implemented in Phase 1” error; tests inject a fake handler to inspect normalized input.

- [x] **Step 1: Write failing HTTP integration tests**

Assert:

- missing/wrong API key is rejected before execution;
- malformed request body returns stable OpenAI-shaped validation error;
- `X-Conversation-Key` reaches the fake execution handler;
- valid Chat Completions and Responses requests arrive as the expected `NormalizedRequest`;
- unsupported parameters produce stable unsupported errors;
- default production handler does not fabricate assistant output.

- [x] **Step 2: Run integration test and verify red**

Run: `corepack pnpm vitest run tests/integration/post-routes.test.ts`
Expected: FAIL because POST routes are not registered.

- [x] **Step 3: Implement routes and execution boundary**

Keep route handlers thin: request metadata → normalizer → injected execution. Do not import Playwright or future persistence code.

- [x] **Step 4: Run API unit/integration suite and architecture check**

Run: `corepack pnpm test && corepack pnpm check:architecture`
Expected: PASS.

- [x] **Step 5: Commit Task 6**

Commit message: `✨ 接通 OpenAI POST 协议验证链`

---

### Task 7: Complete Docker runtime and noVNC maintenance overlay

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.yaml`
- Create: `compose.novnc.yaml`
- Create: `docker/entrypoint.sh`
- Create: `docker/start-novnc.sh`
- Create: `docker/maintenance-browser.mjs`
- Create: `scripts/docker-smoke.mjs`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Normal mode: Gateway process on `PORT`, `/data` bind-mounted, noVNC processes absent and port unpublished.
- Maintenance mode: same image/data with `UI_MODE=novnc`; Xvfb + lightweight window manager + x11vnc + websockify/noVNC start before the Gateway and maintenance port is published only by overlay.
- Entrypoint prepares `/data`, aligns the runtime user to `PUID/PGID`, then execs long-running processes as non-root.

- [x] **Step 1: Confirm the pinned Playwright image exists and inspect its runtime**

Run `docker manifest inspect mcr.microsoft.com/playwright:v1.62.1-noble` and a disposable `node --version` check. The inspected image is `linux/amd64` and reports Node `v24.18.1`, so no derived-image Node replacement is required. The runtime keeps the image-provided `/ms-playwright` browser bundle and the project pins `playwright@1.62.1`.

- [x] **Step 2: Write the Docker smoke harness before the image implementation**

`scripts/docker-smoke.mjs` must fail unless all of these hold:

- container starts from the default Compose path;
- `/health` returns 200;
- `/v1/models` without auth returns 401;
- `/v1/models` with the test key returns `chatgpt-web`;
- runtime Node major is 24;
- long-running Gateway user UID/GID match requested smoke `PUID/PGID` and are non-root;
- `/data` test path is writable by the runtime user;
- base Compose does not publish the noVNC port;
- overlay config publishes only the configured noVNC port and starts maintenance mode.

- [x] **Step 3: Run smoke harness and verify red**

Run: `corepack pnpm docker:smoke`
Expected: FAIL because Docker/Compose files do not exist yet.

- [x] **Step 4: Implement the multi-stage Docker image**

Build app dependencies/artifacts in a builder stage. Runtime stage starts from the pinned official Playwright Noble image, installs the maintenance/runtime packages `x11vnc`, `novnc`, `websockify`, `fluxbox`, `x11-utils`, and `gosu`, copies production artifacts and the matching Playwright package, and includes no secret/runtime data. The image switches the base image's Azure Ubuntu mirror entry to the standard Ubuntu archive mirror to avoid the observed Docker DNS failure against `azure.archive.ubuntu.com`.

- [x] **Step 5: Implement dynamic non-root entrypoint**

At startup as root, validate numeric `PUID/PGID`, adjust the dedicated runtime user/group, create/chown only required `/data` paths, optionally start the maintenance stack, then drop privileges for the Gateway. Do not recursively chown arbitrary host paths outside `/data`.

- [x] **Step 6: Implement maintenance stack with password protection**

Require `NOVNC_PASSWORD` only when `UI_MODE=novnc`; generate a restrictive temporary x11vnc password file, start Xvfb + WM + x11vnc + websockify/noVNC bound to the container maintenance port, and avoid echoing the password.

- [x] **Step 7: Implement base Compose and overlay**

Base Compose uses the bind mount `${DATA_PATH:-./data}:/data`, Gateway port variables, `UI_MODE=headless`, and no maintenance port mapping. Overlay sets `UI_MODE=novnc` and publishes `${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}:${NOVNC_PORT:-6080}` only for explicit maintenance use; loopback binding is the safe default.

- [x] **Step 8: Run fresh Docker build and smoke verification**

Run: `corepack pnpm docker:build && corepack pnpm docker:smoke`
Expected: PASS for all deterministic checks. The final smoke also verifies the noVNC HTML endpoint, maintenance process UID/GID, password absence from process arguments, and that the maintenance browser remains alive against `about:blank`. Real ChatGPT login is intentionally not exercised.

- [ ] **Step 9: Commit Task 7**

Commit message: `🐳 增加完整 Gateway Docker 与 noVNC 维护模式`

---

### Task 8: Repository checks, documentation writeback, and Phase 1 acceptance

**Files:**
- Modify: `scripts/check-architecture.mjs` if new executable architecture rules can be enforced safely.
- Modify: `README.md`
- Modify: `docs/testing.md`
- Modify: `docs/development-workflow.md` only if actual commands differ from the approved spec.
- Modify: `docs/PROJECT_STATE.md`
- Modify: `docs/superpowers/plans/2026-08-14-phase-1-toolchain-protocol-docker.md`
- Modify: `docs/superpowers/specs/2026-08-14-phase-1-toolchain-protocol-docker-design.md` only if implementation facts forced an approved design clarification.

**Interfaces:**
- Produces: current project facts sufficient for a new agent to know Phase 1 is implemented, what commands prove it, and what remains unverified.

- [ ] **Step 1: Run complete deterministic product verification**

Run: `corepack pnpm verify`
Expected: PASS with zero test/lint/type/build/repository failures.

- [ ] **Step 2: Run fresh Docker verification**

Run: `corepack pnpm docker:build && corepack pnpm docker:smoke`
Expected: PASS.

- [ ] **Step 3: Verify requirements line by line**

Check all 13 Phase 1 acceptance criteria from the governing spec against current source/tests/runtime evidence. Any unmet criterion remains `[!]` in this plan and keeps `PROJECT_STATE` from claiming Phase 1 completion.

- [ ] **Step 4: Update human-facing usage documentation**

README must document normal Compose startup, `.env` setup, Gateway authentication, `/data` bind mount, maintenance overlay usage, and the explicit statement that real ChatGPT execution is not implemented until later phases.

- [ ] **Step 5: Apply Project Memory writeback**

If all deterministic acceptance criteria pass, update `PROJECT_STATE` to Phase 1 implemented / ready for Phase 2 design. Keep real ChatGPT E2E listed as unverified and do not mark browser-driver capabilities implemented.

- [ ] **Step 6: Mark every completed plan checkbox with current evidence**

Use `[x]` only for executed/verified steps; `[!]` for blockers and `[-]` only for superseded steps with explanation.

- [ ] **Step 7: Run repository governance and Git hygiene checks**

Run:

```bash
corepack pnpm verify:repo
git diff --check
git status --short --branch
git diff
git diff --staged
```

Expected: checks pass; staged diff contains no `.env`, Browser Profile, database, upload, generated image, or secret.

- [ ] **Step 8: Commit Phase 1 completion/writeback**

Commit message: `📝 记录 Phase 1 工具链与 Docker 实施结果`

- [ ] **Step 9: Push the feature branch**

Push normally to `origin/phase-1-toolchain-spec`; do not force-push. Record the actual push result in the final report.
