# Phase 8 ChatGPT Image Generation Design（图片生成设计）

**Date:** 2026-08-27
**Status:** Accepted — standalone and reduced combined Phase 3→8 authenticated acceptance complete

## 1. Goal

实现 `POST /v1/images/generations`，通过 authenticated ChatGPT Web 生成一张最终图片，将原始最终图片保存到 `${DATA_DIR}/generated/`，写入既有 `generated_images` SQLite Repository，并返回 OpenAI-compatible URL 或 `b64_json`。

## 2. V1 scope

支持：

- `prompt`：必填非空字符串。
- `n`：默认/只支持 `1`；`n>1` 稳定拒绝。
- `response_format`：`url | b64_json`，默认 `url`。
- `size` / `quality` / `style`：接受兼容字段但不伪造网页精确控制；当前仅作为 ignored compatibility metadata，不加入冗长网页 Prompt。
- 一次请求使用一个 Fresh ChatGPT page turn，不参与 Conversation Key / Context Sync。
- 最终图片只在 ChatGPT Assistant turn 完成后采集，不返回 partial image。
- Gateway 保存图片 bytes；不把 ChatGPT 临时 CDN/blob URL 暴露为 API 事实来源。

不支持：image edits、variations、partial streaming、`n>1`。

## 3. Architecture

```text
POST /v1/images/generations
→ Image request validation
→ ImageGenerationService
→ PagePool.acquire()
→ ChatGPT image driver: Fresh + minimal image prompt
→ snapshot conversation-turn image baseline before Send
→ select exactly one newly added generated-image candidate
→ fetch candidate bytes inside authenticated page context
→ signature sniff
→ atomic write data/generated/<uuid>.<ext>
→ SHA-256 + generated_images insert
→ URL or b64_json encoder
```

Images execution is separate from Conversation Engine because the OpenAI Images endpoint is a one-shot generation API and has no `X-Conversation-Key` continuation semantics.

## 4. ChatGPT image driver

新增 `src/chatgpt/image-driver.ts`。它复用现有 text driver 的 Fresh navigation/send behavior，但图片归属不依赖文本 Assistant role。2026-08-27 Phase 8 首次 live 请求暴露当前 ChatGPT 图片 turn 可不挂在 `[data-message-author-role="assistant"]` 下，因此 image Driver 在 Send 前记录 conversation-turn `img` collection baseline，只检查随后新增的图片 DOM；文本 Driver 的 `copy-turn-action-button` completion marker 不再作为图片生成完成条件。

生成 Prompt 保持最小：

```text
Create an image: <caller prompt>
```

不加入 Gateway/agent 身份话术，不把 API JSON 直接抄到网页。

最终图候选规则：

1. Send 前记录 `section[data-testid^="conversation-turn-"] img` 的 baseline；只检查本请求之后新增的图片元素，从而允许 image-only turn 没有 `[data-message-author-role="assistant"]`。
2. 只接受可见、已加载、`naturalWidth >= 256` 且 `naturalHeight >= 256` 的 `img`。
3. 合格 DOM 候选先按 `currentSrc || src` 去重，因为当前 ChatGPT 可重复渲染同一生成资源；恰好一个**不同图片资源**即进入 bytes fetch，无需等待文本 turn 的 copy action。多个不同图片源仍返回 `chatgpt_image_ambiguous`；直到超时仍没有候选返回 `chatgpt_generation_timeout`。
4. 在页面上下文中 `fetch(img.currentSrc || img.src)`，这样 authenticated HTTP URL、data/blob URL 都可读取；只返回 bytes，不信任远端 MIME。
5. Gateway 使用现有 `validateImageBytes()` sniff PNG/JPEG/WebP/GIF。

## 5. Storage and persistence

新增 `src/images/storage.ts` 与 `src/images/service.ts`。

- `${DATA_DIR}/generated` 启动时创建。
- 文件名只使用 Gateway UUID + sniffed extension，不使用 prompt/远端 filename。
- 写入采用同目录 temp file → rename 原子提交。
- `GeneratedImageRecord` 复用 migration 001 既有结构；Phase 8 不新增 migration。
- Images endpoint 不创建 Conversation/Message，因此 `conversationId` / `messageId` 保持 NULL。
- 记录保存 `prompt`, `mimeType`, `sizeBytes`, `sha256`, `storagePath`, `createdAt`。
- 如果持久化失败，删除刚写入文件；如果文件写入失败，不插入 DB。

## 6. Public API

请求：

```json
{
  "prompt": "a lighthouse in a storm",
  "n": 1,
  "response_format": "url"
}
```

响应：

```json
{
  "created": 1787800000,
  "data": [{ "url": "https://gateway.example/v1/images/<id>/content" }]
}
```

或：

```json
{
  "created": 1787800000,
  "data": [{ "b64_json": "..." }]
}
```

新增 authenticated `GET /v1/images/:id/content`。URL 返回优先使用可选 `PUBLIC_BASE_URL`；未配置时从当前 Fastify request protocol + Host 构造。`PUBLIC_BASE_URL` 只允许 `http(s)` origin/path base，不允许 credentials/query/hash。

## 7. Error model

新增稳定错误：

- `invalid_image_request` → 400
- `unsupported_image_request` → 400
- `chatgpt_image_missing` → 502
- `chatgpt_image_ambiguous` → 502
- `chatgpt_image_fetch_failed` → 502
- `image_storage_error` → 500
- maintenance/browser/auth/selector errors继续复用既有稳定映射。

错误和日志不包含完整 prompt、图片 bytes、临时 URL、Browser cookies。

## 8. Deterministic coverage

在最终统一测试阶段至少覆盖：

- request schema/defaults/n>1/unsupported format。
- URL and b64 response shapes。
- image signature validation, atomic storage, DB insert/rollback, restart read。
- target-turn candidate selection: zero/one/multiple/too-small/unloaded。
- authenticated content route and traversal-safe id lookup。
- runtime headless wires image service; maintenance mode returns stable error。
- existing Chat/Responses/Files routes unaffected。

## 9. Real E2E acceptance

2026-08-28 standalone Phase 8 已真实调用 `/v1/images/generations` 并通过：

1. HTTP 200。
2. SQLite 有 GeneratedImage record。
3. URL content bytes 可读且 signature 合法；另一次 `b64_json` 可解码并 signature 合法。
4. 磁盘 bytes SHA-256 与 SQLite 一致。
5. 重启 Gateway 后已生成 URL content 仍可读取。

2026-08-29 final reduced combined Phase 3→8 subsequently exited 0 and Phase 8 again returned `url/base64/persistence/restart=true`. Phase 8 acceptance is closed.
