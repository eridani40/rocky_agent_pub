---
type: interface
title: Feature Gate 机制（build-time 编译期常量）
priority: P1
status: active
updated: 2026-07-31
since: v0.0.223
related: [../package/[P0]packaging_toolchain.md, frontend/[P0]tech_stack.md]
---

# Feature Gate 机制（build-time 编译期常量）

> 定位：**前端编译期常量**机制，用 vite `define` 把构建期 env 变量内联进 web bundle，让代码分支在打包时被 dead-code elimination 处理。**仅管前端呈现**（后端零涉及）；运行时不可变（要改需重新打包）。
> 需求权威：`specs/prd/version_logs/v0.0.223.md §2.1`；设计参考：`states/v0.0.223/okr-req-gate-plan.md` + `specs/research/v0.0.223-todo-okr-research.md §1`。
> 首个用例：`__FEATURE_OKR__`（v0.0.223 默认关，隐藏 OKR/requirement UI 漏出，gate 长期保留代码/spec/测试不删）。

---

## 1. 是什么 / 为什么

**问题**：某些功能要「从界面消失但不删代码」——dev 默认关、packaged 默认关，未来开 gate 即重启（无代码改动）。例：v0.0.223 OKR/requirement 成本太大暂不投用，但代码/spec/测试全留待命。

**方案**：vite `define` 编译期常量（对齐 `build-dmg.sh:94 export VITE_API_BASE` 既有编译期注入模式）。

**为什么不选其他**：
- **runtime-config.json**：那是后端 process.env 注入机制（packaged cwd=`/`）；前端打包后不读 process.env，必须编译期内联。
- **import.meta.env.VITE_***：也可，但 `define` 更显式（不绑 VITE_ 前缀）、对齐「编译期常量」语义。二选一即可，本机制选 `define`。
- **app_config / 运行时配置**：用户可见、可改；feature gate 是 build-time 技术配置，对用户不可见。

---

## 2. 机制（三件套）

### 2.1 vite define 注入

`app/web/vite.config.ts` 加：
```typescript
define: {
  __FEATURE_OKR__: JSON.stringify(process.env.FEATURE_OKR === 'true'),
}
```
- `process.env.FEATURE_OKR` 字符串 `'true'` → boolean true；其他/未设 → false。
- 编译期替换：`if (__FEATURE_OKR__) {...}` 中的常量被内联为字面 `true`/`false`，bundler dead-code elimination 移除 false 分支。

### 2.2 TS 类型声明

`app/web/src/vite-env.d.ts`（文件不存在，v0.0.223 新建）：
```typescript
/// <reference types="vite/client" />
declare const __FEATURE_OKR__: boolean;
```
MUST 声明，否则 tsc 报「未定义全局变量」。

### 2.3 build-dmg.sh 默认不 export

`scripts/build-dmg.sh` 默认**不** `export FEATURE_OKR`（即关）。未来开 OKR 重启：
```bash
export FEATURE_OKR=true
bash scripts/build-dmg.sh ...
```
零代码改动。

dev 行为：默认关（`FEATURE_OKR` 未设 → false）；调试 OKR 功能时 `FEATURE_OKR=true bun run dev`。

---

## 3. 代码读法（条件渲染）

```typescript
// panorama-route.tsx
const visibleTabs = __FEATURE_OKR__ ? FIXED_TABS : FIXED_TABS.filter(t => t.id === 'tasks');

// component-board-task-card.tsx
{__FEATURE_OKR__ && <span>src · req:{task.source.requirementId}</span>}
```

MUST：
- gate 开时（`__FEATURE_OKR__===true`）行为不变（代码/spec/测试全留）。
- gate 关时分支不渲染（不留空占位污染布局）。
- gate 仅管前端呈现；后端数据/store/API/工具 impl **全留**（gate 长期保留决策）。

---

## 4. 用例：v0.0.223 OKR/req 漏出点全盘扫清单

| 漏出点 | 文件 | gate 包法 |
|---|---|---|
| ④ 全景 OKR/req tab | `component-panorama-route.tsx:52` FIXED_TABS | gate 关 filter 留 tasks |
| ③ task 卡「所属 requirement」 | `component-board-task-card.tsx:132` | `{__FEATURE_OKR__ && <span>...}` |
| task 看板筛选条（全部/按 Req/按 KR） | `component-board-toolbar.tsx`（BoardTaskFilterBar 渲染条件） | `tab==='tasks' && isFeatureOkrOn()`——gate 关时整个筛选条不渲染（仅留「全部」语义即不筛选；组件代码保留不删） |
| task 创建/编辑表单 requirement 选择器 | `component-board-edit-fields.tsx`（TaskFields，gate 关隐藏选择器）+ `component-board-entity-modal.tsx`（D1-b 强制：`isCreateTaskBlocked` 加 gate 条件，gate 关 task 可无 requirement） | gate 关隐藏选择器 + 放宽 D1-b 强制 |
| requirement 视图 / @requirement mention | `component-board-requirements-view.tsx` / `board-utils.ts:28` | 不用 gate（route 层 tab 滤后天然不渲染；mention 类型映射仅 type，不主动显隐） |
| ① agent 工具集（goal/requirement） | `studio-leader/mate.parent.main.yaml` toolBound | **走配置层摘**（非 gate），见 `okr-req-gate-plan.md A1` |
| ② system prompt OKR 段 | `rocky_context/prompt/{rules,identity,...}.ts` | **走配置层摘**（非 gate），见 `okr-req-gate-plan.md A2` |
| ⑤ squad_board reminder OKR/req 段 | `rocky_context/prompt/squad_board.ts` | **走配置层滤**（非 gate），见 `squad_reminder_providers.md §4` |

**关键**：gate（build-time 编译期常量）只管**前端代码呈现**；①②⑤ 是 plugin 配置层（运行时配置），两层独立——重启 OKR 需手动恢复 ①②⑤ 配置 + 开 gate（不联动，PRD §2.1 明确）。

---

## 5. 边界 / 风险

- **仅前端**：gate 是 vite define，后端/electron 主进程零涉及；后端 OKR 数据/store/API/工具 impl 全留待 gate 开时复用。
- **UT 影响**：现有 component UT 假设 goals/requirements 恒可见，gate 关后需适配（mock `__FEATURE_OKR__=true` 跑旧断言 + 加 `=false` 验隐藏）。
- **test-time 注记（v0.0.223 实证）**：vitest 走独立 transform 管线，**不吃** `app/web/vite.config.ts` 的 build-time define；且**勿在根 `vitest.config.ts` 加 define**——define 会在 transform 期把标识符内联成字面量，`vi.stubGlobal` 再设值也无人读取，gate=true 双值 UT 即失效。统一读法 = `lib/feature-gates.ts` 的 `isFeatureOkrOn()`（`typeof`-guard：生产 define 内联后常量折叠；UT 未定义安全回落 false + stubGlobal 双值 mock 渲染期生效）。
- **packaged 验证**：dev 默认关即代表 packaged 行为，dev 通过即 packaged 通过（编译期常量，无运行时差异）。
- **长期保留**：gate 不在某版本删代码（PRD §6 开放点已定：长期保留）；代码/spec/测试全留待命。

---

## 6. 版本

**v0.0.223** — 新建 feature gate 机制（vite define + vite-env.d.ts + build-dmg 不 export）；首个用例 `__FEATURE_OKR__` 默认关，隐藏 OKR/requirement 前端漏出（③④ + task 表单 requirement 选择器）。详见 `specs/tech/version_logs/v0.0.223/change_plan.md` E/F 节。
