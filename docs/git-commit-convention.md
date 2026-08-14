# Git Commit Convention（提交规范）

## 标题格式

```text
<Emoji> <中文具体描述>
```

标题必须说明具体行为变化。

| Emoji | 类型 | 示例 |
|---|---|---|
| ✨ | 新功能 | `✨ 新增 Conversation 增量上下文同步` |
| 🐛 | Bug（缺陷）修复 | `🐛 修复 Markdown 重排导致流式内容重复` |
| ♻️ | 重构 | `♻️ 拆分 ChatGPT Driver 与流式稳定算法` |
| 🧪 | 测试 | `🧪 补充 Context Sync 分叉重建测试` |
| 📝 | 文档 | `📝 固化 OpenAI 接口兼容矩阵` |
| 🔧 | 配置 | `🔧 增加 Playwright Chromium 运行配置` |
| 👷 | CI（持续集成）/自动化 | `👷 增加项目记忆一致性检查` |
| 🐳 | Docker（容器） | `🐳 增加 NAS 单容器运行配置` |
| 🔒 | 安全 | `🔒 阻止浏览器 Profile 和 Token 被提交` |
| ⚡ | 性能 | `⚡ 降低 Streaming DOM 快照重复解析` |
| 🗃️ | 数据库 | `🗃️ 增加 Conversation 消息持久化表` |
| 🔥 | 删除 | `🔥 移除未使用的外部 Chrome 兼容路径` |
| 🚑 | 紧急修复 | `🚑 修复 ChatGPT 改版导致所有请求无法发送` |

禁止：`fix bug`、`update`、`WIP`、`修复问题`、`优化代码`、`修改配置` 等模糊标题。

## 粒度

一个提交对应一个可以独立解释和验证的变化。测试和最小实现天然不可分时允许同一提交；不要为了追求提交数量把一个完整闭环机械拆碎。

## 提交前

```bash
git status --short
git diff --check
git diff
git diff --staged
```

工具链完整后同时运行 `pnpm verify`。
