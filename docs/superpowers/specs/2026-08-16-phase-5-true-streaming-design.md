# Phase 5 True Streaming Design

**Date:** 2026-08-16
**Status:** Completed; implementation and authenticated real E2E accepted
**Scope:** Phase 5

2026-08-17 final acceptance evidence: fresh DevSpace `corepack pnpm verify` passed 55 test files / 332 tests; fresh `linux/amd64` Docker build produced `sha256:78cf872f42c51e14a0dcb99281087c2a604ec2fc12e9c642ab58ed2474ac84b0` and full `docker:smoke` passed; authenticated `inspect:chatgpt`, standalone Phase 5 real E2E, and combined Phase 3/4/5 real E2E all passed. Phase 5 is closed; attachments, Tools, Structured Output and image execution remain later phases.

## 1. Goal（目标）

Phase 5 在 Phase 4 已完成的 Conversation ownership、Context Sync、Assistant turn ownership、SQLite sync checkpoint 和真实 ChatGPT Web E2E 基础上，交付**真正从 ChatGPT DOM 增量读取并向 OpenAI Compatible Client 实时输出**的文本 Streaming 闭环。

本阶段必须同时满足：

1. `stream=true` 在 ChatGPT 仍生成当前 Assistant turn 时就开始向客户端输出，不允许等待完整回答后再人工切片。
2. DOM polling 采用约 `200ms` cadence，且每次只观察本请求拥有的 Assistant turn。
3. 使用 Stable Prefix（稳定前缀）而不是 `currentText.slice(previousText.length)`，抵抗 Markdown / React DOM 回写造成的文本重排。
4. 已经发给客户端的文本永不撤回、永不重复；最终完成时必须 flush 尚未发送的尾部。
5. Completion（完成）继续以**目标 Assistant turn 自身的 completion marker** 为主要完成证据；2026-08-29 后只增加一个受限 stalled-Page verifier：本轮先真实观察到唯一 Stop，owned turn 无非-prose `.markdown` 状态且同一非空正文持续稳定达到阈值，再用同一 BrowserContext 的临时 Page 重开同一 Conversation；只有 verifier 在同一 target index 读到 exact text + 正式 marker 才确认完成。不能退化成“文本稳定就完成”，也不重新把可能滞留的全局 Stop control 设为主完成条件。
6. Chat Completions SSE 与 Responses SSE 使用不同协议 Encoder，但共享同一套 protocol-neutral internal stream events。
7. Client abort（客户端主动断开）发生在生成尚未完成时，Gateway 必须 best-effort 停止 ChatGPT 当前生成，并保持 SQLite `in_flight`，让下一次同 key 请求通过 Phase 4 REBUILD 收敛，而不是把部分回答伪装成已提交历史。
8. Streaming 成功只有在最终 Assistant 文本、ChatGPT Conversation URL 和 SQLite aggregate 已确认提交后，才发送协议终止成功事件。
9. Phase 4 非流式路径继续保留，并与 Streaming 复用同一 Assistant turn observation / completion 语义，避免两套完成判断漂移。
10. 保持现有模块隔离：`stream/` 不理解 Playwright、Selector、Fastify、SQLite 或 OpenAI SSE 细节。

Phase 5 完成后，项目将拥有可被后续附件与 Tool Calling 复用的“网页增量文本 → 稳定内部 Delta → 协议 Streaming”基础，而 Phase 6/7 只需要扩展输入和输出语义，不再重新解决基础文本流问题。

## 2. Current Foundation（当前基础）

Phase 5 不是重新设计 Conversation 或 Browser 生命周期。以下 Phase 4 事实直接作为前提：

- `X-Conversation-Key` 对应稳定本地 Conversation identity。
- same-key FIFO 串行，different-key 可并行。
- Page affinity / idle timeout / LRU eviction 已完成。
- SQLite `clean | in_flight` checkpoint 是恢复事实来源。
- 第一个可能写 ChatGPT turn 的动作前必须先持久化 `in_flight`。
- 成功后一次 `ConversationStore.save()` 原子保存 authoritative messages、Assistant、Conversation URL 和 clean checkpoint。
- post-checkpoint 未知失败不猜网页副作用，保持 `in_flight`，下一请求 REBUILD。
- Driver 已使用 Assistant baseline 锁定本请求新 Assistant turn。
- 当前真实 DOM 已证明全局 `stop-button` 可能在回答文本稳定后继续滞留，因此目标 Assistant turn 的 `copy-turn-action-button` completion marker 仍是主完成边界。2026-08-29 reduced combined 又证明原 Page 的 action completion UI 也可能在 240 秒窗口内一直不挂载，而之后重开同一服务器 Conversation 时完整正文和 action UI 已存在。Driver 因此不再从 Stop 消失猜 completion；只有同一 request 已经亲眼见过唯一 Stop、没有非-prose Assistant 状态且同一正文持续稳定后，才允许临时 verifier Page 重开**同一个** Conversation，并要求同一 target index / exact text / formal marker 三者同时成立。
- 当前非流式 `sendText()` 最终返回完整 Assistant text + safe ChatGPT Conversation URL。

Phase 5 只在这些已验证边界上增加 Streaming，不重新定义 FRESH / APPEND / RESTORE / REBUILD。

## 3. Non-Goals（本阶段明确不做）

Phase 5 不实现：

- 图片 URL / Base64 图片输入。
- 文件上传、`/v1/files` 生命周期或附件 readiness。
- Tool Calling Prompt / Detection / Parser / Tool Result 闭环。
- Streaming tool calls。
- Structured Output execution 或增量 JSON validation。
- ChatGPT 图片生成或 partial image streaming。
- Reasoning / thinking 内容暴露为公共协议字段。
- OpenAI `stream_options`；当前请求 Schema 没有该字段，本阶段不为了 usage 扩大协议面。
- Token usage 估算或伪造。
- 多 choice / `n>1` Streaming。
- 多 Gateway 进程共享一个 Conversation queue / Browser Profile。
- SSE 自动重连、`Last-Event-ID` 或断点续传。
- 对已经发给客户端的文本做 correction / backspace / retract。
- 把 DOM HTML、Markdown AST 或 React internal state 作为 Streaming 数据源。
- 私有 ChatGPT `/backend-api`、WebSocket 或网络拦截路径。
- 为 Streaming 新增数据库 migration。
- 为 polling cadence 暴露新的生产环境变量；本阶段先使用内部稳定默认值。

Phase 5 仍是**纯文本执行阶段**。附件、Tools、Structured Output 和 image execution 不得因为 Streaming 基础存在而被误报为已支持。

## 4. Locked Product Semantics（锁定产品语义）

本规格锁定以下行为：

1. **真 Streaming 必须以 DOM 增量为来源。** “生成结束后按字符/词切片”属于伪流式，明确不接受。
2. **Stable Prefix 是唯一允许提交给客户端的文本。** 未稳定尾部只存在于内存 snapshot window，不提前发出。
3. **已提交 prefix 不允许回退。** 如果后续 DOM snapshot 不再以已提交文本为前缀，立即进入稳定的 stream divergence failure；不能向客户端发送“修正字符”。
4. **最终 completion snapshot 可以强制 flush 未稳定尾部。** completion marker 已出现且最终文本通过稳定确认后，不再要求尾部额外等待普通 Stable Prefix window。
5. **全局 Stop control 不再是主完成必要条件。** 正常成功仍由 completion marker + final stable text 决定；只有原 Page marker 长时间未挂载时，Driver 才在“本轮曾观察到唯一 Stop + 无非-prose Assistant 状态 + 同一非空正文持续稳定”后启动 same-Conversation verifier。verifier 必须在同一 target index 得到 exact text + 正式 marker；Stop 消失、Stop 仍存在或仅仅正文稳定都不直接决定成功。
6. **Client abort 在 completion 之前发生时，不保存 partial Assistant。** checkpoint 保持 `in_flight`，Page binding 失败释放，下一同 key 请求 REBUILD。
7. **Client abort 在 completion 已经被确认之后发生时，不回滚已完成网页 turn。** Engine 继续 best-effort 完成 SQLite final save；只是客户端不再收到剩余 protocol frames。
8. **SSE 成功终止必须晚于 SQLite clean commit。** 客户端收到 `[DONE]` 或 `response.completed` 时，本地持久化已经是 clean authoritative state。
9. **最终文本是单一事实。** `concat(all text deltas)`、final DOM text、SQLite Assistant text 和 terminal protocol object 中的完整文本必须完全一致。
10. **non-stream 与 stream 使用同一 Assistant observation / completion semantics。** 不能让 `stream=false` 和 `stream=true` 对同一个 DOM turn 得出不同的“完成”结论。
11. **same-key queue 在整个 Streaming 生命周期内保持占用。** 不能在 HTTP headers 写出后提前释放 queue，让下一请求并发写同一 ChatGPT Conversation。
12. **慢客户端必须产生 backpressure，而不是无上限排队 Delta。** Streaming 不维护无限 event buffer。
13. **公开协议不泄漏内部 DOM 状态。** Stable Prefix sample count、completion marker、Stop control、Page URL 等只作为内部执行事实。

## 5. Considered Approaches（方案比较）

### 5.1 方案 A：纯 Streaming Core + ChatGPT Turn Observer + Conversation 编排 + 双 SSE Encoder

结构：

```text
ChatGPT target Assistant turn
          │
          ▼
   ChatGPT Turn Observer
          │ AssistantSnapshot
          ▼
      stream/ core
  ┌───────┼─────────┐
  │ Stable Prefix   │
  │ Completion      │
  │ Delta lifecycle │
  └───────┬─────────┘
          │ TextStreamEvent
          ▼
 Conversation Engine
   checkpoint / save
          │
          ▼
       API sink
   ┌──────┴────────┐
   ▼               ▼
Chat Completion   Responses
SSE Encoder       SSE Encoder
```

优点：

- 与现有架构边界一致。
- Stable Prefix 可纯单元测试，不需要浏览器。
- DOM Selector 仍集中在 `chatgpt/`。
- Conversation Engine 继续拥有 checkpoint / queue / Page lease。
- 两套 API 协议只负责 framing，不复制 DOM polling。
- Client abort 可以从 HTTP AbortSignal 一直传到当前 ChatGPT turn。

缺点：

- 需要把当前单体 `sendText()` 拆出可观察的 Assistant turn handle。
- API route 要增加 SSE low-level lifecycle。

**选择此方案。**

### 5.2 方案 B：Driver 直接返回 SSE / 直接写 HTTP

优点：代码路径短。

拒绝原因：

- `chatgpt/` 会依赖 API / Fastify / OpenAI framing。
- Conversation Engine 很难保持 queue 和 checkpoint ownership。
- Chat Completions / Responses 协议逻辑会污染 DOM Driver。
- 后续 Tool Calling /附件扩展会继续放大耦合。

### 5.3 方案 C：两个 HTTP route 各自 polling DOM

优点：路由看起来可以独立完成协议。

拒绝原因：

- 直接违反 API Adapter 不实现浏览器逻辑的既有架构。
- 会产生两套 Stable Prefix / completion / abort 实现。
- Selector 与 Page ownership 很快漂移。

### 5.4 方案 D：等待完整回答，再切片为 SSE

实现最简单，但它不是 Phase 5 的“真 Streaming”，直接拒绝。

## 6. High-Level Architecture（总体架构）

推荐数据流：

```text
OpenAI Compatible Client
          │
          ▼
 Chat Completions / Responses Route
          │
          ▼
      Normalizer
          │
          ▼
   NormalizedRequest
          │
          ▼
 Conversation Engine
  ┌───────┼───────────────┐
  ▼       ▼               ▼
Queue   Context         Conversation
        Planner         Store
  └───────┬───────────────┘
          ▼
 Conversation Page Registry
          │
          ▼
      ChatGPT Driver
          │
          ▼
  Assistant Turn Handle
          │ observe()
          ▼
   AssistantSnapshot
          │
          ▼
     stream/ core
          │ TextStreamEvent
          ▼
 protocol-neutral sink
   ┌──────┴────────┐
   ▼               ▼
Chat Completions  Responses
SSE Encoder       SSE Encoder
```

推荐目录：

```text
src/
├── stream/
│   ├── types.ts
│   ├── normalize.ts
│   ├── stable-prefix.ts
│   ├── completion.ts
│   └── text-stream.ts
├── chatgpt/
│   ├── driver.ts
│   ├── completion.ts          # 可收敛/复用 stream completion primitive
│   ├── selectors.ts
│   └── ...
├── conversations/
│   ├── conversation-engine.ts
│   └── ...
└── api/
    ├── encode/
    │   ├── chat-completions-stream.ts
    │   └── responses-stream.ts
    ├── sse.ts
    └── routes/
        ├── chat-completions.ts
        └── responses.ts
```

文件名允许在 implementation plan 中按实际代码最小调整，但模块 ownership 不变。

## 7. Phase 5 Capability Gate（能力边界）

Phase 5 继续只执行纯文本请求。

### 7.1 `stream=false`

保持 Phase 4 已验证行为：

- 文本输出。
- 无附件。
- 无 Tools。
- `toolChoice.mode === 'auto'`。
- 无 Structured Output execution。
- trailing user turn 有效。
- FRESH / APPEND / RESTORE / REBUILD 全部继续支持。

### 7.2 `stream=true`

与上面完全相同，唯一新增能力是：

```text
output.mode === 'text'
output.stream === true
```

不因为 `stream=true` 改变 Context Sync 语义。

### 7.3 仍拒绝

以下在 Phase 5 仍返回 capability error：

- `attachments.length > 0`
- `tools.length > 0`
- 非默认 Tool Choice
- `output.structured !== undefined`
- `output.mode === 'image'`
- non-text message part
- tool message / tool-call execution history

建议 Phase 5 将临时公共 capability code 更新为：

```text
unsupported_phase5_request
```

不为 Streaming 单独新增另一个 capability code。

## 8. ChatGPT Turn Ownership（Assistant Turn 归属）

Phase 5 必须复用 Phase 3/4 已验证的 baseline ownership：

```text
发送前 assistantTurns.count() = baseline
        ↓
click Send
        ↓
等待 assistantTurns.count() > baseline
        ↓
目标 turn = assistantTurns.nth(baseline)
```

整个 Streaming 生命周期只允许读取这个 target turn。

2026-08-17 authenticated real E2E 发现，Fresh/REBUILD 首次发送后 ChatGPT 会先进入 provisional `/c/WEB:<uuid>` bootstrap route，并在该阶段短暂暴露一个 Assistant collection 节点；随后切换到正式 `/c/<uuid>` route 时，同一 collection index 的内容会被替换为真正回答。这个 provisional 节点**不是 authoritative Assistant target**，不得进入 Stable Prefix 或向客户端输出。对于从无安全 Conversation URL 的 Fresh 页面开始的 `startText()`，`observe()` 必须在正式可恢复 Conversation URL 建立前继续返回 missing snapshot；一旦正式 URL 建立，仍按发送前 baseline index 锁定该请求的 target turn。APPEND/RESTORE 已从正式 Conversation URL 开始，不受该 route gate 影响。

同一轮 authenticated APPEND real E2E 还确认：即使 URL 已经是正式 `/c/<uuid>`，ChatGPT 仍可能先在新 Assistant index 挂载一个约 8 code points 的临时 placeholder；该节点没有 authoritative prose content，随后会被卸载，再由真正回答重新占用该 target index。Phase 5 纯文本 authoritative snapshot 因此必须同时满足：**owned Assistant turn index 存在，且该 turn 内唯一 `.markdown.prose` 正文节点存在**。只有 placeholder、正文节点 count=0 时 `observe()` 继续返回 missing；authoritative prose 正文节点 count>1 视为 selector ambiguity。输出文本读取该正文节点的 `innerText()`，completion marker 仍从 owned Assistant turn 的 ancestor action 区判断。

2026-08-28 final-candidate combined Phase 3→8 又确认一个网页状态边界：网络短暂中断时，同一个 owned Assistant turn 可以在真正 `.markdown.prose` 回答旁额外挂载非 prose `.markdown` 状态块，文本为 `Connection interrupted. Waiting for the complete answer`。这个状态节点属于网页传输/生成状态，不是 Assistant authoritative content；正文 selector 必须排除它，但多个 `.markdown.prose` 仍保持严格 ambiguity，避免通过 `.first()` 截断 writing-block/editor 等结构化输出。

禁止：

- 每轮 polling 读取“页面最后一个 Assistant”。
- 用 `.last()` 猜当前 turn。
- 因为页面出现其他历史 turn 就切换 target。
- 通过文本内容匹配猜 ownership。

目标 turn 一旦出现后又消失，属于 DOM consistency failure，不能静默切换到另一个节点。

## 9. Driver Contract（Driver 接口）

当前 `sendText()` 同时负责 submit + wait full completion。Phase 5 需要增加一个可观察的 turn handle，但不能把 SSE 逻辑塞进 Driver。

推荐接口：

```ts
export interface AssistantSnapshot {
  exists: boolean;
  text: string;
  completionMarkerPresent: boolean;
}

export interface ChatGptTextTurn {
  observe(): Promise<AssistantSnapshot>;
  stop(): Promise<'stopped' | 'already_complete'>;
  conversationUrl(): Promise<string>;
}

export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;

  openConversation(
    page: Page,
    conversationUrl: string,
  ): Promise<'restored' | 'not_restorable'>;

  startText(
    page: Page,
    request: ChatGptTextRequest,
  ): Promise<ChatGptTextTurn>;

  sendText(
    page: Page,
    request: ChatGptTextRequest,
  ): Promise<ChatGptTextResult>;
}
```

### 9.1 `startText()`

只做：

```text
capture Assistant baseline
→ resolve unique composer
→ focus composer
→ enter single-line prompt with keyboard text input OR multiline prompt as one text/plain ProseMirror paste transaction
→ acknowledge exact known conversation-history rate-limit notification if uniquely visible
→ resolve unique send button
→ click Send
→ return handle bound to baseline index
```

它不等待完整回答。

2026-08-28 V1 abort→REBUILD 调试补充了输入边界：`Locator.fill()` 可让多段文本完整显示在 Composer DOM，却在 Send 后只形成第一段 Web user turn；整段 `keyboard.insertText()` 在普通 Fresh Page 可行，但在 PagePool replacement-before-close 产生的新 Page 上同样只保留第一段。无发送 replacement DOM probe 证明同一 ProseMirror 节点并未 remount，问题是 multiline `insertText` 事务本身；对 multiline 分发 `text/plain` paste 事件后，完整段落结构与 Send readiness 均出现。因此当前设计把单行与多行输入路径分开，不通过直接改 `innerHTML` 或绕过 ProseMirror 状态提交文本。

2026-08-17 authenticated real E2E 在重复多轮验收后观察到 ChatGPT 会挂载 `data-testid="modal-conversation-history-rate-limit"` 通知层，唯一按钮为 `Got it`。隔离 Profile 实验确认：第一轮请求正常完成后该通知出现；点击 `Got it` 只关闭 overlay，同一正式 Conversation URL 上第二轮请求仍可立即正常完成，说明它不是 CAPTCHA/MFA/人机验证，也不是服务端拒绝本次 Send。Driver 因此只允许在 **该精确 testid 唯一、可见，且其内部 `Got it` 按钮唯一** 时确认通知，然后再执行普通 Send；不匹配其它 modal，不 force-click，不自动处理任何登录、MFA 或 challenge UI。modal 或按钮 ambiguity 继续返回稳定 selector error。

### 9.2 `observe()`

只读取当前 target turn：

- `exists`
- 当前可见 `innerText()`
- target turn ancestor 下 `copy-turn-action-button` completion marker 是否存在

Selector ambiguity 继续返回稳定 Driver error。

`observe()` 不执行 Stable Prefix，不生成 SSE event，不读取 SQLite。

### 9.3 `conversationUrl()`

只在需要 final result 时调用。

必须继续走 Phase 4 safe URL validation：

- `https:`
- hostname 严格 `chatgpt.com`
- non-root Conversation pathname
- provisional `/c/WEB:*` bootstrap pathname 必须拒绝；它不是可恢复的 authoritative Conversation identity

不允许把任意当前 URL 原样持久化。

### 9.4 `sendText()`

保留给 non-stream 路径，但内部改为：

```text
startText()
→ common completion observation
→ final URL
→ return full result
```

这样 Streaming 和 non-stream 共享 target ownership / completion semantics。

## 10. Stop Generation Contract（停止生成）

`ChatGptTextTurn.stop()` 只用于取消当前 handle 拥有的生成。

顺序：

```text
observe target
  │
  ├─ completion marker already present → already_complete
  │
  └─ still generating
       ↓
   resolve unique Stop control
       ↓
     click once
       ↓
 bounded wait for target to reach terminal DOM state
       ↓
      stopped
```

规则：

- Stop selector 仍必须走 Selector Registry unique semantics。
- ambiguous Stop control 不允许 `.first()` 点击。
- 已经 click Send 但 target Assistant turn 还没挂载时，`stop()` 仍允许通过严格唯一的 Stop control 取消本轮生成；“target 尚未出现”不能被误判为“无需停止”。
- `stop()` 不负责持久化 partial Assistant。
- Abort cleanup 的 stop failure 记录受控诊断，但客户端通常已经断开，不再尝试写 HTTP error。
- stop timeout 不能导致无限 shutdown；实现使用内部 bounded timeout，而且这个预算必须覆盖 Stop `locator.click()` 本身，不能让 Playwright 较长的默认 click timeout 绕过取消上限。
- Stop 在 inspect 时严格唯一、但在实际 click 前因本轮自然完成而 detach 时，重新观察 owned target；若 completion marker 已建立则收敛为 `already_complete`，不把 DOM race 误报为取消失败。
- Stop control 的**存在**不再参与成功 completion 的必要条件，因为 Phase 4 real E2E 已证明它可能滞留。

## 11. Assistant Snapshot（Assistant 快照）

`AssistantSnapshot` 是 `chatgpt/` 与 `stream/` 的边界。

最小结构：

```ts
interface AssistantSnapshot {
  exists: boolean;
  text: string;
  completionMarkerPresent: boolean;
}
```

为什么不把这些字段放进去：

- Playwright `Locator`
- selector name
- raw HTML
- Page URL
- Stop button locator/status
- thinking DOM node
- Fastify request

因为 Stable Prefix 和 Completion 算法应该能用固定 fixture 独立测试。

### 11.1 Missing target

发送后 target 尚未出现：

```ts
{ exists: false, text: '', completionMarkerPresent: false }
```

一旦曾经观察到 `exists=true`，后续又变回 `false`，不能当成“继续等待新的 turn”；这是 target ownership 被破坏，进入 `chatgpt_stream_diverged`。

## 12. Snapshot Normalization（快照规范化）

Stable Prefix 比较的是**最终会向客户端输出的纯文本表示**，不是 DOM HTML。

Phase 5 normalization 只做确定性且低风险的处理：

```text
CRLF / CR → LF
```

明确不做：

- `.trim()` 作为输出文本变换。
- collapse whitespace。
- Markdown parse / re-render。
- HTML parse。
- Unicode normalization（NFC/NFKC）。
- 删除代码块空格。
- 删除尾部换行。

空回答判断可以使用 `text.trim().length > 0`，但真正输出和持久化必须保留 normalized text 本身。

## 13. Stable Prefix（稳定前缀）

### 13.1 Why naive slicing fails

禁止：

```ts
const delta = currentText.slice(previousText.length);
```

示例：

```text
snapshot 1: "**hel"
snapshot 2: "hello"
```

如果 DOM/Markdown rendering 重排，第二次 snapshot 可能不再以第一次 snapshot 为前缀。直接按旧长度 slice 会丢字或重复。

### 13.2 Window

默认：

```text
poll interval        = 200ms
stable samples       = 3
commit tail holdback = 64 Unicode code points
```

保留最近最多 3 个**已存在 target turn**的 normalized text snapshot。

2026-08-17 authenticated real E2E 证明，正式 `/c/<uuid>` route 上的 Markdown renderer 会在生成期间短距离回排当前尾部；2026-08-26 最终 Phase 6 combined regression 又观测到一次 **38 code-point** 的尾部回排。由于已经写入 SSE 的字节不能撤回，3-sample window 之外还需要一个 **bounded commit tail holdback**：普通生成 snapshot 的 Stable Prefix 最后 **64 个 Unicode code points** 只保留在内存，不提前承诺给客户端；Completion Detector 最终确认后再精确 flush。64 是对已观测 38-code-point 回排留下余量的当前默认值。这个 guard 不 trim、不改写、不丢弃字符，只延迟尾部提交；如果 rewrite 穿过已经 committed 的 guard 之外前缀，仍然必须 `chatgpt_stream_diverged`。

例如：

```text
S1 = "Hello"
S2 = "Hello wo"
S3 = "Hello world"
```

三者 longest common prefix：

```text
"Hello"
```

只有这个 prefix 可以提交。

### 13.3 Longest Common Prefix

算法输入是 bounded snapshot window：

```ts
stable = longestCommonPrefix(window)
```

LCP 必须按 Unicode code point 安全推进，不能在 surrogate pair 中间切断字符串。

本阶段不需要 grapheme cluster library；SSE chunk 边界可以位于组合字符之间，但每个 delta 至少必须保持合法 JS / UTF-8 字符串，不产生半个 surrogate。

### 13.4 Emitted Prefix

状态：

```ts
interface StablePrefixState {
  emitted: string;
  samples: string[];
  holdbackCodePoints: number;
}
```

每次普通 polling：

```text
normalize current
→ verify current startsWith(emitted)
→ push bounded sample
→ stable = LCP(samples)
→ verify stable startsWith(emitted)
→ committable = stable 去掉最后 holdbackCodePoints 个 code points
→ 如果 committable 比 emitted 更长，则只 emit committable.slice(emitted.length)
→ 如果 committable 因尾部回排而暂时比 emitted 更短，但 stable 仍 startsWith(emitted)，保持 emitted 不变
```

Completion Detector 最终确认后的 `flushStablePrefix()` 不应用 holdback，直接把 authoritative final text 中尚未发送的完整尾部一次性发出。

### 13.5 No Retraction

如果：

```text
current does NOT startWith(emitted)
```

说明 ChatGPT DOM 已经重写了 Gateway 之前承诺给客户端的内容。

Gateway 必须：

```text
throw chatgpt_stream_diverged
→ no success terminator
→ current checkpoint stays in_flight
→ current Page binding fails/discards
→ next keyed request REBUILD
```

禁止：

- 发 backspace。
- 发 correction event。
- 发负 delta。
- 静默覆盖客户端旧文本。

### 13.6 Why bounded window

只保留最后 3 个完整 string snapshot：

- 内存有明确上界 `O(stableSamples × currentTextLength)`。
- 不保留无限历史。
- 测试容易确定。
- 3 个 sample 在 200ms cadence 下仍然能在回答生成过程中持续产生可见增量。

Phase 5 不引入复杂 diff 库。

## 14. Completion Detector（完成检测）

### 14.1 Primary finality signal

当前真实 ChatGPT DOM 下：

```text
target Assistant turn completion marker present
```

仍是主要完成信号。全局 Stop 的**存在**不是主 marker 成功的必要条件，因为它可能在答案已经完成后滞留。

2026-08-29 后增加一个只处理 stalled original Page 的 bounded verifier。它不是简单的：

```text
global Stop button disappeared
```

而必须先在**同一 request** 观察到唯一 Stop，证明该 turn 确实处于生成态；owned Assistant turn 没有非-prose `.markdown` 状态块，并且同一非空 authoritative text 持续稳定至少 5 秒。之后才允许同一 BrowserContext 创建临时 verifier Page、重开相同 Conversation URL；verifier 必须在同一 target index 看到唯一 authoritative prose、exact text 和唯一正式 completion marker。Stop 从未出现、正文仍变化、存在 `Connection interrupted...` 一类状态、verifier 文本不同或 verifier marker 缺失时都保持未完成。verifier 不输入、不 Send，用完立即关闭，因此不会新建 ChatGPT Conversation。

### 14.2 Completion requirements

Streaming 完成必须同时满足：

1. target turn 已经出现，且 authoritative `.markdown.prose` 唯一。
2. completion evidence 成立：target turn completion marker 存在且 unique；**或**上述 same-Conversation verifier 已对同一 target index 的 exact text + unique formal marker 完成确认。
3. normalized text 非空。
4. completion evidence 成立后，最终文本连续 `3` 次 stream sample 完全一致。
5. 再做一次 final observation；completion evidence 仍成立且文本仍完全一致。

最终确认后得到：

```ts
interface CompletedAssistant {
  text: string;
}
```

### 14.3 Timeout

当前 generation timeout baseline：

```text
240s
```

- timeout 前从未看到 target → `chatgpt_response_missing`
- target 出现但一直无法完成 → `chatgpt_generation_timeout`

如果后续真实 E2E 证明 120s 不足，再独立设计配置；Phase 5 不提前扩张环境变量。

### 14.4 Final tail flush

普通 Streaming 可能只提交到：

```text
emitted = "Hello wor"
```

最终完成文本：

```text
final = "Hello world!"
```

Completion 确认后：

```text
verify final startsWith(emitted)
→ tail = final.slice(emitted.length)
→ emit tail if non-empty
```

不要求最终 tail 再经过普通 3-sample Stable Prefix window，因为 Completion Detector 本身已经完成更强的 final stable confirmation。

如果 final 不以 emitted 开头，同样是 `chatgpt_stream_diverged`。

## 15. Protocol-Neutral Internal Events（内部流事件）

Phase 5 使用最小事件集合：

```ts
export type TextStreamEvent =
  | {
      type: 'started';
      startedAt: number;
    }
  | {
      type: 'text.delta';
      delta: string;
    }
  | {
      type: 'completed';
      result: TextExecutionResult;
    };
```

其中：

```ts
interface TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}
```

### 15.1 Why only three event kinds

Phase 5 只流文本，不需要提前设计 Tool / Image / Reasoning event universe。

未来 Phase 7 可以扩展 union，但现在 YAGNI。

### 15.2 Event guarantees

- `started` 恰好一次。
- `text.delta` 可以 0..N 次，但成功文本最终必须非空。
- 每个 `delta` 非空。
- 所有 delta 连接后始终是当前 committed prefix。
- 客户端连接持续可写到 terminal 时，`completed` 恰好一次，且必须是最后一个内部事件。
- 对成功且客户端连接持续可写到 terminal 的 stream，`completed.result.text === concat(all delta)`。
- completion 已确认后 transport 才关闭时，Engine 可以跳过无法投递的 `completed` sink event，但仍返回最终 `TextExecutionResult` 并完成 authoritative persistence。
- error 不包装成一个 fake `completed` event；由执行 promise reject。

## 16. Streaming Sink（协议无关输出边界）

Conversation Engine 不应该返回一个需要自行维护 same-key queue 生命周期的裸 AsyncIterable；也不应该直接知道 Fastify。

推荐：

```ts
export type TextStreamSink = (event: TextStreamEvent) => Promise<void>;

export interface StreamingExecutionOptions {
  signal: AbortSignal;
  sink: TextStreamSink;
}

export type NormalizedStreamingExecutionHandler = (
  request: NormalizedRequest,
  options: StreamingExecutionOptions,
) => Promise<TextExecutionResult>;
```

语义：

- Engine 的单个 `Promise` 覆盖 queue → Page → web generation → persistence → terminal event 整个生命周期。
- `await sink(event)` 自然形成 backpressure。
- API sink 只负责 protocol framing / socket write，并在 transport 提前关闭时触发 `AbortSignal`。
- Engine 只看 `AbortSignal` 和 sink write 结果，不知道 Node socket。
- completion 建立前的 sink/transport failure 属于 cancellation/failure；completion 建立后的 transport close 只停止协议投递，不阻止 final persistence。

## 17. Stream Start Boundary（流开始边界）

一个重要边界是：什么时候 HTTP 仍可以返回普通 JSON error，什么时候已经进入 SSE。

推荐顺序：

```text
queue / load SQLite / canonicalize / plan
→ acquire Page
→ openFresh/openConversation
→ auth + composer readiness
→ sink({ type: 'started' })
→ mark/create SQLite in_flight
→ startText() / web submit
→ DOM polling / deltas
```

### 17.1 Before `started`

这些失败仍可由 Fastify global error mapper 返回普通 OpenAI-style HTTP error：

- invalid request
- auth_required
- page_capacity_exceeded
- selector failure during readiness
- restore / browser navigation failure

因为 API sink 尚未写 SSE headers。

### 17.2 After `started`

HTTP 200 + SSE 已开始；后续 failure 不能再改 HTTP status。

API 层必须：

- 写 protocol-appropriate stream error event（如果 socket 仍可写）。
- 不写 success terminator。
- 关闭响应。

### 17.3 Why `started` before `in_flight`

如果客户端在第一帧写出时已经断开：

- sink 失败。
- Gateway 还没有 mark `in_flight`。
- 也还没有 ChatGPT web side effect。

这使“无法建立 SSE”仍然是无副作用失败。

一旦 `started` 成功，后续先 mark `in_flight` 再执行 web submit，继续满足 Phase 4 crash consistency。

## 18. Streaming Execution Flow（执行流）

Keyed request：

```text
queue.run(conversationKey)
        ↓
load latest aggregate
        ↓
validate + canonicalize
        ↓
plan FRESH | APPEND | RESTORE | REBUILD
        ↓
acquire/reuse Conversation Page
        ↓
prepare Fresh / restored Page
        ↓
stream.started → API opens SSE
        ↓
mark/create in_flight
        ↓
startText(prompt)
        ↓
repeat ~200ms:
  observe target Assistant
  → normalize Snapshot
  → Stable Prefix
  → emit text.delta
  → Completion Detector
        ↓
Completion confirmed
        ↓
mark completionEstablished=true
        ↓
try flush final tail as text.delta
  └─ transport already closed? record transport closed, continue finalization
        ↓
read safe Conversation URL
        ↓
build final aggregate
        ↓
ConversationStore.save(clean)
        ↓
session.complete()
        ↓
transport still writable ? emit completed(result) : skip protocol terminal
        ↓
API writes protocol success terminator only if completed event was delivered
        ↓
queue work resolves
```

Unkeyed request 使用同一流程，但成功后不建立长期 affinity，保持 Phase 4 transient semantics。

## 19. Persistence and Crash Consistency（持久化与崩溃一致性）

Phase 5 **不新增数据库字段**。

### 19.1 No partial persistence

Streaming 中间只存在于内存：

```text
DOM snapshots
Stable Prefix window
emitted prefix
protocol deltas
```

SQLite 不保存：

- 每个 delta。
- partial Assistant。
- snapshot window。
- SSE sequence number。
- HTTP connection state。

### 19.2 Success commit

只有 Completion confirmed 后，才一次性构造与 Phase 4 相同的 final aggregate：

```text
authoritative request history
+ current user
+ final Assistant text
+ safe ChatGPT Conversation URL
+ sync.status=clean
+ syncedMessageCount=messages.length
```

并通过 `ConversationStore.save()` 单事务保存。

### 19.3 Terminal ordering

对于**客户端连接仍然可写的成功 stream**，必须：

```text
completion established
→ final tail delta
→ SQLite clean save
→ Page session complete
→ internal completed
→ protocol terminal success
```

为什么 final tail 可以早于 DB save：

- 它仍然只是增量内容，不代表请求终态成功。
- 如果 DB save 随后失败，stream 不会收到 `[DONE]` / `response.completed`。
- checkpoint 仍为 `in_flight`，下一请求 REBUILD。

如果 completion 已经确认后客户端才断开，final tail write 可能失败；这个 transport failure **不得阻止** safe URL 读取和 final SQLite clean save。此时不再有 protocol terminal success，但本地仍保存已经确定完成的 ChatGPT turn。

### 19.4 Failure after checkpoint

在**completion 尚未建立**时，任何 post-checkpoint error：

- 不写 synthetic Assistant。
- 不保存 partial text。
- 保持 `in_flight`。
- `session.fail()`，不保留未知 Page affinity。
- keyed next request REBUILD。

completion 已经确认后，网页副作用不再未知：Gateway 已拥有确定的 final Assistant text。此后如果只是 client transport close，按 20.4 继续 final clean save；如果 safe URL / final aggregate / SQLite save 自身失败，则请求仍不能形成 clean success，并按真实 persistence/runtime failure 处理。

这与 Phase 4“不对未知网页副作用猜 rollback”的原则一致，同时避免把已确定完成的网页 turn 因晚到 socket close 人为降级成 unknown。

## 20. Client Abort（客户端断开）

### 20.1 HTTP detection

API route 创建一个 `AbortController`。

对于已 hijack 的 Node response：

```text
reply.raw close
AND response not writableFinished
        ↓
controller.abort()
```

同时 socket/write error 也必须 abort。

正常 `end()` 导致的 close 不得误判成 client abort。

### 20.2 Abort timing matrix

Abort 必须按是否已经发生 web side effect 处理：

| Abort moment | Web side effect | Checkpoint | Action |
|---|---|---|---|
| `started` 之前 | 无 | 保持原状态 | 普通取消，不调用 Stop |
| `started` 后、`in_flight` 前 | 无 | 保持原状态 | 结束 stream，不调用 Stop |
| `in_flight` 后、Send click 前 | 尚未提交 turn | 保持 `in_flight` | 不猜 rollback；无 turn 可 Stop，下一 key REBUILD |
| Send click 后、completion 前 | 可能/已经生成 | 保持 `in_flight` | best-effort `turn.stop()`，不保存 partial Assistant |
| completion confirmed 后 | 已完成 | 最终保存 clean | 不 Stop，不回滚；继续 authoritative finalization |

### 20.3 Before Assistant completion

如果 Send 已经发生、`signal.aborted` 且 completion 尚未建立：

```text
best-effort turn.stop()
→ do NOT save partial Assistant
→ keep checkpoint in_flight
→ session.fail()
→ release/discard current binding
→ queue work ends as cancelled internal outcome
```

如果 abort 发生在 Send 之前，则不调用 `turn.stop()`；是否保留 `in_flight` 只取决于 checkpoint 是否已经写入，继续遵循 Phase 4“不猜 rollback”原则。

客户端已经断开，所以不需要公共 `client_aborted` HTTP error body。

### 20.4 After Assistant completion

如果 completion 已经确认，而 socket 随后断开：

- 不尝试“撤销”ChatGPT 已完成 turn。
- final tail write 失败只标记 transport closed，不中断 authoritative finalization。
- 继续 best-effort 完成 safe URL + final SQLite save。
- Page 按正常成功语义 complete。
- 不再尝试向已关闭 socket写 `completed` / terminal frames。

客户端后续若带旧 authoritative history 再请求，Phase 4 Context Planner 会按现有规则决定 APPEND/REBUILD；Gateway 不伪造客户端已收到内容。

### 20.5 Abort and queue ownership

same-key queue 必须等 cancel cleanup 完成后再让下一个请求执行。

不能：

```text
socket close
→ immediately release queue
→ stop() still running in background
```

否则下一请求可能与上一轮 Stop click 同时操作同一 Conversation。

## 21. Backpressure（反压）

API sink 每次写 SSE frame 都必须等待 Node writable backpressure：

```text
reply.raw.write(frame)
  │
  ├─ true  → continue
  │
  └─ false → await 'drain' OR abort/close
```

因此 DOM polling loop 不是 `setInterval()` 并发触发，而是：

```text
observe
→ process
→ await sink write/drain
→ sleep until next cadence
→ observe
```

效果：

- 慢客户端只会降低 sampling 频率。
- 不建立无限 Delta queue。
- 不出现多个 Playwright `innerText()` observation 并发重叠。

Stable Prefix 对不规则采样仍然有效，因为它比较的是有序真实 snapshot，不依赖固定 token 频率。

## 22. SSE Transport Boundary（SSE 传输边界）

Phase 5 使用 Fastify async route，但实际 Streaming response 由低层 Node `ServerResponse` 管理。

首次内部 `started` event 到达时：

```text
reply.hijack()
reply.raw.writeHead(200, ...SSE headers...)
```

最小 headers：

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
```

不要求 Phase 5 增加代理特定 header。

### 22.1 Why hijack

进入 SSE 后：

- Fastify 不应在 async handler resolve 时再自动 `reply.send()`。
- API 层明确承担 raw write/end 生命周期。
- global error handler 只负责 `started` 之前的异常。

### 22.2 Shared SSE writer

`src/api/sse.ts` 只负责：

- UTF-8 frame serialization。
- `event:` / `data:` 行拼接。
- `\n\n` event delimiter。
- write + drain backpressure。
- socket close detection。
- idempotent end。

它不知道 Assistant Snapshot 或 Conversation。

## 23. Chat Completions SSE Encoder

Phase 5 只支持一个 text choice：`index=0`。

### 23.1 Stream metadata

每个请求创建一次：

```text
id      = chatcmpl_<uuid>
created = stream started Unix seconds
model   = chatgpt-web
```

同一个 stream 的所有 chunk 使用相同 `id` / `created` / `model`。

### 23.2 Started chunk

内部：

```ts
{ type: 'started', startedAt }
```

编码：

```text
data: {
  "id": "chatcmpl_...",
  "object": "chat.completion.chunk",
  "created": 123,
  "model": "chatgpt-web",
  "choices": [{
    "index": 0,
    "delta": { "role": "assistant", "content": "" },
    "finish_reason": null
  }]
}

```

### 23.3 Text delta

内部：

```ts
{ type: 'text.delta', delta: 'hello' }
```

编码：

```text
data: {
  "id": "chatcmpl_...",
  "object": "chat.completion.chunk",
  "created": 123,
  "model": "chatgpt-web",
  "choices": [{
    "index": 0,
    "delta": { "content": "hello" },
    "finish_reason": null
  }]
}

```

### 23.4 Completed

收到 internal `completed` 后：

先写 final chunk：

```text
data: {
  "id": "chatcmpl_...",
  "object": "chat.completion.chunk",
  "created": 123,
  "model": "chatgpt-web",
  "choices": [{
    "index": 0,
    "delta": {},
    "finish_reason": "stop"
  }]
}

```

再写：

```text
data: [DONE]

```

然后 `end()`。

### 23.5 Usage

Phase 5：

- 不发送 fake usage。
- 不接受 `stream_options.include_usage`。
- 不增加空 `choices` usage chunk。

## 24. Responses SSE Encoder

Responses 使用 typed SSE events，并对整个流维护稳定：

```text
response id = resp_<uuid>
message id  = msg_<uuid>
output_index = 0
content_index = 0
sequence_number strictly increasing
```

sequence number 内部从 `0` 初始化，每 emit 一个 Responses event 先递增，因此首事件为 `1`。

### 24.1 Started lifecycle

一个 internal `started` 映射为以下固定顺序：

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
```

`response.created` / `response.in_progress` 使用同一个 minimal Response object：

```text
id
object = response
created_at
completed_at = null
status = in_progress
error = null
incomplete_details = null
model = chatgpt-web
output = []
usage = null
```

Phase 5 不借机扩张 current Responses compatibility object 的其他可选字段。

`response.output_item.added`：

```json
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "id": "msg_...",
    "type": "message",
    "status": "in_progress",
    "role": "assistant",
    "content": []
  }
}
```

`response.content_part.added`：

```json
{
  "type": "response.content_part.added",
  "item_id": "msg_...",
  "output_index": 0,
  "content_index": 0,
  "part": {
    "type": "output_text",
    "text": "",
    "annotations": []
  }
}
```

每个 JSON object 都包含自己的 `sequence_number`。

SSE framing：

```text
event: <event.type>
data: <event JSON>

```

### 24.2 Text delta

每个 internal `text.delta` 映射：

```json
{
  "type": "response.output_text.delta",
  "item_id": "msg_...",
  "output_index": 0,
  "content_index": 0,
  "delta": "...",
  "sequence_number": 5
}
```

本项目当前不支持 logprobs，因此不伪造。

### 24.3 Completed lifecycle

internal `completed(result)` 依次输出：

```text
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

`response.output_text.done.text`、`content_part.done.part.text`、`output_item.done.item.content[0].text` 和 `response.completed.response.output[0].content[0].text` 必须全部等于：

```text
result.text
```

最终 `response.completed.response` 与当前 non-stream `encodeResponse()` 的已支持字段保持一致：

- `status='completed'`
- `completed_at` 来自 result
- `usage=null`
- 单个 Assistant message / output_text

Responses 不使用 Chat Completions 的 `[DONE]` marker；`response.completed` 是成功终态。

## 25. Error Semantics（错误语义）

### 25.1 Pre-stream errors

在 internal `started` 之前抛出的错误继续使用现有 Fastify / OpenAI-style JSON error：

```text
HTTP status != 200 as mapped
Content-Type: application/json
{ "error": ... }
```

### 25.2 Post-stream errors

一旦 SSE started，HTTP status 已经是 200。

Chat Completions：

```text
data: {"error":{...}}

```

然后直接关闭连接：

- 不发送 `finish_reason:"stop"`。
- 不发送 `[DONE]`。

Responses：

```text
event: error
data: {
  "type": "error",
  "code": "...",
  "message": "...",
  "param": null,
  "sequence_number": N
}

```

然后关闭：

- 不发送 `response.completed`。

### 25.3 New stable error

增加：

```text
chatgpt_stream_diverged
```

推荐映射：

| Code | HTTP before stream | OpenAI type | Meaning |
|---|---:|---|---|
| `chatgpt_stream_diverged` | 502 | `server_error` | ChatGPT DOM rewrote or lost a previously committed Assistant prefix |
| `unsupported_phase5_request` | 501 | `server_error` | Request requires attachments/tools/structured/image etc. not implemented in Phase 5 |

如果 divergence 发生在 SSE 已经开始后，则使用上面的 stream error framing，HTTP status 保持 200。

### 25.4 Client abort

Client abort 是 transport cancellation，不是一个需要返回给已断开的客户端的公共 API error。

内部日志可以记录：

```text
requestId
conversation key hash / non-sensitive identifier
stream state
bytes/events emitted count
stop outcome
```

不得记录正文。

## 26. Conversation Engine Integration（Conversation Engine 接入）

推荐 `createConversationEngine()` 返回一组共享同一依赖的 handler：

```ts
interface ConversationExecutionEngine {
  execute: NormalizedExecutionHandler;
  stream: NormalizedStreamingExecutionHandler;
}
```

如果为了保持现有调用最小 diff，需要先增加 parallel factory，也必须保证两条路径调用同一 private preparation/finalization helpers；不能复制一整份 Phase 4 state machine。

### 26.1 Shared preparation

应共享：

- load aggregate。
- canonical request。
- Context Planner。
- Page Registry acquire。
- `preparePage()`。
- prompt selection。
- initial/in-flight aggregate creation。
- final aggregate builder。
- safe URL validation。
- session success/failure。

### 26.2 Stream-specific work

只新增：

- `started` boundary。
- `startText()` handle。
- DOM polling。
- Stable Prefix。
- abort/stop。
- stream events。

### 26.3 Non-stream regression

现有 `execute` route 输出 shape 不变化。

`stream=false` 不应经过 SSE writer。

## 27. API Route Integration（API 路由接入）

两套 route 仍先 Normalizer：

```text
HTTP body
→ normalizeChatCompletions / normalizeResponses
→ NormalizedRequest
```

之后只按：

```ts
normalized.output.stream
```

分支：

```text
false → execute() → existing non-stream encoder
true  → stream()  → protocol SSE sink
```

不能在两个 route 中重新实现 capability validation / Context Sync。

### 27.1 Server dependency

`buildServer()` 可由：

```ts
execute
stream
```

两个 handler 注入，或注入一个组合 execution backend。

maintenance mode 同样必须提供 streaming handler：

- 在 `started` 前抛 `browser_maintenance_mode`。
- 返回正常 HTTP 503 JSON。
- 不打开伪 SSE 200。

## 28. Concurrency（并发）

### 28.1 Same key

完整 Streaming request 生命周期都在：

```text
queue.run(key, work)
```

内部。

因此：

```text
request A streaming
→ first delta
→ ...still generating...
→ request B same key arrives
→ B waits
→ A completed / cancelled cleanup
→ B starts
```

### 28.2 Different keys

仍由现有 Page capacity 决定并行，不加 global streaming lock。

### 28.3 Unkeyed

不进入 shared key queue；仍可并行，成功后 transient Page release。

## 29. Polling and Resource Policy（轮询与资源策略）

Phase 5 默认：

```text
STREAM_POLL_INTERVAL_MS = 200
STREAM_STABLE_SAMPLES   = 3
GENERATION_TIMEOUT_MS   = 120000
```

这些先作为内部常量/可注入测试参数，不增加 env。

理由：

- Roadmap 已批准约 200ms direction。
- 3-sample window 给 DOM rewrite 留出观察窗口。
- 120s 与当前 non-stream completion baseline 一致。
- 避免在真实数据出现前增加调参面。

测试使用 fake clock 注入，禁止 unit test 真睡 200ms。

## 30. Architecture Rules（架构规则）

Phase 5 强化 checker：

`src/stream/` 禁止直接 import：

- `playwright`
- `src/api/`
- `src/browser/`
- `src/chatgpt/`
- `src/persistence/`
- `node:sqlite`

`src/stream/` 只允许纯类型、纯算法和 clock abstraction。

继续保持：

- Selector 只定义在 `src/chatgpt/selectors.ts`。
- `chatgpt/` 不依赖 API / persistence / BrowserManager。
- `api/` 不依赖 Playwright。
- `browser/` 不理解 Conversation / API。

建议 `scripts/check-architecture.mjs` 增加 synthetic import-rule tests，证明普通、dynamic、require/side-effect import 都不能绕过边界；按现有 checker 能力最小扩展。

## 31. Deterministic Unit Tests（确定性单元测试）

### 31.1 Snapshot normalization

覆盖：

- CRLF → LF。
- CR → LF。
- leading/trailing whitespace 保留。
- Markdown fence/indent 保留。
- emoji / surrogate pair 不被切坏。

### 31.2 Longest common prefix

覆盖：

```text
["a", "ab", "abc"] → "a"
["abc", "abc", "abc"] → "abc"
["abX", "abY", "abZ"] → "ab"
emoji / CJK / code fences
```

### 31.3 Stable Prefix state

覆盖：

- 前 1-2 sample 不过早发不稳定尾部。
- 第 3 sample 发 stable prefix。
- 增长过程不重复。
- DOM 尾部重排但未越过 emitted prefix 时只延迟、不报错。
- DOM rewrite 穿过 emitted prefix → `chatgpt_stream_diverged`。
- completed final tail flush。
- target disappears after first appearance → divergence。

### 31.4 Completion

覆盖：

- marker 缺失继续等待。
- marker 出现但文本仍变化继续等待。
- marker + 3 stable samples + final re-read → complete。
- global stale Stop control 不阻止完成。
- no turn timeout → response_missing。
- existing turn but no completion → generation_timeout。

### 31.5 Chat Completions encoder

覆盖：

- fixed stream id/created/model。
- role chunk exactly once。
- deltas order不变。
- final finish chunk exactly once。
- `[DONE]` exactly once。
- no usage fabrication。
- error after start has no success terminator。

### 31.6 Responses encoder

覆盖完整顺序：

```text
created
in_progress
output_item.added
content_part.added
output_text.delta...
output_text.done
content_part.done
output_item.done
completed
```

断言：

- response/message id 全程稳定。
- sequence_number 严格单调。
- indices 恒为 0。
- concatenated delta == all done/full text fields。
- usage null。
- error stream 不出现 completed。

### 31.7 SSE writer

覆盖：

- frame delimiter。
- multi-byte UTF-8。
- write false 等待 drain。
- close before writableFinished abort。
- normal end close 不误报 abort。
- end 幂等。

## 32. Integration Tests（集成测试）

使用 fake ChatGPT Driver + real temporary SQLite + real Fastify，不访问 ChatGPT。

必须覆盖：

1. Chat Completions `stream=true` 从 fake snapshots 逐步得到 SSE delta。
2. Responses `stream=true` 得到正确 typed event lifecycle。
3. `stream=false` 继续走现有 JSON encoder，行为不变。
4. full-history APPEND Streaming 不重复发送旧 history。
5. single-user incremental Streaming 使用 stored Conversation。
6. RESTORE + Streaming。
7. REBUILD + Streaming。
8. same-key 第二请求必须等第一 stream terminal/cancel cleanup 后才进入 Driver。
9. different-key Streaming 可并行。
10. final tail emitted 后 SQLite save 成功，再发 terminal success。
11. SQLite final save 失败时客户端没有 `[DONE]` / `response.completed`，checkpoint 保持 `in_flight`。
12. Stable Prefix divergence 后 checkpoint 保持 `in_flight`，Page binding discarded。
13. Client abort 在生成中 → fake `stop()` called exactly once、no partial Assistant persisted、checkpoint in_flight。
14. Client abort after completion → final aggregate 仍可完成保存。
15. Slow writable backpressure 不制造无界 buffered events。
16. maintenance mode Streaming 在 SSE started 前返回 503 JSON。

## 33. Real ChatGPT E2E（真实网页验收）

Phase 5 必须新增显式命令，例如：

```bash
E2E_CHATGPT=1 \
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \
CHATGPT_PROXY_SERVER=http://proxy-host:port \
corepack pnpm test:e2e:chatgpt:phase5
```

并最终把 combined：

```text
test:e2e:chatgpt
```

扩展为：

```text
Phase 3 regression
→ Phase 4 Conversation regression
→ Phase 5 Streaming
```

继续使用隔离 Profile clone，不污染人工登录基准 Profile。

### 33.1 E2E must use a real TCP HTTP listener

Phase 5 的核心是“时间上真的边生成边收到”。Fastify `app.inject()` 会把整个响应作为测试对象收集后再读取，不能单独证明客户端实时收到中间 SSE。

因此 Phase 5 real Streaming E2E 必须：

```text
runtime.app.listen({ host: '127.0.0.1', port: 0 })
→ real fetch / Node HTTP client
→ incremental read response.body
```

测试结束关闭 listener/runtime。

### 33.2 Chat Completions long reply

Prompt 要求一个足够长、可稳定识别的纯文本回答。

验收：

- HTTP 200 + SSE content type。
- 收到至少多个 non-empty content deltas。
- 在收到**第一个 meaningful text delta 时**，通过 runtime 当前 Page 检查 target Assistant turn completion marker 尚未出现。

这个断言直接证明：

```text
客户端已经收到文字
AND ChatGPT 当前 turn 仍未完成
```

从而排除“完整后切片”的伪 Streaming。

最终：

```text
concat(delta)
== final live Assistant innerText
== SQLite Assistant text
```

且 finish chunk / `[DONE]` 唯一。

### 33.3 Markdown / code block

真实回答至少包含：

- Markdown heading/list。
- fenced code block。
- 多行缩进。

断言最终 delta concatenation 与 final DOM text 完全一致，且没有重复 fence、丢行或尾部截断。

### 33.4 Responses stream

真实 `/v1/responses`：

- typed event order 合法。
- response/message id 稳定。
- sequence number 单调。
- 多个 `response.output_text.delta`。
- `output_text.done.text == response.completed final text == SQLite Assistant`。

### 33.5 Client abort

真实 long reply：

```text
start stream
→ wait at least one meaningful delta
→ abort client connection
→ Gateway stop current ChatGPT generation
```

验收：

- current target turn 在 bounded period 内进入 terminal/stopped DOM state，不继续无界增长。
- local Conversation checkpoint 保持 `in_flight`。
- current Page affinity 不被当成 clean success 保留。
- 下一次同 key authoritative request 可以通过 REBUILD 收敛成功。

不能只用 fake Driver 的 `stop()` 调用次数替代真实 E2E；DOM Stop 行为属于外部变化面。

## 34. Docker Validation（Docker 验证）

Phase 5 不改变 Docker 架构、Playwright/Chrome 版本或 Profile 路径，因此不新增 Docker 配置项。

但产品 runtime / route 生命周期发生变化，完成实施后仍必须运行现有：

```bash
corepack pnpm docker:build
corepack pnpm docker:smoke
```

Docker smoke 继续证明：

- normal/maintenance single browser owner。
- Gateway/SQLite lifecycle。
- non-root / PUID/PGID。
- migrations 仍只有 001+002。
- HTTP auth / health 不回归。

**Docker smoke 不证明真 Streaming。** 真 Streaming 只能由显式 real ChatGPT E2E 证明。

## 35. Observability and Privacy（可观测性与隐私）

允许记录：

- request id。
- stream/non-stream mode。
- Conversation mode：FRESH/APPEND/RESTORE/REBUILD。
- snapshot count。
- delta count。
- emitted character/code-point count。
- duration。
- stop outcome。
- stable error code。
- non-sensitive fingerprint。

禁止普通日志记录：

- Assistant raw text。
- user raw prompt。
- SSE payload content。
- Cookies / Authorization / Gateway API key。
- Browser Profile 内容。
- full DOM snapshot。

诊断 screenshot / HTML 仍必须通过现有显式 diagnostics opt-in 边界。

## 36. Security Boundaries（安全边界）

Phase 5 保持：

- 不导航任意 persisted URL。
- 不调用私有 ChatGPT API。
- 不把 DOM HTML 直接发客户端。
- 不允许 Selector ambiguity 自动选第一个元素。
- Client abort stop 只能点击当前页面严格唯一的 Stop control。
- API error 不包含 Playwright stack、filesystem path 或原始正文。
- Streaming 不能绕过 Gateway Bearer API Key；SSE route 仍属于 `/v1/*` auth hook。

## 37. External Protocol Compatibility Decisions（外部协议兼容决定）

Phase 5 implementation 前已重新核对当前官方协议与当前项目依赖：

- OpenAI Chat Completions Streaming 返回 streamed `chat.completion.chunk` objects；同一 completion 的 chunk ID / created timestamp 保持一致，choice 使用 `delta` 和 terminal `finish_reason`。
- OpenAI Responses `stream=true` 使用 SSE typed events；Phase 5 需要的 text lifecycle 包含 `response.created`、`response.in_progress`、output/content added、`response.output_text.delta`、done events 和 `response.completed`。
- Fastify 当前 Reply contract 提供 `reply.hijack()` 让 async route 接管 response 生命周期，并通过 `reply.raw` 暴露 Node `http.ServerResponse`；Phase 5 因此可以明确区分 pre-stream Fastify error 与 post-stream raw SSE error。

Primary references checked on 2026-08-16：

- OpenAI API Reference — Responses Streaming Events: `https://platform.openai.com/docs/api-reference/responses-streaming`
- OpenAI official Node SDK — Chat Completion chunk types: `https://github.com/openai/openai-node/blob/main/src/resources/chat/completions/completions.ts`
- OpenAI official Node SDK — Streaming usage: `https://github.com/openai/openai-node`
- Fastify Reply reference: `https://fastify.dev/docs/latest/Reference/Reply/`

如果 implementation 时官方 event schema 已变化，必须以当时 primary source 为准并先更新本 spec，而不是为了旧规格硬编码过时协议。

## 38. Documentation Impact（文档影响）

本次只编写设计，不改变当前已实现 API 行为。

Phase 5 真正实施完成后需要同步：

- `docs/PROJECT_STATE.md`：Streaming 从 ❌ → ✅，更新真实测试证据。
- `docs/api-compatibility.md`：Current Implementation 从 Phase 4 更新到 Phase 5，`stream=true` 从目标变成当前支持。
- `docs/architecture.md`：把本规格中已落地的 Stable Prefix / abort / SSE boundary 更新为实现事实。
- `docs/testing.md`：记录新增 deterministic / integration / real E2E 命令与真实基线。
- `docs/roadmap.md`：Phase 5 完成后关闭阶段。

设计阶段不能提前把 Streaming 写成已实现。

## 39. Acceptance Criteria（验收标准）

Phase 5 只有满足以下全部条件才算完成：

### Core behavior

1. `stream=true` 纯文本 Chat Completions 可用。
2. `stream=true` 纯文本 Responses 可用。
3. 至少一个真实长回复在 ChatGPT completion marker 出现前，客户端已经收到 meaningful text delta。
4. Stable Prefix 没有重复输出。
5. Markdown / code block real E2E 没有尾部丢失或重复。
6. final tail 一定 flush。
7. 对成功且连接持续到 terminal 的 stream，`concat(delta) == final DOM == SQLite Assistant == terminal protocol text`。
8. non-stream regression 全绿。

### Consistency

9. same-key Streaming 全程 FIFO。
10. different-key 仍可并行。
11. success terminal event 只在 SQLite clean save 后发送。
12. post-checkpoint failure 不保存 partial Assistant。
13. stream divergence 保持 `in_flight`，下一请求可 REBUILD。
14. client abort before completion 会 best-effort Stop，并保持 `in_flight`。
15. client abort after confirmed completion 不破坏已完成 authoritative save。

### Protocol

16. Chat Completions chunks 使用稳定 id/created/model。
17. Chat Completions finish chunk 和 `[DONE]` 各一次。
18. Responses typed lifecycle / sequence numbers / IDs 一致。
19. post-start error 不伪造成功 terminator。
20. 不伪造 token usage。

### Validation

21. Stable Prefix / Completion / Encoders / SSE writer 有确定性 unit coverage。
22. Conversation + abort + persistence 有 integration coverage。
23. `corepack pnpm verify` 通过。
24. fresh Docker build + smoke 通过。
25. 显式 real ChatGPT Phase 5 E2E 通过长回复、Markdown/code、Responses、client abort。
26. combined real E2E 保持 Phase 3/4 regression 通过。
27. 项目记忆、API、架构、测试文档按真实结果回写。
28. `git diff --check` 和仓库治理检查通过。

## 40. Implementation Constraints（实施约束）

实施计划必须遵守：

- 先纯 `stream/` 红测试，再 Stable Prefix 最小实现。
- 再拆 Driver turn handle，不一次重写整个 Driver。
- non-stream completion regression 必须在 Driver 重构时保持绿。
- 再接 Conversation Engine Streaming lifecycle / abort。
- 再接协议 Encoder / Fastify SSE。
- 最后做系统 integration、Docker、real E2E。
- real E2E 发现 DOM 事实与本 spec 冲突时，先更新事实/spec，再改代码。
- 不为了 Phase 5 顺手实现 Phase 6/7 能力。

具体 Task 顺序属于下一步 implementation plan，不在本设计规格中提前固定文件级 patch。

## 41. Final Decision（最终设计结论）

Phase 5 采用：

```text
DOM-only target Assistant observation
+ ~200ms sequential polling
+ 3-sample Stable Prefix
+ target-turn completion marker + final stable confirmation
+ final tail flush
+ protocol-neutral started/delta/completed events
+ Conversation Engine-owned checkpoint/queue/persistence
+ Chat Completions / Responses independent SSE encoders
+ Fastify hijacked raw SSE transport with backpressure
+ client abort → best-effort ChatGPT Stop + in_flight convergence
```

核心原则是：

> **Streaming 只承诺已经稳定观察到的前缀；Conversation 只承诺已经完成并原子持久化的最终 turn；HTTP 只在这两个事实边界上输出对应协议事件。**

这样可以在不依赖 ChatGPT 私有 API、不破坏 Phase 4 Conversation 一致性的前提下，实现真正实时、无重复、可恢复且可验证的 DOM Streaming。
