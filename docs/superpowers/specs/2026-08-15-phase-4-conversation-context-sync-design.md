# Phase 4 Conversation + Context Sync Design

**Date:** 2026-08-15  
**Status:** Approved; ready for implementation planning  
**Scope:** Phase 4

## 1. Goal（目标）

Phase 4 在 Phase 2 SQLite Conversation 持久化和 Phase 3 Playwright Browser / Fresh Text Driver 基础上，交付稳定的 Conversation 生命周期与 Context Sync（上下文同步）闭环：

1. `X-Conversation-Key` 正式成为可续接 Conversation 的稳定客户端身份。
2. 同一 Conversation FIFO 串行，不同 Conversation 在 Page 容量允许时并行。
3. 识别并执行 `FRESH | APPEND | RESTORE | REBUILD` 四种同步模式。
4. 客户端重复发送完整历史时，只把 ChatGPT 尚未知的当前 user turn 追加到网页，不重复灌入旧历史。
5. Page 被回收或 Gateway 重启后，使用 SQLite 中保存的 ChatGPT Conversation URL 恢复原网页会话。
6. 历史分叉、instructions 变化、URL 无法恢复或同步状态不确定时，通过 `REBUILD` 收敛到确定状态。
7. 增加最小持久化 sync checkpoint，覆盖“网页已经写入但 SQLite 尚未提交”这一崩溃窗口。
8. Conversation 保持 Page affinity；无压力时按 idle timeout 回收，容量压力下按 LRU 让出 idle Page。
9. 无 `X-Conversation-Key` 的请求仍完整持久化，但不建立跨请求隐式身份。
10. 保持 API Adapter、Conversation Engine、Context Planner、ChatGPT Driver、Browser Page Pool、Persistence 的模块隔离。

Phase 4 完成后，Phase 5 Streaming 可以建立在稳定的 Conversation ownership、Assistant turn ownership 和 Context Sync 之上，而不再承担会话恢复职责。

## 2. Non-Goals（本阶段明确不做）

Phase 4 不实现：

- Streaming / SSE / Stable Prefix。
- Client abort → stop generation。
- 图片 URL / Base64 图片实际解析与上传。
- 文件实际解析、落盘、上传和 `/v1/files` 生命周期。
- Tool Calling Prompt / Parser / Tool Result 执行闭环。
- Structured Output 执行约束。
- ChatGPT 图片生成。
- 多 Gateway 进程共享同一 Browser Profile / Conversation Queue 的横向扩展。
- Conversation 删除、归档、TTL 或数据库垃圾回收 API。
- 自动删除被 REBUILD 替代的 ChatGPT server-side Conversation。
- 通过 DOM 修改、编辑历史消息或私有 ChatGPT API 来“修补”旧网页历史。
- Event sourcing / 完整操作日志。

Phase 4 仍严格限定为**非流式、纯文本**执行路径；后续能力不能因为请求被持久化就被伪装成已经支持。

## 3. Approved Product Semantics（已确认产品语义）

本设计讨论已锁定以下选择：

1. **无 `X-Conversation-Key` 不做隐式身份推断。** 每个请求都是独立 Conversation；即使带完整历史，也不会通过 fingerprint 自动绑定旧 Conversation。
2. **有 key 同时支持完整历史和纯增量。** 常见 OpenAI 客户端可以每轮重发完整 messages；轻量客户端也可以只发送本轮 user。
3. **完整历史发生分叉时自动 REBUILD。** 客户端本次提交的完整有效历史成为新的 authoritative history，ConversationKey 保持不变。
4. **RESTORE 确认不可恢复时自动降级 REBUILD。** 但 `auth_required`、DOM selector 错误、Browser runtime 错误不得被错误吞成 REBUILD。
5. **容量压力下 LRU 回收 idle affinity Page。** busy Page 永远不回收。
6. **增加持久化 sync checkpoint。** 不确定状态不猜测网页到底执行到哪一步，下一请求通过 REBUILD 收敛。
7. **不存在的 key 自动创建 Conversation。** 不增加单独的“创建会话”公开 API。
8. **同 key FIFO 排队等待。** 排队请求不提前占 Page，轮到执行时重新加载最新 SQLite 状态。
9. **无 key 请求仍完整持久化。** `conversation_key = NULL`，请求结束后不保留长期 Page affinity。
10. **请求模式使用确定性规则。** 只有一条 user message → incremental；多条 message 或出现 assistant/tool history → full。Phase 4 capability gate 仍会拒绝 tool 执行。
11. **incremental 请求修改 instructions → REBUILD。** 新 instructions + 已确认旧历史 + 当前 user 形成新的有效上下文。
12. **FRESH / REBUILD 使用单次 Context Envelope。** 不逐轮 replay 历史，不让 ChatGPT 重新生成历史 assistant，也不伪造 DOM turn。
13. **SQLite 是恢复事实来源。** ChatGPT URL 是可恢复资源定位，Page 只是运行时缓存。

## 4. High-Level Architecture（总体架构）

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
  Conversation Engine
    ┌─────┼───────────────┐
    ▼     ▼               ▼
 Queue  Conversation    Context
        Store           Planner
    │     │               │
    └─────┴───────┬───────┘
                  ▼
       Conversation Page Registry
                  │
                  ▼
              Page Pool
                  │
                  ▼
          ChatGPT Text Driver
                  │
                  ▼
             chatgpt.com
```

推荐模块：

```text
src/
├── context/
│   ├── canonicalize.ts
│   ├── fingerprint.ts
│   ├── planner.ts
│   └── types.ts
├── conversations/
│   ├── conversation-engine.ts
│   ├── conversation-queue.ts
│   ├── page-registry.ts
│   ├── aggregate-builder.ts
│   ├── errors.ts
│   └── types.ts
├── chatgpt/
│   ├── driver.ts
│   └── ...existing selector/auth/completion files
├── browser/
│   ├── page-pool.ts
│   └── types.ts
└── persistence/
    ├── conversation-store.ts
    ├── repositories/conversations.ts
    └── types.ts
```

### 4.1 `context/`

纯逻辑层，只做：

- 文本 canonicalization。
- request mode 分类。
- history / instructions fingerprint。
- stored state 与 request 的比较。
- `FRESH | APPEND | RESTORE | REBUILD` 计划。

禁止依赖：

- Playwright。
- `chatgpt/`。
- `persistence/`。
- `api/`。
- wall-clock I/O。

### 4.2 `conversations/`

拥有：

- Conversation identity。
- 同 key FIFO。
- 从 SQLite 读取最新 aggregate。
- 调用 Context Planner。
- Page affinity / LRU / idle timer。
- sync checkpoint 的 begin / complete 生命周期。
- Driver 执行编排。

不定义 ChatGPT selector，不直接构造 OpenAI HTTP response。

### 4.3 `browser/`

继续只管理 BrowserContext / Page 生命周期和 Page capacity，不理解 ConversationKey、SQLite 或 ChatGPT URL 语义。

### 4.4 `chatgpt/`

继续只理解 ChatGPT Web DOM。Phase 4 把“导航 Fresh / 打开已知 Conversation / 当前页面发送文本”从 Phase 3 的单体 `sendText()` 中拆成可组合操作，但 Driver 不读取 SQLite、不管理 Page Pool。

## 5. Conversation Identity（会话身份）

### 5.1 Keyed Conversation

客户端：

```text
X-Conversation-Key: agent-thread-123
```

Gateway：

- 使用现有 `conversations.conversation_key UNIQUE` 找到或创建 Conversation。
- ConversationKey 不等于 SQLite UUID，也不等于 ChatGPT Conversation URL。
- REBUILD 后 key 和 SQLite Conversation `id` 保持不变，只替换 ChatGPT URL 和有效历史。

### 5.2 Unkeyed Conversation

没有 Header：

- 每个 HTTP 请求生成新的 SQLite Conversation UUID。
- `conversation_key = NULL`。
- 完整保存请求历史、当前 user、Assistant 输出和 ChatGPT URL。
- 请求完成后 Page 作为 transient lease 释放，不建立跨请求 affinity。
- 后续请求不会按历史 fingerprint、内容或 URL 自动找到它。

因此：

```text
持久化事实 != 跨请求身份
```

Phase 4 不增加自动生成并返回 Conversation Key 的协议扩展。

## 6. Phase 4 Capability Gate（能力边界）

Phase 4 可执行请求必须满足：

- `output.mode === 'text'`
- `output.stream === false`
- `attachments.length === 0`
- `tools.length === 0`
- `toolChoice.mode === 'auto'`
- `output.structured === undefined`
- 所有 Message content 都只能是 text part
- 当前待执行输入最终必须得到一个 trailing user turn

Phase 4 可以读取并 canonicalize `user | assistant` 文本历史。

`tool` message 或 tool call 历史虽然会使请求在“形态”上被分类为 full，但实际执行仍属于 Phase 7，因此 capability validation 必须返回明确的 `unsupported_phase4_request`，不能把 tool 文本当普通 Assistant/User history 发送。

## 7. Canonicalization and Fingerprint（规范化与指纹）

Context Sync 比较的是 Gateway canonical history，不比较 DOM 节点结构。

### 7.1 Canonical Text Message

Phase 4 对纯文本 Message 使用：

```ts
interface CanonicalTextMessage {
  role: 'user' | 'assistant';
  text: string;
}
```

同一 Message 的多个 text part 按当前实际网页提交语义稳定连接：

```ts
parts.map((part) => part.text).join('\n')
```

持久化到 Phase 4 Conversation aggregate 时也规范为单个 text part：

```ts
[{ type: 'text', text: canonicalText }]
```

这样 Chat Completions 字符串 content、文本 part 数组和 Responses `input_text` 最终只按“实际会发送给 ChatGPT 的文本”比较，不因协议表示差异制造假分叉。

### 7.2 Canonical Instructions

instructions canonical form：

```ts
interface CanonicalInstructions {
  system: string[];
  developer: string[];
}
```

同角色内部保持原顺序；system / developer 使用明确字段表达优先级，而不是依赖数组交错位置。

### 7.3 Fingerprint

`context/fingerprint.ts` 对 canonical value 的稳定 JSON serialization 计算 SHA-256 hex。

Fingerprint 用于：

- 快速 history/instructions equality。
- deterministic tests。
- 诊断 mode/reason。

Phase 4 **不新增 fingerprint 数据库列**；从 loaded aggregate 与当前 request 现场计算即可。同步正确性仍建立在 canonical value 上，不依赖 ChatGPT DOM 文本反推。

普通日志不得输出原始消息正文；需要诊断时可以记录 mode、reason、message count 和非敏感 fingerprint。

## 8. Request Mode（请求模式）

模式只使用确定性形状规则：

```text
恰好 1 条 message，且 role=user
        ↓
incremental

多条 message
或存在 assistant/tool history
        ↓
full
```

instructions 不参与 full / incremental 分类。

### 8.1 Incremental

已有本地：

```text
user1
assistant1
```

请求：

```text
[user2]
```

有效历史：

```text
user1
assistant1
user2
```

### 8.2 Full

请求：

```text
user1
assistant1
user2
```

只有当：

```text
request[0..-2] == stored messages
```

并且 request 只比 stored history 多**恰好一个 trailing user** 时，才允许增量追加。

如果 full 请求携带多个 Gateway 尚未知的 historical turns，例如：

```text
stored: user1 assistant1
request: user1 assistant1 user2 assistant2 user3
```

Gateway 不尝试把 `assistant2` 注入旧网页会话，直接 REBUILD。

### 8.3 Ambiguous Reset

已有 key 下只有一条 user message 永远按 incremental 解释。

如果客户端想把一个已有 Conversation 的完整历史重置为“只有一条 user”，协议本身无法与普通增量区分；Phase 4 要求客户端使用新的 `X-Conversation-Key`。不增加 `X-Conversation-Mode`。

## 9. Persistence Migration and Sync Checkpoint（持久化检查点）

Phase 4 新增：

```text
migrations/002_add_conversation_sync_checkpoint.sql
```

`conversations` 增加：

```text
sync_status           TEXT NOT NULL DEFAULT 'clean'
                      CHECK clean|in_flight
synced_message_count  INTEGER NOT NULL DEFAULT 0
                      CHECK >= 0
sync_started_at       INTEGER NULL
```

不增加 event log，不保存“正在执行的请求正文”。

Persistence type：

```ts
interface ConversationSyncCheckpoint {
  status: 'clean' | 'in_flight';
  syncedMessageCount: number;
  startedAt?: number;
}

interface ConversationRecord {
  // existing fields...
  sync: ConversationSyncCheckpoint;
}
```

Repository / Store validation：

- `clean` → `startedAt` 必须为空。
- `in_flight` → `startedAt` 必须存在。
- `syncedMessageCount >= 0`。
- aggregate 中 `syncedMessageCount <= messages.length`。

不在 persistence 层强制 `clean => count === messages.length`，因为 migration 后的 legacy rows 必须能够被加载；是否可安全 APPEND 由 Context Planner 判断。

### 9.1 Fully Synced Definition

只有同时满足：

```text
sync.status == clean
sync.syncedMessageCount == messages.length
chatgptConversationUrl != undefined
```

才是 `fullySynced`。

SQLite 中“有 URL”本身不是安全 APPEND 的充分条件。

### 9.2 Migration Backward Safety

现有 row 迁移后默认：

```text
status = clean
count = 0
```

如果 legacy row 已有 Message，则：

```text
count != messages.length
```

Planner 自动 REBUILD，不会错误认为旧数据已经和网页同步。

不需要回填猜测历史同步位置。

## 10. Context Sync Planner（纯状态机）

建议输入：

```ts
interface ContextSyncInput {
  stored?: CanonicalStoredConversation;
  request: CanonicalConversationRequest;
  requestMode: 'incremental' | 'full';
  hasAffinityPage: boolean;
}
```

输出：

```ts
type ContextSyncPlan =
  | { mode: 'FRESH'; effectiveHistory: CanonicalTextMessage[] }
  | { mode: 'APPEND'; currentUser: CanonicalTextMessage }
  | { mode: 'RESTORE'; currentUser: CanonicalTextMessage }
  | {
      mode: 'REBUILD';
      reason: RebuildReason;
      effectiveHistory: CanonicalTextMessage[];
    };
```

`RebuildReason` 至少覆盖：

```text
checkpoint_uncertain
checkpoint_mismatch
instructions_changed
history_diverged
multiple_unsynced_turns
conversation_url_missing
conversation_not_restorable   // executor runtime downgrade reason
```

### 10.1 Planner Priority

```text
stored 不存在
  → FRESH

stored 存在但 !fullySynced
  → REBUILD

instructions changed
  → REBUILD

request mode = full
  ├── exact stored prefix + exactly one trailing user
  │     → 可增量
  └── 其他差异
        → REBUILD

request mode = incremental
  → stored history + current user

可增量：
  ├── affinity Page exists → APPEND
  ├── URL exists           → RESTORE
  └── URL missing          → REBUILD
```

Planner 不打开网页，因此 `RESTORE → not_restorable → REBUILD` 是 executor 在执行期做的安全降级，不要求 Planner 预测外部 URL 当前是否有效。

## 11. FRESH（新会话）

适用：

- 新 `X-Conversation-Key`。
- 任意无 key 独立请求。

流程：

```text
canonicalize
→ create local Conversation identity
→ acquire Page
→ openFresh(page)
→ auth/composer ready
→ persist sync=in_flight checkpoint
→ send Context Envelope once
→ wait Assistant completion
→ atomically save final aggregate + URL + clean checkpoint
```

首次请求可以包含完整历史：

```text
history:
  user1
  assistant1
  user2
  assistant2
current_user:
  user3
```

网页仍然只收到**一个** Context Envelope，并只生成当前 Assistant。

## 12. APPEND（增量追加）

APPEND 只在能够证明旧状态一致时执行：

- existing keyed Conversation。
- fully synced。
- instructions unchanged。
- request previous history 与 stored history 一致。
- 只有一个新的 trailing user。
- 存在可用 affinity Page。

执行：

```text
openConversation(savedUrl)   // same Page 时可 short-circuit navigation
→ ready
→ mark sync=in_flight
→ send compact Append Envelope containing current user only
→ wait Assistant
→ append current user + generated Assistant in SQLite
→ update URL
→ count = messages.length
→ clean
```

**不重新发送：**

- 旧 user history。
- 旧 assistant history。
- 已建立的 instructions。

这是 Phase 4 的核心兼容目标。

## 13. RESTORE（恢复 Page）

RESTORE 表示：

```text
本地与 ChatGPT Conversation 逻辑状态仍被认为一致，
但当前进程没有该 Conversation 的 affinity Page。
```

典型原因：

- Gateway 重启。
- idle timeout 关闭 Page。
- LRU eviction 释放 affinity。
- Page 自身被关闭。

流程：

```text
acquire Page
→ openConversation(savedUrl)
→ restored?
   ├── yes → mark in_flight → APPEND current user
   └── no  → openFresh → REBUILD
```

因此 RESTORE 可以理解为：

```text
恢复 Page identity + 安全 APPEND
```

RESTORE 本身不重发完整历史。

## 14. REBUILD（确定性重建）

REBUILD 统一处理不能证明安全 APPEND 的情况：

- full history 修改 / 回滚 / 压缩 / 分叉。
- full request 含多个未同步 turns。
- incremental request 修改 system/developer instructions。
- checkpoint 为 `in_flight`。
- checkpoint count 与 local Message 数不一致。
- 已有 Conversation 没有 URL。
- affinity Page / URL 确认不可恢复。

流程：

```text
choose authoritative effective history
→ openFresh(page)
→ mark sync=in_flight
→ send one Context Envelope
→ wait current Assistant
→ atomically replace effective local aggregate
→ replace ChatGPT URL
→ clean checkpoint
```

ConversationKey 与 SQLite Conversation UUID 保持不变。

旧 ChatGPT server-side Conversation 变成 orphan，不删除，也不再继续写入。

### 14.1 Authoritative History

**Full divergence：** 客户端本次 full history 为 authoritative source。

**Incremental + instructions changed：** 已确认 stored history + 当前 user 为 authoritative messages，新 instructions 为 authoritative instructions。

**Checkpoint uncertain + incremental：** 只信任 `syncedMessageCount` 所代表的已确认 stored history；上一次未提交网页写入被视为 orphan effect。当前新的 incremental user 追加到已确认历史后 REBUILD。

Phase 4 不尝试从 DOM 抓取“可能多出来的一轮”来修补 SQLite。

## 15. Message Record Reconciliation（本地 Message 身份）

最终 aggregate 构建不应无条件为所有历史 Message 重建 UUID。

`aggregate-builder.ts` 使用 canonical longest common prefix：

- 与 stored canonical history 完全一致的 prefix 复用已有 Message row id / sequence。
- authoritative history 中发生变化的 suffix 生成新的 UUID v4。
- 新 current user 与生成的 Assistant 生成新 UUID。
- sequence 最终严格从 0 连续递增。

这样 instructions-only REBUILD 可以保留全部既有 Message identity；history divergence 只替换发生变化后的 suffix。

Phase 4 当前没有附件/Tool Call，但这个规则避免未来 dependent entities 因无意义的 Message identity 全量抖动。

## 16. Context and Append Envelopes（Prompt 表示）

### 16.1 Context Envelope

FRESH / REBUILD 使用版本化单次 envelope：

```json
{
  "version": 1,
  "instructions": {
    "system": ["..."],
    "developer": ["..."]
  },
  "history": [
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ],
  "current_user": { "text": "..." }
}
```

稳定前导语义：

- `history` 是已经完成的 transcript。
- 不重新回答、改写或补全 `history`。
- 只针对 `current_user` 生成新的 Assistant response。
- system 指令优先于 developer，developer 优先于 current user。

正文必须用 `JSON.stringify()` 序列化，禁止手工拼接未转义用户文本。

### 16.2 Append Envelope

APPEND / RESTORE 成功后只发送 compact envelope：

```json
{
  "version": 1,
  "current_user": { "text": "..." }
}
```

不携带旧 history 或旧 instructions。

前导语只说明“继续已经建立的 API context，并只回答 current_user”。

这仍然只是 ChatGPT Web prompt-level 近似映射，不是 OpenAI 原生 system/developer privilege boundary，也不能把 JSON 包装当作 prompt injection 安全隔离。

## 17. Crash Consistency（崩溃一致性）

### 17.1 Write Order

对于任何可能向 ChatGPT Conversation 写入新 turn 的操作：

```text
Page navigation / Auth / Composer readiness
        ↓
SQLite metadata transaction:
  status = in_flight
  startedAt = now
  syncedMessageCount 保持旧值
        ↓
网页 write / submit
        ↓
Assistant completion
        ↓
SQLite aggregate transaction:
  保存 authoritative messages
  保存 generated Assistant
  保存 current/new ChatGPT URL
  syncedMessageCount = messages.length
  status = clean
  startedAt = NULL
        ↓
HTTP success
```

必须在**第一个可能改变网页 Conversation 的动作之前**持久化 `in_flight`。

Auth Probe、Fresh/Restore navigation 和 composer readiness 发生在它之前，因为这些操作不应产生 Conversation turn。

### 17.2 Uncertain Window

如果：

```text
mark in_flight
→ ChatGPT 已接收/可能接收
→ process crash / generation timeout / unknown send failure
```

数据库保留 `in_flight`。

Gateway 不尝试区分：

- 网页根本没收到。
- 网页收到 user 但没生成完。
- 网页已生成 Assistant，但 SQLite 没提交。

下一次该 key 请求一律 REBUILD。

### 17.3 No Rollback Guessing

一旦进入 `in_flight`，执行错误不会为了“看起来像发送前失败”自动改回 clean，除非未来 Driver 提供经过独立设计、可证明没有网页副作用的事务信号。

Phase 4 选择保守一致性，不根据 Playwright error message 猜测副作用。

## 18. Persistence API（持久化接口）

Phase 2 `ConversationStore.save()` 继续作为完整 aggregate 原子保存边界。

Phase 4 增加最小 metadata operation，例如：

```ts
markSyncInFlight(conversationId: string, startedAt: number): void;
```

语义：

- 同步 transaction。
- 只更新 Conversation checkpoint，不重写 child rows。
- 保持 `syncedMessageCount` 不变。
- Conversation 不存在时失败。

新 Conversation 在首次网页 write 前先保存一个最小 aggregate：

- stable UUID。
- 可选 ConversationKey。
- 当前 instructions metadata。
- `messages=[]`。
- URL undefined。
- checkpoint `in_flight / count=0`。

随后网页成功时由一次完整 `ConversationStore.save()` 写入 authoritative history + current user + Assistant + URL + clean checkpoint。

这样不需要在 SQLite transaction 内等待 Playwright，也不引入 async transaction callback。

## 19. Conversation FIFO Queue（同会话队列）

建议接口：

```ts
interface ConversationQueue {
  run<T>(conversationKey: string, work: () => Promise<T>): Promise<T>;
  close(): void;
}
```

行为：

- 每个 key 独立 Promise tail / FIFO。
- 前一个 work resolve 或 reject 后，下一个都继续执行，错误不能 poison 队列。
- 最后一个 work 完成后删除 Map entry，避免 key 泄漏。
- 排队阶段不读取 SQLite snapshot、不 acquire Page。
- 真正轮到 work 时重新 `loadByKey()`，因此能看到前一请求刚提交的 Assistant 和 checkpoint。
- 不同 key 没有共享 global mutex。
- 无 key 请求不进入 shared identity queue，可并行执行。

单进程 Queue 足够的前提是当前 V1 正式运行边界只有一个 Gateway/Browser owner。Phase 4 不声称支持多个 Gateway 进程同时写同一 DB/Profile。

## 20. Conversation Page Registry（Page affinity）

`PagePool` 保持通用容量层；Conversation 语义放在 `conversations/page-registry.ts`。

运行时 binding：

```ts
interface ConversationPageBinding {
  conversationId: string;
  lease: PageLease;
  busy: boolean;
  lastUsedAt: number;
}
```

### 20.1 Keyed Request

成功请求后：

- lease 不立即归还 PagePool。
- Registry 保存 Conversation → Page affinity。
- `busy=false`。
- `lastUsedAt=now`。

下一请求在 FIFO 轮到后可复用同一个 Page。

### 20.2 Transient Unkeyed Request

无 key：

- 仍通过 Registry 统一申请 capacity，这样必要时可以触发 LRU affinity eviction。
- 请求结束后 release lease。
- 不创建长期 binding。

### 20.3 Capacity Pressure LRU

获取新 Page 时：

1. 先正常 `PagePool.acquire()`。
2. 如果 `page_capacity_exceeded`，查找 Registry 中 `busy=false` 的 affinity binding。
3. 按 `lastUsedAt ASC` 选择最久未使用；tie 使用 stable Conversation id 顺序保证测试确定性。
4. 解绑并 `lease.release()`，让 Page 回到 PagePool idle set。
5. 重试一次 acquire；PagePool 可直接复用同一个物理 Page。

busy binding 永不 eviction。

如果所有容量都被 busy request 占用：

```text
page_capacity_exceeded
```

Phase 4 不新增独立 global Page-capacity waiting queue。

### 20.4 Idle Timeout

新增生产配置：

```text
PAGE_IDLE_TIMEOUT_MINUTES=30
```

Registry 使用**单个可重排 timer**管理最早到期 binding，而不是每 Conversation 一个 timer：

- binding 变 idle 时计算 expiry。
- timer 到期关闭所有已过期、仍 `busy=false` 的 affinity Page。
- busy request 不因 timer 被中断。
- timer 使用 `unref()`，不得阻止 Node 进程退出。
- 每次 binding 更新后重新安排下一个最早 expiry。

idle timeout 要真正释放物理 Page，而不只是解除 affinity。

因此 `PageLease` 建议扩展一个明确的终止操作：

```ts
interface PageLease {
  readonly page: Page;
  release(): Promise<void>; // return to pool idle set
  close(): Promise<void>;   // close Page and remove from pool capacity
}
```

两者都必须幂等。

- LRU pressure：优先 `release()`，复用现有物理 Page。
- idle timeout：`close()`，真正回收资源。

### 20.5 Page Close / Crash

Registry 每次使用 binding 前检查 Page 是否仍可用；Page 已关闭时立即删除 binding。

当前请求中 Page/Context runtime failure：

- 不关闭其他 Conversation Page。
- 当前 binding 不继续保留。
- 如果已经 mark `in_flight`，checkpoint 留作下一轮 REBUILD。

## 21. ChatGPT Driver Contract（网页驱动接口）

Phase 3 `sendText()` 内部强制 `goto(chatgpt.com/)`，Phase 4 必须拆分导航和发送。

推荐稳定接口：

```ts
export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;

  openConversation(
    page: Page,
    conversationUrl: string,
  ): Promise<'restored' | 'not_restorable'>;

  sendText(
    page: Page,
    request: ChatGptTextRequest,
  ): Promise<ChatGptTextResult>;
}
```

### 21.1 `openFresh`

```text
goto https://chatgpt.com/
→ domcontentloaded
→ AuthProbe
→ Composer unique readiness
```

不产生 user turn。

### 21.2 `openConversation`

必须先验证 persisted URL：

- protocol 必须 `https:`。
- hostname 必须严格 `chatgpt.com`。
- pathname 必须不是 `/`。

禁止对任意 SQLite URL 直接 `page.goto()`，避免持久化数据损坏导致导航到外部 origin 并泄漏 ChatGPT browser credentials。

如果当前 Page 已经位于同一个 canonical Conversation pathname，可跳过网络 navigation，但仍重新执行 Auth/Composer readiness。

否则导航 saved URL。

结果：

- 最终仍是相同 Conversation pathname + ready → `restored`。
- 明确被重定向到 Fresh/root 或 Conversation 不存在 → `not_restorable`。
- `auth_required` → 原错误。
- `selector_missing` / `selector_ambiguous` → 原错误。
- Browser runtime/navigation failure → `browser_unavailable`。

不能用 `catch { return not_restorable }` 吞掉所有外部错误。

### 21.3 `sendText`

不导航。

继续复用 Phase 3 已验证行为：

```text
capture Assistant baseline
→ fill composer
→ click send
→ wait new Assistant index=baseline
→ generation state + stable text completion
→ return text + page.url()
```

成功 URL 仍必须经过 safe ChatGPT URL validation 后才能持久化为 Conversation URL。

## 22. Conversation Engine（执行编排）

建议入口继续实现现有 `NormalizedExecutionHandler`，这样 Chat Completions / Responses 路由不感知 Conversation 细节。

### 22.1 Keyed Flow

```text
queue.run(key)
  ↓
load latest aggregate by key
  ↓
validate + canonicalize request
  ↓
plan Context Sync
  ↓
acquire/reuse Page through Registry
  ↓
prepare Fresh or existing Conversation
  ↓
RESTORE not_restorable ? → switch to REBUILD
  ↓
mark/create in_flight checkpoint
  ↓
send Context or Append Envelope
  ↓
Assistant completed
  ↓
build/reconcile final aggregate
  ↓
ConversationStore.save(clean)
  ↓
retain successful keyed Page affinity
  ↓
return protocol-neutral text result
```

### 22.2 Failure Flow

**Before `in_flight`:**

- DB confirmed state保持不变。
- 当前新 lease 释放。
- 已存在 affinity 如果仍可用可根据错误类型保守解绑；Phase 4 默认失败后解绑，下一次重新 RESTORE，避免长期保留未知 Page state。

**After `in_flight`:**

- checkpoint 保持 `in_flight`。
- 当前 binding 解绑/release。
- 不写 synthetic Assistant。
- 返回稳定错误。
- 下一同 key 请求 REBUILD。

### 22.3 Success Result

保持 Phase 3 protocol-neutral result：

```ts
interface TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}
```

API Encoder 不需要读取 Conversation aggregate。

## 23. Error Boundary（稳定错误边界）

Phase 3 Browser / Driver codes 保留：

```text
auth_required
browser_unavailable
browser_maintenance_mode
page_capacity_exceeded
selector_missing
selector_ambiguous
chatgpt_generation_timeout
chatgpt_response_missing
```

Phase 4 替换临时 capability code：

```text
unsupported_phase4_request
invalid_conversation_request
```

推荐映射：

| Code | HTTP | OpenAI type | 含义 |
|---|---:|---|---|
| `unsupported_phase4_request` | 501 | `server_error` | 请求需要 Streaming/附件/Tools/Structured Output/图片等后续阶段 |
| `invalid_conversation_request` | 400 | `invalid_request_error` | Conversation 请求形状无法形成当前 trailing user turn 等语义错误 |

`conversation_sync_not_implemented` 不再用于已支持的 key / 多轮文本路径。

`RESTORE not_restorable` 是内部控制流，不直接作为公共错误；若后续 REBUILD 成功，请求正常成功。REBUILD 自身失败时暴露真实稳定 Driver/Browser error。

API error mapper 需要允许 execution code 指定 `type`，不能继续假设所有 execution error 都是 `server_error`。

Persistence data corruption / impossible aggregate state 不返回 SQLite SQL、路径或用户正文；映射为普通 500 server error，并保留受控内部诊断。

## 24. Configuration（配置）

新增：

```text
PAGE_IDLE_TIMEOUT_MINUTES=30
```

推荐验证范围：

```text
1 .. 1440
```

继续保留：

```text
MAX_ACTIVE_PAGES=4
```

二者都属于运行调优，不是 OpenAI API 协议承诺。

Phase 4 不增加：

- Conversation queue length env。
- RESTORE retry count env。
- REBUILD enable/disable switch。
- auto conversation inference switch。
- arbitrary ChatGPT URL override。

先保持确定性产品语义，避免配置组合爆炸。

## 25. Runtime Lifecycle（运行时生命周期）

Headless Gateway：

```text
open Persistence
→ launch BrowserManager/PagePool
→ create ChatGPT Driver
→ create Conversation Queue
→ create Conversation Page Registry
→ create Conversation Engine
→ build Fastify
→ listen
```

Shutdown：

```text
stop accepting HTTP / await Fastify in-flight handlers
→ close Conversation Queue to new work
→ close Page Registry timer + release affinities
→ close PagePool / BrowserContext
→ close Persistence
```

`UI_MODE=novnc` 继续不启动产品 BrowserManager；POST Conversation execution 返回既有 `browser_maintenance_mode`。

Queue / Registry 都必须幂等关闭。

## 26. Security and Privacy（安全与隐私）

- ConversationKey、URL 和 fingerprints 可以用于受控诊断，但普通日志不得输出完整 message/instruction content。
- persisted ChatGPT URL 必须严格限制到 `https://chatgpt.com`，禁止 arbitrary-origin restore。
- Browser Profile/Cookie/Local Storage 继续不得进入 SQLite 普通 message 字段、日志或 Git。
- Context Envelope 使用 JSON serialization 防止结构破坏，但不宣称能够消除 prompt injection。
- REBUILD 不抓取旧 DOM transcript 作为事实来源，避免网页中潜在非 API 内容被静默吸收到本地 Conversation。
- 无 key Conversation 永久持久化属于当前已批准语义；Phase 4 不实现 TTL，因此运营者应把数据库继续视为敏感数据。
- 不调用 ChatGPT 私有 `/backend-api`。

## 27. Deterministic Test Strategy（确定性测试）

`corepack pnpm verify` 继续不得访问真实 ChatGPT。

### 27.1 Context Unit Tests

覆盖：

- text-part canonicalization。
- system/developer canonicalization。
- stable SHA-256 fingerprint。
- single-user → incremental。
- multiple/user+assistant → full。
- new Conversation → FRESH。
- full exact prefix + one user + affinity → APPEND。
- full exact prefix + one user + no Page + URL → RESTORE。
- incremental + clean + affinity → APPEND。
- incremental + no Page + URL → RESTORE。
- history edit / rollback / compression / branch → REBUILD。
- full request multiple unsynced turns → REBUILD。
- instructions change → REBUILD。
- `in_flight` → REBUILD。
- clean but count mismatch → REBUILD。
- URL missing → REBUILD。

### 27.2 Persistence Tests

真实临时 SQLite：

- migration `002` 只执行一次并进入 checksum history。
- legacy row 默认 clean/count=0。
- checkpoint JSON/type round-trip 不存在；字段保持关系型。
- `markSyncInFlight` 只更新 metadata，不改 child rows。
- final aggregate save 原子推进 clean/count。
- close → reopen 保留 URL/checkpoint/messages。
- invalid checkpoint invariant 被拒绝。

### 27.3 Queue Tests

- same key FIFO。
- 前一个 reject 不阻塞后一个。
- queued work 开始时才调用 state loader。
- different key work 可以 overlap。
- queue entry 在尾任务完成后清理。

### 27.4 Page Registry Tests

使用 fake PagePool / Page：

- keyed affinity reuse。
- unkeyed transient release。
- capacity pressure LRU eviction。
- busy binding 不被 eviction。
- all busy → `page_capacity_exceeded`。
- idle timeout close physical Page。
- LRU pressure 使用 release/reuse 而不是无条件 new Page。
- closed Page binding 自动失效。
- timer reschedule / `close()` 幂等。

使用 fake clock/timer，不让测试真实等待 30 分钟。

### 27.5 Driver Tests

- `openFresh` auth/composer readiness。
- valid saved URL restore。
- current same URL short-circuit navigation。
- foreign origin URL 在 `page.goto` 前被拒绝/判不可恢复。
- root redirect → `not_restorable`。
- auth_required 不降级为 `not_restorable`。
- selector error 不降级为 `not_restorable`。
- `sendText` 不自行导航。
- Assistant baseline/completion 行为继续通过 Phase 3 regression tests。

### 27.6 Conversation Engine Integration Tests

真实临时 SQLite + fake Driver/Page：

1. 新 keyed request FRESH → clean aggregate。
2. 第二轮 full history → 只发送 current user Append Envelope。
3. 第二轮 incremental → APPEND。
4. idle/LRU Page 丢失 → RESTORE。
5. Persistence close/reopen + 新 Engine → RESTORE。
6. RESTORE `not_restorable` → REBUILD。
7. full history divergence → REBUILD，并替换 URL。
8. incremental instructions change → REBUILD，保留旧 history。
9. 模拟 `in_flight` crash → 下一请求 REBUILD。
10. send error after checkpoint → DB 保持 in_flight。
11. same key 并发 HTTP/Engine calls FIFO。
12. different keys 可以并行直到 Page capacity。
13. unkeyed request持久化但无 affinity。
14. Chat Completions / Responses 继续共享同一 Engine。

## 28. Real ChatGPT E2E（真实网页验收）

Phase 4 真实 E2E 继续：

- 显式 `E2E_CHATGPT=1`。
- 必须使用独立 E2E Profile。
- 不进入普通 `verify`。
- 需要当前环境代理时显式 `CHATGPT_PROXY_SERVER`。

Phase 4 至少验证：

### 28.1 Keyed FRESH + Full-History APPEND

1. 使用随机 `X-Conversation-Key` 和随机 token A 发第一轮。
2. 读取 SQLite，确认 clean、count=2、保存非 root ChatGPT URL。
3. 第二轮使用常见 OpenAI full history：`user1 + assistant1 + user2(token B)`。
4. HTTP 200，回答满足 challenge。
5. SQLite URL 与第一轮相同。
6. 使用已验证 user-turn collection 检查同一网页第二个 Web user turn：包含 token B，**不包含 token A / 第一轮完整历史**。

这条真实证明“第二轮没有重复灌入第一轮完整历史”，而不只证明回答看起来正确。

### 28.2 Gateway Restart RESTORE

1. 完成 keyed Conversation 第一/第二轮。
2. 关闭 runtime，保持同一 SQLite data dir 和 E2E Browser Profile。
3. 创建新的 runtime。
4. 只发送 incremental user challenge。
5. 回答需要引用此前已建立的上下文。
6. SQLite ChatGPT URL 保持同一 Conversation URL。

### 28.3 Divergence REBUILD

1. 对已存在 key 发送修改过旧 Assistant/User history 的 full request。
2. 请求成功。
3. SQLite ConversationKey / UUID 不变。
4. ChatGPT URL 变成新的非 root Conversation URL。
5. 回答遵循修改后的 authoritative history，而不是旧网页上下文。

真实 E2E 不要求覆盖所有 LRU/Queue race；这些由 deterministic tests 验证。

## 29. Architecture Enforcement（架构自动约束）

Phase 4 应收紧 `scripts/check-architecture.mjs`：

1. `context/` 禁止导入 `playwright`、`api/`、`chatgpt/`、`persistence/`。
2. `browser/` 继续禁止导入 `api/`、`persistence/`、`chatgpt/`、`conversations/`。
3. `chatgpt/` 继续禁止导入 `api/`、`persistence/`、Conversation Engine/Page Registry。
4. `api/` 继续禁止导入 `playwright` / selectors。
5. `persistence/` 继续禁止导入 `playwright`。
6. ChatGPT selector literal 继续只允许定义在 `src/chatgpt/selectors.ts`。
7. `process.env` 生产读取继续只允许 `src/config/`。

Conversation Engine 可以依赖 `context/`、`persistence/`、`browser` abstraction 和 `chatgpt` Driver interface；反向依赖禁止。

## 30. API Compatibility Honesty（兼容真实性）

Phase 4 实现后，才可以把当前实际支持范围更新为：

- Chat Completions / Responses 非流式纯文本。
- `X-Conversation-Key` keyed multi-turn。
- full-history prefix APPEND。
- incremental keyed APPEND。
- restart/Page-loss RESTORE。
- divergence/instructions/uncertain-state REBUILD。

仍不能声明：

- Streaming。
- attachments/files。
- Tool Calling execution。
- Structured Output guarantee。
- image generation。

无 key 请求仍是独立 Fresh/Context Envelope 执行，不进行跨请求自动续接。

本设计文档获批本身**不改变当前 Phase 3 产品能力**；只有 Phase 4 实现和验收完成后，`api-compatibility.md` 的 Current Implementation 才能升级。

## 31. Acceptance Criteria（Phase 4 验收）

Phase 4 实现只有全部满足才可标记 complete：

1. `X-Conversation-Key` 不再触发 `conversation_sync_not_implemented`，新 key 可 FRESH。
2. keyed Conversation 同时支持 full-history 和 single-user incremental 请求。
3. Context Planner 是纯逻辑模块并覆盖四种 mode。
4. full history exact prefix 时第二轮只发送 current user，不重复旧历史。
5. history divergence 自动 REBUILD，key / local Conversation id 保持不变。
6. instructions change 自动 REBUILD，并保留已有 confirmed history。
7. migration `002` 提供 clean/in_flight + synced count checkpoint。
8. 网页 write 前持久化 in_flight，成功后原子推进 clean/count/URL/messages。
9. 任意 post-checkpoint unknown failure 不错误回滚 clean；下一请求 REBUILD。
10. 同 key FIFO，不同 key 可并行；排队请求不提前占 Page。
11. keyed Page affinity 生效。
12. `PAGE_IDLE_TIMEOUT_MINUTES=30` 默认生效并真正关闭过期 idle Page。
13. capacity pressure 可 LRU 释放最久 idle affinity；busy Page 不 eviction。
14. 所有 Page busy 时稳定返回现有 `page_capacity_exceeded`。
15. Driver 拆分 Fresh / Conversation restore / send，`sendText` 不再强制 Fresh navigation。
16. persisted Conversation URL 只允许安全 `https://chatgpt.com` restore。
17. `not_restorable` 自动 REBUILD；auth/selector/browser error 不被吞掉。
18. 无 key 请求完整持久化但不建立跨请求 affinity/identity。
19. Chat Completions / Responses 继续复用同一 Conversation Engine。
20. Phase 4 unsupported capability 继续明确 501；语义无效 Conversation 请求使用 400 invalid_request_error。
21. `corepack pnpm verify` 全绿且不访问真实 ChatGPT。
22. fresh Docker build/smoke 全绿；新增 idle config 正确透传。
23. 独立 E2E Profile 的 keyed FRESH + full-history APPEND 真实通过，并验证第二 Web user turn 不含第一轮历史。
24. Gateway restart 后真实 RESTORE 通过，继续同一 ChatGPT URL。
25. 至少一次真实 divergence REBUILD 通过并获得新 URL。
26. architecture/project-memory/docs 检查与实际实现一致。
27. 未完成真实 E2E 时，PROJECT_STATE 保持 Phase 4 implementation/blocked，不得仅凭 fake Driver 测试标记 complete。

## 32. Recommended Implementation Order（推荐实施顺序）

后续 plan 应按独立可验收闭环拆分：

1. migration `002` + persistence checkpoint types/repository/store。
2. canonicalize + fingerprint + pure Context Planner。
3. same-key FIFO Queue。
4. PageLease close + Conversation Page Registry + idle/LRU。
5. ChatGPT Driver Fresh/Restore/Send 拆分与 safe URL restore。
6. Conversation aggregate builder / message identity reconciliation。
7. Conversation Engine FRESH + APPEND。
8. RESTORE + `not_restorable → REBUILD`。
9. crash checkpoint / REBUILD convergence tests。
10. API error/capability boundary + runtime wiring。
11. config / architecture checks / deterministic integration tests。
12. Docker smoke adjustments。
13. docs/project-memory writeback。
14. explicit real FRESH+APPEND E2E。
15. explicit restart RESTORE E2E。
16. explicit divergence REBUILD E2E。
17. 只有全部验收通过后关闭 Phase 4。

## 33. Known Limitations / Deferred Decisions（已知限制）

- 无 key Conversation 会持续保存在 SQLite；Phase 4 不提供 retention/GC。
- REBUILD 会留下旧 ChatGPT server-side Conversation orphan；不通过网页或私有 API 自动删除。
- 同 key FIFO 只在单 Gateway process 内成立；V1 不支持多进程共享写入。
- Prompt Envelope 无法提供 OpenAI 原生 system privilege，仍是 Web prompt 近似映射。
- ChatGPT URL/DOM 属于外部变化面；真实 E2E 是 RESTORE/APPEND 可用性的最终证据。
- Phase 4 只处理纯文本 Message。附件和 Tool Result 如何参与 canonical history / fingerprint 必须在对应 Phase 扩展本设计，而不是提前偷偷编码。

## 34. Design Rationale Summary（设计理由摘要）

Phase 4 的核心原则是：

> **能证明一致才 APPEND；不能证明一致就 REBUILD。**

因此系统不依赖 DOM transcript 猜测历史，不在未知崩溃窗口中猜“网页到底有没有收到”，也不通过复杂 patch 修复旧 ChatGPT Conversation。

SQLite 保存完整本地 Conversation 与最小 checkpoint；ChatGPT URL 是可恢复位置；Page 是可丢弃运行时缓存。这个边界让 Phase 4 可以在保持实现简单的同时，为后续 Streaming、附件和 Tool Calling 提供确定的 Conversation foundation。
