# Phase 1 Toolchain, Protocol Model, and Docker Runtime Design

**Date:** 2026-08-14
**Status:** Approved; implementation active
**Scope:** Phase 1

## 1. Goal（目标）

Phase 1 建立后续产品代码的稳定基础：

1. 完整 TypeScript（类型化 JavaScript）工具链。
2. Fastify + TypeBox/Ajv 的 OpenAI Compatible API（OpenAI 兼容接口）协议边界。
3. Chat Completions 与 Responses 共用的 `NormalizedRequest` 内部模型。
4. `/health`、`/v1/models` 和请求 Normalizer（标准化器）的可测试最小闭环。
5. 从项目早期就提供可长期运行的完整 Docker（容器）边界，而不是到后期再二次容器化。
6. 固化整套项目依赖升级流程，使环境升级可重复、可验证、可回滚。

Phase 1 的验收必须在**不访问真实 ChatGPT、不依赖浏览器登录态**的情况下完成。

## 2. Non-Goals（本阶段明确不做）

Phase 1 不实现：

- SQLite 持久化。
- Conversation Engine（会话引擎）和 Context Sync（上下文同步）。
- ChatGPT DOM（文档对象模型）驱动。
- 真实 ChatGPT 文本生成。
- 真 Streaming（流式输出）。
- 文件实际下载、落盘和上传。
- Tool Calling（工具调用）Prompt + Parser 执行链。
- ChatGPT 图片生成。
- 真实 ChatGPT 登录 E2E（端到端）验收。

Phase 1 可以把后续需要的协议描述标准化为内部结构，但不能把未来能力伪装成已经可执行。

## 3. Runtime Baseline（运行时基线）

### 3.1 Node.js

截至 2026-08-14，项目选择 Node.js 24.x LTS 作为首个运行时基线。

策略不是“永远固定 Node 24”，而是：

- 每个 Git commit（提交）对应明确、可复现的 Node 版本范围或镜像版本。
- “升级项目依赖”允许跟随新的 Node LTS major（主版本）。
- 跨 Node major 升级必须经过完整兼容性验证，不自动漂移。

### 3.2 Package Manager（包管理器）

使用 pnpm + Corepack。

`package.json` 必须：

- 通过 `packageManager` 固定 pnpm **精确版本**。
- 通过 `engines.node` 表达批准的 Node 运行范围。

仓库提交 `pnpm-lock.yaml`。不同开发机、CI（持续集成）和 Docker 构建必须使用同一 pnpm 版本。

### 3.3 TypeScript Build（构建）

- `tsc` 负责正式类型检查和生产构建。
- 生产容器只运行编译后的 JavaScript。
- 开发期可以使用轻量 TypeScript 启动工具，但不得让它成为生产运行前提。

## 4. Core Toolchain（核心工具链）

Phase 1 固定：

```text
Node.js        当前批准的 LTS
pnpm           Corepack + 精确版本锁定
TypeScript     tsc typecheck + build
Fastify        HTTP Server
TypeBox        Schema + TypeScript 类型单一事实来源
Ajv            Fastify 运行时 Schema 校验
Vitest         Unit / Integration 测试
ESLint         静态检查
Prettier       格式检查
```

TypeBox 是 API Schema（结构）与 TypeScript 输入类型的单一事实来源。禁止为同一公开请求结构长期维护一份手写 JSON Schema 和另一份独立 TypeScript interface，避免协议漂移。

## 5. Docker as the Formal Runtime Boundary（Docker 作为正式运行边界）

Docker 不再推迟到后期 Phase；从 Phase 1 起就是项目正式运行方式。

目标结构：

```text
NAS / Linux amd64 Host
└── Docker
    └── chatgpt-web-gateway
        ├── Node.js runtime
        ├── Fastify Gateway
        ├── Playwright
        ├── bundled Chromium
        ├── optional noVNC maintenance stack
        └── /data
            ├── gateway.db
            ├── browser-profile/
            ├── files/
            ├── generated/
            ├── temp/
            └── logs/
```

Phase 1 目标平台为 `linux/amd64`。ARM64 / multi-arch（多架构）不属于当前验收矩阵。

### 5.1 Base Image（基础镜像）

运行镜像以**官方 Playwright Node Docker 镜像**为基础，并固定明确版本 tag（标签）。项目安装的 Playwright package 版本必须与镜像浏览器版本保持匹配。

Node LTS 策略与 Playwright 镜像版本独立治理：不能假设某个 Playwright 官方镜像内置的 Node 永远等于项目批准的 LTS。Docker 构建必须检查实际 `node --version`；如果基础镜像 Node 不符合批准基线，则在派生镜像中显式安装并锁定批准的 Node 版本，然后由构建/启动 smoke test（冒烟测试）验证。

### 5.2 Runtime Modes（运行模式）

同一个镜像支持两种模式：

```text
UI_MODE=headless   正常长期运行
UI_MODE=novnc      首次登录、重新认证或人工排障
```

`headless` 是默认模式。

正常模式：

- Gateway 运行。
- Chromium 以 headless 方式运行（进入浏览器 Phase 后）。
- Xvfb / VNC / noVNC / 轻量窗口管理器不启动。
- noVNC 端口不发布。

维护模式：

- 通过 Compose overlay 显式启用。
- 启动 headed Chromium 所需的 Xvfb / VNC / noVNC 组件。
- 临时发布 noVNC 端口。
- noVNC 使用与 Gateway API Key 分离的维护访问凭据。
- 完成登录或排障后恢复普通 headless Compose。

noVNC **不是正常运行依赖**，但保留为重新认证和故障诊断入口。不能承诺“首次登录一次后永久不再需要 noVNC”，因为网页登录态可能过期或要求人工验证。

### 5.3 Compose Delivery（Compose 交付）

仓库提供：

```text
Dockerfile
compose.yaml
compose.novnc.yaml
```

正常运行：

```bash
docker compose up -d
```

维护模式使用基础 Compose + noVNC overlay。正常 Compose 不发布 noVNC 端口。

### 5.4 Persistent Data（持久数据）

`/data` 使用宿主机目录 Bind Mount（绑定挂载），不以 Docker named volume 作为默认方案。

这样 NAS 管理员可以直接备份、迁移和检查：

- SQLite 数据库。
- ChatGPT Browser Profile（浏览器配置）。
- 上传文件。
- 生成图片。
- 临时文件和受控日志。

Browser Profile 固定在 `/data/browser-profile/`，headless 和 noVNC 模式复用同一份持久状态。

### 5.5 Container User（容器用户）

长期 Gateway / Chromium 进程必须以非 root 用户运行，并支持通过 `PUID` / `PGID` 与 NAS 宿主机目录权限对齐。

Entrypoint（入口脚本）允许在启动初期执行**最小且有界的权限准备**，随后必须降权并 `exec` 长期进程；不得让 Gateway 或 Chromium 因方便而长期以 root 运行。

## 6. Configuration Boundary（配置边界）

所有运行配置集中在 `src/config/`。业务模块不得分散直接读取 `process.env`。

Phase 1 配置至少包括：

```text
HOST=0.0.0.0
PORT=3000
GATEWAY_API_KEY=<secret>
UI_MODE=headless
PUID=<uid>
PGID=<gid>
DATA_DIR=/data
```

noVNC 维护模式增加独立维护凭据配置。

规则：

- `HOST` 可配置，默认 `0.0.0.0`。
- `PORT` 可配置，默认 `3000`。
- `DATA_DIR` 容器默认 `/data`。
- 正式 Gateway 缺少 `GATEWAY_API_KEY` 时启动失败。
- 仓库保留 `.env.example`，真实 `.env` 不提交 Git。
- 默认 Compose 使用 `.env` / `env_file` 注入配置。
- API Key、Authorization Header、Cookie、Browser Profile 内容不得写入普通日志。

## 7. Authentication（认证）

认证规则：

- `GET /health` 无需认证。
- 所有 `/v1/*` 默认要求：

```text
Authorization: Bearer <GATEWAY_API_KEY>
```

缺失、格式错误或 Key 不匹配时返回稳定的 OpenAI 风格认证错误，不暴露配置值。

## 8. API and Adapter Boundary（API 与适配器边界）

Phase 1 的主要数据流：

```text
HTTP Request
    ↓
Fastify Route
    ↓
TypeBox / Ajv Validation
    ↓
API Adapter
    ↓
NormalizedRequest
    ↓
Injected Execution Boundary / Fake Handler
```

Phase 1 不允许 API Route（路由）直接依赖 Playwright、ChatGPT DOM 或未来 SQLite Repository。

`POST /v1/chat/completions` 和 `POST /v1/responses` 只能做协议 Adapter，不得各自发展一套后端执行逻辑。

## 9. NormalizedRequest（统一内部请求模型）

核心模型保持与 V1 governing spec（一号主设计规格）一致：

```ts
interface NormalizedRequest {
  requestId: string;
  conversationKey?: string;
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  attachments: NormalizedAttachment[];
  output: {
    mode: 'text' | 'image';
    stream: boolean;
    structured?: NormalizedStructuredOutput;
  };
}
```

Phase 1 必须定义这些子结构的最小稳定边界，并测试语义等价输入得到一致内部表达。

### 9.1 Instructions（指令）

Chat Completions：

- `system`
- `developer`

Responses API 对应 instruction / message 控制内容，统一进入 `instructions`。

### 9.2 Messages（消息）

至少标准化：

- `user`
- `assistant`
- `tool`

字符串 `content` 转成统一 text part（文本片段）。

### 9.3 Attachments（附件描述）

Phase 1 只标准化“附件是什么、来源是什么”，不执行网络下载或落盘。

支持描述：

- Chat Completions `image_url` URL。
- Base64 Data URL 图片。
- Responses `input_image`。
- `file_id` 引用。
- Base64 文件输入。
- Responses `input_file`。

后续 Attachment Pipeline（附件流水线）消费统一 attachment 描述。

### 9.4 Tools（工具）

标准化：

- OpenAI function tool schema。
- `tool_choice=auto`。
- `tool_choice=none`。
- `tool_choice=required`。
- 指定 function。

Phase 1 不生成 Tool Prompt，也不解析模型 Tool Call。

### 9.5 Structured Output（结构化输出）

`response_format=json_object` / `json_schema` 转换为统一 structured-output 描述，并保留“这是 Prompt 约束/本地校验，不是 ChatGPT Web 原生硬约束”的兼容语义。

### 9.6 Ignored and Unsupported Parameters（忽略与不支持参数）

V1 已批准为近似/忽略的参数应被协议层接受并以内部可诊断方式记录为 ignored，而不是伪装已由 ChatGPT Web 精确执行。

V1 明确 unsupported 的参数必须产生稳定错误。

## 10. Conversation Identity Extension（会话标识扩展）

Phase 1 定义受控兼容扩展 Header：

```text
X-Conversation-Key: <stable-id>
```

API Adapter 将其写入：

```ts
conversationKey?: string
```

客户端不提供时保持 `undefined`。自动生成、绑定、恢复和分叉策略属于后续 Conversation / Context Sync Phase，Phase 1 不猜测。

## 11. Phase 1 Endpoints（本阶段端点）

### 11.1 `GET /health`

无需认证，返回最小健康状态：

```json
{
  "status": "ok"
}
```

Phase 1 的 `ok` 只代表 Gateway HTTP 进程和基础配置可服务；尚未实现 Browser Runtime 时不能暗示 ChatGPT 页面已登录或可用。

### 11.2 `GET /v1/models`

要求 Bearer API Key。

默认只暴露：

```text
chatgpt-web
```

不得伪装为具体 OpenAI API 模型。

### 11.3 `POST /v1/chat/completions`

Phase 1 实现完整请求 Schema 校验和 Normalizer，并通过注入 fake/stub execution boundary 验证 HTTP → Adapter 闭环。

本阶段不得返回伪造的 ChatGPT 正常回答来制造“接口已可聊天”的假象。

### 11.4 `POST /v1/responses`

与 Chat Completions 相同：实现请求 Schema + Adapter → `NormalizedRequest`，执行边界仍为可注入 fake/stub。

## 12. Error Model（错误模型）

内部至少建立：

```text
ValidationError
AuthenticationError
UnsupportedParameterError
InvalidRequestError
```

API 层统一转换为 OpenAI 风格错误：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": "...",
    "code": "..."
  }
}
```

不得把 Ajv、Fastify 或后续 Playwright 原始 stack trace（堆栈）、Secret（密钥）或敏感路径直接返回客户端。

## 13. Testing Strategy（测试策略）

### 13.1 Unit（单元）

至少覆盖：

- Config parsing / validation。
- Bearer API Key 认证。
- Chat Completions Schema / Normalizer。
- Responses Schema / Normalizer。
- system / developer 指令标准化。
- user / assistant / tool 消息标准化。
- tool / tool_choice 标准化。
- attachment descriptor 标准化。
- structured output。
- ignored 参数。
- unsupported 参数。
- `X-Conversation-Key`。
- OpenAI 风格错误映射。

### 13.2 Integration（集成）

使用 Fastify injection（注入测试）或等价本地方式，不连接 ChatGPT：

- `GET /health`。
- `GET /v1/models` 无 Key / 错 Key / 正确 Key。
- `POST /v1/chat/completions` HTTP → Schema → Adapter → fake boundary。
- `POST /v1/responses` HTTP → Schema → Adapter → fake boundary。

### 13.3 Docker Smoke（Docker 冒烟）

Phase 1 必须验证：

1. 完整 `linux/amd64` 镜像可构建。
2. 镜像实际 Node 版本符合批准基线。
3. Playwright package 与基础镜像版本约束一致。
4. 默认 headless Compose 可启动 Gateway。
5. `/health` 可访问。
6. `/v1/models` 无 Key 被拒绝。
7. 正确 Key 可获得 `chatgpt-web`。
8. `/data` Bind Mount 可写且长期进程为非 root。
9. noVNC overlay 能启动维护栈并只在维护配置下发布端口。

这些 smoke test **不等于真实 ChatGPT E2E**。Phase 1 不得声称网页登录、Selector、上传或图片生成已验证。

## 14. Verification Commands（验证命令）

Phase 1 建立这些标准入口：

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` 组合确定性检查：

```text
format:check
→ lint
→ typecheck
→ test
→ build
→ check:architecture
→ check:project-memory
→ check:docs
→ check:version
```

`pnpm verify` 不访问真实 ChatGPT、不要求真实 Browser Profile 登录，也不自动运行真实 E2E。

## 15. Dependency Upgrade Workflow（项目依赖升级流程）

用户后续只说“升级项目依赖”时，默认范围是**整套基础栈**，包括：

- Node LTS / Docker runtime baseline。
- Playwright 官方基础镜像。
- Playwright package 与 bundled Chromium。
- pnpm。
- TypeScript。
- Fastify。
- TypeBox / Ajv。
- Vitest / ESLint / Prettier。
- 其他生产依赖与开发依赖。

标准流程：

```text
读取当前版本与官方兼容信息
→ 确认 Node / Playwright / Chromium / pnpm 组合
→ 分层升级并处理 breaking changes
→ 更新 packageManager / engines / Docker image pins
→ 刷新 pnpm-lock.yaml
→ 检查异常依赖解析变化
→ typecheck / lint / format:check / test / build / verify
→ 重新构建完整 Docker 镜像
→ 检查容器内实际 Node / pnpm / Playwright 版本
→ Docker smoke test
→ 项目记忆与版本文档回写判断
→ git diff --check + staged diff
→ 按提交规范提交
```

原则：

- 目标是升级到**当前兼容且已验证**的组合，不是为了追求版本号而强行接受不兼容版本。
- 新 Node LTS major 可以在此流程中升级，不要求用户额外说“升级 Node”。
- 如果某个 major upgrade 需要独立迁移，应拆成明确任务并记录 blocker，不把失败的迁移伪装成完成。
- 所有版本变化必须来自当次实际验证结果，不凭记忆猜包版本或镜像 tag。

## 16. Roadmap Impact（路线图影响）

原路线图把 Docker / NAS 部署集中到 Phase 9。现在调整为：

- **Phase 1：** 建立完整正式 Docker 镜像、基础 Compose、noVNC 维护 overlay、`/data` 持久化运行边界和 Docker smoke test。
- **Phase 9：** 不再负责“第一次容器化”；聚焦恢复、诊断、日志、安全加固、NAS 运维文档和生产成熟度。

这避免产品前八个 Phase 在一种环境开发，最后再把浏览器、权限和持久化问题一次性暴露到 Docker 中。

## 17. Acceptance Criteria（Phase 1 验收）

Phase 1 完成时必须同时满足：

1. TypeScript / pnpm / Fastify / TypeBox / Ajv / Vitest / ESLint / Prettier 工具链可执行。
2. `pnpm verify` 是本地确定性总入口并通过。
3. `/health` 与 `/v1/models` 行为符合本 spec。
4. `/v1/*` 默认 Bearer API Key 认证有效。
5. Chat Completions 和 Responses 的主要 V1 输入可标准化到同一 `NormalizedRequest`。
6. 相同语义的两类 API 输入在内部模型上保持一致。
7. ignored / unsupported 参数行为有测试证明。
8. Conversation Key Header 可以进入统一模型，但不提前实现会话生命周期。
9. 完整 `linux/amd64` Docker 镜像和普通 Compose 可构建、可启动、可 smoke test。
10. noVNC 仅在显式维护 overlay 下启用，正常运行不启动相关进程、不发布相关端口。
11. `/data` 通过 Bind Mount 持久化，长期服务进程非 root，并支持 `PUID/PGID`。
12. 真实 ChatGPT Web E2E 未运行时，文档和最终汇报明确标记为未验证。
13. “升级项目依赖”流程已经写入长期项目文档，可由后续 Agent 直接执行。

## 18. Risks and Constraints（风险与约束）

- Playwright 官方镜像与项目 Playwright package 必须精确协调；版本错配可能导致浏览器 executable（可执行文件）无法定位。
- Playwright 官方镜像内置 Node 版本可能与项目批准的 Node LTS 不同步，因此必须在构建时校验，而不是假设。
- noVNC 会增加镜像磁盘体积，但正常 headless 模式不启动维护进程，因此不应产生持续 CPU / RAM 开销。
- 动态 `PUID/PGID` 与 Chromium sandbox（沙箱）需要在 Docker 实现时做真实 smoke test，不能仅靠配置文件推断可行。
- Phase 1 的 POST 路由只证明协议闭环，不证明 ChatGPT Web 已能回答。
