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
- MIME（媒体类型）、Base64、URL 输入解析。
- 文件 SHA-256 去重。
- OpenAI 错误映射。
- SQLite PRAGMA、checksum migration、失败 migration rollback。
- Conversation / Message / Tool Call / Attachment / File / Generated Image Repository 约束与 JSON round-trip。
- `ConversationStore` aggregate validation 与同步事务边界。
- Phase 3 Page Pool capacity/reuse/close、BrowserManager lifecycle、Selector Registry unique/collection/fallback/missing/ambiguous。
- Auth Probe authenticated/auth_required/unknown、Driver turn ownership、completion stable sampling/timeout，以及 Phase 4 `openFresh` / `openConversation` / `sendText` 分离与安全 Conversation identity 校验。
- Phase 4 `incremental | full` 分类、`FRESH | APPEND | RESTORE | REBUILD` 纯 Planner、`clean | in_flight` checkpoint、Phase 4 request/prompt boundary、同 key FIFO、Conversation Page affinity/idle+LRU eviction、Conversation Engine 原子成功/未知失败收敛语义。
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
- 文件元数据 + 文件系统。
- Client abort（客户端断开）→ stop generation。

## E2E（端到端）

真实 ChatGPT E2E 默认关闭，而且必须同时显式提供**独立于生产**的测试 Browser Profile：

```bash
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm inspect:chatgpt

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase4
```

`CHATGPT_PROFILE_DIR` 缺失会 fail fast；如果解析到生产 `${DATA_DIR}/browser-profile/` 也会拒绝运行。测试 Profile 不得使用个人日常浏览器 Profile，登录由人工完成；E2E harness 不自动填写账号密码、MFA 或 CAPTCHA。需要代理时显式设置 `CHATGPT_PROXY_SERVER`；只接受 `http` / `https` / `socks5` server origin，URL 内禁止账号密码。

2026-08-15 Phase 3 已实际运行真实命令并通过最终验收。DevSpace 直连 `chatgpt.com` 的系统 DNS/HTTPS 路径不可用，显式 `CHATGPT_PROXY_SERVER` 恢复网络；Xvfb + full Playwright Chromium 可进入 ChatGPT 网页。隔离 Profile 通过 maintenance Google Chrome Stable 人工登录后，真实 `inspect:chatgpt` 得到 `auth=authenticated`、`composer=unique`；完整 `test:e2e:chatgpt` 随后同时得到 `driverChallenge=true` 与 `gatewayChallenge=true`。

Phase 4 提供 standalone `test:e2e:chatgpt:phase4`，而主 `test:e2e:chatgpt` 现在先跑 Phase 3 regression 再跑完整 Phase 4。Phase 4 harness 真实走 Gateway HTTP，验证 full-history APPEND 后 live ChatGPT user turn 只含新 marker、不含第一轮 token；随后 close/recreate runtime，以 single-user incremental 请求验证 RESTORE；最后提交修改后的 full history 强制 REBUILD，并要求 local key/UUID 不变而 ChatGPT URL 改变。Harness 会把显式隔离源 Profile 复制到临时 Profile 并排除 Chromium `Singleton*` marker，避免测试污染/锁死人工登录基准 Profile；复制行为有确定性单测。2026-08-15 实际运行 combined E2E 时 Phase 3 auth probe 返回 `auth_required`；standalone Phase 4 又独立在 turn 1 返回 HTTP 503 `auth_required`。因此当前外部 blocker 明确是隔离 Profile 认证失效，Phase 4 real E2E 仍未通过。

隔离 E2E Profile 可通过 maintenance overlay 人工登录：设置 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile` 后，maintenance Google Chrome Stable 使用该测试 Profile；normal headless runtime 仍固定使用 `${DATA_DIR}/browser-profile/`。真实调试证明 Chrome for Testing 在 `auth.openai.com` Turnstile 会反复 challenge，而固定 Google Chrome Stable 能通过人工验证；maintenance 因此不使用产品 Playwright 浏览器。

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
- `schema_migrations` 包含且只包含一次 `001_initial` 当前基线。
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

当前 `corepack pnpm verify` 已组合 format、lint、typecheck、unit/integration test、build 和全部仓库治理检查。Phase 2 的确定性测试覆盖 migration checksum、防半迁移、Repository、同步事务、aggregate 原子替换以及 close/reopen 恢复；Phase 3 覆盖 Browser/PagePool、Selector/Auth、Fresh Driver/completion、response encoder 与 E2E safety gate。Phase 4 deterministic coverage 已包含 checkpoint migration、full/incremental Planner、same-key FIFO / cross-key parallel、Page affinity/idle+LRU、Driver restore、Conversation Engine crash-convergence、runtime restart、无 key持久化与跨 Chat Completions/Responses HTTP 连续性。当前最终 deterministic 基线为 43 个测试文件 / 272 个测试；使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。

`corepack pnpm verify` 必须是本地确定性检查，不自动访问真实 ChatGPT。

## 不能伪造的验证

只有真实 E2E 才能证明：

- ChatGPT 当前 Selector 可用。
- Browser Profile 当前仍登录。
- 文件实际上传成功。
- 图片实际生成并能下载。
- 当前 ChatGPT UI 没有破坏完成检测。

真实 E2E 没有通过时，最终汇报必须明确实际停在哪个外部边界。Phase 3 有历史真实通过证据：authenticated selector inspection、Fresh Driver challenge 与 Gateway HTTP challenge 均在独立测试 Profile 上执行成功。Phase 4 当前代码、deterministic 与 Docker smoke 已完成，但 real E2E 仍停在隔离 Profile `auth_required`，尚未触达真实 APPEND/RESTORE/REBUILD DOM 断言。因此可以声明 Phase 4 **实现完成、真实网页验收未完成**，但不能关闭 Phase 4，也不能外推到 Streaming、附件、Tools 或图片能力。
