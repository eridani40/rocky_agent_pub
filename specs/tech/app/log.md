---
type: log
title: App KB 变更记录
updated: 2026-07-31
---

# App KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴，仅记 app/ 本级 spec 文件变更；子 KB 变更见各自 `log.md`）。
> 跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。

## 2026-07-31 · v0.0.229 feature_gate §4 补漏出点：task 看板筛选条

- **`[P1]feature_gate.md` §4 漏出点清单补一行**：task 看板筛选条（全部/按 Req/按 KR）——`component-board-toolbar.tsx` BoardTaskFilterBar 渲染条件加 `isFeatureOkrOn()`，gate 关时整个筛选条不渲染（组件代码 gate 内保留不删）。此点为 v0.0.223 漏 gate 的残留，本版本补齐后 §4 清单与代码 gate 点一致。
- 详情：`specs/tech/version_logs/v0.0.229/change_plan.md`

## 2026-07-30 · v0.0.223 新建 feature gate 机制（`__FEATURE_OKR__`）

- **新建 `[P1]feature_gate.md`**：build-time 编译期常量机制——vite `define` 注入 `__FEATURE_OKR__`（`app/web/vite.config.ts`）+ `vite-env.d.ts` 类型声明 + `scripts/build-dmg.sh` 默认不 export（packaged 默认关）；**仅管前端呈现**（后端 OKR 代码/store/工具 impl 全留，gate 长期保留不删，未来开 gate 即重启）。
- **读取口统一 `lib/feature-gates.ts isFeatureOkrOn()`**（typeof-guard）：生产 define 内联后常量折叠；UT 走 `vi.stubGlobal('__FEATURE_OKR__', true/false)` 双值 mock（渲染期生效）。**勿在根 `vitest.config.ts` 加 define**——transform 期内联字面量后 stubGlobal 失效，gate=true 双值不可测（§5 test-time 注记，T2 实证）。
- **首个用例**：OKR/requirement 前端漏出点 gate 包——全景 FIXED_TABS 滤留 tasks（panorama-route）、task 卡 req span 条件渲染（task-card）、requirement 选择器隐藏 + D1-b 强制放宽（edit-fields TaskFields + entity-modal isCreateTaskBlocked 加 gate 条件）。①②⑤（工具/prompt/squad_board reminder）走 plugin 配置层摘，与 gate 两层独立。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：§4 漏出点清单落点修正——requirement 选择器实际渲染在 `component-board-edit-fields.tsx TaskFields`（非 entity-modal 文件内，T2 偏离已对齐）；其余与 spec 一致。无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.223/change_plan.md`（E/F 节）
