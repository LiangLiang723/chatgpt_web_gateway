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
- Chat Completions / Responses SSE Encoder（流式编码器）。

## Integration（集成测试）

使用 local fixture（本地固定样本）和 fake driver（假驱动），不连接 ChatGPT：

- Phase 1：Fastify HTTP → Schema → Normalizer → injected fake execution boundary。
- 后续：API → Normalizer → Conversation Engine → fake ChatGPT Driver。
- SQLite Repository。
- Conversation Queue（队列）。
- Page Pool 策略。
- 文件元数据 + 文件系统。
- Client abort（客户端断开）→ stop generation。

## E2E（端到端）

真实 ChatGPT E2E 默认关闭：

```text
E2E_CHATGPT=1
```

使用独立测试 Browser Profile（浏览器配置），不得使用个人日常浏览器 Profile。

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

后续产品代码必须提供 `pnpm inspect:chatgpt`，至少报告 Composer（输入框）、Send Button（发送按钮）、Assistant Turn（回复节点）、Stop Button（停止按钮）、File Input（文件输入）、URL、Auth State（认证状态）。

真实页面失败允许保存受控诊断 screenshot（截图）和 DOM snapshot（网页快照）；默认普通日志不重复记录完整用户正文。

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
- noVNC overlay 只在维护配置下启动并发布端口。

Docker smoke 不等于真实 ChatGPT E2E，不能用来证明 Selector、登录、上传或图片生成有效。

## 最终目标验证入口

Phase 1 建立完整工具链后：

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm check:architecture
pnpm check:project-memory
pnpm check:docs
pnpm check:version
pnpm build
pnpm verify
```

`pnpm verify` 必须是本地确定性检查，不自动访问真实 ChatGPT。

## 不能伪造的验证

只有真实 E2E 才能证明：

- ChatGPT 当前 Selector 可用。
- Browser Profile 当前仍登录。
- 文件实际上传成功。
- 图片实际生成并能下载。
- 当前 ChatGPT UI 没有破坏完成检测。

没有跑 E2E 时，最终汇报必须明确“未验证真实 ChatGPT 网页”。
