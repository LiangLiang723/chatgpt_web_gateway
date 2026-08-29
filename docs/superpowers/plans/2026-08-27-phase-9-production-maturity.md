# Phase 9 Production Maturity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close V1 compatibility and NAS production-maturity gaps after Phase 8.

**Architecture:** Reuse the existing Conversation recovery and formal Docker boundary. Add only local structured-output validation, failed-Page isolation, process-level BrowserContext restart signaling, bounded diagnostics, and cold backup/restore operations.

**Tech Stack:** Node 24, TypeScript, Fastify, Ajv, Playwright, SQLite, Docker Compose, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-phase-9-production-maturity-design.md`

## Global Constraints

- No intermediate test execution per the user's standing instruction; author deterministic tests now and run the full matrix only after all V1 functionality is implemented.
- `/health` remains process-only and unauthenticated.
- `/v1/diagnostics` is authenticated and must not probe ChatGPT automatically.
- Failed browser Pages are discarded, not returned to the idle pool.
- Unexpected BrowserContext death exits the production process non-zero so Compose can restart it.
- Backup/restore is cold-only; no hot-backup guarantee.
- No production dependency or database migration is required.

---

### Task 1: Structured Output execution

**Files:** `src/structured/output.ts`, `src/conversations/prompts.ts`, `src/conversations/request-context.ts`, `src/conversations/conversation-engine.ts`, `src/api/errors.ts`, focused unit/integration tests.

- [x] Implement JSON-safe structured-output prompt policy.
- [x] Validate caller JSON Schema before browser execution.
- [x] Validate final Assistant JSON object/schema before clean commit and success terminal.
- [x] Add stable `chatgpt_structured_output_invalid` mapping.
- [x] Author deterministic tests; defer execution to final unified test stage.

### Task 2: Browser recovery hardening

**Files:** `src/conversations/page-registry.ts`, `src/browser/browser-manager.ts`, `src/runtime.ts`, `src/index.ts`, relevant tests.

- [x] Close failed keyed/transient Pages instead of releasing them.
- [x] Preserve Persistent BrowserContext when a failed lease is its last tracked Page by creating a fresh idle replacement before closing the failed Page.
- [x] Add unexpected Persistent BrowserContext close callback.
- [x] Wire production fatal callback to graceful non-zero process shutdown for Compose restart.
- [x] Author deterministic Page/Browser lifecycle tests; defer execution.

### Task 3: Local diagnostics

**Files:** `src/diagnostics/runtime.ts`, `src/api/routes/diagnostics.ts`, `src/api/server.ts`, `src/runtime.ts`, route tests.

- [x] Add bounded local runtime snapshot with honest `auth_state=not_probed`.
- [x] Register authenticated `GET /v1/diagnostics`.
- [x] Author sensitive-field regression tests; defer execution.

### Task 4: Cold backup / restore and NAS configuration

**Files:** `scripts/backup-data.mjs`, `scripts/restore-data.mjs`, `package.json`, `.env.example`, `compose.yaml`, `docs/operations.md`, deterministic CLI tests.

- [x] Add cold backup CLI with explicit stopped-Gateway acknowledgement and manifest.
- [x] Add restore CLI requiring supported manifest and empty target.
- [x] Add `PUBLIC_BASE_URL` deployment configuration without hard-coded environment addresses.
- [x] Write NAS deployment/update/login/backup/restore/rollback/diagnostics operations guide in `docs/operations.md`.
- [x] Author backup/restore round-trip test covering manifest, byte-for-byte DATA_DIR restoration, explicit stopped-Gateway acknowledgement, and non-empty target rejection; execution deferred to final unified verification.

### Task 5: Phase 9/V1 documentation writeback

**Files:** README, API compatibility, architecture, testing, roadmap, Project State, Phase 8/9 specs/plans.

- [x] Record Structured Output as prompt-constrained + locally validated compatibility, not native constrained decoding.
- [x] Record Page discard and process-level BrowserContext recovery.
- [x] Record diagnostics and cold-backup security boundaries.
- [x] Keep actual acceptance status pending until the final unified verification and authenticated E2E matrix succeeds.

### Task 6: Unified V1 verification and closure

**Final acceptance evidence (2026-08-29):** Phase 7 stale-policy was fixed by binding normalized `tool_choice`/function policy into the tool-context fingerprint, so policy changes use `tools_changed → REBUILD` while identical policy remains eligible for RESTORE. The first final standalone run then exposed a separate Browser RESTORE race: after navigating to a saved Conversation URL, authenticated Composer readiness could appear before historical user/assistant turns hydrated, causing the next send to capture an Assistant baseline of zero and misclassify the previous answer as the new target. No-message live sampling proved Composer appeared around 3.05s while history remained `0 / 0`, then the same page hydrated to `2 / 2` around 3.78s and contained both the expected prior `P7RESULT_*` and new `P7RESTORE_*`. The Driver now waits for cross-URL restored history to hydrate, the last Assistant completion marker to be ready, and the turn-count signature to remain stable before returning `restored`. The signed-out homepage also exposed multiple visible `Log in` controls; Auth Probe now treats login indicators as a collection signal while preserving strict uniqueness for Composer. With those evidence-backed fixes, fresh deterministic/Docker, Phase 7 standalone, adjacent Phase 6 standalone, and reduced combined Phase 3→8 all passed.

- [x] **Step 1: Run fresh deterministic verification** — final RESTORE-hydration/Auth candidate passed `corepack pnpm verify` at **86 test files / 595 tests**; format, lint, typecheck, build, Project Memory, Docs, Architecture, Version, and `git diff --check` all passed.
- [x] **Step 2: Verify the formal Docker boundary** — fresh `linux/amd64` image `sha256:866e2b280a1a3ab790c1ab4ae725ec0c1fe345420b7aeec438497806fbd896fa` built with explicit `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://192.168.3.83:7890`; full `corepack pnpm docker:smoke` passed. The proxy is not committed as a repository/image default.
- [x] **Step 3: Run the authenticated standalone gate for the latest Driver selector/input candidate** — after no-message inspection returned authenticated/Composer+Send unique, the current multiline ProseMirror paste candidate passed `chatCompletions/markdown/responses/abort=true`.
- [x] **Step 4: Run final authenticated real E2E** — fresh no-message inspect returned `auth=authenticated` / Composer unique. Final Phase 7 standalone returned `singleTool/resultContinuation/policyRebuild/multipleTools/streamTool/streamText/restore/schemaRebuild=true`. The required immediately adjacent Phase 6 standalone then returned image Data URL/file_id, XLSX/TXT/PDF/DOCX, Streaming, APPEND and RESTORE all `true`. Reduced combined Phase 3→8 subsequently exited 0 with Phase 3 `gatewayChallenge=true`, Phase 4 APPEND/RESTORE/REBUILD, Phase 5 Chat Completions/Markdown/Responses, all eight Phase 7 results, and Phase 8 `url/base64/persistence/restart` true; combined intentionally reported Phase 5 `abort=not_run_in_combined` and Phase 6 `attachmentMatrix=not_run_in_combined`, whose coverage comes from the adjacent standalone gates.
- [x] **Step 5: Close and publish the branch state** — staged diff / `git diff --check` / secret inspection passed; the only sensitive-pattern matches were explicit placeholder secrets in `docs/operations.md`. Main acceptance commit `e0d804c` (`✨ 完成 V1 兼容能力与生产成熟化`) was committed and normally pushed to `origin/phase-7-tool-calling`. Final Project State closes this plan with `ACTIVE_PLAN=none`. No Release, Git tag, or Docker registry publish was created.
