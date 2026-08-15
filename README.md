# ChatGPT Web Gateway

一个只面向 **ChatGPT Web（ChatGPT 网页）** 的 OpenAI Compatible API（OpenAI 兼容接口）网关。

项目目标是在一个完整 Docker 容器中，通过 Playwright bundled Chromium（Playwright 自带 Chromium）操作已登录的 `chatgpt.com`，向上游提供通用 OpenAI 风格接口。当前真实实现状态始终以 [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) 为准。

## 当前已实现：Phase 3 Fresh 非流式文本闭环

Phase 1 已完成工具链、协议层和正式 Docker 运行边界，Phase 2 完成 SQLite 结构化持久化；Phase 3 已完成 Browser / Driver / Fresh text execution，并通过独立测试 Profile 的真实 authenticated ChatGPT Web E2E：

- TypeScript + pnpm/Corepack + Fastify + TypeBox/Ajv。
- Vitest、ESLint、Prettier 和确定性 `verify`。
- `GET /health`。
- `GET /v1/models`，默认只暴露 `chatgpt-web`。
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
- bounded Page Pool、Selector Registry、Auth Probe、Fresh ChatGPT text Driver 和非流式 completion observer 已实现。
- `Phase3Executor` 只允许 Fresh、非流式、纯文本请求；历史会话/Conversation Key 明确返回 Phase 4 未实现，Streaming/附件/Tools/Structured Output 等未来能力明确拒绝。
- `POST /v1/chat/completions` 与 `POST /v1/responses` 已接入 Browser/Driver 执行链，并分别编码 OpenAI-style 非流式文本响应；不会伪造 token usage。
- `corepack pnpm inspect:chatgpt` 与 `corepack pnpm test:e2e:chatgpt` 已提供显式真实网页诊断/E2E harness，要求独立测试 Browser Profile。
- `UI_MODE=novnc` 明确禁用产品 BrowserManager，只保留 headed maintenance browser；此时 ChatGPT POST 返回 `503 browser_maintenance_mode`，避免两个 Chromium 同时占用一个 Profile。

**Phase 3 已完成真实验收。** 独立 E2E Profile 已通过人工登录，`inspect:chatgpt` 实际确认 `auth=authenticated` 且 Composer 唯一可定位；随后真实 `test:e2e:chatgpt` 同时通过 Fresh Driver challenge 与 Gateway HTTP → ChatGPT Web → Chat Completions challenge。该验收只证明 Phase 3 的 Fresh、非流式、纯文本能力，不代表后续 Conversation Sync / Streaming / Attachments / Tools / Images 已实现。

尚未实现的核心能力包括 Phase 4 Conversation Engine / Context Sync、真 Streaming、附件实际解析/上传、Tool Calling 执行闭环和图片生成。

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

> 这是已批准产品范围，不代表上述能力已经全部实现。

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

Phase 2 启动时会在 `/data/gateway.db` 自动创建/校验 SQLite Schema，并按顺序执行 `migrations/*.sql`。当前数据库使用 WAL，因此运行时还可能出现 `gateway.db-wal` / `gateway.db-shm`；它们是正常 SQLite 状态的一部分，不应在 Gateway 运行时手工删除。

Docker smoke 已验证数据库由指定 `PUID/PGID` 非 root 进程创建、migration 只记录一次，并在同一 Bind Mount 下重启容器后继续可用。`/data/files/` 和 `/data/generated/` 目前只有 metadata Repository 边界，真实业务字节写入仍属于后续 Phase。

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
| `MAX_ACTIVE_PAGES` | `4` | Phase 3 Page Pool 最大打开 Page 数；当前不排队等待 |
| `CHATGPT_PROXY_SERVER` | 空 | 可选 ChatGPT 浏览器代理；支持 `http` / `https` / `socks5`，URL 内禁止账号密码 |
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
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt
```

测试 Profile 需要通过人工方式完成 ChatGPT 登录；工具不会自动填写账号密码、MFA 或 CAPTCHA。需要代理的环境通过 `CHATGPT_PROXY_SERVER` 显式配置；如果要用 noVNC 给隔离测试 Profile 登录，可在 maintenance overlay 中同时设置 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile`。真实 E2E 只有人工登录完成并实际通过后才算验收。

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
       Phase3Executor             ← 已实现 Fresh-only；Phase 4 将扩展为 Conversation Engine
              │
              ▼
        ChatGPT Driver            ← Phase 3 Fresh 非流式纯文本 real E2E 已通过
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
- [`docs/superpowers/specs/`](docs/superpowers/specs/)：设计规格。
- [`docs/superpowers/plans/`](docs/superpowers/plans/)：实施计划与执行状态。

Agent / 开发者开始任务前应依次阅读 `AGENTS.md`、`PROJECT_STATE.md`、Active Plan 和当前任务相关源码/测试。

## 版本与变更

- 当前仓库版本：`V0.0.1`。
- 版本规范见 [`docs/versioning.md`](docs/versioning.md)。
- 公开版本记录见 [`CHANGELOG.md`](CHANGELOG.md)。

当前 Phase 3 开发实现不自动创建新的发布版本、Git Tag、Docker Registry 镜像或 GitHub Release。

## 开源协议

本项目采用 [MIT License](LICENSE)。
