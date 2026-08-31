# Architecture（架构）

## 目标

把 ChatGPT Web（ChatGPT 网页）通过 Playwright（浏览器自动化框架）自带 Chromium（浏览器）转换为稳定、可测试、通用的 OpenAI Compatible API（OpenAI 兼容接口）。

项目不模拟整个 OpenAI 平台，只实现 Agent（智能体）常用且可以自然映射到 ChatGPT Web 的能力。

## 顶层数据流

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
       Conversation Engine
   ┌──────────┼───────────┐
   ▼          ▼           ▼
Context     Tools     Attachments
   └──────────┼───────────┘
              ▼
        ChatGPT Driver
              │
              ▼
        Browser Manager
              │
              ▼
     Playwright Chromium
              │
              ▼
          chatgpt.com
```

## 模块职责

```text
src/
├── api/             OpenAI HTTP 协议、认证、Schema、输入输出 Adapter
├── browser/         Chromium 生命周期、BrowserContext、Page Pool、健康检查
├── chatgpt/         ChatGPT DOM 行为、Selector、发送、提取、上传、图片生成
├── conversations/   Conversation 生命周期、队列、Page 绑定和恢复
├── context/         FRESH / APPEND / RESTORE / REBUILD 纯逻辑
├── tools/           Tool Schema 标准化、external-function Prompt/Protocol、Parser、Tool Result
├── structured/      Structured Output policy、JSON/Ajv 本地最终校验
├── attachments/     图片/文件解析、下载、去重、落盘、上传准备
├── images/          图片生成 request/service/storage 与 Generated Image lifecycle
├── stream/          Snapshot、Stable Prefix、Delta、内部流事件
├── persistence/     SQLite Repository 与文件元数据
├── diagnostics/     本地 Browser/Page/Persistence readiness snapshot
├── config/          环境变量、默认值、配置验证
└── observability/   结构化日志和错误上下文
```

## 内部统一请求模型

`/v1/chat/completions`、`/v1/responses` 不得各自实现浏览器执行链。入口 Adapter（适配器）统一转换为内部模型：

```ts
interface NormalizedRequest {
  requestId: string;
  conversationKey?: string;
  instructions: NormalizedInstruction[];
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  attachments: NormalizedAttachment[];
  output: {
    mode: 'text' | 'image';
    stream: boolean;
    structured?: NormalizedStructuredOutput;
  };
  diagnostics: {
    ignoredParameters: string[];
  };
}
```

图片生成可以有独立 `ImageRequestAdapter`，但浏览器生命周期、错误、持久化和生成资源管理仍复用公共基础设施。

HTTP compatibility-only metadata 不应为了客户端兼容污染 `NormalizedRequest`。Chat Completions 的 `stream_options.include_usage?: boolean`、Cherry/Pi Assistant `reasoning_content` / `reasoning` / `reasoning_text` history metadata，以及 Pi/OpenClaw/Hermes 常见 `store`、`reasoning_effort`、`parallel_tool_calls`、`service_tier`、prompt-cache/provider metadata 都由 strict request schema 显式接收后在 API adapter 边界消费/忽略；Pi/OpenAI-compatible 的 singleton user text object `content:{type:"text",text:string}` 则严格规范化为普通单个 text part，不开放任意 singleton content object。Responses 同样在 adapter 层消费 Codex `reasoning/include/client_metadata` 等兼容字段。未知顶层字段与未知 strict nested members 仍由 Ajv 拒绝，且 Gateway 不因为这些 metadata 伪造 token usage/reasoning 或 server-side behavior。`GET /v1/models` 的 context/max-input/max-output hints 分别从 `AppConfig.modelContextWindow/modelMaxInputTokens/modelMaxOutputTokens` 读取，同时暴露 snake_case 与 Cherry-compatible camelCase aliases；这些字段不进入 Conversation/Browser 执行链，也不代表 ChatGPT Web 官方固定 token limit。

## Conversation（对话）和 Context Sync（上下文同步）

每个 Conversation 有稳定 `ConversationKey`，本地保存完整消息和 ChatGPT conversation URL。

同步只允许四种模式：

- `FRESH`：没有已知会话，创建新 ChatGPT Conversation。
- `APPEND`：输入历史与本地已同步前缀一致，只发送新增内容。
- `RESTORE`：进程/Page 已丢失，但 ChatGPT conversation URL 和本地状态可恢复。
- `REBUILD`：历史被压缩、修改、回滚，或原网页会话不可恢复，根据当前有效历史建立新会话。

同一 Conversation 请求串行，不同 Conversation 可以并行。显式 key 继续按公开 conversation key 排队；被唯一识别出的匿名续接按 persisted Conversation id 派生内部 queue key 排队，并在真正获得该 queue slot 后再次执行唯一候选证明。若等待期间另一个匿名请求已经推进了原 Conversation，当前请求必须回退 FRESH，不能拿更新后的 aggregate 做 REBUILD/覆盖。禁止全局锁串行所有用户。

Phase 4 已批准设计以 SQLite `ConversationStore` + `clean | in_flight` sync checkpoint 作为恢复事实源，并把请求确定性分为 `incremental | full`：单条 user message 是 incremental；多条消息或 assistant/tool history 是 full。只有能够证明已确认历史与当前请求一致时才 APPEND/RESTORE；历史分叉、instructions 变化、checkpoint 不确定/不匹配、URL 缺失或确认不可恢复时统一 REBUILD。V0.1.3 对没有 `X-Conversation-Key`、但会每轮重发完整历史的 Cherry/OpenAI-compatible 客户端增加保守匿名续接：只查询 `conversation_key = NULL`、`clean`、有持久化 ChatGPT URL 且 `synced_message_count` 与当前确认历史长度精确一致的候选，再复用同一个 `planContextSync()` 校验 instructions、tool fingerprint 与完整历史前缀；**恰好一个**候选能得到 APPEND/RESTORE 时才复用，否则继续 FRESH。Gateway 仍不生成或暴露伪造的客户端会话 key，也不会在存在歧义时猜测身份。

有稳定 key 的请求通过 keyed FIFO Queue 串行化；排队期间不占 Page，轮到时重新读取 SQLite 最新状态。第一次可能写入 ChatGPT turn 之前先把 checkpoint 置 `in_flight`；成功后一次性保存 reconciled aggregate 并恢复 `clean`。任何发生在 checkpoint 之后且无法证明网页副作用的失败都不得猜测回滚为 clean，下一请求通过 REBUILD 收敛。普通认证、Selector、Browser runtime 错误不得被伪装成“可安全重建”的 restore failure。

## Container Runtime（容器运行时）

Docker 从 Phase 1 起就是正式运行边界，而不是后期附加包装。目标平台先锁定 `linux/amd64`。

仓库提供单一完整镜像。Phase 3 起正常 `UI_MODE=headless` 会先启动仅供浏览器使用的 Xvfb，再由 Gateway BrowserManager 以 `headless:false` 启动 full Playwright bundled Chromium / Persistent BrowserContext；**headless 在这里表示无可访问 UI，而不是 Chromium 的 `--headless` 指纹**。真实环境验证表明 Playwright headless-shell 与 Chromium new-headless 都会长期停在 ChatGPT Cloudflare challenge，而 Xvfb 上的 full Chromium 可进入正常 ChatGPT 页面，因此这是实现强制调整。正常模式不启动 x11vnc/websockify/noVNC，也不发布维护端口。首次登录、重新认证或人工排障时，通过 Compose noVNC overlay 启动 Xvfb / x11vnc / noVNC 和独立 headed maintenance browser。maintenance browser 使用镜像内固定版本的 **Google Chrome Stable**，由 Node 直接 spawn，不创建 Playwright BrowserContext、不开 `--remote-debugging-pipe`；真实 A/B 验证中 Chrome for Testing 在 `auth.openai.com` Turnstile 持续循环，而 Google Chrome Stable 完成人工验证并保存可供产品 Playwright Chromium 复用的 Profile 登录态。maintenance 模式不启动产品 BrowserManager，ChatGPT POST 返回稳定 `browser_maintenance_mode`，从而保证同一 Profile 只有一个 browser owner。

镜像以官方 Playwright Node Docker 镜像为基础并固定明确版本。Phase 1 实现固定 `mcr.microsoft.com/playwright:v1.62.1-noble` 与 `playwright@1.62.1`；实测镜像运行时为 Node `v24.18.1` / `linux/amd64`。后续升级仍必须重新检查 package / image / Node LTS 组合，不能把这次结果当作永久事实。

持久状态统一通过宿主机目录 Bind Mount 到 `/data`；normal BrowserManager 的生产 Profile 固定在 `/data/browser-profile/`。**同一 Profile 同时只能有一个 browser owner**：Phase 3 起 `UI_MODE=headless` 由产品 BrowserManager / Playwright Chromium 占用生产 Profile；`UI_MODE=novnc` 则明确禁用产品 BrowserManager，只启动 headed maintenance Google Chrome Stable。maintenance 默认仍使用 `/data/browser-profile/`，但显式 real E2E 可通过 `CHATGPT_PROFILE_DIR=/data/e2e-browser-profile` 切到隔离测试 Profile；该 override 不改变 normal headless 的生产 Profile。maintenance shutdown 由 entrypoint 有序监督：等待 Chrome Profile lock ready，停机时请求 Chrome 退出后再停止 Gateway；若 Chrome 已退出但当前容器自己的 Linux `SingletonLock/Cookie/Socket` 仍残留，只在 lock hostname 匹配当前容器且 PID 已确认不存在时清理 stale marker，避免下一模式因容器 hostname 改变误报 Profile 仍被占用。maintenance 的 x11vnc 0.9.16 固定使用 `-threads`：真实复现中默认单线程模式会高 CPU 且不发送 RFB banner，而 threaded 模式能立即完成 `RFB 003.008` 握手。maintenance overlay 使用 vendored Playwright seccomp profile 开放 Chromium user-namespace 所需 syscall，让非 root Google Chrome 保持 Linux sandbox；不添加 `SYS_ADMIN`，也不使用 `--no-sandbox`。长期 Gateway / Browser 进程必须非 root，并支持 `PUID/PGID` 与 NAS 文件权限对齐。noVNC overlay 默认只把维护端口绑定到宿主机 `127.0.0.1`；需要远程 NAS 访问时必须显式调整绑定并自行保证网络访问控制。

ChatGPT 浏览器网络可通过可选 `CHATGPT_PROXY_SERVER` 配置。该值只允许 `http` / `https` / `socks5` proxy server origin，URL 内禁止用户名/密码；同一值必须传给 normal BrowserManager、maintenance browser、`inspect:chatgpt` 和 real E2E，避免四条路径出现不同网络行为。Compose 同时透传可选 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 给容器内通用工具，并提供 `host.docker.internal:host-gateway`；代理运行在 Docker Host 时应使用 `http://host.docker.internal:<port>`，因为容器内 `127.0.0.1` 指向容器自身。generic proxy 变量不替代 Chromium 的 `CHATGPT_PROXY_SERVER`；未配置时保持直连。

## Browser（浏览器）

V1：

```text
Playwright
  └── Chromium
      └── Persistent BrowserContext
          ├── Page A → Conversation A
          ├── Page B → Conversation B
          └── Page C → Conversation C
```

Page 数有上限。Phase 3 建立 bounded Page Pool；Phase 4 已在其上增加 Conversation → Page affinity、idle timeout 与容量压力下的 LRU idle eviction。默认 `PAGE_IDLE_TIMEOUT_MINUTES=30`，只回收 idle affinity，不抢占 active Conversation。Conversation 请求失败时对应 lease 会 discard，避免把未知状态 Page 继续绑定给该 key；本地 SQLite 状态仍保留，因此后续可通过 conversation URL RESTORE。

恢复边界分两级：

1. **Page/Conversation 级：** 单次执行失败时对应 keyed/transient Page 直接关闭，不重新放回 idle pool。Playwright Persistent BrowserContext 关闭最后一个 Page 会同时关闭整个 context，因此 PagePool 在关闭最后一个 failed lease 前先创建一个 fresh idle replacement，再关闭失败 Page；这保持“未知状态 Page 不复用”，同时避免把正常 Page failure 错升级成 BrowserContext death。SQLite `in_flight` / saved Conversation URL 保留，下一请求使用 fresh Page 后按 RESTORE/REBUILD 规则收敛；单 Page 故障不主动杀掉其他 Conversation。
2. **BrowserContext/进程级：** Persistent BrowserContext 真正意外关闭时 BrowserManager 触发 fatal callback。生产 `src/index.ts` 有序关闭 Gateway 后以非零状态退出，由 Compose `restart: unless-stopped` 重建进程和 Chromium；`/data` 下 SQLite、Browser Profile、Files、Generated Images 均保留。应用内部不维护复杂 BrowserContext 热替换状态机。

人工登录失效仍进入 noVNC maintenance 边界处理，不自动填写账号、MFA 或 CAPTCHA。

## ChatGPT Driver（网页驱动）

上层只依赖稳定接口，不依赖 DOM 细节。所有 ChatGPT Selector 必须集中在 `src/chatgpt/selectors.ts`。

Phase 3 建立了 Fresh text Driver 的发送/完成观察基础；Phase 4 将导航/readiness 与提交彻底拆分为 `openFresh(page)`、`openConversation(page, savedUrl)` 和纯 `sendText(page, { prompt })`。`openConversation` 只接受安全 `https://chatgpt.com` non-root Conversation URL，以 canonical pathname 比较 identity（忽略 query/hash）；确认无法恢复时返回显式 `not_restorable`，auth/selector/browser 异常继续作为错误传播。跨 URL RESTORE 不把 Composer 出现等同于历史 Conversation 已恢复：导航后会在 authenticated readiness 之后再次确认 canonical pathname，并等待既有 user/assistant turn 成对挂载、末个 Assistant completion marker 就绪且连续采样稳定后才返回 `restored`；同一 pathname 的 retained-Page APPEND 不增加该恢复等待。2026-08-29 live restart 直接证明必要性：Composer 已出现时历史 turn 仍为 `0 / 0`，数百毫秒后才一次性水合为 `2 / 2`；旧实现因此把前一轮 `P7RESULT_*` 错认成本轮目标，而重新打开该 Conversation 后末个 Assistant 实际已经是正确 `P7RESTORE_*`。所有路径仍复用 Auth Probe、Assistant Turn baseline ownership 和 completion observer。2026-08-16 真实 DOM 验收发现全局 `stop-button` 可能在答案可见文本已经稳定后继续滞留，因此它不再是唯一完成条件；Driver 绑定本次新 Assistant turn，主要等待该 turn 的 `copy-turn-action-button` completion marker，再结合非空文本稳定确认完成。2026-08-29 reduced combined 又暴露相反边界：Assistant 正文已经长期稳定，但原 Page 的 completion action UI 在 Gateway generation timeout 内没有挂载；之后恢复同一服务器 Conversation 时，完整正文与 action UI 都已正常存在。当前候选因此增加一个严格受限的第二终态：**同一 request 必须先真实观察到唯一 Stop control（证明进入生成态），owned turn 没有任何非-prose `.markdown` 状态块，且同一非空 authoritative text 持续稳定至少 5 秒；随后用同一 BrowserContext 的临时验证 Page 重开完全相同的 Conversation URL，只有 verifier 的同一 target index 也出现唯一 `.markdown.prose`、文本逐字完全一致并挂载正式 `copy-turn-action-button` marker 时，原 observation 才视为完成**。验证 Page 不输入、不点击 Send、不会创建新 Conversation，并在确认后立即关闭；仅仅“正文稳定”或 Stop 消失永远不够。固定约 200ms 只是 polling cadence，不把任意 sleep、`networkidle` 或全局按钮瞬时状态当作完成证据。2026-08-26 real E2E 进一步确认 Composer 写入后 Send control 仍可能短暂未挂载，因此 Driver 在输入后以 strict unique selector 轮询等待 Send readiness；Assistant 完成后的空 Composer 不再被错误要求必须暴露 Send。2026-08-28 abort→REBUILD 调试进一步证明 Playwright `Locator.fill()` 会让多段 ProseMirror DOM 在 Send 后只提交首段；改为整段 `keyboard.insertText()` 后，普通 Fresh Page 可完整提交，但 PagePool replacement-before-close 产生的新 Page 上 multiline `insertText` 仍只接受首段。当前 Driver 因此把 Composer 输入运输集中到 `src/chatgpt/composer-input.ts`：单行文本继续使用 `keyboard.insertText()`；普通多行文本继续向已聚焦 Composer 分发一次 `text/plain` paste，让 ProseMirror 自己形成完整文档事务；超过 **16 KiB UTF-8** 的多行 Prompt 不再进行一个大型 synthetic paste，而是按不超过 **4 KiB UTF-8** 的 Unicode-safe `keyboard.insertText()` 分块输入，并用 `Shift+Enter` 表达行分隔。该阈值只取决于最终 Browser Prompt 字节数，不取决于客户端身份或 tool 数量，且不截断 system/developer instructions、Skills、history 或 tool definitions。2026-08-31 真实 Pi `0.84.4` + 精确 16 tools 的单请求最终 Browser Prompt 达到 **21,019 UTF-8 bytes** 并成功完成，证明大型 Prompt 已进入分段运输路径。

Selector Registry 区分 `unique` 与 `collection`。Unique selector primary 多匹配立即 `selector_ambiguous`，不会通过 `.first()` / `.nth()` 掩盖；collection 才允许按明确业务索引访问新 turn。Phase 5 authenticated real E2E 进一步确认 Fresh 会短暂进入 `/c/WEB:<uuid>` provisional route，APPEND 也可能先挂载没有 authoritative prose 正文的临时 Assistant placeholder；Driver 因此只有在正式安全 Conversation URL 与 owned turn 唯一 `.markdown.prose` 正文同时成立后才暴露 authoritative snapshot。2026-08-28 final-candidate combined 回归还观察到网络短暂中断时，同一 Assistant turn 会额外挂载非 prose 的 `.markdown` 状态块（`Connection interrupted. Waiting for the complete answer`）；该状态块不是 Assistant 正文，必须被正文 selector 排除。若 ChatGPT 生成 writing-block/editor 导致多个 `.markdown.prose` 正文节点，继续严格 `selector_ambiguous`，不截断结构化 UI 冒充纯文本。

Phase 5 Conversation Engine 继续复用 Phase 4 的 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、Page affinity 与 SQLite `clean | in_flight` checkpoint，并提供 protocol-neutral `{ execute, stream }` 两条纯文本执行入口。`stream=true` 不改变 Context Sync：FRESH/REBUILD 仍发送完整 Context Envelope，APPEND/RESTORE 仍只发送 `current_user`。附件、Tools、Structured Output 与 image execution 仍由 `unsupported_phase5_request` 明确拒绝。Streaming 整个生命周期（包含 abort cleanup）都在 same-key Queue 内；不同 key 仍可并行。

浏览器/Driver 原始异常不会直接成为公共 API；未知 Page/Playwright runtime/navigation failure 仍映射为稳定 `browser_unavailable`。V0.1.4 的 Driver wrapper 会为未知异常保留原始 `cause`，并只附加 bounded 本地诊断：operation、Page URL/title/document readyState/closed，以及发送失败时 Prompt 的字符数、UTF-8 bytes、行数；不记录 Prompt 正文、tool schema/arguments/results、Cookie、API key、Profile path 或代理凭据。普通 HTTP 5xx 与 SSE 已返回 200 后的执行失败都会写结构化 server log，但公共 OpenAI-compatible error body/frame 保持稳定且不暴露 Playwright internals。`src/chatgpt/inspect.ts` 只检查已经拥有的 Page，不创建 BrowserManager；显式 CLI 才负责独立 E2E Profile 的 Browser 生命周期。当前 ChatGPT 还可能显示明确 `data-testid="modal-conversation-history-rate-limit"` 的通知 overlay；真实隔离实验已证明其唯一 `Got it` 只是关闭提示、关闭后同一 Conversation 请求仍可立即成功，因此 Driver 只对这个精确 testid + 唯一按钮做确认。CAPTCHA、MFA、其它 modal 与未知 challenge 仍绝不自动处理。

Phase 3 authenticated ChatGPT DOM 与 Fresh 文本链已于 2026-08-15 完成真实验收：独立 Profile 先通过 maintenance Google Chrome Stable 人工登录，再由产品同版本族的 Playwright Chromium 复用该 Profile；`inspect:chatgpt` 实际得到 `auth=authenticated` 与唯一 Composer。真实运行还发现 Composer 在 `domcontentloaded` 后可能延迟挂载，因此 Auth Probe 在首次 strict probe 为 unknown 时会使用 Locator `waitFor({ state: 'attached' })` 等待 Composer/Login signal 后重新 strict probe，而不是固定 sleep。随后 `test:e2e:chatgpt` 实际通过 Fresh Driver challenge 与 Gateway HTTP → ChatGPT Web → Chat Completions challenge。

Phase 4 于 2026-08-16 完成真实 authenticated ChatGPT Web E2E：新的干净隔离 Profile 经 maintenance Google Chrome Stable 登录后，`inspect:chatgpt` 返回 `auth=authenticated` / `composer=unique`；修复上述 completion marker 回归后，combined `test:e2e:chatgpt` 同时通过 Phase 3 regression 与 Phase 4 full-history APPEND、runtime restart RESTORE、history divergence REBUILD。APPEND 的 live DOM 断言证明第二个 Web user turn 只包含新 marker、不重发第一轮历史；RESTORE 保持持久化 Conversation URL；REBUILD 保持本地 key/UUID 但获得新的 ChatGPT Conversation URL。

## Streaming（流式输出）

Phase 5 已实现纯文本真 Streaming 的代码路径：

```text
Target Assistant DOM Turn
   ↓ observe() ~200ms
AssistantSnapshot
   ↓ CRLF/CR normalize
3-sample Stable Prefix
   ↓ non-empty Delta
Protocol-neutral TextStreamEvent
   ├── Chat Completions SSE Encoder
   └── Responses SSE Encoder
```

`src/stream/` 是纯逻辑层，不依赖 Playwright、`api/`、`browser/`、`chatgpt/`、`persistence/` 或 `node:sqlite`。Assistant ownership 仍由发送前 `assistantTurns.count()` 的 baseline 决定；Driver 的 `ChatGptTextTurn` 只观察固定 target turn，并提供 `observe()`、严格唯一 Stop 的 `stop()` 和安全 `conversationUrl()`。

Stable Prefix 使用最近 3 个 snapshot 的 longest common prefix，并在普通生成阶段默认把最后 **64 个 Unicode code points** 作为 bounded commit-tail holdback 留在内存。2026-08-26 authenticated combined regression 观测到 Markdown renderer 一次 **38 code-point** 尾部回排，因此当前默认值从 16 提升为 64 并有确定性回归测试。最终 completion 确认后再精确 flush 被保留的完整尾部。已经发送的 prefix 永不撤回；若后续 DOM rewrite 穿过已 committed prefix，仍进入稳定 `chatgpt_stream_diverged`，不发送 correction/backspace。Completion 的主终态仍是 target turn 自身的 `copy-turn-action-button` marker + 连续稳定 final text + final reread；若原 Page 的 action UI 长时间卡住，则只允许使用上述**same-Conversation reload verification**：本轮先观察到生成态 Stop、无非-prose Assistant 状态、同一正文稳定达到阈值，再由临时 verifier Page 对相同 Conversation / target index / exact text / 正式 marker 做二次确认。可能滞留的全局 Stop 不会阻止主 marker，也不会单独证明完成；从未观察到本轮生成态时也不会启动 verifier。

Conversation Engine 在首个 protocol-neutral `started` 后、第一次可能写网页 turn 前持久化 `in_flight`。若客户端在首帧后立即断开，Engine 会在 checkpoint 前检查 AbortSignal；若断开发生在 checkpoint 后但 Send 前，Driver 在 baseline/composer/input/send 异步边界继续检查同一个 signal，保证不继续点击 Send。生成中 abort 会 best-effort Stop、不保存 partial Assistant、保持 `in_flight` 并 discard 当前 Page；下一 keyed request 通过 REBUILD 收敛。Stop click 自身使用与取消流程一致的 bounded timeout，不落回 Playwright 较长的默认 click wait；若严格唯一的 Stop 在检查与点击之间消失，而 owned Assistant turn 已建立 completion marker，则该竞态按 `already_complete` 收敛，避免取消清理被 DOM detach 长时间悬住。

成功流只有在 final Assistant text、安全 Conversation URL 和完整 aggregate 已经原子保存为 clean 后才发送成功 terminal。final save 失败不发送 `[DONE]` / `response.completed`；clean commit 后才发生的 terminal transport close 不回滚已经确定完成的网页 turn。

HTTP 层第一次收到 internal `started` 才通过 Fastify `reply.hijack()` 接管 raw SSE。SSE writer 尊重 Node writable backpressure；pre-start error 保持普通 OpenAI-style 非 200 JSON，post-start error 使用协议内 error framing 且不伪造成功终止。

Chat Completions 与 Responses 使用独立 Encoder，但共享同一 internal stream event。2026-08-17 Phase 5 authenticated real E2E 已在隔离登录 Profile + 显式 LAN proxy 上完成：standalone harness 真实通过长 Chat Completions、Markdown/code、Responses typed lifecycle 与 client abort→Stop→`in_flight`→REBUILD；随后 combined harness 同时通过 Phase 3、Phase 4 与 Phase 5。真实断言要求首个 meaningful delta 早于 target completion marker，并要求最终 `delta concat == authoritative live DOM == SQLite`。

## Tool Calling（工具调用）

Phase 7 function Tool Calling 已重构为 Gateway-owned **external-function request protocol**。2026-08-27 authenticated inspect 已在新的可达 LAN proxy 上恢复；此前真实网页拒绝 caller-defined pseudo-tool 的证据促使 V2 不再要求 ChatGPT 把函数当作网页原生工具。后续 restart Tool Result continuation 先暴露 `tool_choice=none` Prompt 传播缺陷，又在 reduced combined/standalone 复现出更深层 stale-policy 问题：网页 Conversation 会保留上一轮 function-request policy，因此 function policy 变化不能继续复用原 URL。当前候选把 normalized `tool_choice` 纳入 tool-context fingerprint，使 policy 变化通过 `tools_changed` 保守 REBUILD。Fresh live rerun 已观察到 forced-function → none 使用新 Conversation URL 且最终页面产生正确 result；完整 standalone 当前仅因 ChatGPT conversation-history rate limit 暂停。执行链如下：

```text
OpenAI Tool Schema
   ↓
Canonicalize + Fingerprint
   ↓
External-function definitions + request policy
   ↓
ChatGPT emits request records only
   ↓
Tool Detection Buffer
   ↓
Tool Parser
   ↓
OpenAI tool_calls
```

`src/tools/` 保持纯逻辑边界：`canonicalize.ts` 负责 stable tool definitions、tool-context fingerprint 与 tool-choice validation；fingerprint 同时绑定 canonical definitions、private protocol version 与 normalized function policy，任一语义变化都会让旧网页上下文保守 REBUILD。`prompt.ts`/`protocol.ts` 定义固定 `EXTERNAL_FUNCTION_REQUESTS_V1` sentinel/envelope 和 JSON-safe external-function context/policy；`parser.ts` 在 generation 完成后严格解析，不自动修复模型输出；`detection-buffer.ts` 只做 streaming prefix classification，不依赖 API、Playwright、Persistence 或 SQLite。

Canonical Conversation first-class 表达 assistant Tool Call 与 tool-result message。Planner 的 pending turn 可以是 exactly one user 或 one-or-more consecutive tool results；stored/current tool-context fingerprint 不同会保守 `REBUILD(reason='tools_changed')`。这不仅覆盖 schema/protocol 变化，也覆盖 `auto|none|required|function(name)` policy 变化。FRESH/REBUILD Context Prompt v2 在允许 function request 时注入完整 definitions/protocol/history/pending；APPEND/RESTORE 只发生在 policy 未变化时，并只发送当前 `function_policy` + `pending`。`tool_choice=none` 的 Context Prompt 只携带最小禁止策略、不注入 schema/protocol；pending 只有 Tool Result 时要求使用该 result 继续此前 user request，而不是寻找不存在的“final pending user message”。Tool Result 的 function name 从已持久化 `externalCallId` 解析，客户端 output 仅作为 untrusted data field。

严格 Parser 成功后由 Conversation Engine 生成 Gateway-owned `call_<32 hex>` ID，再构造 final aggregate；assistant Tool Call 使用 `messages.role='assistant'` + `tool_calls` table，客户端结果使用 `messages.role='tool'` + `tool_call_id`。最终 clean aggregate 原子保存完成后，route/stream encoder 才允许输出成功 terminal；parser failure 保持 checkpoint `in_flight`，下一次 keyed request 通过 REBUILD 收敛。

存在 tools 时，DOM Stable Prefix 先进入 `ToolDetectionBuffer`。如果前缀仍可能成为 sentinel 就继续缓冲；一旦明确普通文本，立刻 flush 并恢复 Phase 5 true text streaming；一旦确认 TOOL，private marker/payload 全程留在内部直到 generation completed，再 strict parse 并输出协议级 tool-call event。若 TEXT 已开始后又出现 private sentinel，立即 `chatgpt_tool_protocol_invalid`，不得把内部 JSON 泄漏到公共 content。

两套 API 共享 internal `text | tool_calls` execution result/event union。Chat Completions 映射为 `content:null` / `delta.tool_calls` / `finish_reason='tool_calls'`。V0.1.2 的 Responses adapter 继续复用同一个 internal function representation：`namespace` tool 先扁平为内部 `namespace::name`，输出时恢复独立 `namespace/name`；`custom`/freeform tool 映射成一个必填 string `input` 的外部函数，输出时恢复 `custom_tool_call` 与 `response.custom_tool_call_input.*` SSE。`web_search` / `tool_search` 等 OpenAI-hosted server tools 只在 adapter 层兼容接收并过滤，不进入 tool fingerprint/Prompt，也不伪装成 Gateway 可执行能力。`stream/` 自己定义纯 `StreamToolCall` 结构，不反向依赖 `api/`，保持现有可执行架构约束。

## Attachments（附件）

Phase 6 已完成实现与 authenticated real E2E 验收；Governing Spec 见 [`docs/superpowers/specs/2026-08-17-phase-6-attachments-files-design.md`](superpowers/specs/2026-08-17-phase-6-attachments-files-design.md)。当前数据流是：

```text
OpenAI content part / file_id
          ↓
Attachment Resolver
          ↓
URL Download / Base64 Decode / File Lookup
          ↓
Persistent Logical File → content-addressed SHA-256 Blob
          ↓
Canonical multimodal Conversation + Context Planner
          ↓
request-scoped PreparedAttachment staging
          ↓
Playwright setInputFiles
          ↓
等待本请求 owned ChatGPT 附件预览和真实 upload readiness
          ↓
发送 Prompt
```

Phase 6 锁定逻辑 File 与物理 Blob 分离：公开 `/v1/files` 和 inline URL/Data URL/Base64 都最终解析成本地 File；相同 bytes 可以有不同逻辑 File identity，但共享一个 SHA-256 Blob。永久 Blob path 不包含用户 filename，raw URL/Base64 不进入 Attachment persistence。`chatgpt/` 只接收已经准备好的本地 staging path，不下载网络、不解码 Base64、不访问 SQLite。

Context Sync 仍只有 `FRESH | APPEND | RESTORE | REBUILD`：APPEND/RESTORE 只上传当前新增 user turn 附件；FRESH/REBUILD 从本地 File 事实源重新上传当前有效 full context 所需附件。对于没有 system/developer、Tools、Structured Output 等额外语义的单条 user 文本 + 附件请求，附件 bytes 已经通过网页上传，因此 Browser Prompt 直接发送用户文本，不再额外包一层 JSON/context wrapper；只有需要重建历史、保留非普通语义或没有可直发文本时才使用结构化 Context Prompt。第一次 Browser upload side effect 前必须先持久化 `in_flight`；upload/readiness 的未知失败保持 `in_flight` 并 discard Page。stream/non-stream 在 Send 后继续共享 Phase 5 target Assistant / completion / Stable Prefix。

SQLite 保存 File/Blob/Attachment 元数据和引用，大文件字节保存在 `data/files/`。migration 003、Files DELETE retained-history、SSRF/资源限制、upload ownership/readiness 与双协议附件执行链均已实现。2026-08-26 最终 combined Phase 3/4/5/6 real E2E 通过，Phase 6 因而关闭；该验收覆盖 Data URL image、image `file_id`、TXT/PDF/DOCX/XLSX、APPEND/RESTORE 与 attachment Streaming。Remote URL image fetch 的安全链由 deterministic tests 覆盖，本轮没有使用公网 fixture 做 live remote-fetch E2E。

## Structured Output（结构化输出）

Chat Completions `response_format=json_object/json_schema` 与 Responses `text.format=json_object/json_schema` 统一进入 `NormalizedRequest.output.structured`。Gateway 不声称 ChatGPT Web 具有原生 constrained decoding：

1. `src/structured/output.ts` 把约束作为 JSON-safe `structured_output` policy 加入 Context/Append Prompt。
2. `json_schema` 在 Browser execution 前用本地 Ajv compile；无效 schema 直接 `invalid_conversation_request`，不访问 ChatGPT。
3. 最终 Assistant DOM 文本必须是完整 JSON object；`json_schema` 还必须通过同一 schema 的本地 Ajv validation。
4. 最终验证失败返回 `chatgpt_structured_output_invalid`，不会保存 clean success；Streaming 的成功 terminal 仍晚于最终本地校验和 SQLite clean commit。

## 图片生成

Images execution 不进入 Conversation Engine。`POST /v1/images/generations` → `ImageGenerationService` → Page Pool lease → `ChatGptImageDriver` Fresh turn。Driver 只发送最小 `Create an image: <prompt>`；Send 前记录 conversation-turn `img` collection baseline，只检查本请求随后新增的可见、已加载且至少 256×256 的图片元素。图片归属不依赖 `[data-message-author-role="assistant"]` 或文本 turn 的 `copy-turn-action-button`，因为当前 ChatGPT image-only turn 可不挂在该 role 容器下；合格 DOM 节点按 `currentSrc || src` 去重同一生成资源，恰好一个不同图片源即进入 bytes fetch，多个不同图片源稳定拒绝，直到超时仍没有候选才返回 generation timeout。

最终图片 bytes 在 authenticated page/context 边界取回后做 PNG/JPEG/WebP/GIF signature sniff，使用 Gateway UUID 文件名写入 `${DATA_DIR}/generated` 的同目录 temp → rename 原子路径，并插入既有 `generated_images` Repository。读取时重新计算 SHA-256 与 SQLite 记录核对。`response_format=url` 返回 authenticated `GET /v1/images/:id/content`；`b64_json` 返回持久化后的相同 bytes。可选 `PUBLIC_BASE_URL` 只负责 URL base，必须是无 credentials/query/hash 的 `http(s)` base。V1 不做 edits/variations、partial image streaming 或 `n>1`。

## Persistence（持久化）

目标数据目录：

```text
data/
├── gateway.db
├── browser-profile/
├── files/
├── generated/
├── temp/
└── logs/
```

SQLite 保存 Conversation、Message、Tool Call、Attachment、File、Generated Image 等结构化记录。磁盘持久化是恢复事实来源，内存只做运行时缓存。

Phase 2 使用 Node 24 内置 `node:sqlite` 的单 `DatabaseSync` 连接，不引入 ORM 或第三方 SQLite driver。数据库固定 `${DATA_DIR}/gateway.db`，启用 `foreign_keys=ON`、WAL 和 5000ms busy timeout。Schema 通过单向顺序编号 migration 管理，并保存 SHA-256 checksum 防止已执行历史 SQL 被静默改写。

业务实体使用 UUID v4 主键和 Unix 毫秒时间；需要查询/约束的字段关系化，复杂 content/instructions/tools/source 使用 JSON `TEXT`。上层只依赖 Repository / `ConversationStore`，`node:sqlite` 不能泄漏到 `src/persistence/` 外。完整 Conversation aggregate 的保存必须在单个同步事务中完成；事务 helper 会拒绝 async callback。进程关闭并重新打开同一数据库后应能恢复语义一致的结构化状态。

Phase 2 已把 persistence lifecycle 接到生产 Gateway：Fastify listen 前创建/迁移 `${DATA_DIR}/gateway.db`，shutdown 时幂等关闭数据库。Phase 6 进一步把 `${DATA_DIR}/files/blobs` 与 `${DATA_DIR}/temp` 纳入正式容器边界；Phase 8 把 `${DATA_DIR}/generated` 纳入同一非 root writeability smoke。最终 Docker 镜像包含 `migrations/`。当前 migration 仍只有 `001/002/003`，Phase 7–9 不新增 migration。

## Diagnostics 与冷备份

`GET /health` 继续只表示 process liveness。authenticated `GET /v1/diagnostics` 在 operator **显式调用**时由 `src/diagnostics/` 获取一个普通 PagePool lease，访问 `https://chatgpt.com/` 并复用现有 Auth Probe；成功报告 `auth_state=authenticated|auth_required|unknown` 与 bounded `probe.status/page_url/document_state`，同时保留调用前的 Page open/leased/idle 与 SQLite/Files/Generated Images readiness。retained Conversation affinity Page 始终占用 lease，因此 diagnostics 不会导航它；容量已满时直接报告 `capacity_exceeded`，其它探测失败报告 `failed` 并在 `finally` release lease。maintenance mode 没有 Browser runtime 时保持 `auth_state=not_probed` / `probe=null`。该接口不会返回 API Key、Cookie、proxy URL、Profile path、Prompt、Tool argument/result 或内容 bytes。

`scripts/backup-data.mjs` / `restore-data.mjs` 把整个 `${DATA_DIR}` 作为冷备份边界。两者都要求显式 `--gateway-stopped`；backup destination 必须位于 DATA_DIR 外且不存在，并写 `BACKUP_MANIFEST.json`；restore 只接受受支持 manifest 且要求目标 DATA_DIR 为空。Browser Profile 与用户数据会随备份一起复制，因此备份本身按高敏感凭据处理。详细流程见 [`operations.md`](operations.md)。

## API Authentication（接口认证）

`GET /health` 保持无需认证；所有 `/v1/*` 默认要求 `Authorization: Bearer <GATEWAY_API_KEY>`。配置集中在 `src/config/`，业务模块不得分散读取环境变量。缺失 Gateway API Key 时正式服务启动失败。

兼容扩展 `X-Conversation-Key` 可把客户端稳定会话标识传入 `NormalizedRequest.conversationKey`，并且始终优先于匿名匹配。带 key 的请求使用 SQLite Conversation lifecycle、同 key FIFO 与 Page affinity；未提供时 `NormalizedRequest.conversationKey` 仍保持 `undefined`。V0.1.3 仅对完整历史请求做保守匿名续接：若 SQLite 中恰好一个 `conversation_key = NULL` 的 clean Conversation 能被现有 Context Sync planner 严格证明为 APPEND/RESTORE，则复用其 persisted Conversation id / URL，并使用内部匿名 queue key；0 个或多个匹配都创建新的匿名 FRESH Conversation。Gateway 从不把该内部匹配伪装成客户端可见 key。

## 错误边界

内部使用稳定错误类型；API 层映射为 OpenAI 风格错误。不得把 Playwright 原始堆栈、Cookie、API Key、Authorization Header、文件系统敏感路径返回客户端。服务端只允许写经过边界审查的结构化运行诊断和 error cause chain；任何新增 diagnostics 字段都必须保持不含 Prompt/tool/content/Cookie/credential/Profile path。

## 可执行架构约束

`scripts/check-architecture.mjs` 会随着产品源码出现逐步收紧：

- `api/` 不直接导入 `playwright`。
- `context/` 不依赖 `playwright`、`api/` 或 `chatgpt/`。
- `stream/` 不直接导入 `chatgpt/selectors`。
- `persistence/` 不依赖 `playwright`。
- `node:sqlite` 只允许在 `src/persistence/` 中导入；checker 同时识别普通、动态、require 和 side-effect import。
- ChatGPT Selector 只允许定义在 `src/chatgpt/selectors.ts`。
- `browser/` 不依赖 `api/`、`persistence/` 或 `chatgpt/`；`chatgpt/` 不依赖 `api/`、`persistence/` 或 BrowserManager/PagePool 实现。
