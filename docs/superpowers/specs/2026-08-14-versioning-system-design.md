# Versioning System Design

## Goal

把 README 与版本历史职责分开，建立稳定、可机器校验的项目版本体系。

## Decisions

- README 只描述项目定位、能力、当前状态入口和使用方式，不记录阶段性 `V1/V2` 历史。
- 公开版本、CHANGELOG 和 Git Tag 使用 `Vx.y.z`，例如 `V0.0.1`、`V1.0.2`。
- `package.json` 使用标准 `x.y.z`，不带 `V`。
- 根目录 `VERSION` 保存当前公开版本。
- `CHANGELOG.md` 是版本变化的唯一历史入口。
- `docs/versioning.md` 定义升级规则和发布流程。
- `scripts/check-version.mjs` 校验 `VERSION`、`package.json`、`CHANGELOG.md`、`PROJECT_STATE.md` 一致。
- 当前初始版本为 `V0.0.1`。

## Compatibility

历史 spec 文件名中的 `v1` 保留，因为它们属于历史设计档案；它们不再作为 README 中的产品版本展示。
