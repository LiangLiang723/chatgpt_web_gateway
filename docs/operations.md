# Operations Guide（NAS 部署与运维）

本指南面向 Docker Compose NAS/家庭服务器部署。正式运行边界是 `compose.yaml` + 持久化 `${DATA_PATH}:/data`；noVNC 只用于首次登录、重新认证和人工排障。

## 1. 首次部署

准备仓库与配置：

```bash
cp .env.example .env
```

至少设置：

```dotenv
GATEWAY_API_KEY=replace-with-a-long-random-secret
DATA_PATH=./data
PUID=1000
PGID=1000
NOVNC_PASSWORD=replace-with-a-separate-strong-secret
```

可选项：

```dotenv
# ChatGPT 浏览器需要代理时显式设置；不要提交局域网地址到仓库默认配置。
CHATGPT_PROXY_SERVER=http://proxy-host:port

# 生成图片 URL 需要经过反向代理/域名时设置；仅允许无 credentials/query/hash 的 http(s) base。
PUBLIC_BASE_URL=https://gateway.example
```

确认 `${DATA_PATH}` 位于 NAS 的持久化存储，不要放在容器临时层。随后构建并启动：

```bash
docker compose build
docker compose up -d
```

检查 process liveness：

```bash
curl http://127.0.0.1:3000/health
```

检查 authenticated local diagnostics：

```bash
curl \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  http://127.0.0.1:3000/v1/diagnostics
```

`/health` 只代表 Gateway 进程可响应；`/v1/diagnostics` 只检查本地 Browser/Page/Persistence 边界，并固定报告 `auth_state=not_probed`。它们都不会偷偷访问 ChatGPT，也不能证明当前登录态有效。

## 2. 首次 ChatGPT 登录 / 重新认证

普通模式和 maintenance 模式共用生产 `/data/browser-profile/`，因此必须互斥运行。

先停止普通模式：

```bash
docker compose down
```

启动 noVNC maintenance overlay：

```bash
docker compose -f compose.yaml -f compose.novnc.yaml up -d
```

默认 noVNC 只绑定 `127.0.0.1:6080`。如 NAS 必须从其他主机访问，可显式设置 `NOVNC_BIND`，但应同时使用可信局域网、防火墙或 TLS 反向代理限制暴露面。

通过 noVNC 打开的固定 Google Chrome Stable 手工完成 ChatGPT 登录、MFA 或安全验证。项目不会自动填写账号、密码、MFA 或 CAPTCHA。

完成后关闭 maintenance，再恢复普通运行：

```bash
docker compose -f compose.yaml -f compose.novnc.yaml down
docker compose up -d
```

如果需要明确验证网页登录/DOM 状态，应使用**独立测试 Profile**运行 `corepack pnpm inspect:chatgpt`；不要拿生产 Profile 做 real E2E。

## 3. 日常更新

更新前先创建冷备份，确认备份成功后再更新代码/镜像。

若使用仓库源码构建：

```bash
git fetch --all --prune
git status --short --branch
# 切换/快进到已批准版本后：
docker compose build
docker compose up -d
```

更新后检查：

```bash
curl http://127.0.0.1:3000/health
curl \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  http://127.0.0.1:3000/v1/diagnostics
```

如果本次更新改变 Playwright/Chromium、Browser Profile 行为或 ChatGPT Driver，应按项目 `docs/testing.md` 要求重新执行显式 authenticated inspect/E2E，而不是从 `/health` 推断网页兼容性。

## 4. 冷备份

备份边界是整个 `${DATA_PATH}`，其中可能包含：

- `gateway.db` 及 SQLite 状态；
- `browser-profile/` 登录会话；
- `files/` 用户文件；
- `generated/` 生成图片；
- 其他 `/data` 运行目录。

这些内容包含高敏感凭据和用户数据，备份目录应按密码/密钥等级保护，不应同步到公开位置。

**只支持冷备份。** 先停止 Gateway：

```bash
docker compose down
```

然后创建一个不存在的新备份目录：

```bash
corepack pnpm backup:data ./data /path/to/backups/chatgpt-web-gateway-YYYYMMDD --gateway-stopped
```

CLI 会拒绝：

- 未显式传 `--gateway-stopped`；
- backup destination 位于 DATA_DIR 内；
- destination 已存在；
- DATA_DIR 缺少 `gateway.db`。

成功后备份目录包含 `BACKUP_MANIFEST.json`，manifest 标记 schema 版本与冷备份边界。备份完成后可恢复普通模式：

```bash
docker compose up -d
```

不要在 Gateway 运行中直接复制 `gateway.db` + Browser Profile 后声称获得一致备份；项目没有提供这种 hot-backup 保证。

## 5. 恢复

恢复前停止 Gateway：

```bash
docker compose down
```

目标 DATA_DIR 必须不存在或为空。若要保留当前故障现场，先把原 DATA_DIR 改名到隔离位置，不要覆盖它。

执行恢复：

```bash
corepack pnpm restore:data /path/to/backups/chatgpt-web-gateway-YYYYMMDD ./data --gateway-stopped
```

CLI 会校验受支持的 `BACKUP_MANIFEST.json`、`gateway.db` 条目、manifest entry 安全性和空目标要求。成功后启动：

```bash
docker compose up -d
```

随后先检查 `/health`、`/v1/diagnostics`；如恢复目标涉及 ChatGPT 登录状态，再使用 maintenance noVNC 或独立 `inspect:chatgpt` 明确确认登录状态。

## 6. 故障诊断

推荐按从本地到外部的顺序排查：

1. `docker compose ps`：容器是否持续运行，是否被 `restart: unless-stopped` 重新拉起。
2. `GET /health`：Gateway 进程是否响应。
3. authenticated `GET /v1/diagnostics`：`status`、`ui_mode`、Browser/Page 计数、本地 SQLite/Files/Generated Images readiness。
4. `docker compose logs --tail=200 gateway`：只检查必要日志；不要公开包含用户请求或环境细节的日志。
5. 若本地边界正常但请求返回 `auth_required` / selector / ChatGPT generation 错误，进入 maintenance noVNC 手工检查登录和网页状态。
6. 需要产品级外部证据时，用隔离测试 Profile 运行 `inspect:chatgpt` 或最窄 standalone Phase E2E。

单个 Conversation Page 执行失败后，Gateway 会关闭该 Page 而不是放回 idle pool。Persistent BrowserContext 意外关闭属于进程级 fatal：生产进程以非零状态退出，由 Compose `restart: unless-stopped` 创建新的 BrowserContext；`/data` 持久化状态不会因此删除。

## 7. 回滚

代码/镜像回滚与数据回滚分开处理：

- **代码/镜像回滚：** 停止当前版本，切回已知良好的 commit/image，再用同一 `${DATA_PATH}` 启动。只有在该旧版本明确兼容当前数据库 schema 时才这样做。
- **数据回滚：** 使用更新前的冷备份恢复到一个空 DATA_DIR；不要把旧 `gateway.db` 单独覆盖到新 Browser Profile/Files 上。

安全回滚流程：

```text
停止 Gateway
→ 保留当前故障 DATA_DIR
→ 选择已知良好代码/镜像
→ 必要时把冷备份恢复到空 DATA_DIR
→ 启动
→ /health
→ /v1/diagnostics
→ 必要时人工登录/inspect
```

当前迁移采用 checksum 顺序校验，项目不提供自动 downgrade migration。若新版本已经引入旧版本不认识的 schema，优先使用“旧代码 + 更新前完整冷备份”组合，而不是手工修改 SQLite。

## 8. 对外暴露安全边界

- `/v1/*` 必须使用长随机 Bearer API Key；不要复用 noVNC 密码。
- `PUBLIC_BASE_URL` 只改变生成图片 URL 的 base，不会绕过 `/v1/images/:id/content` 的 Bearer authentication。
- 公网暴露 Gateway 时应由反向代理提供 TLS，并限制 API/noVNC 的访问来源。
- noVNC 默认只绑定 loopback；不建议直接暴露到公网。
- `.env`、Browser Profile、SQLite、用户文件、生成图片、冷备份都不得提交到 Git。
- `CHATGPT_PROXY_SERVER` 仅支持显式 server origin，代理凭据不应写在 URL 中。
