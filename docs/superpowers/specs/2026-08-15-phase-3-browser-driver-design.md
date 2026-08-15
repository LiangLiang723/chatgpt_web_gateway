# Phase 3 Browser Runtime and Minimal ChatGPT Driver Design

**Date:** 2026-08-15
**Status:** Approved; implementation may proceed
**Scope:** Phase 3

## 1. Goal（目标）

Phase 3 在 Phase 1 的协议边界、Docker 运行边界和 Phase 2 的 SQLite 持久化基础上，交付第一个**真实可用的 ChatGPT Web 文本执行闭环**：

1. Gateway 正常 headless 模式启动 Playwright bundled Chromium。
2. 使用项目专用 Persistent BrowserContext（持久浏览器上下文）复用 ChatGPT 登录状态。
3. 提供有上限的 Page Pool（页面池），但不提前实现 Conversation Queue / URL Restore。
4. 所有 ChatGPT DOM Selector（选择器）集中管理，并对 missing / ambiguous 做稳定诊断。
5. 明确区分 ChatGPT 未登录、DOM contract 改版和 Browser runtime 故障。
6. 完成 Fresh 单轮、非流式、纯文本 ChatGPT Driver。
7. 现有 Chat Completions / Responses 两个 POST 路由真正接入 ChatGPT Web 文本执行。
8. 提供 `inspect:chatgpt` 诊断命令。
9. 使用独立测试 Browser Profile 完成真实 ChatGPT 登录检查、真实 Fresh 文本问答和至少一条 Gateway HTTP → ChatGPT Web → OpenAI-style response E2E。

Phase 3 的完成不是“fixture DOM 测试通过”，而是必须有真实 ChatGPT Web E2E 证据。

## 2. Non-Goals（本阶段明确不做）

Phase 3 不实现：

- Conversation Queue（同会话串行队列）。
- Conversation URL RESTORE / REBUILD。
- `FRESH | APPEND | RESTORE | REBUILD` Context Sync 决策。
- Page idle timeout / idle 回收策略。
- 多轮增量 Conversation。
- 真 Streaming / SSE / Stable Prefix。
- 图片或文件实际 resolve / upload。
- Tool Calling Prompt / Parser / Tool Result 回传。
- Structured Output 执行约束。
- ChatGPT 图片生成。
- 自动填写 ChatGPT 用户名/密码。
- 自动处理 MFA、CAPTCHA、设备确认或风控挑战。
- 自动修改 ChatGPT 账号设置。

Phase 3 可以为 Phase 4+ 提供稳定接口和错误边界，但不得把未来能力伪装成已实现。

## 3. Approved Choices（已确认设计选择）

本设计讨论已明确批准：

1. **真实 E2E 是 Phase 3 完成门槛。**
2. **登录失效人工恢复。** Gateway 不自动登录；返回稳定 `auth_required`，运营者通过 noVNC maintenance overlay 手动恢复同一 Profile。
3. **Selector Registry 使用语义主路径 + 少量明确 fallback。** 本应唯一的目标出现多个匹配时直接失败，不用 `.first()` 掩盖歧义。
4. **Page Pool 默认最大活跃 Page 为 4。** Phase 3 只做容量和 Page 生命周期，不做 Queue / idle / Restore。
5. **非流式完成判断使用新 Assistant Turn + 生成状态 + 文本稳定采样。** 不用固定 sleep，不把 `networkidle` 当回答完成。
6. **Gateway 未登录不崩进程。** `/health` 仍代表 Gateway runtime 健康，ChatGPT 执行返回 `auth_required`。
7. **两个现有 POST 路由在 Phase 3 接入真实 ChatGPT Driver。** 只支持本阶段已经实现的 Fresh 非流式纯文本请求。
8. **Fresh 单轮边界。** 历史 assistant/tool、多 user turn、Conversation key 均返回 `conversation_sync_not_implemented`。
9. **system/developer 指令与 user message 通过一次内部 JSON envelope 提交。** 不制造额外网页 turn，不声称网页具有 OpenAI 原生 role privilege boundary。
10. **真实 E2E 使用独立测试 Profile。** 不默认读取生产 `/data/browser-profile/`。
11. **诊断默认不保存用户页面。** 只有显式诊断目录时才保存 screenshot / DOM snapshot。
12. **Browser/Driver 使用稳定内部错误码。** 不把 Playwright 原始异常当公共协议。

## 4. External Runtime Facts（外部运行事实）

截至设计日期，项目固定 `playwright@1.62.1` 和官方 `mcr.microsoft.com/playwright:v1.62.1-noble` 镜像。

Playwright 当前官方行为与本设计依赖关系：

- `chromium.launchPersistentContext(userDataDir, ...)` 使用指定 User Data Directory 保存 cookies / local storage 等浏览器会话数据，并返回唯一 BrowserContext；关闭该 Context 会关闭浏览器。
- 浏览器不允许两个实例同时使用同一个 User Data Directory，因此正常 headless BrowserManager 与 noVNC maintenance browser 必须保持互斥运行。
- 一个 BrowserContext 可以承载多个 Page。
- Locator 单目标动作默认严格匹配；多匹配会报错。`.first()` / `.last()` / `.nth()` 虽可绕过 strictness，但不适合作为本应唯一目标的长期修复。
- Playwright actionability / auto-wait 已覆盖 visible、stable、enabled 等交互前条件，因此业务同步不得以固定 sleep 代替真实 DOM 状态。

这些是升级 Playwright / Node / Chromium 时必须重新验证的外部事实，不是永久不变的假设。

## 5. High-Level Architecture（总体架构）

```text
OpenAI Compatible Client
          │
          ▼
     API Adapter
          │
          ▼
   NormalizedRequest
          │
          ▼
   Phase3Executor
          │
          ├── Fresh capability validation
          ├── instruction envelope
          │
          ▼
       PagePool
          │ lease
          ▼
    ChatGPTDriver
          │
          ├── AuthProbe
          ├── SelectorRegistry
          ├── Prompt submit
          ├── Assistant turn ownership
          └── Completion observer
          │
          ▼
   Playwright Page
          │
          ▼
Persistent BrowserContext
          │
          ▼
 bundled Chromium
          │
          ▼
      chatgpt.com
```

Runtime owner：

```text
GatewayRuntime
├── PersistenceContext
├── BrowserManager
│   └── Persistent BrowserContext
│       └── PagePool
└── Fastify
    └── Phase3Executor
```

Browser 和 Persistence 是两个平级运行资源；Phase 3 Executor 暂不把 ConversationStore 接入实际问答生命周期。

## 6. Module Boundaries（模块边界）

建议结构：

```text
src/
├── browser/
│   ├── browser-manager.ts
│   ├── page-pool.ts
│   ├── errors.ts
│   └── types.ts
├── chatgpt/
│   ├── selectors.ts
│   ├── selector-registry.ts
│   ├── auth.ts
│   ├── completion.ts
│   ├── driver.ts
│   ├── errors.ts
│   └── inspect.ts
├── conversations/
│   └── phase3-executor.ts
├── api/
│   ├── execution.ts
│   └── response encoders / routes
└── runtime.ts
```

### 6.1 `browser/`

只理解 Playwright BrowserContext / Page 生命周期，不理解 ChatGPT DOM。

允许依赖：

- `playwright`
- config/types
- browser-local errors

禁止依赖：

- `api/`
- `chatgpt/`
- `persistence/`
- OpenAI response shape

### 6.2 `chatgpt/`

只理解 ChatGPT Web DOM 和 Driver 行为。

允许依赖：

- Playwright `Page` / `Locator` 类型
- `chatgpt/selectors.ts`
- ChatGPT-local errors/types

禁止：

- 创建 BrowserContext
- 读取 `process.env`
- 管理 Page Pool
- 写 SQLite
- 构造 OpenAI HTTP response

### 6.3 `conversations/phase3-executor.ts`

这是 Phase 3 的临时最小执行编排层：

- 校验 Phase 3 capability boundary。
- 构造内部 prompt envelope。
- acquire/release Page lease。
- 调用 ChatGPTDriver。
- 返回协议无关的文本结果。

Phase 4 Conversation Engine 会替代/吸收这层的会话编排职责，因此这里必须保持小而明确。

### 6.4 `api/`

继续只负责：

- HTTP request schema
- normalization
- Gateway error mapping
- Chat Completions / Responses response encoding

不得导入 `playwright` 或 ChatGPT selector。

## 7. BrowserManager（浏览器管理器）

### 7.1 Interface

```ts
export interface BrowserManager {
  readonly context: BrowserContext;
  readonly pages: PagePool;
  close(): Promise<void>;
}

export interface CreateBrowserManagerOptions {
  profileDir: string;
  headless: true;
  maxActivePages: number;
}
```

生产 BrowserManager 固定使用 bundled Chromium：

```ts
chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
```

不得配置外部 Chrome executable path。

### 7.2 Profile

生产路径：

```text
${DATA_DIR}/browser-profile/
```

BrowserManager 启动前确保目录存在，但不创建/读取账号密码文件。

同一个 Profile 不允许正常 Gateway BrowserManager 和 maintenance browser 并发占用。部署流程通过 Compose 模式切换保证互斥；如果 Chromium 因 Profile lock 无法启动，映射为 `browser_unavailable`。

### 7.3 Lifecycle

Gateway startup：

```text
loadConfig
  ↓
open Persistence
  ↓
UI_MODE=headless ?
  ├── yes → launch BrowserManager → build Phase3Executor
  └── no  → UI_MODE=novnc，产品 BrowserManager 禁用
  ↓
build Fastify
  ↓
listen
```

Browser 启动失败属于 headless startup failure；ChatGPT 未登录不属于 startup failure。

`UI_MODE=novnc` 是 maintenance 模式：现有 entrypoint 会启动 Xvfb / noVNC / headed maintenance browser，并随后启动 Gateway HTTP 进程。因此 GatewayRuntime 在该模式下**不得**再启动产品 headless BrowserManager，否则两个 Chromium 会争抢同一 `/data/browser-profile/`。maintenance 模式的 ChatGPT POST 请求返回稳定 `browser_maintenance_mode`，而 `/health` / `/v1/models` 继续可用于维护诊断。

Gateway shutdown：

```text
stop Fastify
  ↓
close PagePool
  ↓
close BrowserContext / Chromium
  ↓
close Persistence
```

`close()` 必须幂等。

## 8. PagePool（页面池）

### 8.1 Interface

```ts
export interface PageLease {
  readonly page: Page;
  release(): Promise<void>;
}

export interface PagePool {
  acquire(): Promise<PageLease>;
  close(): Promise<void>;
  readonly openCount: number;
  readonly leasedCount: number;
  readonly idleCount: number;
}
```

### 8.2 Capacity

Phase 3 默认：

```text
MAX_ACTIVE_PAGES=4
```

该值属于运行配置，不是公开 API 协议承诺。

行为：

- 有 idle Page → 租用该 Page。
- 无 idle 且 Page 总数 `< maxActivePages` → `context.newPage()`。
- `openCount` 已达上限 → `page_capacity_exceeded`。
- Phase 3 不等待容量，不创建 global queue。

### 8.3 Release

正常 release：

- lease 只能 release 一次；重复 release 幂等。
- 未 crash / 未 close 的 Page 放回 idle pool。
- 下次 acquire 后 Driver 必须执行 Fresh 初始化，不假设 Page 已位于正确 URL。

Page 自身 close/crash：

- 从 pool tracking 中移除。
- 当前 lease 的后续操作失败为 `browser_unavailable` / response error。
- 不关闭其他 Page，不重启整个 Context。

Page Pool `close()`：

- 阻止新 acquire。
- 关闭所有 tracked Page。
- 幂等。

Phase 4 再实现：

- Conversation → Page affinity
- Queue
- idle timeout
- conversation URL restore

## 9. Selector Registry（选择器注册表）

所有 selector definition 必须定义在：

```text
src/chatgpt/selectors.ts
```

其他文件不得包含 ChatGPT CSS/test-id/role selector literal 的复制版本。

### 9.1 Cardinality

```ts
export type SelectorCardinality = 'unique' | 'collection';

export interface SelectorDefinition {
  name: string;
  cardinality: SelectorCardinality;
  candidates: readonly SelectorCandidate[];
}
```

`unique` 示例：

- composer
- send button
- login/sign-up indicator
- active stop/generating control

`collection` 示例：

- assistant turns
- user turns

### 9.2 Candidate Resolution

Unique definition：

```text
candidate 1
├── count = 1 → resolved
├── count > 1 → selector_ambiguous
└── count = 0 → candidate 2
                    ...
all 0 → selector_missing
```

不允许通过 `.first()` / `.last()` / `.nth()` 让 unique selector 静默通过。

Collection definition 可以返回一个多元素 Locator。Driver 可通过明确的业务索引访问，例如“发送前 Assistant Turn 数 N，因此新 Turn 是 index N”。这种 index 是 turn ownership，不是 selector fallback。

### 9.3 Candidate Quality

优先级：

1. role + accessible name
2. label / placeholder
3. stable `data-testid` / stable attribute
4. scoped CSS fallback

禁止：

- 第 N 个 `div`
- “附近第一个按钮”
- 依赖易变 CSS module hash
- 基于回复正文内容反向定位控制按钮

当前真实 ChatGPT selector 必须通过显式 `inspect:chatgpt` / E2E 验证后才可以标记为 verified。

## 10. Auth Probe（认证状态探测）

不能把“找不到 composer”直接等价为“未登录”。

内部状态：

```ts
export type ChatGptAuthState =
  | { state: 'authenticated' }
  | { state: 'auth_required' }
  | { state: 'unknown'; reason: string };
```

判断：

```text
goto chatgpt.com
  ↓
composer resolves unique?
  ├── yes → authenticated
  ↓ no
explicit login/sign-up signal?
  ├── yes → auth_required
  ↓ no
unknown
```

映射：

- `auth_required` → stable `auth_required`
- unknown + missing selector → `selector_missing`
- unknown + ambiguous selector → `selector_ambiguous`
- Page/Context unusable → `browser_unavailable`

Gateway 不自动输入用户名/密码，也不自动处理 MFA/CAPTCHA。

运营恢复：

```text
stop normal Gateway/browser owner
  ↓
start noVNC maintenance overlay
  ↓
manual login using /data/browser-profile/
  ↓
stop maintenance
  ↓
start normal Gateway
```

## 11. Fresh Page Initialization（Fresh 页面初始化）

每个 Phase 3 请求在租到 Page 后执行：

```text
goto https://chatgpt.com/
  ↓ wait domcontentloaded
AuthProbe
  ↓
Composer unique readiness
  ↓
READY
```

不使用：

- `networkidle` 作为 ChatGPT ready/completion 证据
- 任意固定 sleep
- 已有 Page URL 作为 Conversation identity

## 12. Phase 3 Prompt Envelope

### 12.1 Allowed Input

Phase 3 仅接受：

- `output.mode === 'text'`
- `output.stream === false`
- `tools.length === 0`
- `toolChoice.mode === 'auto'`（在无 tools 时）
- `attachments.length === 0`
- `output.structured === undefined`
- 任意个 system/developer instructions
- 恰好一个 user message
- user message 只包含 text parts
- 无 assistant/tool history
- `conversationKey === undefined`

### 12.2 Rejected as Future Conversation Sync

以下返回 `conversation_sync_not_implemented`：

- 有 `conversationKey`
- 多个 user turn
- 任意 assistant history
- 任意 tool history
- 其他需要识别/恢复已有 ChatGPT Conversation 的请求

### 12.3 Rejected as Future Capability

以下返回 `unsupported_phase3_request`：

- `stream=true`
- attachment
- tools
- non-default tool choice
- structured output
- image output

### 12.4 Envelope Format

一次网页提交，稳定模板：

```text
You are processing an API request through ChatGPT Web Gateway.
Interpret the following JSON fields by their declared roles.
System instructions have priority over developer instructions;
developer instructions have priority over the user message.

<JSON payload>
```

JSON payload：

```json
{
  "system": ["..."],
  "developer": ["..."],
  "user": "..."
}
```

必须使用 `JSON.stringify()` 生成 payload，不能手工拼接未转义正文。

这只是 ChatGPT Web 的**近似 role 映射**，不是 OpenAI 原生 system/developer privilege boundary，也不是安全隔离机制。公开兼容文档必须诚实说明这一点。

## 13. ChatGPT Driver（网页驱动）

### 13.1 Interface

```ts
export interface ChatGptTextRequest {
  prompt: string;
}

export interface ChatGptTextResult {
  text: string;
  conversationUrl: string;
}

export interface ChatGptDriver {
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}
```

Driver 不接收 `NormalizedRequest`；协议 capability 已由 Executor 处理。

### 13.2 Send State Machine

```text
READY
  ↓
AUTH_CHECK
  ↓
CAPTURE_BASELINE
  ↓
COMPOSING
  ↓
SUBMITTING
  ↓
WAITING_FOR_TURN
  ↓
WAITING_FOR_COMPLETION
  ↓
COMPLETED
```

失败状态映射为稳定 ChatGPTDriverError。

### 13.3 Turn Ownership

发送前：

```ts
const baseline = await assistantTurns.count();
```

发送后等待：

```text
assistant turn count > baseline
```

锁定：

```text
assistantTurns index baseline
```

只观察这个新 Turn；不能读取“页面当前最后一个 Assistant Turn”来猜本次归属。

### 13.4 Completion Observation

Phase 3 默认内部策略：

```text
poll interval      ≈ 250 ms
stable samples     = 3
generation timeout = 120 s
```

完成必须同时满足：

1. 新 Assistant Turn 已存在。
2. active stop/generating control 不再存在。
3. 明确 thinking/searching/generating 状态不再活跃（如果当前 selector registry 能观察）。
4. 新 Turn 文本非空。
5. 新 Turn 文本连续 3 次采样一致。
6. 最后重新读取一次完整文本作为最终结果。

250ms 是“读取真实状态的 observation cadence”，不是固定等待网页完成的 sleep。

Phase 5 Streaming 会复用 turn ownership / completion observer，但 Phase 3 不实现 Stable Prefix / SSE。

### 13.5 URL

成功结果返回当前 `page.url()` 作为 `conversationUrl`。

Phase 3 可以用于：

- 诊断
- E2E 验证
- Phase 4 接口准备

不得因此声称已经实现 Conversation URL persistence / RESTORE。

## 14. Phase3Executor

### 14.1 Result

```ts
export interface Phase3TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}
```

### 14.2 Flow

```text
NormalizedRequest
  ↓
validatePhase3Request
  ↓
buildPromptEnvelope
  ↓
PagePool.acquire
  ↓
ChatGptDriver.sendText
  ↓
release in finally
  ↓
Phase3TextExecutionResult
```

Page lease 无论 success / auth_required / selector error / timeout 都必须在 `finally` 中 release。

## 15. API Response Encoding

两个路由继续共享同一个 `NormalizedExecutionHandler` / internal execution result，不各自实现 Driver。

### 15.1 Chat Completions

Phase 3 成功最小输出：

```json
{
  "id": "chatcmpl_<gateway-id>",
  "object": "chat.completion",
  "created": 1786720000,
  "model": "chatgpt-web",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

- `created` 使用 Unix 秒。
- ID 由 Gateway 本地生成，不冒充 OpenAI ID。
- 不伪造 token usage；Phase 3 可以省略 usage。

### 15.2 Responses API

Phase 3 成功最小输出遵循当前 Response / output message / output_text 形状：

```json
{
  "id": "resp_<gateway-id>",
  "object": "response",
  "created_at": 1786720000,
  "completed_at": 1786720012,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "model": "chatgpt-web",
  "output": [
    {
      "id": "msg_<gateway-id>",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "...",
          "annotations": []
        }
      ]
    }
  ],
  "usage": null
}
```

Gateway 不输出伪 token 数。

## 16. Stable Error Boundary（稳定错误边界）

内部错误：

```text
auth_required
browser_unavailable
browser_maintenance_mode
page_capacity_exceeded
selector_missing
selector_ambiguous
chatgpt_generation_timeout
chatgpt_response_missing
conversation_sync_not_implemented
unsupported_phase3_request
```

API 建议映射：

| Code | HTTP | OpenAI error type | 含义 |
|---|---:|---|---|
| `auth_required` | 503 | `server_error` | Gateway Key 正确，但 ChatGPT Profile 需人工登录 |
| `browser_unavailable` | 503 | `server_error` | Chromium/Context/Page runtime 不可用 |
| `browser_maintenance_mode` | 503 | `server_error` | `UI_MODE=novnc` 正在人工维护，产品 BrowserManager 被有意禁用 |
| `page_capacity_exceeded` | 503 | `server_error` | 当前 Page Pool 已满 |
| `selector_missing` | 502 | `server_error` | ChatGPT DOM contract 缺失 |
| `selector_ambiguous` | 502 | `server_error` | 应唯一元素出现多匹配 |
| `chatgpt_generation_timeout` | 504 | `server_error` | 网页生成未在限制内完成 |
| `chatgpt_response_missing` | 502 | `server_error` | 发送后没有可读取的新 Assistant Turn |
| `conversation_sync_not_implemented` | 501 | `server_error` | 请求需要 Phase 4 Conversation Sync |
| `unsupported_phase3_request` | 501 | `server_error` | 请求需要 Streaming/附件/Tools 等未来阶段 |

`auth_required` **不能映射为 HTTP 401**：401 已表示 Gateway Bearer API Key 认证失败。

Playwright 原始 error message、stack、filesystem profile path、Cookie 等不得直接返回客户端。

## 17. `inspect:chatgpt` Diagnostic（诊断工具）

命令：

```bash
corepack pnpm inspect:chatgpt
```

该命令是**显式真实 ChatGPT 工具**，不属于默认 `verify`。

实现边界保持 `chatgpt/` 与 BrowserManager 解耦：`src/chatgpt/inspect.ts` 提供 `inspectChatGptPage(page, ...)`，只检查一个已经拥有的 Page；`scripts/inspect-chatgpt.ts` 才负责用显式 E2E Profile 启动/关闭 BrowserManager 和 lease/release Page。这样架构检查可以继续禁止 `chatgpt/` 依赖 BrowserManager/PagePool 实现。

### 17.1 Required E2E Profile

必须显式设置：

```text
CHATGPT_PROFILE_DIR=/absolute/path/to/e2e-browser-profile
```

缺失时拒绝运行：

```text
e2e_profile_required
```

不得自动 fallback 到 `${DATA_DIR}/browser-profile/`。

### 17.2 Output

默认输出机器可读 JSON：

```json
{
  "url": "https://chatgpt.com/",
  "auth": "authenticated",
  "selectors": {
    "composer": "unique",
    "sendButton": "unique",
    "assistantTurns": {
      "status": "collection",
      "count": 4
    },
    "stopControl": "missing"
  }
}
```

诊断必须理解 selector 的状态语义。例如 idle 页面 `stopControl: missing` 是合理状态，不自动判失败。

### 17.3 Optional Artifacts

只有显式设置：

```text
CHATGPT_DIAGNOSTICS_DIR=/absolute/path/to/diagnostics
```

才允许保存：

- screenshot
- DOM/HTML snapshot

这些内容可能包含用户页面数据：

- 必须在受控临时/诊断目录；
- 必须被 Git ignore / hygiene 排除；
- 普通 Gateway runtime 不默认生成。

## 18. Real E2E Profile（真实 E2E Profile）

真实 Phase 3 E2E 使用独立 Profile，例如：

```text
/data/e2e-browser-profile/
```

不得使用生产：

```text
/data/browser-profile/
```

真实测试创建 ChatGPT server-side Conversation，因此必须视为有外部副作用。

E2E Profile 仍通过人工 maintenance/headed 流程登录；测试不会自动读取账号密码。

## 19. Test Strategy（测试策略）

### 19.1 Deterministic Unit / Integration

`corepack pnpm verify` 继续：

- 不访问 `chatgpt.com`
- 不要求账号
- 不读取真实 Browser Profile
- 不执行真实 E2E

覆盖：

#### BrowserManager

- persistent context launch options
- profile path
- startup error → `browser_unavailable`
- idempotent close

BrowserManager 测试应优先通过注入 BrowserType-like launcher / fake context 避免启动真实浏览器；另有本地 Chromium smoke 时可显式运行。

#### PagePool

- acquire/release
- idle reuse
- capacity exceeded
- closed/crashed Page removal
- close prevents further acquire
- idempotent release/close

#### Selector Registry

使用仓库内固定 HTML fixture / mock Page-like boundary 验证：

- primary success
- fallback success
- missing
- ambiguous
- unique/collection distinction

Fixture 通过**不代表当前 ChatGPT DOM 已验证**。

#### Auth Probe

- composer unique → authenticated
- explicit login signal → auth_required
- neither → unknown/error mapping

#### Completion

- baseline = N
- new Assistant Turn ownership = index N
- active generation prevents completion
- stable text sampling completes
- timeout
- empty/missing response

#### Phase3Executor

- Fresh request accepted
- system/developer order preserved
- JSON escaping safe
- stream/tools/attachments/structured rejected
- assistant/tool/multiple user/conversation key rejected as sync not implemented
- Page lease always released

#### API Encoders

- Chat Completions text response shape
- Responses text response shape
- no fabricated token usage
- stable error mapping

### 19.2 Real E2E Command

建议：

```bash
E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/data/e2e-browser-profile \
corepack pnpm test:e2e:chatgpt
```

规则：

- `E2E_CHATGPT !== 1` 时不执行真实访问。
- `CHATGPT_PROFILE_DIR` 缺失时 fail fast。
- 未登录时返回/报告 `auth_required`，不进入自动登录流程。
- 真实 E2E 不包含在普通 `verify`。

## 20. Real Phase 3 E2E Scenarios（真实验收场景）

### 20.1 Auth + Selector Inspection

```text
launch persistent E2E profile
  ↓
goto chatgpt.com
  ↓
AuthProbe == authenticated
  ↓
composer == unique
  ↓
assistant turn collection observable
```

没有这条证据，Phase 3 不可完成。

### 20.2 Fresh Driver Text Question

生成随机 challenge token：

```text
CWG_PHASE3_<random suffix>
```

Prompt 语义：

```text
Return exactly this token and nothing else: <token>
```

验收：

- Fresh Page 初始化成功。
- 发送前记录 Assistant baseline。
- 新 Assistant Turn 出现。
- stable completion 成功。
- 最终文本包含 challenge token。
- `conversationUrl` 是真实 ChatGPT Conversation URL，而不是初始 root URL。

随机 suffix 用于避免误把历史页面文本当作当前回答。

### 20.3 Gateway HTTP E2E

至少一条真实：

```text
POST /v1/chat/completions
→ API key auth
→ normalizer
→ Phase3Executor
→ PagePool
→ ChatGPTDriver
→ chatgpt.com
→ Chat Completion response
```

断言：

- HTTP 200
- `model === 'chatgpt-web'`
- `choices[0].message.role === 'assistant'`
- `choices[0].message.content` 包含 challenge token
- `finish_reason === 'stop'`

为了减少真实 ChatGPT 外部调用，Responses API 可以通过共享 Executor 的确定性 integration test 验证编码；Phase 3 不要求两个协议分别生成一次真实 ChatGPT 回答。

## 21. Docker Boundary（Docker 边界）

普通 Docker smoke 继续**不访问真实 ChatGPT**，但 Phase 3 后新增：

- Gateway 正常 headless runtime 确实启动 BrowserManager / Chromium。
- Chromium 进程运行 UID/GID 与配置的 `PUID/PGID` 一致。
- `/data/browser-profile/` 可由长期非 root 进程创建/使用。
- 普通 Compose 不启动 noVNC / Xvfb / x11vnc / maintenance browser。
- maintenance overlay 只启动 headed maintenance browser，不再启动产品 headless BrowserManager；HTTP POST 返回 `browser_maintenance_mode`，从而保证同一 Profile 单 owner。
- shutdown 同时正确关闭 Fastify、Browser、SQLite。

普通 `docker:smoke` 不能证明：

- ChatGPT 当前登录
- 当前 selector 有效
- 真实文本问答成功

真实 Docker/ChatGPT E2E 必须显式执行并使用独立测试 Profile。

## 22. Configuration（配置）

Phase 3 生产配置新增最小字段：

```text
MAX_ACTIVE_PAGES=4
CHATGPT_PROXY_SERVER=
```

`CHATGPT_PROXY_SERVER` 是实现阶段由真实 E2E 网络环境强制暴露出的可选能力：未配置时 Chromium 直连；配置时 normal BrowserManager 与 maintenance browser 使用同一代理。只接受 `http` / `https` / `socks5` server origin，URL 内禁止用户名/密码，避免凭据进入 Chromium 参数或诊断输出。

Browser profile path 不新增生产环境变量，固定派生：

```text
join(DATA_DIR, 'browser-profile')
```

Phase 3 不新增：

- browser executable path
- browser channel
- arbitrary Chromium args env
- page idle timeout（留 Phase 4）
- automated login credentials

E2E-only 环境变量不进入 production `AppConfig`：

```text
E2E_CHATGPT
CHATGPT_PROFILE_DIR
CHATGPT_DIAGNOSTICS_DIR
```

`CHATGPT_PROFILE_DIR` 也允许 maintenance overlay 显式传给 headed maintenance browser，用于给隔离 E2E Profile 完成人工 Cloudflare/登录；normal headless Gateway 不读取该变量，生产 Profile 仍固定 `${DATA_DIR}/browser-profile/`。`CHATGPT_PROXY_SERVER` 则属于 production `AppConfig`，同时也由显式诊断/E2E CLI 读取，以保证四条浏览器路径使用一致网络。

## 23. Security and Privacy（安全与隐私）

- Browser Profile 是敏感凭证数据，继续不得提交 Git。
- E2E Profile 与 production Profile 隔离。
- 代理 URL 不允许内嵌用户名/密码；需要带认证的代理属于后续独立设计，不在 Phase 3 当前实现内。
- 不把 Cookie、Local Storage、Authorization、ChatGPT 页面正文默认写日志。
- Driver error 返回稳定 code，不返回原始 DOM / Playwright stack。
- screenshot / DOM snapshot 必须显式开启。
- 不逆向调用 ChatGPT 私有 `/backend-api`。
- 所有 ChatGPT 操作通过网页 DOM / Playwright 完成。
- Gateway 不自动保存/填写账号密码，不自动处理 MFA/CAPTCHA。

## 24. Architecture Enforcement（架构自动约束）

`scripts/check-architecture.mjs` 在 Phase 3 应增加/收紧：

1. `api/` 继续禁止导入 `playwright`。
2. `persistence/` 继续禁止导入 `playwright`。
3. ChatGPT selector-like literals 只能出现在 `src/chatgpt/selectors.ts`。
4. `browser/` 不得导入 `api/`、`persistence/` 或 `chatgpt/`。
5. `chatgpt/` 不得导入 `api/`、`persistence/` 或 `browser/browser-manager` / `page-pool` 实现。
6. `process.env` 生产读取仍只允许 `src/config/`；scripts/E2E CLI 独立治理。

## 25. API Compatibility Honesty（兼容真实性）

Phase 3 后真实实现：

- Chat Completions Fresh non-stream text
- Responses Fresh non-stream text
- system/developer 的网页 prompt envelope 近似映射

仍未实现：

- Conversation key lifecycle
- multi-turn append/restore
- Streaming
- attachment execution
- Tool Calling execution
- Structured Output execution guarantee
- image generation

用户发送未来能力时必须得到明确稳定错误，不允许忽略并返回看似成功结果。

## 26. Acceptance Criteria（Phase 3 验收）

Phase 3 只有全部满足才可标记 complete：

1. Playwright bundled Chromium 通过 Persistent BrowserContext 接入正常 Gateway headless runtime；`UI_MODE=novnc` 时产品 BrowserManager 明确禁用，避免 Profile 双 owner。
2. Production Profile 固定 `${DATA_DIR}/browser-profile/`，BrowserManager 幂等关闭。
3. Page Pool 默认容量 4，支持 acquire/release/reuse/capacity error/page removal。
4. Selector Registry 具有 unique/collection cardinality、fallback、missing/ambiguous 诊断。
5. 所有 ChatGPT selector literal 仍集中在 `src/chatgpt/selectors.ts`。
6. Auth Probe 正确区分 authenticated / auth_required / unknown。
7. 未登录不会导致 Gateway health/startup 反复失败；ChatGPT 请求返回稳定 `auth_required`。
8. Fresh text Driver 使用 Assistant baseline 锁定本次新 Turn。
9. Non-stream completion 使用生成状态 + 非空文本 + 连续稳定采样，不用 fixed completion sleep / networkidle。
10. Phase3Executor 只接受 Fresh 单轮非流式纯文本请求，并对未来能力明确拒绝。
11. system/developer/user envelope 使用 JSON serialization 并有单元测试覆盖转义/顺序。
12. Page lease 在所有执行结果下都释放。
13. Chat Completions 返回 OpenAI-style non-stream text object，不伪造 token usage。
14. Responses 返回 OpenAI-style completed response/output_text object，usage 未知时为 null。
15. stable Browser/Driver/API error code 与 HTTP mapping 已测试，包括 maintenance 模式的 `browser_maintenance_mode`。
16. `inspect:chatgpt` 完成，缺少显式 E2E Profile 时拒绝运行。
17. screenshot/DOM artifact 只有显式 diagnostics dir 时保存。
18. `corepack pnpm verify` 确定性全绿且不访问真实 ChatGPT。
19. fresh Docker build / smoke 全绿，普通 smoke 启动生产 headless Chromium 但不访问真实 ChatGPT。
20. 独立测试 Profile 的真实 ChatGPT auth/selector inspection 通过。
21. 独立测试 Profile 的真实 Fresh Driver 文本问答通过。
22. 至少一次真实 Gateway HTTP → ChatGPT Web → Chat Completions response E2E 通过。
23. 项目记忆/API/架构/测试/README 与实际能力一致。
24. 真实 E2E 未通过时，`PROJECT_STATE` 必须保留 Phase 3 active/blocked，不可通过 fixture 测试宣称完成。

## 27. Failure / Blocked State（阻塞规则）

如果实现、离线验证、Docker 都完成，但真实 E2E 因以下外部原因无法通过：

- E2E Profile 未登录
- ChatGPT CAPTCHA / MFA / 风控
- 当前网络不能访问 ChatGPT
- 当前 ChatGPT DOM 与 selector registry 不匹配
- ChatGPT 页面功能异常

项目状态必须记录真实事实，例如：

```text
PHASE=phase-3-implementation
STATUS=blocked
ACTIVE_PLAN=<phase-3-plan>
NEXT_TASK=resolve-phase-3-real-e2e-blocker
```

实现代码可以提交和推送，但不得把 Phase 3 标记 complete。

## 28. Implementation Order（实施顺序）

建议按以下独立闭环实施：

1. BrowserManager + config + PagePool。
2. Selector Registry + fixture diagnostics。
3. Auth Probe + `inspect:chatgpt` CLI foundation。
4. Completion observer + Fresh ChatGPTDriver。
5. Phase3Executor + instruction envelope + capability boundary。
6. Chat Completions / Responses encoders + stable API errors。
7. Gateway runtime Browser lifecycle + Docker smoke。
8. Architecture/docs/project-memory writeback。
9. 显式真实 inspect/auth E2E。
10. 显式真实 Driver E2E。
11. 显式真实 Gateway HTTP E2E。
12. 只有真实验收全部通过后关闭 Phase 3。

## 29. References（设计依据）

外部 API 行为以实现时的官方资料为准，重点包括：

- Playwright `BrowserType.launchPersistentContext`
- Playwright `BrowserContext` / `Page`
- Playwright Locator strictness / actionability
- Playwright authentication state security guidance
- OpenAI Chat Completions response object
- OpenAI Responses completed response / output message / output_text object

实现阶段如官方行为与本 spec 假设冲突，必须先更新 spec/plan，再修改产品代码。
