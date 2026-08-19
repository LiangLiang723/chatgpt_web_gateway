# Phase 6 Attachments and Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 6 image/file input and `/v1/files` as a persistent, security-bounded attachment pipeline that reuses the existing Conversation + True Streaming execution chain.

**Architecture:** External URL/Data URL/Base64/public `file_id` sources resolve into Gateway-owned logical Files backed by content-addressed Blobs. Conversation canonicalization fingerprints ordered multimodal content, the planner keeps the existing FRESH/APPEND/RESTORE/REBUILD modes, and only request-scoped staged local paths reach the ChatGPT Driver. Browser upload/readiness must be discovered by authenticated DOM inspection before selectors are locked; after Send, Phase 5 target-turn/Stable Prefix behavior remains unchanged.

**Tech Stack:** Node 24, TypeScript 6, Fastify 5.11.3, `@fastify/multipart@10.1.0`, TypeBox/Ajv, `node:sqlite`, Playwright 1.62.1, Vitest 4.1.10.

**Spec:** `docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`

## Global Constraints

- Keep `linux/amd64` as the formal Docker acceptance target.
- Use `@fastify/multipart@10.1.0`; consume file streams and never use whole-file `toBuffer()` for product upload handling.
- `MAX_FILE_BYTES = 32 MiB`, `MAX_ATTACHMENTS_PER_REQUEST = 16`, `MAX_TOTAL_ATTACHMENT_BYTES_PER_REQUEST = 64 MiB`, `MAX_REMOTE_REDIRECTS = 5`, `REMOTE_CONNECT_TIMEOUT = 10 s`, `REMOTE_TOTAL_TIMEOUT = 30 s`.
- Permanent Blob path is `${DATA_DIR}/files/blobs/<64-char-lowercase-sha256>`; user filenames never enter permanent paths.
- Public IDs are opaque `file-<uuid-v4>` values and are distinct from internal SQLite UUIDs.
- URL images allow only `http:`/`https:` with no URL credentials and must apply DNS/IP/redirect SSRF checks at every hop.
- Image byte allowlist for Phase 6 is PNG/JPEG/WEBP/GIF with MIME/signature agreement.
- No raw URL query/token, Data URL, Base64 payload, permanent path, or staging path may be persisted in Attachment source metadata or returned in API errors.
- `file_url`, Tools, Structured Output execution, and image output remain unsupported in Phase 6.
- Same-key queue remains the serialization boundary; attachment resolution occurs after entering that queue.
- Stream `started` occurs only after all pre-browser attachment validation succeeds; checkpoint becomes `in_flight` before the first browser upload side effect.
- APPEND/RESTORE upload only current user attachments; FRESH/REBUILD upload all attachments in the effective history + current user Context Envelope.
- Real ChatGPT attachment selectors/readiness must come from fresh authenticated inspection; never substitute fixed sleeps.
- Do not mark Phase 6 complete until deterministic verify, fresh Docker build/smoke, standalone Phase 6 authenticated E2E, and combined Phase 3/4/5/6 E2E all pass.

---

## File Structure

### New production files

- `migrations/003_add_file_blob_lifecycle.sql` — migrate Phase 2 File rows into logical `files` + physical `file_blobs`.
- `src/persistence/repositories/file-blobs.ts` — Blob row CRUD and reference queries.
- `src/attachments/policy.ts` — all Phase 6 limits, purpose enum, filename policy, and image MIME constants.
- `src/attachments/errors.ts` — stable internal File/Attachment error codes.
- `src/attachments/image.ts` — strict Base64/Data URL parsing and image signature sniffing.
- `src/attachments/network-policy.ts` — URL parsing, public-IP classification, DNS/redirect policy.
- `src/attachments/file-service.ts` — atomic temp-write, SHA-256 dedup, logical File CRUD, leases, tombstone/GC, startup cleanup.
- `src/attachments/resolver.ts` — resolve `NormalizedAttachment` into leased logical Files and prepared metadata.
- `src/attachments/staging.ts` — deterministic request-scoped upload filenames, hardlink/copy staging, cleanup.
- `src/api/files.ts` — public File object/list encoders and query types.
- `src/api/routes/files.ts` — Files API routes and streaming multipart adapter.
- `src/context/multimodal.ts` — canonical ordered content conversion/fingerprint helpers.
- `scripts/test-chatgpt-phase6-e2e.ts` — standalone authenticated Phase 6 real E2E.

### Existing production files to modify

- `package.json`, `pnpm-lock.yaml` — add exact multipart dependency.
- `src/persistence/types.ts`, `src/persistence/index.ts`, `src/persistence/repositories/files.ts`, `src/persistence/repositories/attachments.ts`, `src/persistence/conversation-store.ts` — logical File/Blob and redacted Attachment persistence.
- `src/api/server.ts`, `src/api/errors.ts` — FileService injection, Files route registration, stable Phase 6 errors.
- `src/runtime.ts` — construct FileService and AttachmentResolver from `DATA_DIR`; cleanup on close/start.
- `src/context/types.ts`, `src/context/planner.ts`, `src/context/canonicalize.ts` — multimodal canonical messages while retaining text-only behavior.
- `src/conversations/request-context.ts`, `src/conversations/prompts.ts`, `src/conversations/aggregate-builder.ts`, `src/conversations/conversation-engine.ts` — resolution/canonicalization/upload selection/checkpoint/final AttachmentRecords.
- `src/chatgpt/selectors.ts`, `src/chatgpt/inspect.ts`, `src/chatgpt/driver.ts`, `src/chatgpt/errors.ts` — attachment diagnostics and prepared upload ownership/readiness.
- `scripts/inspect-chatgpt.ts`, `scripts/test-chatgpt-e2e.ts`, `scripts/docker-smoke.mjs`, `scripts/check-architecture.mjs` — diagnostics, combined E2E, Docker acceptance, architecture guards.
- `docs/testing.md`, `docs/architecture.md`, `docs/api-compatibility.md`, `docs/roadmap.md`, `docs/PROJECT_STATE.md` — final accepted facts only when their evidence exists.

### New/expanded tests

- `tests/unit/persistence-file-blobs.test.ts`
- `tests/unit/attachment-policy.test.ts`
- `tests/unit/attachment-image.test.ts`
- `tests/unit/attachment-network-policy.test.ts`
- `tests/unit/file-service.test.ts`
- `tests/unit/attachment-resolver.test.ts`
- `tests/unit/multimodal-context.test.ts`
- `tests/unit/files-api.test.ts`
- `tests/unit/chatgpt-upload.test.ts`
- `tests/integration/files-lifecycle.test.ts`
- `tests/integration/conversation-attachments.test.ts`
- existing migration/persistence/conversation/streaming tests as regressions.

---

### Task 1: File/Blob Migration and FileService

**Files:**
- Create: `migrations/003_add_file_blob_lifecycle.sql`
- Create: `src/persistence/repositories/file-blobs.ts`
- Create: `src/attachments/policy.ts`
- Create: `src/attachments/errors.ts`
- Create: `src/attachments/file-service.ts`
- Modify: `src/persistence/types.ts`
- Modify: `src/persistence/repositories/files.ts`
- Modify: `src/persistence/index.ts`
- Test: `tests/unit/persistence-migrations.test.ts`
- Test: `tests/unit/persistence-files-images.test.ts`
- Create: `tests/unit/persistence-file-blobs.test.ts`
- Create: `tests/unit/file-service.test.ts`

**Interfaces:**
- Produces `FileBlobRecord { id, sha256, sizeBytes, storagePath, createdAt }`.
- Produces `FileRecord { id, publicId?, blobId, filename, mimeType?, purpose?, deletedAt?, sizeBytes, sha256, storagePath, createdAt, updatedAt }` as a joined projection.
- Produces `FileService.createPublicFile(input)`, `createPrivateFile(input)`, `getPublicFile(publicId)`, `listPublicFiles(query)`, `openContent(publicId)`, `acquirePublicFile(publicId)`, `deletePublicFile(publicId)`, `cleanup()`.
- `createPublicFile`/`createPrivateFile` accept a byte stream plus safe metadata and return a logical `FileRecord` only after the Blob is durably adopted.

- [x] **Step 1: Add failing migration tests for schema 003 and legacy duplicate-hash migration**

Extend `tests/unit/persistence-migrations.test.ts` so a fresh DB expects `file_blobs`, `files.public_id/blob_id/purpose/deleted_at`, and exactly migrations `001`, `002`, `003`. Add a legacy fixture with two old `files` rows sharing SHA/size but different paths plus an Attachment FK; after migration both logical rows must reference one Blob and the Attachment must still point at its original internal File UUID. Add a conflicting same-SHA/different-size fixture that expects migration rollback.

Run: `corepack pnpm vitest run tests/unit/persistence-migrations.test.ts`
Expected: FAIL because migration `003` and the new schema do not exist.

- [x] **Step 2: Implement migration 003 minimally**

Create `003_add_file_blob_lifecycle.sql` using SQLite table rebuild semantics: create `file_blobs`, create the target `files_new`, populate one Blob per SHA after rejecting same-SHA/different-size, populate logical Files preserving internal IDs, rebuild Attachment FK compatibility, then rename/index. Keep SQL deterministic because migration checksums are persisted.

Run: `corepack pnpm vitest run tests/unit/persistence-migrations.test.ts`
Expected: PASS.

- [x] **Step 3: Add failing repository projection tests**

Define desired rows in `tests/unit/persistence-file-blobs.test.ts` and update `tests/unit/persistence-files-images.test.ts` to assert:

```ts
expect(files.getById(file.id)).toMatchObject({
  id: file.id,
  publicId: 'file-11111111-1111-4111-8111-111111111111',
  blobId,
  sha256: 'abc123',
  sizeBytes: 12,
  storagePath: '/data/files/blobs/abc123',
  purpose: 'user_data',
});
```

Run both repository test files.
Expected: FAIL because types/repositories still expose the Phase 2 schema.

- [x] **Step 4: Implement Blob/File repositories and projections**

Add `FileBlobRepository` with `insert`, `getById`, `getBySha256`, `countReferences`, `deleteById`. Refactor `FileRepository` to join `files f JOIN file_blobs b ON b.id=f.blob_id` and provide `insert`, `getById`, `getByPublicId`, `listPublic`, `markDeleted`, `deleteById`, `countByBlobId`. Wire `fileBlobs` into `PersistenceContext`.

Run repository tests.
Expected: PASS.

- [x] **Step 5: Add failing FileService tests for atomic store/dedup/lease/delete/GC**

Tests use a real temp filesystem + SQLite and assert:

```ts
const a = await service.createPublicFile({ filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain', source: Readable.from('same') });
const b = await service.createPublicFile({ filename: 'b.txt', purpose: 'vision', mimeType: 'text/plain', source: Readable.from('same') });
expect(a.publicId).not.toBe(b.publicId);
expect(a.blobId).toBe(b.blobId);
expect(await fs.readFile(a.storagePath, 'utf8')).toBe('same');
```

Also assert 32 MiB + 1 byte rejects `file_too_large`, a lease keeps tombstoned bytes alive, and releasing the last unreferenced lease permits logical/Blob cleanup.

Run: `corepack pnpm vitest run tests/unit/file-service.test.ts`
Expected: FAIL because FileService does not exist.

- [x] **Step 6: Implement minimal FileService and centralized policy**

`src/attachments/policy.ts` exports exact constants and accepted purpose set. `FileService` writes `${DATA_DIR}/temp/<uuid>.part`, updates `createHash('sha256')` and byte count per chunk, fsyncs/closes, atomically adopts `${DATA_DIR}/files/blobs/<sha>`, then inserts Blob/File metadata. Same-hash creation reuses the existing Blob after size verification. Lease counts live only in-process and are checked before deferred cleanup.

Run: `corepack pnpm vitest run tests/unit/file-service.test.ts tests/unit/persistence-file-blobs.test.ts tests/unit/persistence-files-images.test.ts tests/unit/persistence-migrations.test.ts`
Expected: PASS.

- [x] **Step 7: Run affected persistence integration regression and commit**

Run: `corepack pnpm vitest run tests/integration/persistence-recovery.test.ts tests/unit/persistence-tools-attachments.test.ts`
Expected: PASS.

Commit: `🗃️ 增加 Phase 6 File Blob 生命周期`

---

### Task 2: Files HTTP API

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/api/files.ts`
- Create: `src/api/routes/files.ts`
- Modify: `src/api/server.ts`
- Modify: `src/api/errors.ts`
- Modify: `src/runtime.ts`
- Create: `tests/unit/files-api.test.ts`
- Create: `tests/integration/files-lifecycle.test.ts`

**Interfaces:**
- Consumes `FileService` from Task 1.
- Produces all five `/v1/files` endpoints.
- `buildServer` accepts optional `fileService?: FileService`; production runtime always injects it.

- [x] **Step 1: Add exact multipart dependency**

Run: `corepack pnpm add @fastify/multipart@10.1.0`
Expected: package and lockfile update only; no unrelated dependency upgrades.

Execution note: DevSpace forbids shell commands from editing project files, so `package.json` / `pnpm-lock.yaml` were updated through workspace edits and then `corepack pnpm install --frozen-lockfile --ignore-scripts` verified the exact lock plus pnpm supply-chain policy.

- [x] **Step 2: Write failing API tests for auth/create/object shape**

Use Fastify `app.inject()` with multipart payload and assert one file + `purpose=user_data` returns status 200 and:

```ts
{
  id: expect.stringMatching(/^file-[0-9a-f-]+$/),
  object: 'file',
  bytes: 5,
  created_at: 1786900000,
  filename: 'a.txt',
  purpose: 'user_data',
}
```

Missing/duplicate file, invalid purpose, unexpected `expires_after`, unsafe filename, and oversized stream must map to `invalid_file_upload`/`file_too_large` without local paths.

Run: `corepack pnpm vitest run tests/unit/files-api.test.ts`
Expected: FAIL because Files routes are absent.

- [x] **Step 3: Implement create route using multipart stream**

Register `@fastify/multipart` with `files: 1`, constrained field/part counts, and `fileSize = MAX_FILE_BYTES + 1` so FileService remains authoritative. Iterate request parts, require exactly one `file` and one `purpose`, consume the file stream directly through `FileService.createPublicFile`, and reject extra parts/fields. Encode timestamps in Unix seconds.

Run unit API tests.
Expected: create tests PASS.

- [x] **Step 4: Add failing list/retrieve/content/delete tests**

Cover `after`, `limit`, `order`, `purpose`, private/deleted/unknown 404, exact content bytes, MIME fallback, safe Content-Disposition, and tombstone delete response.

Run unit API tests.
Expected: FAIL on unimplemented routes.

- [x] **Step 5: Implement list/retrieve/content/delete routes and stable errors**

Add FileService methods/query plumbing and encode OpenAI-style list object with `first_id`, `last_id`, `has_more`. Content must stream from the Blob path through FileService, not expose the path. Map `file_not_found`, `invalid_file_upload`, `file_too_large`, `file_storage_error` in `src/api/errors.ts`.

Run unit API tests.
Expected: PASS.

- [x] **Step 6: Add and pass restart lifecycle integration**

`tests/integration/files-lifecycle.test.ts` must perform POST → metadata → list → content → close runtime → reopen same `DATA_DIR` → content → DELETE → 404, plus same bytes twice => distinct public IDs / one Blob.

Run: `corepack pnpm vitest run tests/integration/files-lifecycle.test.ts`
Expected: PASS.

- [x] **Step 7: Run server/runtime regressions and commit**

Run: `corepack pnpm vitest run tests/integration/gateway-runtime.test.ts tests/unit/api-errors.test.ts tests/unit/request-schemas.test.ts`
Expected: PASS.

Commit: `✨ 实现 OpenAI 兼容 Files 生命周期`

---

### Task 3: Attachment Resolver, Security Policy, and Staging

**Files:**
- Create: `src/attachments/image.ts`
- Create: `src/attachments/network-policy.ts`
- Create: `src/attachments/resolver.ts`
- Create: `src/attachments/staging.ts`
- Create: `tests/unit/attachment-policy.test.ts`
- Create: `tests/unit/attachment-image.test.ts`
- Create: `tests/unit/attachment-network-policy.test.ts`
- Create: `tests/unit/attachment-resolver.test.ts`

**Interfaces:**
- Produces `ResolvedAttachment { localAttachmentId, kind, file, source: AttachmentSourceRecord, lease }`.
- Produces `PreparedAttachment { localAttachmentId, kind, fileId, sha256, filename, mimeType?, sizeBytes, stagingPath, uploadFilename }`.
- Produces `AttachmentResolver.resolveAll(attachments, { requestId, signal })` returning a request-scoped handle with `resolved`, `stage(uploadIds)`, and `release()`.
- Network transport/DNS are injectable so SSRF behavior is deterministic without relaxing production policy.

- [x] **Step 1: Write failing filename/image/Base64 tests**

Assert filename rejects `/`, `\\`, NUL/control characters, empty names, and >255 UTF-8 bytes while accepting normal Unicode. Assert strict Base64 rejects bad alphabet/padding. Assert PNG/JPEG/WEBP/GIF signatures and MIME mismatch behavior.

Run: `corepack pnpm vitest run tests/unit/attachment-policy.test.ts tests/unit/attachment-image.test.ts`
Expected: FAIL because modules do not exist.

- [x] **Step 2: Implement filename and image parsers**

Implement byte-length-safe filename validation, strict Base64 decode with encoded-size precheck + decoded-size check, `data:image/<type>;base64,...` parser, and signature sniffing that returns canonical MIME + extension.

Run the two tests.
Expected: PASS.

- [x] **Step 3: Write failing URL/SSRF tests**

Cover scheme/credential rejection, IPv4 loopback/private/link-local/CGNAT/multicast/unspecified, IPv6 loopback/ULA/link-local/multicast/unspecified, all DNS answers checked, redirect revalidation, >5 redirects, response streaming >32 MiB, and sanitized fetch errors that exclude query tokens.

Run: `corepack pnpm vitest run tests/unit/attachment-network-policy.test.ts`
Expected: FAIL.

- [x] **Step 4: Implement production URL policy with injectable DNS/transport**

Parse URL, resolve all addresses, reject non-global ranges, pin the selected validated address through the transport boundary, re-run policy for each redirect, apply 10s connect/30s total timeout, and stream into FileService without trusting `Content-Length` alone.

Run network policy tests.
Expected: PASS.

- [x] **Step 5: Write failing resolver/staging tests**

Cover URL image, Data URL image, Base64 document with required filename, public `file_id`, deleted/missing file, `file_id` image sniff, max 16 attachments, total 64 MiB, dedup semantic reuse, deterministic duplicate upload filenames (`notes.txt`, `notes (2).txt`), hardlink fallback copy, and cleanup.

Run: `corepack pnpm vitest run tests/unit/attachment-resolver.test.ts`
Expected: FAIL.

- [x] **Step 6: Implement resolver and staging**

Resolve all external descriptors into FileService logical Files, acquire leases before returning, never persist raw source content, then stage only selected attachment IDs under `${DATA_DIR}/temp/attachments/<request-id>/...`. `release()` must remove staging and release all leases even after partial failure.

Run resolver tests.
Expected: PASS.

- [x] **Step 7: Run normalized-input regressions and commit**

Run: `corepack pnpm vitest run tests/unit/chat-completions-normalizer.test.ts tests/unit/responses-normalizer.test.ts tests/unit/normalized-common.test.ts tests/unit/normalizer-parity.test.ts`
Expected: PASS.

Commit: `🔒 增加附件解析与 SSRF 安全边界`

---

### Task 4: Canonical Multimodal Context and Upload Selection

**Files:**
- Create: `src/context/multimodal.ts`
- Modify: `src/context/types.ts`
- Modify: `src/context/planner.ts`
- Modify: `src/conversations/request-context.ts`
- Modify: `src/conversations/prompts.ts`
- Create: `tests/unit/multimodal-context.test.ts`
- Modify: `tests/unit/context-planner.test.ts`
- Modify: `tests/unit/phase4-request-context.test.ts`

**Interfaces:**
- `CanonicalContentPart = {type:'text'; text:string} | {type:'attachment'; kind; sha256; filename; mimeType?}`.
- `CanonicalMessage = { role:'user'|'assistant'; content: CanonicalContentPart[] }`.
- `toCanonicalConversationRequest(request, resolvedAttachmentById)` accepts resolved file semantics; text-only calls remain source-compatible through an empty map/default helper.
- `selectUploadAttachmentIds(plan, canonicalRequest)` returns ordered local attachment IDs needed for the chosen plan without adding a fifth planner mode.

- [x] **Step 1: Write failing canonical equivalence/order tests**

Test same bytes from URL/Data URL/public file become equal canonical attachment parts when kind/filename/MIME match; different filename or image/file kind changes fingerprint; text/attachment order is preserved; attachment-only final user is valid; empty user remains invalid.

Run: `corepack pnpm vitest run tests/unit/multimodal-context.test.ts`
Expected: FAIL.

- [x] **Step 2: Implement canonical multimodal conversion**

Replace text-only message assumptions with ordered `content` parts and add helpers to extract normalized text only where prompt serialization needs it. Keep `canonicalizeText` and instruction behavior unchanged.

Run multimodal tests.
Expected: PASS.

- [x] **Step 3: Add failing planner/upload-set regression tests**

Assert existing pure-text Phase 4 cases produce the same FRESH/APPEND/RESTORE/REBUILD results. Add attachment cases: APPEND/RESTORE current user IDs only; FRESH/REBUILD all effective history/current IDs; full-history attachment divergence causes REBUILD.

Run: `corepack pnpm vitest run tests/unit/context-planner.test.ts tests/unit/multimodal-context.test.ts`
Expected: FAIL on upload-set/canonical attachment behavior.

- [x] **Step 4: Update planner/prompt serialization minimally**

Planner continues comparing canonical messages through existing fingerprint. Context prompt serializes ordered content and attachment metadata `{kind, filename, upload_filename}` supplied by Conversation layer, never hash/file ID/path. Append prompt serializes only current user content.

Run planner/multimodal and existing Phase 4 request-context tests.
Expected: PASS.

- [x] **Step 5: Run full text-only Context regression and commit**

Run: `corepack pnpm vitest run tests/unit/context-*.test.ts tests/unit/phase4-request*.test.ts tests/integration/conversation-engine.test.ts tests/integration/conversation-streaming.test.ts`
Expected: PASS.

Commit: `♻️ 扩展 Conversation 多模态上下文模型`

---

### Task 5: Authenticated DOM Inspection and ChatGPT Upload Driver

**Files:**
- Modify: `src/chatgpt/inspect.ts`
- Modify: `scripts/inspect-chatgpt.ts`
- Modify after inspection: `src/chatgpt/selectors.ts`
- Modify: `src/chatgpt/driver.ts`
- Modify: `src/chatgpt/errors.ts`
- Create: `tests/unit/chatgpt-upload.test.ts`
- Modify: `tests/unit/chatgpt-inspect.test.ts`
- Modify: `tests/unit/chatgpt-driver.test.ts`

**Interfaces:**
- Driver request adds `attachments?: ChatGptPreparedUpload[]`, where `{ localAttachmentId, kind, path, displayFilename }` contains no URL/Base64/FileRepository detail.
- `inspect:chatgpt` report adds attachment trigger/input multiplicity and preview/readiness diagnostic facts.
- Driver errors add `chatgpt_upload_failed` and `chatgpt_upload_timeout`.

- [x] **Step 1: Write failing inspection-contract tests without guessing selectors**

Extend inspect result shape to require fields for file input presence/count/multiple support and attachment preview diagnostics. Unit tests use fake selector-registry results; production diagnostics may additionally enumerate safe `input[type=file]` metadata to discover candidates but must not expose user file content.

Run: `corepack pnpm vitest run tests/unit/chatgpt-inspect.test.ts`
Expected: FAIL because the result shape lacks attachment diagnostics.

- [x] **Step 2: Implement diagnostic-only attachment discovery and run deterministic tests**

Add inspection fields while keeping selector registration optional until real inspection proves a stable candidate. Do not add upload behavior yet.

Run inspection unit tests.
Expected: PASS.

- [x] **Step 3: Run fresh authenticated DOM inspection**

Use the existing isolated E2E profile and configured ChatGPT proxy. Run `corepack pnpm inspect:chatgpt` with explicit `CHATGPT_PROFILE_DIR`/`CHATGPT_PROXY_SERVER` and capture whether attachment input, `multiple`, preview items, pending/ready/error signals are observable.

Expected: `auth=authenticated`, `composer=unique`, and a deterministic attachment contract. If no reliable readiness contract exists, mark Task 5 `[!]`, record the blocker in `PROJECT_STATE`, and do not invent sleeps/selectors.

- [x] **Step 4: Lock only inspected selectors and write failing Driver ownership tests**

After Step 3 evidence, add exact stable candidates to `src/chatgpt/selectors.ts`. In `tests/unit/chatgpt-upload.test.ts`, fake Page/Locator behavior must assert: baseline existing previews are ignored; exactly N new owned previews must appear; all must reach ready; one owned error maps `chatgpt_upload_failed`; timeout maps `chatgpt_upload_timeout`; abort interrupts readiness; Send is never clicked before all owned uploads are ready.

Run: `corepack pnpm vitest run tests/unit/chatgpt-upload.test.ts`
Expected: FAIL because Driver has no attachment upload path.

- [x] **Step 5: Implement prepared upload path in Driver**

Order: abort check → Assistant baseline → attachment baseline → `setInputFiles()` with staged paths → wait exact owned items ready → fill prompt → re-check ownership/readiness → Send → existing target-turn observer. Reuse existing selector ambiguity semantics and AbortSignal at every await boundary.

Run: `corepack pnpm vitest run tests/unit/chatgpt-upload.test.ts tests/unit/chatgpt-driver.test.ts tests/unit/chatgpt-inspect.test.ts`
Expected: PASS.

- [x] **Step 6: Commit inspected Driver contract**

Commit: `✨ 增加 ChatGPT 附件上传就绪检测`

---

### Task 6: Conversation Engine Attachment Lifecycle

**Files:**
- Modify: `src/conversations/conversation-engine.ts`
- Modify: `src/conversations/aggregate-builder.ts`
- Modify: `src/persistence/types.ts`
- Modify: `src/persistence/repositories/attachments.ts`
- Modify: `src/persistence/conversation-store.ts`
- Modify: `src/runtime.ts`
- Modify: `src/api/execution.ts` if dependency typing requires it
- Create: `tests/integration/conversation-attachments.test.ts`
- Modify: `tests/integration/conversation-streaming-consistency.test.ts`

**Interfaces:**
- `CreateConversationEngineOptions` receives `attachmentResolver` in addition to existing Driver/Store/Queue/PageRegistry.
- Stored `AttachmentRecord.source` becomes redacted `AttachmentSourceRecord` and `fileId` is required for Phase 6-created records.
- Resolver handle owns leases/staging and is always released in `finally`.

- [x] **Step 1: Write failing non-stream lifecycle tests**

Use real temp SQLite/FileService + fake Driver. Assert resolve occurs inside same-key queue before page acquisition; pre-browser resolver failure leaves checkpoint clean; first browser upload occurs only after checkpoint `in_flight`; APPEND/RESTORE upload current attachments only; FRESH/REBUILD upload all selected effective attachments; success persists User content + redacted AttachmentRecords + Assistant + clean checkpoint atomically.

Run: `corepack pnpm vitest run tests/integration/conversation-attachments.test.ts`
Expected: FAIL because Engine rejects attachments.

- [x] **Step 2: Implement non-stream attachment orchestration**

Inside queue: load latest aggregate → resolve all descriptors → canonicalize using resolved metadata → plan → acquire Page → prepare page → stage only selected IDs → checkpoint → call Driver with staged prepared uploads → final aggregate with AttachmentRecords → session complete. Always release resolver handle/staging in `finally`.

Run conversation attachment tests.
Expected: PASS for non-stream cases.

- [x] **Step 3: Add failing stream ordering/error tests**

Assert resolver failure occurs before internal `started`; after successful resolver, `started` precedes checkpoint/upload; post-start upload failure emits stream error and no success terminal; upload abort keeps `in_flight` and discards Page; final-save failure with attachments still prevents `[DONE]`/`response.completed`.

Run: `corepack pnpm vitest run tests/integration/conversation-attachments.test.ts tests/integration/conversation-streaming-consistency.test.ts`
Expected: FAIL on stream attachment path.

- [x] **Step 4: Implement stream attachment lifecycle while reusing Phase 5 core**

Only pre-Send path changes. After Driver returns a `ChatGptTextTurn`, continue using existing `streamAssistantText`, Stop, conversation URL, final save, and terminal rules unchanged.

Run the two tests.
Expected: PASS.

- [x] **Step 5: Tighten persistence validation and sensitive-source tests**

Update ConversationStore validation so every attachment content reference has an AttachmentRecord, every new AttachmentRecord has `fileId`, and persisted source JSON can only be `{type:'url'|'data_url'|'base64'|'file_id'}` with no payload fields. Add regression asserting raw signed URL/Base64 is absent from DB text.

Run: `corepack pnpm vitest run tests/unit/persistence-tools-attachments.test.ts tests/integration/persistence-recovery.test.ts tests/integration/conversation-attachments.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

Commit: `✨ 接通 Conversation 附件执行生命周期`

---

### Task 7: Cross-Protocol Deterministic Integration and Architecture Guards

**Files:**
- Modify/create relevant API/conversation integration tests
- Modify: `scripts/check-architecture.mjs`
- Modify: `src/api/errors.ts` if uncovered mapping gaps exist

**Interfaces:**
- Both Chat Completions and Responses must feed the same Resolver/Conversation Engine and differ only at protocol adapters/encoders.

- [ ] **Step 1: Add failing HTTP integration matrix**

Cover Chat Completions image URL/Data URL/file data/file_id and Responses input_image/input_file, each with non-stream and at least representative stream paths. Include same-key FIFO during slow resolve/upload, different-key parallel, invalid/deleted file pre-start error, post-start Driver upload error/no success terminal.

Run targeted integration files.
Expected: FAIL only for uncovered wiring/errors.

- [ ] **Step 2: Make minimal protocol wiring/error corrections**

Do not duplicate attachment logic in routes. Extend Phase request validation so attachments are supported while Tools/structured/image output still produce `unsupported_phase6_request`.

Run targeted integration matrix.
Expected: PASS.

- [ ] **Step 3: Add architecture-check assertions**

Make `scripts/check-architecture.mjs` fail if `attachments/` imports Playwright/`api/`/`chatgpt/`, `chatgpt/` imports persistence/FileRepository, or File/Blob filesystem logic appears in API routes/Driver. Preserve existing selector-definition-only-in-`selectors.ts` rule.

Run: `node scripts/check-architecture.mjs`
Expected: PASS after implementation boundaries comply.

- [ ] **Step 4: Run deterministic full verify and commit**

Run: `corepack pnpm verify`
Expected: all format/lint/typecheck/unit/integration/build/governance checks PASS.

Commit: `🧪 完成 Phase 6 确定性附件验收`

---

### Task 8: Docker File Lifecycle Acceptance

**Files:**
- Modify: `scripts/docker-smoke.mjs`
- Modify Docker/Compose files only if evidence requires permission/path changes.

**Interfaces:**
- Docker smoke remains deterministic and does not access real ChatGPT.

- [ ] **Step 1: Add smoke assertions for migration 003 and File directories**

Require migration history exactly `001`, `002`, `003`; verify `/data/files/blobs` and `/data/temp` are writable by configured PUID/PGID.

Run the relevant smoke script against a fresh image after code exists.
Expected before smoke implementation: existing assertions fail on old migration count.

- [ ] **Step 2: Add Files lifecycle smoke**

Through the container HTTP API: upload a small multipart fixture, GET metadata/content, restart with same bind mount, GET exact content, DELETE, then verify public 404. Also retain all existing normal/maintenance single-owner, seccomp/sandbox, RFB, SQLite restart checks.

- [ ] **Step 3: Fresh Docker build and smoke**

Run: `corepack pnpm docker:build`
Expected: PASS on `linux/amd64`.

Run: `corepack pnpm docker:smoke`
Expected: PASS with migrations `001/002/003` and File persistence lifecycle.

- [ ] **Step 4: Commit**

Commit: `🐳 验证 Phase 6 文件持久化容器边界`

---

### Task 9: Authenticated Real Phase 6 E2E

**Files:**
- Create: `scripts/test-chatgpt-phase6-e2e.ts`
- Modify: `scripts/test-chatgpt-e2e.ts`
- Modify: `package.json`
- Add deterministic small fixtures under the existing test fixture convention; generated runtime artifacts remain ignored.

**Interfaces:**
- Adds `corepack pnpm test:e2e:chatgpt:phase6`.
- Combined `test:e2e:chatgpt` runs Phase 3 regression, Phase 4, Phase 5, then Phase 6.

- [ ] **Step 1: Write harness assertions and fixture builders**

Create deterministic tiny PNG/JPEG marker images and PDF/TXT/DOCX/XLSX fixtures with unique tokens using existing dev/runtime libraries or minimal ZIP/XML fixture bytes without adding production parsing dependencies. Harness must test one direct image data path, one image `file_id`, one document `file_id`, one direct Base64 document, same-key APPEND, runtime restart RESTORE, and one attachment `stream=true` path.

- [ ] **Step 2: Run fresh authenticated inspect gate again**

Run with explicit isolated `CHATGPT_PROFILE_DIR` and proxy. Require authenticated composer + attachment readiness diagnostics. If this fails, record real blocker and do not claim Phase 6 acceptance.

- [ ] **Step 3: Run standalone Phase 6 E2E**

Run: `E2E_CHATGPT=1 ... corepack pnpm test:e2e:chatgpt:phase6`
Expected evidence:
- image model answer contains fixture marker;
- PDF/TXT/DOCX/XLSX answers contain each unique token;
- APPEND does not reupload old attachment yet can answer about it;
- restart RESTORE retains attachment context;
- stream meaningful delta occurs before target completion and final delta concat equals DOM/SQLite;
- final Conversation is clean with Attachment → File → Blob linkage.

- [ ] **Step 4: Run combined Phase 3/4/5/6 E2E**

Run: `E2E_CHATGPT=1 ... corepack pnpm test:e2e:chatgpt`
Expected: all earlier phase regressions plus Phase 6 PASS.

- [ ] **Step 5: Record any real remote URL coverage explicitly and commit**

If a safe stable public fixture is available, run a real URL image path. If not, record that remote fetch was deterministically verified but not live-network E2E; never bypass SSRF with localhost/private IP.

Commit: `🧪 增加 Phase 6 真实附件端到端验收`

---

### Task 10: Final Documentation, Project Memory, and Branch Completion

**Files:**
- Modify: `docs/api-compatibility.md`
- Modify: `docs/testing.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/PROJECT_STATE.md`
- Modify: this plan checkboxes/status notes
- Modify: `README.md` only if Files usage/retention behavior needs user-facing instructions.

**Interfaces:**
- Only evidence already produced in Tasks 1–9 may become “implemented/verified” facts.

- [ ] **Step 1: Mark plan tasks with actual outcomes**

Use `[x]`, `[!]`, or `[-]` per `docs/project-memory-protocol.md`; do not mark blocked real E2E as complete.

- [ ] **Step 2: Update compatibility/architecture/testing/state from evidence**

If and only if Task 9 passes, mark Files five endpoints, Chat Completions URL/Data URL/file data/file_id, Responses input_image/input_file data/file_id as implemented and authenticated-real-E2E accepted. Keep `input_file.file_url`, Tools, Structured Output, and Image Generation unsupported. Document DELETE retained-history semantics and Gateway 32/64 MiB limits as product policy, not upstream limits.

- [ ] **Step 3: Fresh final verification**

Run: `corepack pnpm verify`
Expected: PASS.

Run: `git diff --check`
Expected: no output.

Run: `git status --short --branch` and inspect `git diff`/`git diff --staged` before commit.

- [ ] **Step 4: Commit final writeback**

Commit: `📝 完成 Phase 6 附件验收回写`

- [ ] **Step 5: Push feature branch**

Run: `git push`
Expected: `phase-6-attachments` updates on `origin` without force push.
