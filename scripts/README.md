# Repository Checks（仓库检查）

这些脚本只使用 Node.js 标准库，基础骨架阶段无需安装依赖即可运行。

- `check-project-memory.mjs`：状态字段、spec/plan 引用、核心文档和占位符。
- `check-docs.mjs`：Markdown 相对链接。
- `check-architecture.mjs`：已批准的核心模块依赖边界和 Selector 集中规则。

产品工具链建立后，这些检查要并入最终 `pnpm verify`。
