# Development Workflow（开发流程）

## 任务启动

```text
打开工作区
→ git status
→ AGENTS.md
→ PROJECT_STATE.md
→ Active Plan
→ 任务相关文档 / 代码 / 测试
→ 明确成功标准
```

## 小任务

如果行为明确、风险低且不需要多步架构变更：

1. 读取相关实现和测试。
2. 写失败测试。
3. 写最小实现。
4. 运行相关测试。
5. 运行受影响的更大范围检查。
6. 执行项目记忆回写判断。
7. 运行仓库治理检查。
8. 检查 diff（差异）并提交。

## 长任务

满足任一条件时先建立/更新 spec（设计规格）和 plan（实施计划）：

- 跨多个模块。
- 新公开 API。
- 数据库结构变化。
- Context Sync（上下文同步）/ Streaming（流式输出）/ Browser（浏览器）恢复等核心行为变化。
- 部署方式或安全边界变化。
- 预计需要多个独立测试闭环。

长任务执行中：

```text
每个可独立验收 Task
→ 红测试
→ 最小实现
→ 绿测试
→ 更新 Plan checkbox
→ 必要时更新 PROJECT_STATE
→ 下一个 Task
```

## 项目依赖升级

用户只说“升级项目依赖”时，默认升级范围是整套基础栈，而不是只升级普通 npm package：

- Node LTS / Docker runtime baseline。
- Playwright 官方基础镜像、Playwright package 与 bundled Chromium。
- pnpm。
- TypeScript、Fastify、TypeBox / Ajv。
- Vitest、ESLint、Prettier。
- 其他生产与开发依赖。

标准流程：

```text
读取当前版本与官方兼容信息
→ 确认 Node / Playwright / Chromium / pnpm 组合
→ 分层升级并处理 breaking changes
→ 更新 packageManager / engines / Docker image pins
→ 刷新 pnpm-lock.yaml 并检查异常解析变化
→ typecheck / lint / format:check / test / build / verify
→ 重建完整 Docker 镜像
→ 核对容器内实际版本
→ Docker smoke test
→ 项目记忆与版本文档回写判断
→ git diff --check + staged diff
→ 按提交规范提交
```

新 Node LTS major 允许在这套流程中一起升级；如果某项 major upgrade 需要独立迁移或当前不兼容，应拆分任务并明确 blocker，不为了追求最新版本强行升级。

所有包版本、镜像 tag 和兼容性结论必须根据当次官方资料与实际验证确定，不凭记忆猜测。

pnpm 11 的供应链保护也属于升级验收：

- 保持默认 release-age（发布时间成熟窗口）检查，不为了追最新版本随意加入例外。
- 新依赖如果要求 lifecycle/build script，先确认用途，再把具体 package 加入 `pnpm-workspace.yaml` 的 `allowBuilds`；禁止全局放开所有 build script。
- 当前仅批准 `esbuild` 的 install script。新增 allowlist 必须和依赖升级一起审查、测试和提交。

## 完成门槛

在声称完成前必须有刚刚运行的验证证据。

仓库基础检查：

```bash
node scripts/check-project-memory.mjs
node scripts/check-docs.mjs
node scripts/check-architecture.mjs
```

完整 TypeScript（类型化 JavaScript）工具链建立后，目标总入口：

```bash
corepack pnpm verify
```

正式命令使用 Corepack 调用仓库锁定的 pnpm，不要求宿主机安装全局 pnpm。

真实 ChatGPT E2E（端到端）不应默认包含在本地确定性 `verify` 中，必须显式开启。

## 提交

提交规范见 [`git-commit-convention.md`](git-commit-convention.md)。提交前必须看 staged diff（已暂存差异），防止把浏览器 Profile（配置）、SQLite、Cookie 或真实用户文件带入 Git。
