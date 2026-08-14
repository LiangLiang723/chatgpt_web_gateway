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
- Auth Probe authenticated/auth_required/unknown、Fresh Driver turn ownership、completion stable sampling/timeout。
- Phase3Executor Fresh-only capability validation、JSON instruction envelope 和 lease `finally` release。
- Chat Completions / Responses 非流式文本 Encoder 与 stable Browser/Driver/API error mapping。
- Chat Completions / Responses SSE Encoder（流式编码器，Phase 5 目标）。

## Integration（集成测试）

使用 local fixture（本地固定样本）和 fake driver（假驱动），不连接 ChatGPT：

- Phase 1：Fastify HTTP → Schema → Normalizer → injected fake execution boundary。
- Phase 2：真实临时 SQLite 文件 → migration → aggregate save → close → reopen → aggregate/File recovery。
- Phase 2：Gateway runtime 在 Fastify readiness 前创建/迁移 `${DATA_DIR}/gateway.db`，shutdown 幂等关闭 SQLite。
- Phase 3：Gateway runtime headless → BrowserManager → Phase3Executor；maintenance 模式不启动产品 BrowserManager。
- Phase 3：POST route → Normalizer → injected/fake Phase3 execution result → Chat Completions / Responses Encoder，全程不访问真实 ChatGPT。
- 后续：API → Normalizer → Conversation Engine → fake ChatGPT Driver。
- Phase 4 Conversation Queue（队列）与 Page affinity/restore。
- 文件元数据 + 文件系统。
- Client abort（客户端断开）→ stop generation。

## E2E（端到端）

真实 ChatGPT E2E 默认关闭，而且必须同时显式提供**独立于生产**的测试 Browser Profile：

```bash
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
corepack pnpm inspect:chatgpt

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
corepack pnpm test:e2e:chatgpt
```

`CHATGPT_PROFILE_DIR` 缺失会 fail fast；如果解析到生产 `${DATA_DIR}/browser-profile/` 也会拒绝运行。测试 Profile 不得使用个人日常浏览器 Profile，登录由人工完成；E2E harness 不自动填写账号密码、MFA 或 CAPTCHA。

2026-08-15 Phase 3 已实际运行上述真实命令。Bundled Chromium 能启动，但当前 DevSpace 到 `https://chatgpt.com/` 的 HTTPS 访问被网络超时阻塞：DNS 可解析，Node `fetch` 为 `ETIMEDOUT`，Playwright `page.goto` 60 秒超时并映射为 `browser_unavailable`。因此 auth/selector inspection、Fresh Driver challenge 和 Gateway HTTP challenge 尚未通过。

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
- 默认 headless Compose 可启动 Gateway。
- `/health` 可访问。
- `/v1/models` 的 API Key 认证正确。
- `/data` Bind Mount 可写，长期进程非 root。
- noVNC overlay 只在维护配置下启动并发布端口；默认宿主机绑定为 `127.0.0.1`。
- noVNC HTML 入口可访问，Xvfb / x11vnc / websockify / maintenance browser 均以指定 `PUID/PGID` 运行。
- noVNC 密码不出现在进程命令行参数中。
- `/data/gateway.db` 由指定 `PUID/PGID` 创建并可持续读取/写入。
- `schema_migrations` 包含且只包含一次 `001_initial` 当前基线。
- 使用同一 Bind Mount restart Gateway 后数据库和 migration history 仍可用。
- 正常 headless Compose 存在且只存在一个 `/data/browser-profile/` Chromium browser owner，并以指定 `PUID/PGID` 运行。
- maintenance overlay 存在且只存在一个 headed maintenance Chromium owner；产品 headless BrowserManager 不并发占用同一 Profile。

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

当前 `corepack pnpm verify` 已组合 format、lint、typecheck、unit/integration test、build 和全部仓库治理检查。Phase 2 的确定性测试覆盖 migration checksum、防半迁移、Repository、同步事务、aggregate 原子替换以及 close/reopen 恢复；Phase 3 的确定性测试覆盖 Browser/PagePool、Selector/Auth、Fresh Driver/completion、Executor、response encoder、runtime/maintenance 和 E2E safety gate。使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。

`corepack pnpm verify` 必须是本地确定性检查，不自动访问真实 ChatGPT。

## 不能伪造的验证

只有真实 E2E 才能证明：

- ChatGPT 当前 Selector 可用。
- Browser Profile 当前仍登录。
- 文件实际上传成功。
- 图片实际生成并能下载。
- 当前 ChatGPT UI 没有破坏完成检测。

真实 E2E 没有通过时，最终汇报必须明确实际停在哪个外部边界。当前 Phase 3 的事实是：real E2E **已启动但在访问 `chatgpt.com` 时网络超时**，因此不能声称 Selector、登录或真实 Fresh 文本路径已经验证。
