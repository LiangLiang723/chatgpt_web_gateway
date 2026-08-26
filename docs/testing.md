# Testing Strategy（测试策略）

## 原则

测试要证明行为边界，而不是只证明“Playwright 能启动”。真实 ChatGPT Web（ChatGPT 网页）变化与纯业务逻辑必须分开测试。

## Unit（单元测试）

不得访问网络或真实浏览器。重点覆盖：

- OpenAI Schema（结构）→ `NormalizedRequest`。
- `FRESH | APPEND | RESTORE | REBUILD`。
- Message canonicalization（消息规范化）与 fingerprint（指纹）。
- Stable Prefix（稳定前缀）。
- Tool Prompt / Tool Parser。
- MIME（媒体类型）、strict Base64/Data URL、PNG/JPEG/WEBP/GIF signature sniff、URL 输入解析。
- Phase 6 SSRF/DNS/redirect/pinned-address guard、16 attachment / 32 MiB single / 64 MiB request limits、filename policy、request staging hardlink/copy/cleanup。
- 文件 SHA-256 去重。
- OpenAI 错误映射。
- SQLite PRAGMA、checksum migration、失败 migration rollback。
- Conversation / Message / Tool Call / Attachment / File / Generated Image Repository 约束与 JSON round-trip。
- `ConversationStore` aggregate validation 与同步事务边界。
- Phase 3 Page Pool capacity/reuse/close、BrowserManager lifecycle、Selector Registry unique/collection/fallback/missing/ambiguous。
- Auth Probe authenticated/auth_required/unknown、Driver turn ownership、completion stable sampling/timeout，以及 Phase 4 `openFresh` / `openConversation` / `sendText` 分离与安全 Conversation identity 校验。
- Phase 4/6 `incremental | full` 分类、`FRESH | APPEND | RESTORE | REBUILD` 纯 Planner、`clean | in_flight` checkpoint、ordered multimodal canonical content/fingerprint、四-mode attachment upload selection、Context Envelope 敏感字段排除、同 key FIFO、Conversation Page affinity/idle+LRU eviction、Conversation Engine 原子成功/未知失败收敛语义。
- Chat Completions / Responses 非流式文本 Encoder 与 stable Browser/Driver/API error mapping。
- Chat Completions / Responses SSE Encoder（流式编码器，Phase 5 目标）。

## Integration（集成测试）

使用 local fixture（本地固定样本）和 fake driver（假驱动），不连接 ChatGPT：

- Phase 1：Fastify HTTP → Schema → Normalizer → injected fake execution boundary。
- Phase 2：真实临时 SQLite 文件 → migration → aggregate save → close → reopen → aggregate/File recovery。
- Phase 2：Gateway runtime 在 Fastify readiness 前创建/迁移 `${DATA_DIR}/gateway.db`，shutdown 幂等关闭 SQLite。
- Phase 3：POST route → Normalizer → injected/fake execution result → Chat Completions / Responses Encoder，全程不访问真实 ChatGPT。
- Phase 4：Gateway runtime headless → BrowserManager → Conversation Queue → Page Registry → Conversation Engine → fake ChatGPT Driver → SQLite ConversationStore；maintenance 模式不启动产品 BrowserManager/Queue/Registry。
- Phase 4：同 key HTTP 请求 FIFO、不同 key 可并行；full-history 与 single-user incremental APPEND 都不重发已确认前缀；close/recreate runtime 后 RESTORE 使用持久化 Conversation URL；post-checkpoint unknown failure 保持 `in_flight` 并在下一轮 REBUILD。
- Phase 6 Task 1/2：真实临时 SQLite + 文件系统 → migration 003 → SHA-256 Blob dedup → `/v1/files` multipart streaming create/list/retrieve/content/delete → close/reopen runtime → exact content recovery；private File 不进入公开 list，DELETE 保持历史 Attachment 引用边界。
- Phase 6 Task 6：真实临时 SQLite/FileService + AttachmentResolver + fake Driver 覆盖 same-key queue 内 resolve、Page acquire 前 staging、checkpoint-before-Browser-upload、FRESH/APPEND/RESTORE/REBUILD upload selection、redacted AttachmentRecords + required File refs，以及 stream pre-start resolver failure / post-start upload failure/abort / final-save failure 的 `in_flight` 收敛。
- Phase 6 Task 7：真实 Fastify HTTP + 两套 Normalizer + shared Conversation Engine/Resolver/FileService + fake Driver 覆盖 Chat Completions image URL/Data URL/file data/`file_id`、Responses `input_image` URL/Data URL/`file_id` + `input_file` data/`file_id`、双协议 stream/error framing、same-key slow resolve FIFO、different-key parallel、pre-start `file_not_found`、post-start `chatgpt_upload_failed` 与 `unsupported_phase6_request`。
- Client abort（客户端断开）→ stop generation。

## E2E（端到端）

真实 ChatGPT E2E 默认关闭，而且必须同时显式提供**独立于生产**的测试 Browser Profile：

```bash
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm inspect:chatgpt

E2E_CHATGPT=1 \
E2E_CHATGPT_COMBINED=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase3

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase4

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase5

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase6
```

`CHATGPT_PROFILE_DIR` 缺失会 fail fast；如果解析到生产 `${DATA_DIR}/browser-profile/` 也会拒绝运行。测试 Profile 不得使用个人日常浏览器 Profile，登录由人工完成；E2E harness 不自动填写账号密码、MFA 或 CAPTCHA。需要代理时显式设置 `CHATGPT_PROXY_SERVER`；只接受 `http` / `https` / `socks5` server origin，URL 内禁止账号密码。combined `test:e2e:chatgpt` 额外要求 `E2E_CHATGPT_COMBINED=1`，避免调试单一 Phase 时误跑整套真实网页回归。

### 真实 E2E 请求预算与退避

真实 ChatGPT E2E 是昂贵且会创建网页 Conversation 的外部验收，不作为普通调试循环：

1. deterministic/unit/integration 失败时不得访问真实 ChatGPT；先在本地收敛。
2. 真实网页问题先运行最窄 standalone Phase；禁止用 combined suite 定位一个已知单 Phase 失败。
3. combined Phase 3/4/5/6 只在 standalone 相关 Phase 已通过、代码达到最终候选时运行，并要求额外 `E2E_CHATGPT_COMBINED=1`。
4. 同一种真实网页失败最多允许立即复现一次；第二次仍失败后停止重复真实请求，转为 deterministic、DOM inspection、network diagnostics 或代码路径分析，直到形成新的可验证假设。
5. 出现 HTTP 429、ChatGPT history access restriction、平台“请求过于频繁”或同类频率保护时，立即停止全部 real E2E；不得通过新建平行 ChatGPT 会话、换测试入口或连续重试绕过限制，等外部限制解除后再从 standalone 恢复。
6. 不为了验证 E2E harness 的治理/节流改动本身而访问真实 ChatGPT；此类改动用 gate、scenario grouping、typecheck 和 deterministic tests 验证。
7. Phase 6 standalone 当前预算固定为四个逻辑 ChatGPT Conversation group：images、documents、memory/restore、streaming。图片两个场景共用 images；TXT/PDF/DOCX/XLSX 共用 documents；每个 turn 仍使用唯一 token 并验证累计 AttachmentRecords，避免会话复用掩盖当前附件未上传。

2026-08-15 Phase 3 已实际运行真实命令并通过最终验收。DevSpace 直连 `chatgpt.com` 的系统 DNS/HTTPS 路径不可用，显式 `CHATGPT_PROXY_SERVER` 恢复网络；Xvfb + full Playwright Chromium 可进入 ChatGPT 网页。隔离 Profile 通过 maintenance Google Chrome Stable 人工登录后，真实 `inspect:chatgpt` 得到 `auth=authenticated`、`composer=unique`；完整 `test:e2e:chatgpt` 随后同时得到 `driverChallenge=true` 与 `gatewayChallenge=true`。

Phase 3/4/5/6 均提供 standalone 入口；主 `test:e2e:chatgpt` 只用于最终候选 combined regression，并按 Phase 3 → 4 → 5 → 6 顺序运行。Phase 4 harness 真实走 Gateway HTTP，验证 full-history APPEND 后 live ChatGPT user turn 只含新 marker、不含第一轮 token；随后 close/recreate runtime，以 single-user incremental 请求验证 RESTORE；最后提交修改后的 full history 强制 REBUILD，并要求 local key/UUID 不变而 ChatGPT URL 改变。Harness 会把显式隔离源 Profile 复制到临时 Profile 并排除 Chromium `Singleton*` marker，避免测试污染/锁死人工登录基准 Profile；复制行为有确定性单测。2026-08-16 新的干净隔离 Profile 通过 maintenance Google Chrome Stable 登录后，`inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`；combined E2E 最终真实返回 Phase 3 `driverChallenge=true` / `gatewayChallenge=true` 与 Phase 4 `append=true` / `restore=true` / `rebuild=true`，Phase 4 real E2E 验收完成。

隔离 E2E Profile 可通过 maintenance overlay 人工登录：设置 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile` 后，maintenance Google Chrome Stable 使用该测试 Profile；normal headless runtime 仍固定使用 `${DATA_DIR}/browser-profile/`。真实调试证明 Chrome for Testing 在 `auth.openai.com` Turnstile 会反复 challenge，而固定 Google Chrome Stable 能通过人工验证；maintenance 因此不使用产品 Playwright 浏览器。若一个**已失效**的隔离 Profile 在重新认证时再次陷入 challenge loop，不要把“曾经用 Stable Chrome 成功”理解为该旧 Profile 必然可恢复：保留旧 Profile，不继续重复验证，创建一个新的干净隔离 Profile，用 Stable Chrome 登录后先跑 `inspect:chatgpt`，确认 `auth=authenticated` 再运行 real E2E。

目标场景：

1. 登录状态检查。
2. 普通文本一问一答。
3. 多轮 APPEND。
4. Gateway 重启后 RESTORE。
5. 长回复真 Streaming。
6. Markdown / 代码块 Streaming。
7. 图片输入。
8. PDF / TXT / DOCX / XLSX 代表性文件输入。
9. Tool Calling 单工具和多工具。
10. Tool Result 回传后继续回答。
11. ChatGPT 图片生成。
12. Page 回收后重新打开原 Conversation URL。

Phase 6 Task 5 已于 2026-08-19 完成 authenticated DOM inspection：当前网页有唯一 generic `input[type=file]:not([accept])`，owned file tile 用 baseline count 归属；pending 时 tile 内存在 `cursor-wait` / progress circles，ready 时两者同时消失；0-byte fixture 会新增 `role=alert` 并被映射为 upload failure。`inspect:chatgpt` 可通过 `CHATGPT_ATTACHMENT_PROBE_PATH` 运行受控、不点击 Send 的 readiness probe，并在完成后 reload Composer。

2026-08-21 standalone Phase 6 real E2E 真实通过 Data URL image、image `file_id`、TXT、PDF、DOCX、XLSX、same-key APPEND、runtime restart RESTORE 和 attachment Streaming，并要求最终 Conversation 保持 clean 的 Attachment → File → Blob linkage。随后真实网页调试修复了 Markdown 38-code-point 尾部回排与 Composer fill 后 Send 短暂未挂载两个回归。2026-08-26 最终 combined Phase 3/4/5/6 real E2E 以退出码 0 完成，Phase 3 `gatewayChallenge=true`、Phase 4 `append/restore/rebuild=true`、Phase 5 `chatCompletions/markdown/responses/abort=true`、Phase 6 九项均为 `true`，因此 Phase 6 authenticated real E2E 门槛关闭。Remote URL image fetch 的 SSRF/DNS/redirect 安全链由 deterministic tests 覆盖；本轮没有使用公网 fixture 做 live remote-fetch E2E。完整设计见 [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。

## DOM 诊断

Phase 3 已提供 `corepack pnpm inspect:chatgpt`。当前至少报告 URL、Auth State（认证状态）、Composer、Send Button、Assistant Turn collection 和 Stop Control 的结构化状态；后续附件 Phase 再把 File Input 纳入诊断 contract。

默认不保存用户页面。只有显式设置 `CHATGPT_DIAGNOSTICS_DIR` 时才保存受控 screenshot（截图）和 HTML/DOM snapshot（网页快照）；这些诊断产物与 E2E Profile 都被 Git hygiene 排除。

## 仓库治理检查

这些脚本不依赖产品代码：

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
```

它们检查文档/状态/模块边界一致性，不代表产品功能测试。

## Docker Smoke（容器冒烟）

Phase 1 起 Docker 是正式运行边界，因此除普通 Unit / Integration 外还必须验证：

- `linux/amd64` 镜像可构建。
- 容器内 Node 版本符合批准 LTS 基线。
- Playwright package 与官方基础镜像版本约束一致。
- 默认 `UI_MODE=headless` Compose 可启动 Gateway、Xvfb 和产品 full Chromium，但不启动/发布 noVNC。
- `/health` 可访问。
- `/v1/models` 的 API Key 认证正确。
- `/data` Bind Mount 可写，长期进程非 root。
- noVNC overlay 只在维护配置下启动并发布端口；默认宿主机绑定为 `127.0.0.1`。
- Xvfb 在 normal/maintenance 两种模式都以指定 `PUID/PGID` 运行；noVNC HTML、x11vnc / websockify / maintenance browser 只在 maintenance 可用。
- maintenance smoke 不只检查 noVNC HTML 200，还必须通过 `/websockify` WebSocket 实际收到 `RFB 003.008` banner，证明 x11vnc → websockify → noVNC 协议链可用；maintenance 根浏览器必须是固定 Google Chrome Stable，不得存在 `--remote-debugging-pipe` 或 `--no-sandbox`。
- maintenance Compose 必须使用 vendored Playwright seccomp profile；Chrome 进程 `Seccomp` 必须为 filter 模式，且不得拥有 `CAP_SYS_ADMIN`，证明人工登录浏览器以非 root Linux sandbox 运行。
- 当前 Ubuntu x11vnc `0.9.16` 必须使用 `-threads`；真实故障复现表明默认单线程模式会持续高 CPU 且不发送 RFB banner。
- noVNC 密码不出现在进程命令行参数中。
- `/data/gateway.db` 由指定 `PUID/PGID` 创建并可持续读取/写入。
- `schema_migrations` 包含且只包含当前三条 migration：`001_initial`、`002_add_conversation_sync_checkpoint` 与 `003_add_file_blob_lifecycle`，checksum 与顺序均正确。
- `/data/files/blobs` 与 `/data/temp` 在容器内由指定 `PUID/PGID` Gateway 可写；File/Blob bytes 不依赖容器可写层。
- 通过容器 HTTP `/v1/files` 上传 fixture 后 metadata/content 可读；使用同一 Bind Mount restart Gateway 后 exact bytes 可恢复；DELETE 后 metadata/content 均返回 404。
- 使用同一 Bind Mount restart Gateway 后数据库和 migration history 仍可用。
- 正常 `UI_MODE=headless` Compose 存在且只存在一个 `/data/browser-profile/` full Chromium browser owner，命令行不得带 `--headless`，并以指定 `PUID/PGID` 运行。
- maintenance overlay 存在且只存在一个 headed Google Chrome Stable owner；产品 BrowserManager 不并发占用同一 Profile。
- maintenance `down` 后隔离测试 Profile 不残留 `SingletonLock` / `SingletonCookie` / `SingletonSocket`，证明模式切换不会因 stale Chromium owner marker 被阻塞。
- Compose 必须透传 `PAGE_IDLE_TIMEOUT_MINUTES`；当前 smoke 使用非默认值 `12` 验证配置进入容器并保持 normal/maintenance 启动边界。

Docker smoke 不等于真实 ChatGPT E2E，不能用来证明当前 Selector、登录、Fresh 文本回答、上传或图片生成有效。

## 最终目标验证入口

Phase 1 建立完整工具链后：

```text
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
corepack pnpm verify
corepack pnpm docker:build
corepack pnpm docker:smoke
```

当前 `corepack pnpm verify` 已组合 format、lint、typecheck、unit/integration test、build 和全部仓库治理检查。Phase 5 deterministic coverage 包含 Snapshot normalization、Unicode-safe Stable Prefix、**64-code-point commit-tail holdback**、completion/divergence、provisional `/c/WEB:*` / Assistant placeholder ownership、conversation-history rate-limit 通知 modal、Assistant turn handle/Stop/pre-Send abort、SSE backpressure、Chat Completions / Responses encoders、真实本地 TCP route streaming、FRESH/APPEND/RESTORE/REBUILD、same-key FIFO / different-key parallel、final-save failure、生成中 abort 与首帧后取消；2026-08-26 新增 38-code-point Markdown renderer 尾部回排回归测试和 Composer fill 后 Send readiness 竞态覆盖。使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。

`corepack pnpm verify` 必须是本地确定性检查，不自动访问真实 ChatGPT。

## 不能伪造的验证

只有真实 E2E 才能证明：

- ChatGPT 当前 Selector 可用。
- Browser Profile 当前仍登录。
- 文件实际上传成功。
- 图片实际生成并能下载。
- 当前 ChatGPT UI 没有破坏完成检测。

真实 E2E 没有通过时，最终汇报必须明确实际停在哪个外部边界。Phase 3/4/5/6 现在都有 authenticated real E2E 通过证据。2026-08-17 `inspect:chatgpt` 在隔离登录 Profile 上实际返回 `auth=authenticated` / `composer=unique`；standalone `test:e2e:chatgpt:phase5` 真实返回 `chatCompletions=true`、`markdown=true`、`responses=true`、`abort=true`。Harness 通过真实 TCP listener 证明长回复首个 meaningful delta 早于 target completion marker，Chat Completions 只有一个 stop terminal 与一个 `[DONE]`，Markdown/code multiline 不重复/不丢尾，Responses typed lifecycle/IDs/`sequence_number` 正确，并要求最终 `delta concat == authoritative live DOM == SQLite`。abort 场景在 meaningful delta 后真实断开 socket，要求 Driver Stop 成功、SQLite 保持 `in_flight`、Page affinity 被丢弃，下一 same-key authoritative request 通过 REBUILD 收敛且 ChatGPT Conversation URL 改变。2026-08-26 最终 combined `test:e2e:chatgpt` 再次真实通过 Phase 3 gateway regression、Phase 4 APPEND/RESTORE/REBUILD、Phase 5 全部四项与 Phase 6 图片/文档/恢复/Streaming 全部场景。

### Phase 5 Docker 验收事实

2026-08-17 最终 Phase 5 产品代码 fresh `linux/amd64` Docker build 与完整 `docker:smoke` 实际通过，最终镜像 digest 为 `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0`。这是 Phase 5 历史证据，不代表当前 Phase 6 镜像。

### Phase 6 Docker 验收事实

2026-08-19 Task 8 fresh `linux/amd64` Docker build 实际通过，镜像 digest 为 `sha256:4726ee0cd39e641941385887ec44346aceb6641a190689fa188ec87764426558`；随后完整 `docker:smoke` 通过。Smoke 实际覆盖 migration `001/002/003`、`/data/files/blobs` 与 `/data/temp` PUID/PGID writeability、容器 `/v1/files` upload/metadata/content、same Bind Mount restart 后 exact bytes recovery、DELETE 后 public metadata/content 404，以及既有 normal/maintenance single owner、SQLite restart、Chrome sandbox/seccomp 与 noVNC RFB。Docker smoke 仍不访问真实 ChatGPT，因此不证明模型能读取附件。
