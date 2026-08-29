# Phase 9 Production Maturity Design（恢复、诊断与 NAS 生产成熟化）

**Date:** 2026-08-27
**Status:** Accepted — final unified deterministic/Docker and authenticated V1 acceptance complete on 2026-08-29

## 1. Goal

在不重做 Phase 1–8 已有持久化/容器边界的前提下，补齐 V1 生产成熟化：Structured Output 兼容执行、失败 Page 隔离、BrowserContext 进程级恢复、无外网 readiness 诊断、NAS 冷备份/恢复流程与部署安全说明。

## 2. Structured Output

Chat Completions `response_format=json_object/json_schema` 与 Responses `text.format=json_object/json_schema` 已由 Normalizer 统一为 `output.structured`。Phase 9 取消执行层 501：

- Context/Append Prompt 以 JSON-safe `structured_output` data field 携带约束。
- `json_object` 要求整个 Assistant 文本是一个 JSON object。
- `json_schema` 在浏览器执行前用本地 Ajv 编译调用方 schema；无效 schema 返回 `invalid_conversation_request`。
- 最终 Assistant DOM 文本必须本地 parse/validate；失败返回 `chatgpt_structured_output_invalid`，不保存 clean success。
- Streaming 仍可发送生成中的文本 delta；只有最终本地结构校验成功后才允许 clean commit 与成功 terminal。Gateway 不伪造 ChatGPT Web 的原生 constrained-decoding 能力。

## 3. Recovery escalation

复用既有 `clean | in_flight`、RESTORE/REBUILD 与 Conversation URL：

1. 单次网页执行失败时，Conversation Page session 的 `fail()` **关闭**该 Page，不再 release 回池。
2. Playwright Persistent BrowserContext 在最后一个 Page 被关闭时会同时关闭整个 context；因此 PagePool 在关闭最后一个 failed lease 前必须先创建一个 fresh idle replacement Page，再关闭失败 Page。这样仍然真正丢弃未知状态 Page，同时不会把正常 Page-level failure 错升级成 BrowserContext death。
3. 下一请求复用/获取这个 fresh Page；SQLite `in_flight` 触发保守 REBUILD，clean state 可 RESTORE。
4. Persistent BrowserContext 真正意外关闭时，BrowserManager 发出 fatal callback。
5. 产品 `src/index.ts` 清理 Gateway 后以 exit code 1 退出；正式 Compose 已有 `restart: unless-stopped`，因此重新创建 Chromium/BrowserContext，同时 `/data` 的 SQLite/Profile/Files/Generated Images 保持不变。
6. 人工认证失效仍通过 noVNC maintenance overlay 恢复，不自动填写账号、MFA 或 CAPTCHA。

不在应用内部实现复杂 BrowserContext 热替换；进程边界是更简单且可验证的最终恢复层。

## 4. Diagnostics

保持 `GET /health` 为无认证、process-level liveness，不访问 ChatGPT、也不暗示登录有效。

新增 authenticated Gateway extension：`GET /v1/diagnostics`。只返回：

- `status=ready|maintenance`
- `ui_mode`
- Browser 是否存在、Page open/leased/idle 计数
- `auth_state=not_probed`
- SQLite / Files / Generated Images 本地边界 ready

不得返回 API Key、Authorization、Cookie、Proxy URL、Profile path、Prompt、Tool arguments/result 或上传/生成内容。真实登录/DOM 健康仍只由显式 `inspect:chatgpt` 验证。

## 5. Generated image public URL

Phase 8 URL output 支持可选 `PUBLIC_BASE_URL`。只接受无 credentials/query/hash 的 `http(s)` URL base；未配置时使用当前请求 protocol + Host。Compose/.env 只透传，不写死 LAN proxy 或部署地址。

## 6. NAS cold backup and restore

新增 `backup:data` / `restore:data` CLI：

- 必须显式传 `--gateway-stopped`，强调这是**冷备份**。
- Backup destination 必须在 DATA_DIR 外且不存在；保存整个 `/data` 语义边界和 `BACKUP_MANIFEST.json`。
- Restore source 必须有受支持 manifest 和 `gateway.db`；目标 DATA_DIR 必须为空。
- 不提供未经验证的在线 Browser Profile + SQLite 热备一致性承诺。
- 备份包含 ChatGPT 登录 Profile 和用户数据，按敏感凭据等级保护。

## 7. Deployment/security maturity

- 基础 Compose 继续 `restart: unless-stopped`、`init: true`、`linux/amd64`、非 root PUID/PGID、持久 `/data`。
- noVNC 仍只在 maintenance overlay 中启用，默认 bind `127.0.0.1` 并要求 `NOVNC_PASSWORD`。
- Gateway API 必须使用长随机 Bearer key；公网暴露时应由反向代理提供 TLS。
- `PUBLIC_BASE_URL` 不改变 content route 的 Bearer authentication。
- ChatGPT/browser network proxy 继续显式配置；不提交局域网代理为默认值。

## 8. Acceptance

最终统一测试阶段必须证明，并已于 2026-08-29 全部满足：

1. Structured Output deterministic json_object/json_schema、无效 schema、最终 mismatch、stream terminal gate。
2. failed Page 被关闭；下一次可获得新 Page。
3. unexpected BrowserContext close 通知 fatal，intentional close 不误报。
4. diagnostics 需要 Bearer 且无敏感字段。
5. cold backup → restore 后 SQLite、Files、Generated Images/Profile 文件边界保持。
6. Docker smoke 继续证明 non-root `/data` 可写、maintenance/noVNC/seccomp 和 restart boundary 无回归。
7. NAS operations 文档给出首次部署、登录、更新、备份、恢复、故障诊断和回滚步骤。
