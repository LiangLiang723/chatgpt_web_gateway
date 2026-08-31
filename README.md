# ChatGPT Web Gateway

一个只面向 **ChatGPT Web（ChatGPT 网页）** 的 OpenAI Compatible API（OpenAI 兼容接口）网关。

项目目标是在一个完整 Docker 容器中，通过 Playwright bundled Chromium（Playwright 自带 Chromium）操作已登录的 `chatgpt.com`，向上游提供通用 OpenAI 风格接口。当前真实实现状态始终以 [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) 为准。

## 当前状态：V1 验收完成，公开版本 V0.1.0

Phase 1–10 的 V1 功能与验收门槛已经关闭。2026-08-29 fresh deterministic 为 **86 test files / 595 tests**，format/lint/typecheck/build/Project Memory/Docs/Architecture/Version 与 `git diff --check` 全绿；fresh `linux/amd64` image `sha256:866e2b280a1a3ab790c1ab4ae725ec0c1fe345420b7aeec438497806fbd896fa` 与 full Docker smoke 通过。authenticated Phase 7 standalone 全部语义组通过，紧邻的 Phase 6 standalone 九项再次通过，随后 reduced combined Phase 3→8 退出码 0：Phase 3/4/5/7/8 全绿，Phase 5 abort 与 Phase 6 attachment matrix 按测试治理引用相邻 standalone 证据。最终验收期间还修复了两个真实 DOM 边界：登出首页同时出现多个 `Log in` 控件时 Auth Probe 正确报告 `auth_required`；跨 URL RESTORE 时必须等待历史 Conversation turns 水合完成，不能只看到 Composer 就开始取 Assistant baseline。当前公开版本为 `V0.1.0`；这一 MINOR 版本发布本次已完成的 V1 兼容能力与生产成熟化成果，并保留 `0.x` 早期阶段定位。Git Tag / GitHub Release 随本版本创建，Docker Registry 镜像仍不发布：

- TypeScript + pnpm/Corepack + Fastify + TypeBox/Ajv。
- Vitest、ESLint、Prettier 和确定性 `verify`。
- `GET /health`。
- authenticated `GET /v1/diagnostics`，只报告本地 Browser/Page/Persistence 状态并固定 `auth_state=not_probed`。
- `GET /v1/models`，默认只暴露 `chatgpt-web`，并返回已实现能力、Streaming 支持和可配置 context-window compatibility hint。
- `/v1/*` Bearer API Key 认证；`/health` 无需认证。
- `POST /v1/chat/completions` 与 `POST /v1/responses` 的 Schema 校验和统一 `NormalizedRequest` Normalizer。
- `X-Conversation-Key` 兼容扩展。
- 文本、图片/文件描述、Tools、Structured Output、ignored/unsupported 参数的协议标准化。
- 完整 `linux/amd64` Docker 镜像。
- `/data` Bind Mount、动态 `PUID/PGID` 非 root 运行。
- 默认 headless Compose 与按需 noVNC maintenance overlay。
- Docker build / smoke 自动验证。
- Node 24 内置 `node:sqlite`，单 `DatabaseSync` 连接，`foreign_keys=ON`、WAL、5000ms busy timeout。
- `${DATA_DIR}/gateway.db` 在 Gateway 启动前自动创建并执行 checksum migration。
- Conversation / Message / Tool Call / Attachment / File / Generated Image Repository。
- `ConversationStore` 在单事务内保存完整 Conversation aggregate；失败会 rollback，不留下半状态。
- 真实文件数据库已通过 save → close → reopen → load 恢复测试。
- Docker smoke 已验证 `/data/gateway.db`、migration history、`PUID/PGID` owner 和容器 restart 后持续可用。
- 正常 `UI_MODE=headless` 已启动产品级 Persistent BrowserContext；为通过真实 ChatGPT Cloudflare，内部使用 **Xvfb + full Chromium (`headless:false`)**，但不启动/发布 noVNC，因此对外仍是无 UI 的 headless 运行模式。`MAX_ACTIVE_PAGES` 默认 `4`；可选 `CHATGPT_PROXY_SERVER` 会同时应用到 normal、maintenance、inspect 和 real E2E Chromium。
- bounded Page Pool、Selector Registry、Auth Probe、ChatGPT text Driver 和非流式 completion observer 已实现；Driver 将 `openFresh`、`openConversation` 与纯 `sendText` 分离，并验证安全 Conversation URL identity。
- Phase 4 Conversation Engine 已实现 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、跨 key 并行、Conversation Page affinity、idle deadline + LRU 回收、`clean | in_flight` SQLite sync checkpoint 与 crash-convergence。
- full-history 与 single-user incremental 客户端都支持；`X-Conversation-Key` 存在时保持稳定 Conversation lifecycle。未提供 key 时每个请求仍建立并持久化独立 `conversation_key = NULL` Fresh Conversation，但不会跨请求猜测身份。
- `POST /v1/chat/completions` 与 `POST /v1/responses` 已接入共享 Conversation/Browser/Driver 执行链，支持非流式与真实 DOM Streaming；不会伪造 token usage。Chat Completions 兼容接收 Cherry Studio 常见的 `stream_options.include_usage?: boolean`，但该字段仅作为兼容 metadata 忽略，`include_usage=true` 不生成 fake usage chunk。Phase 6 图片/文件附件、Phase 7 function Tools/Tool Result continuation，以及 `json_object` / `json_schema` Structured Output prompt policy + 本地最终校验均已实现。
- `POST /v1/images/generations` 已实现 `n=1`、`url|b64_json`、request-scoped conversation-turn 图片基线采集、`${DATA_DIR}/generated` 原子持久化、SQLite `generated_images` 记录与 SHA-256 完整性检查；图片采集不依赖文本 Assistant role/copy completion marker，并按 `currentSrc || src` 去重同一 generated asset 的重复 DOM copy，`GET /v1/images/:id/content` 继续要求 Bearer authentication。
- `corepack pnpm inspect:chatgpt`、Phase 3–8 standalone E2E 与 combined `corepack pnpm test:e2e:chatgpt` 提供显式真实网页诊断/验收，要求独立测试 Browser Profile；combined 额外要求 `E2E_CHATGPT_COMBINED=1`。
- `UI_MODE=novnc` 明确禁用产品 BrowserManager，只保留 headed maintenance browser；此时 ChatGPT POST 返回 `503 browser_maintenance_mode`，避免两个 Chromium 同时占用一个 Profile。

**Phase 6 已完成真实验收。** 2026-08-26 最终 combined real E2E 退出码 0，Phase 3 `gatewayChallenge=true`、Phase 4 APPEND/RESTORE/REBUILD、Phase 5 Chat Completions/Markdown/Responses/abort，以及 Phase 6 Data URL image、image `file_id`、TXT/PDF/DOCX/XLSX、APPEND/RESTORE/Streaming 全部通过。验收过程中真实观测到 38-code-point Markdown renderer 尾部回排，因此 Streaming 默认 commit-tail holdback 从 16 提升为 64；同时 Driver 会在 Composer fill 后等待 Send control readiness，避免 Fresh/Page 复用竞态。

**Phase 7 Tool Calling V2 已完成验收。** 网页侧不再要求 ChatGPT“调用一个并不存在的原生工具”，而是把 caller-defined function 描述为外部操作请求，固定使用 external-function request envelope。tool-context fingerprint 同时绑定 canonical tool definitions、private protocol version 与 normalized `tool_choice`/function policy；schema/protocol/policy 任一变化都会通过 `tools_changed` 保守 REBUILD，仅声明顺序变化不触发。最终 standalone 已真实通过 single tool、Tool Result continuation、policy-change REBUILD、same-policy restart RESTORE、multiple tools、tool streaming、text streaming 与 schema change REBUILD，并在 reduced combined 中再次全绿。

**Phase 8/9 也已完成验收。** Structured Output 不再是 501 缺口；图片生成、图片持久化/内容读取、Page failure discard、Persistent BrowserContext fatal restart signaling、`/v1/diagnostics`、`PUBLIC_BASE_URL`、`backup:data` / `restore:data` 与 NAS 运维文档都已接入。Phase 8 standalone `url/base64/persistence/restart` 与 reduced combined 均通过；Phase 9 deterministic/Docker 已覆盖 Structured Output、recovery、diagnostics 与 cold backup/restore。Remote URL image input 的 SSRF/DNS/redirect 链有 deterministic coverage，但仍没有公网 fixture 的 live remote-fetch E2E。

## V1 批准范围

V1 最终目标包括：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/files`
- `GET /v1/files`
- `GET /v1/files/:id`
- `GET /v1/files/:id/content`
- `DELETE /v1/files/:id`
- `POST /v1/images/generations`
- 多轮 Conversation、Context Sync、真 DOM Streaming
- 图片/文件输入与 `file_id` 复用
- Tool Calling
- SQLite 完整会话持久化
- 多 Conversation 并行
- ChatGPT 图片生成

> 这是本轮 V1 已完成并通过验收的产品范围；各接口的精确兼容边界仍以 [`docs/api-compatibility.md`](docs/api-compatibility.md) 为准。

## Docker 运行

### 1. 准备配置

复制示例配置：

```bash
cp .env.example .env
```

至少修改：

```dotenv
GATEWAY_API_KEY=replace-with-a-long-random-secret
DATA_PATH=./data
PUID=1000
PGID=1000
```

`.env` 已被 Git 忽略，不得提交真实 API Key、Cookie 或 Browser Profile。

### 2. 构建并启动普通模式

```bash
corepack pnpm docker:build
docker compose up -d
```

普通 Compose：

- 默认映射 Gateway `3000` 端口。
- 默认 `UI_MODE=headless`。
- **不会启动 x11vnc / websockify / noVNC / maintenance browser。** Xvfb 会作为 normal full Chromium 的虚拟显示启动。
- **不会发布 noVNC 端口。**
- 普通模式会启动 Xvfb + 产品级 full Chromium Persistent BrowserContext；不启动 x11vnc/websockify/noVNC，也不发布维护端口。

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

模型列表需要认证：

```bash
curl \
  -H "Authorization: Bearer replace-with-the-key-from-.env" \
  http://127.0.0.1:3000/v1/models
```

`chatgpt-web` 的模型元数据包含 `image-recognition`、`file-input`、`function-call`、`structured-output`、`input_modalities=["text","image"]`、`supports_streaming=true` 与 `context_window`。默认 `context_window=128000`，可通过 `MODEL_CONTEXT_WINDOW` 调整；该值只是 Gateway 给 OpenAI-compatible 客户端的兼容提示，不是 ChatGPT 官方保证的 Web 后端固定上下文上限。图片生成通过独立 `/v1/images/generations` 暴露，因此对话模型不声明 `image-generation`。部分 Cherry Studio 版本的通用 `/models` 映射可能忽略扩展字段，因此 UI 是否自动填充取决于客户端版本。

### 3. 持久化目录

Compose 默认：

```text
${DATA_PATH:-./data} → /data
```

容器内预留：

```text
/data/
├── gateway.db
├── browser-profile/
├── files/
├── generated/
├── temp/
└── logs/
```

启动时会在 `/data/gateway.db` 自动创建/校验 SQLite Schema，并按顺序执行 checksum migration。当前 migration history 包含 `001_initial`、`002_add_conversation_sync_checkpoint` 与 `003_add_file_blob_lifecycle`；数据库使用 WAL，因此运行时还可能出现 `gateway.db-wal` / `gateway.db-shm`，它们是正常 SQLite 状态的一部分，不应在 Gateway 运行时手工删除。

Docker smoke 的当前候选会同时验证数据库、`/data/files/blobs`、`/data/generated` 与 `/data/temp` 由指定 `PUID/PGID` 非 root 进程读写，并在同一 Bind Mount 下重启容器后继续可用。`/v1/files` 的 metadata/content 可跨 Gateway restart 恢复；DELETE 会立即撤销公开访问，但历史 Conversation Attachment 若仍引用 File，内部 bytes 会保留以支持 REBUILD/恢复，不承诺立即 secure erase。完整 NAS 部署、冷备份、恢复、诊断与回滚流程见 [`docs/operations.md`](docs/operations.md)。

## noVNC 维护模式

noVNC 是**首次登录、重新认证和人工排障入口**，不是正常运行依赖。

先在 `.env` 中设置独立维护密码：

```dotenv
NOVNC_PASSWORD=replace-with-another-strong-secret
```

启动维护 Overlay：

```bash
docker compose -f compose.yaml -f compose.novnc.yaml up -d
```

默认只把 noVNC 绑定到宿主机：

```text
127.0.0.1:6080
```

如果 NAS 需要从其他设备访问，可以显式修改 `NOVNC_BIND`，但这会扩大访问面，应由部署网络、防火墙或反向代理保证安全。

维护模式默认使用同一 `/data/browser-profile/`，因此与普通 `UI_MODE=headless` BrowserManager **互斥**。`UI_MODE=novnc` 时产品 BrowserManager 不启动，确保同一 Profile 只有一个 Chromium owner；real E2E 可通过 `CHATGPT_PROFILE_DIR` 改用隔离测试 Profile。maintenance 登录浏览器使用镜像内固定版本的 **Google Chrome Stable**，由 Node 直接 spawn，不创建 Playwright BrowserContext、不开 `--remote-debugging-pipe`，只提供纯人工账号/MFA/安全验证 UI。maintenance overlay 使用 vendored Playwright seccomp profile，让非 root Chrome 保持 Linux sandbox；不会通过 `SYS_ADMIN` 或 `--no-sandbox` 放宽运行边界。maintenance 停机时会请求 Chrome 退出，并清理经 hostname/PID 证明属于当前已退出 Chrome 的 stale `Singleton*` marker，避免切回 normal 后被旧 Profile lock 阻塞。完成登录或排障后恢复普通模式：

```bash
docker compose -f compose.yaml -f compose.novnc.yaml down
docker compose up -d
```

> maintenance Google Chrome Stable 已通过真实 ChatGPT 账号人工登录验证；随后同一隔离 Profile 已由 Phase 3 `inspect:chatgpt` 与完整 real E2E 成功复用。

## 配置摘要

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | Gateway 容器内监听地址 |
| `PORT` | `3000` | Gateway 端口 |
| `GATEWAY_BIND` | `0.0.0.0` | Compose 宿主机 API 绑定地址 |
| `GATEWAY_API_KEY` | 无 | 必填；`/v1/*` Bearer Key |
| `DATA_PATH` | `./data` | 宿主机 Bind Mount 路径 |
| `PUID` | `1000` | 长期业务进程 UID |
| `PGID` | `1000` | 长期业务进程 GID |
| `MAX_ACTIVE_PAGES` | `4` | Page Pool 最大打开 Page 数；不同 Conversation 可并行直到容量上限 |
| `PAGE_IDLE_TIMEOUT_MINUTES` | `30` | Conversation Page affinity 空闲回收时间；容量压力下可提前回收 LRU idle Page |
| `MODEL_CONTEXT_WINDOW` | `128000` | `/v1/models` 暴露的 context-window compatibility hint；必须为正整数，不代表 ChatGPT 官方 Web context limit |
| `CHATGPT_PROXY_SERVER` | 空 | 可选 ChatGPT 浏览器代理；支持 `http` / `https` / `socks5`，URL 内禁止账号密码 |
| `PUBLIC_BASE_URL` | 空 | 可选生成图片公开 URL base；仅允许无 credentials/query/hash 的 `http(s)` base，content route 仍要求 Bearer auth |
| `NOVNC_BIND` | `127.0.0.1` | noVNC 宿主机绑定地址 |
| `NOVNC_PORT` | `6080` | noVNC 端口 |
| `NOVNC_PASSWORD` | 无 | 仅 maintenance mode 必填 |
| `MAINTENANCE_URL` | `https://chatgpt.com/` | headed maintenance browser 初始页面 |
| `CHATGPT_PROFILE_DIR` | 空 | 仅 maintenance/E2E 显式覆盖 Profile；生产 headless runtime 仍固定 `${DATA_DIR}/browser-profile/` |

## 开发与验证

项目锁定 pnpm 版本，通过 Corepack 使用，不要求宿主机全局安装 pnpm：

```bash
corepack pnpm install
corepack pnpm verify
```

Docker 验证：

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

`verify` 不访问真实 ChatGPT；Docker smoke 也不访问 `chatgpt.com`，只验证 normal Playwright Chromium、maintenance Google Chrome Stable、sandbox/seccomp、HTTP、SQLite、RFB、Profile owner 和运行用户边界。

真实 ChatGPT 诊断/E2E 必须显式提供**独立于生产 Profile**的目录：

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
corepack pnpm test:e2e:chatgpt:phase7

E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase8
```

测试 Profile 需要通过人工方式完成 ChatGPT 登录；工具不会自动填写账号密码、MFA 或 CAPTCHA。需要代理的环境通过 `CHATGPT_PROXY_SERVER` 显式配置；如果要用 noVNC 给隔离测试 Profile 登录，可在 maintenance overlay 中同时设置 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile`。如果一个已失效的隔离 Profile 在重新登录时反复陷入 challenge loop，不要继续重复验证或覆盖旧 Profile：保留旧目录作为证据，创建一个新的干净隔离 Profile，再用 maintenance Google Chrome Stable 登录并先运行 `inspect:chatgpt`。真实 E2E 只有人工登录完成并实际通过后才算验收。

## 明确不做

- Claude / Gemini / Grok 等其他 Provider
- Anthropic Compatible API
- ChatGPT 私有 `/backend-api` 逆向调用
- Google Chrome / Edge / Firefox / WebKit 的**产品自动化兼容层**；maintenance-only 的固定 Google Chrome Stable 仅用于人工登录，不改变产品 Driver 仍只面向 Playwright bundled Chromium
- 把 noVNC 作为正常运行核心依赖
- Audio、Embeddings、Realtime、Batches、Fine-tuning、Vector Stores 等无法自然映射到 ChatGPT Web 的接口

## 架构概览

```text
OpenAI Compatible Client / Agent
              │
              ▼
          API Layer
              │
              ▼
      Request Normalizer
              │
              ▼
       NormalizedRequest
              │
              ▼
      Conversation Engine         ← 四态 + FIFO + checkpoint + multimodal + tools + structured validation
              │
              ▼
        ChatGPT Driver            ← text/stream/upload + external-function request + image driver
              │
              ▼
     Playwright Chromium
              │
              ▼
          chatgpt.com
```

## Living Repository（活仓库）

长期事实写回仓库，不依赖聊天记录：

- [`AGENTS.md`](AGENTS.md)：Agent 工作规则。
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)：当前真实实现、下一任务和 blocker。
- [`docs/architecture.md`](docs/architecture.md)：稳定架构和模块边界。
- [`docs/api-compatibility.md`](docs/api-compatibility.md)：目标兼容范围与当前协议实现说明。
- [`docs/testing.md`](docs/testing.md)：测试层级和完成门槛。
- [`docs/development-workflow.md`](docs/development-workflow.md)：开发和整套依赖升级流程。
- [`docs/operations.md`](docs/operations.md)：NAS 部署、登录、更新、冷备份/恢复、诊断与回滚。
- [`docs/superpowers/specs/`](docs/superpowers/specs/)：设计规格。
- [`docs/superpowers/plans/`](docs/superpowers/plans/)：实施计划与执行状态。

Agent / 开发者开始任务前应依次阅读 `AGENTS.md`、`PROJECT_STATE.md`、Active Plan 和当前任务相关源码/测试。

## 版本与变更

- 当前仓库版本：`V0.1.0`。
- 版本规范见 [`docs/versioning.md`](docs/versioning.md)。
- 公开版本记录见 [`CHANGELOG.md`](CHANGELOG.md)。

`V0.1.0` 是本轮 V1 验收后的公开 MINOR 版本，并创建同名 Git Tag / GitHub Release；Docker Registry 镜像仍需单独发布指令。

## 开源协议

本项目采用 [MIT License](LICENSE)。
