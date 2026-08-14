# Security（安全）

本项目通过已登录 ChatGPT Web（ChatGPT 网页）的浏览器 Profile（配置目录）运行，因此浏览器状态本身属于高敏感数据。

## 禁止提交到 Git

- `data/browser-profile/`
- Cookie（浏览器会话凭据）
- Token（令牌）/ API Key（接口密钥）/ Password（密码）
- `data/gateway.db`
- 真实用户上传文件
- ChatGPT 生成图片
- 包含真实用户正文的诊断 HTML / Screenshot（截图）/ Log（日志）
- `.env`

## 运行时原则

- API 默认要求 Bearer Key（持有者密钥）认证。
- 对外错误不得泄漏 Playwright 堆栈、文件系统路径、Cookie 或页面敏感内容。
- 诊断文件和普通日志分离；诊断正文记录应由显式配置控制。
- 浏览器 Profile 使用项目专用目录，不使用个人日常浏览器 Profile。
- 上传文件和生成图片应保存在可配置数据目录，并允许部署者通过文件系统权限限制访问。

## 发现凭据泄漏

如果发现真实凭据已经进入提交历史：

1. 停止继续提交或发布。
2. 立即指出受影响凭据和文件。
3. 建议轮换相关凭据。
4. 在得到用户明确批准前，不擅自重写 Git 历史。
