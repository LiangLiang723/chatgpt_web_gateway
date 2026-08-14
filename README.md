# ChatGPT Web Gateway

一个只面向 **ChatGPT Web（ChatGPT 网页）** 的 OpenAI Compatible API（OpenAI 兼容接口）网关。

项目使用 Playwright（浏览器自动化框架）自带 Chromium（浏览器）操作 `chatgpt.com`，把网页能力转换为通用 OpenAI 风格接口，供任意支持 OpenAI API（应用程序接口）的 Agent（智能体）或客户端调用。

## V1 已批准目标

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
- 文本、图片 URL、Base64 图片、文件输入
- `file_id` 文件复用
- Tool Calling（工具调用）
- 真 DOM（文档对象模型）Streaming（流式输出）
- 完整 Conversation（对话）持久化
- SQLite（嵌入式数据库）保存结构化状态
- 同 Conversation 串行、不同 Conversation 可并行
- ChatGPT 图片生成；V1 为非流式、`n=1`

## 明确不做

- Claude / Gemini / Grok 等其他 Provider（服务商）
- Anthropic Compatible API（Anthropic 兼容接口）
- ChatGPT 私有 `/backend-api` 逆向调用
- Google Chrome / Edge / Firefox / WebKit 兼容层
- noVNC（网页远程桌面）核心依赖
- Audio（音频）、Embeddings（向量嵌入）、Realtime（实时接口）、Batches（批处理）、Fine-tuning（微调）、Vector Stores（向量存储）等无法自然映射到 ChatGPT Web 的接口

## 架构概览

```text
任意 OpenAI API Client / Agent
            │
            ▼
 OpenAI Compatible API
            │
            ▼
   Request Normalizer
            │
            ▼
  Conversation Engine
      ├── Context Sync
      ├── Tool Manager
      ├── Attachments
      └── Streaming
            │
            ▼
     ChatGPT Driver
            │
            ▼
       Playwright
            │
            ▼
 Playwright Chromium
            │
            ▼
       chatgpt.com
```

## Living Repository（活仓库）

本项目不把聊天记录当作项目记忆。长期事实必须写回仓库：

- [`AGENTS.md`](AGENTS.md)：Agent 怎么工作。
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)：现在真实实现到哪里、下一步是什么。
- [`V1 governing spec`](docs/superpowers/specs/2026-08-14-chatgpt-web-gateway-v1-design.md)：已经批准的产品边界和核心设计。
- [`docs/architecture.md`](docs/architecture.md)：系统为什么这样设计。
- [`docs/api-compatibility.md`](docs/api-compatibility.md)：当前对外协议兼容程度。
- [`docs/project-memory-protocol.md`](docs/project-memory-protocol.md)：任务结束时哪些事实必须回写。
- [`docs/superpowers/specs/`](docs/superpowers/specs/)：设计决策。
- [`docs/superpowers/plans/`](docs/superpowers/plans/)：实施计划与执行状态。

仓库提供机器检查：

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
```

如果本机安装了 pnpm（高性能 Node.js 包管理器），也可以运行：

```bash
pnpm verify:repo
```

## 当前真实状态

**目前只有项目治理、架构和空模块骨架，尚未实现 HTTP Server（HTTP 服务）、Playwright 自动化、SQLite 或 API 路由。**

V1 目标不代表已经实现。请始终以 [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md) 的 `Implemented Now（当前已实现）` 为准。

## 开始开发

Agent / 开发者进入仓库后先阅读：

1. [`AGENTS.md`](AGENTS.md)
2. [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)
3. `PROJECT_STATE` 指向的 Active Plan（活动计划）
4. 当前任务相关文档、源码与测试

开发完整流程见 [`docs/development-workflow.md`](docs/development-workflow.md)。

## 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。你可以自由使用、修改、分发和二次开发，但需保留原始版权与许可声明。
