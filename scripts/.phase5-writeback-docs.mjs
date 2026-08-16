import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Expected ${label} was not found`);
  return next;
}

function patch(path, transform) {
  const source = readFileSync(path, 'utf8');
  const next = transform(source);
  writeFileSync(path, next);
}

patch('docs/superpowers/specs/2026-08-16-phase-5-true-streaming-design.md', (source) =>
  replaceOnce(
    source,
    '**Status:** Draft complete; awaiting user review and approval',
    '**Status:** Approved; implementation complete; authenticated real E2E acceptance blocked',
    'Phase 5 spec status',
  ),
);

patch('docs/architecture.md', (source) => {
  let next = source;
  next = replaceOnce(
    next,
    /Phase 4 Conversation Engine 接受非流式纯文本多轮请求，要求最终消息为非空 `user`。[\s\S]*?以稳定 `unsupported_phase4_request` 明确拒绝。/,
    'Phase 5 Conversation Engine 继续复用 Phase 4 的 `FRESH | APPEND | RESTORE | REBUILD`、same-key FIFO、Page affinity 与 SQLite `clean | in_flight` checkpoint，并提供 protocol-neutral `{ execute, stream }` 两条纯文本执行入口。`stream=true` 不改变 Context Sync：FRESH/REBUILD 仍发送完整 Context Envelope，APPEND/RESTORE 仍只发送 `current_user`。附件、Tools、Structured Output 与 image execution 仍由 `unsupported_phase5_request` 明确拒绝。Streaming 整个生命周期（包含 abort cleanup）都在 same-key Queue 内；不同 key 仍可并行。',
    'Phase 4 execution paragraph',
  );
  next = replaceOnce(
    next,
    /## Streaming（流式输出）[\s\S]*?\n## Tool Calling（工具调用）/,
    `## Streaming（流式输出）

Phase 5 已实现纯文本真 Streaming 的代码路径：

\`\`\`text
Target Assistant DOM Turn
   ↓ observe() ~200ms
AssistantSnapshot
   ↓ CRLF/CR normalize
3-sample Stable Prefix
   ↓ non-empty Delta
Protocol-neutral TextStreamEvent
   ├── Chat Completions SSE Encoder
   └── Responses SSE Encoder
\`\`\`

\`src/stream/\` 是纯逻辑层，不依赖 Playwright、\`api/\`、\`browser/\`、\`chatgpt/\`、\`persistence/\` 或 \`node:sqlite\`。Assistant ownership 仍由发送前 \`assistantTurns.count()\` 的 baseline 决定；Driver 的 \`ChatGptTextTurn\` 只观察固定 target turn，并提供 \`observe()\`、严格唯一 Stop 的 \`stop()\` 和安全 \`conversationUrl()\`。

Stable Prefix 只提交最近 3 个 snapshot 的 longest common prefix；已经发送的 prefix 永不撤回。若后续 DOM 不再以 committed prefix 开头，进入稳定 \`chatgpt_stream_diverged\`，不发送 correction/backspace。Completion 以 target turn 自身的 \`copy-turn-action-button\` marker + 连续稳定 final text + final reread 为终态，不把可能滞留的全局 Stop control 当成功必要条件。

Conversation Engine 在首个 protocol-neutral \`started\` 后、第一次可能写网页 turn 前持久化 \`in_flight\`。若客户端在首帧后立即断开，Engine 会在 checkpoint 前检查 AbortSignal；若断开发生在 checkpoint 后但 Send 前，Driver 在 baseline/composer/fill/send 异步边界继续检查同一个 signal，保证不继续点击 Send。生成中 abort 会 best-effort Stop、不保存 partial Assistant、保持 \`in_flight\` 并 discard 当前 Page；下一 keyed request 通过 REBUILD 收敛。

成功流只有在 final Assistant text、安全 Conversation URL 和完整 aggregate 已经原子保存为 clean 后才发送成功 terminal。final save 失败不发送 \`[DONE]\` / \`response.completed\`；clean commit 后才发生的 terminal transport close 不回滚已经确定完成的网页 turn。

HTTP 层第一次收到 internal \`started\` 才通过 Fastify \`reply.hijack()\` 接管 raw SSE。SSE writer 尊重 Node writable backpressure；pre-start error 保持普通 OpenAI-style 非 200 JSON，post-start error 使用协议内 error framing 且不伪造成功终止。

Chat Completions 与 Responses 使用独立 Encoder，但共享同一 internal stream event。Phase 5 real E2E harness 已使用真实 TCP listener 增量读取响应；本次实现后尚未在已登录隔离 Profile 上运行 authenticated Phase 5 E2E，因此当前真实 ChatGPT DOM 的时间行为仍以 \`PROJECT_STATE.md\` 的 blocker 为准。

## Tool Calling（工具调用）`,
    'Streaming architecture section',
  );
  return next;
});

patch('docs/testing.md', (source) => {
  let next = source;
  next = replaceOnce(
    next,
    `E2E_CHATGPT=1 \\
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \\
CHATGPT_PROXY_SERVER=http://proxy-host:port \\
corepack pnpm test:e2e:chatgpt:phase4
\`\`\``,
    `E2E_CHATGPT=1 \\
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \\
CHATGPT_PROXY_SERVER=http://proxy-host:port \\
corepack pnpm test:e2e:chatgpt:phase4

E2E_CHATGPT=1 \\
CHATGPT_PROFILE_DIR=/path/to/e2e-browser-profile \\
CHATGPT_PROXY_SERVER=http://proxy-host:port \\
corepack pnpm test:e2e:chatgpt:phase5
\`\`\``,
    'Phase 5 E2E command block',
  );
  next = replaceOnce(
    next,
    /当前 `corepack pnpm verify` 已组合 format、lint、typecheck、unit\/integration test、build 和全部仓库治理检查。[\s\S]*?使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。/,
    '当前 `corepack pnpm verify` 已组合 format、lint、typecheck、unit/integration test、build 和全部仓库治理检查。Phase 5 deterministic coverage 已新增 Snapshot normalization、Unicode-safe Stable Prefix、completion/divergence、Assistant turn handle/Stop/pre-Send abort、SSE backpressure、Chat Completions / Responses encoders、真实本地 TCP route streaming、FRESH/APPEND/RESTORE/REBUILD、same-key FIFO / different-key parallel、final-save failure、生成中 abort 与首帧后取消。最终 branch-head 只读 CI 已实际通过完整 `verify`；测试数量不在本文手工固定，以 fresh Vitest 输出为准。使用 Corepack 是正式入口，不要求宿主机全局安装 pnpm。',
    'deterministic baseline paragraph',
  );
  next = replaceOnce(
    next,
    /真实 E2E 没有通过时，最终汇报必须明确实际停在哪个外部边界。[\s\S]*?这些后续能力仍必须各自做 deterministic \+ real E2E。/,
    '真实 E2E 没有通过时，最终汇报必须明确实际停在哪个外部边界。Phase 3 与 Phase 4 已有 authenticated real E2E 历史通过证据。Phase 5 real harness 已实现真实 TCP listener 增量读取，包含：长回复在 target completion marker 之前收到 meaningful delta、Markdown/code 最终文本一致性、Responses typed SSE、client abort 后 `in_flight` 与 same-key REBUILD。本次 Phase 5 实现后由于当前工具环境无法访问隔离已登录 Browser Profile / LAN proxy，**没有实际运行** `test:e2e:chatgpt:phase5` 或包含 Phase 5 的 combined real E2E；因此不能把 deterministic/Docker 成功外推为当前 ChatGPT DOM 真 Streaming 已验收。',
    'real E2E final boundary paragraph',
  );
  next += `

### Phase 5 Docker 验收事实

Phase 5 最终 branch-head 只读 CI 已实际完成 fresh \`linux/amd64\` Docker build 与完整 \`docker:smoke\`。Smoke 的产品断言覆盖 normal/maintenance single owner、SQLite migrations/restart、PUID/PGID、Chrome sandbox/seccomp 与 noVNC RFB；验收期间还修复了 hosted runner 的临时 bind mount cleanup：容器会按测试 PUID/PGID 改变挂载目录 ownership，cleanup container 现在先清空内容并把挂载根 ownership 恢复给宿主进程，再由宿主删除临时目录。该修复只作用于 smoke 清理，不改变产品容器运行身份。
`;
  return next;
});

patch('docs/superpowers/plans/2026-08-16-phase-5-true-streaming.md', (source) => {
  let next = source;
  next = replaceOnce(
    next,
    '**Tech Stack:** TypeScript 6、Node 24、Fastify 5、Playwright 1.62.1、Vitest 4、Node `http.ServerResponse` SSE、SQLite `node:sqlite`。',
    `**Tech Stack:** TypeScript 6、Node 24、Fastify 5、Playwright 1.62.1、Vitest 4、Node \`http.ServerResponse\` SSE、SQLite \`node:sqlite\`。

**Execution status (2026-08-16):** Tasks 1–11 的设计激活、产品实现、TDD、deterministic integration、真实 TCP E2E harness 与 combined harness 接入均已完成；Task 12 的 fresh deterministic 与 Docker build/smoke 已通过。当前仅 authenticated \`inspect:chatgpt\`、Phase 5 real E2E 和 combined Phase 3/4/5 real E2E 因本会话无法访问隔离已登录 Browser Profile / LAN proxy 而阻塞，因此 Phase 5 保持开放。`,
    'plan execution status anchor',
  );

  const taskMarker = /^### Task (\d+):/gm;
  const matches = [...next.matchAll(taskMarker)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const task = Number(matches[i][1]);
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : next.length;
    let section = next.slice(start, end);
    if (task <= 11) section = section.replaceAll('- [ ]', '- [x]');
    if (task === 12) {
      section = section
        .replace('- [ ] **Step 1: Fresh deterministic final verification**', '- [x] **Step 1: Fresh deterministic final verification**')
        .replace('- [ ] **Step 2: Fresh Docker validation**', '- [x] **Step 2: Fresh Docker validation**')
        .replace('- [ ] **Step 3: Authenticated DOM inspection**', '- [!] **Step 3: Authenticated DOM inspection**')
        .replace('- [ ] **Step 4: Standalone Phase 5 real E2E**', '- [!] **Step 4: Standalone Phase 5 real E2E**')
        .replace('- [ ] **Step 5: Combined real E2E regression**', '- [!] **Step 5: Combined real E2E regression**')
        .replace('- [ ] **Step 6: Final docs writeback**', '- [x] **Step 6: Final docs writeback**')
        .replace('- [ ] **Step 8: Final documentation commit**', '- [x] **Step 8: Final documentation commit**')
        .replace('- [ ] **Step 9: Push feature branch**', '- [x] **Step 9: Push feature branch**');
    }
    next = next.slice(0, start) + section + next.slice(end);
  }
  return next;
});
