# v0.0.317 变更计划书 — 配置管理·保存交互全局规范

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## Leader 5 项裁决摘要

| 裁决项 | 决定 |
|--------|------|
| 全局 SaveBar | 升级 `component-tab-save-bar.tsx` → 改名 `component-save-bar.tsx`，加 `variant?: 'tab' \| 'detail'` |
| SeatsPanel SaveBar 挂载点 | 面板级共享（SeatsPanel 内一个 SaveBar，按当前 tab dirty 驱动） |
| AppConfig 容器 max-width | 只右侧内容区加 880px，左侧 tab 树不动 |
| 渠道表单 SaveBar | 只换 UI 组件，提交逻辑不动 |
| GroupSaveBar | 全部废弃，saveMode='item' 也改受控上报 tab 级统一保存 |

## 设计决策（D 编号）

### D1: SaveBar 组件升级 — 改名 + variant prop

**文件**：`component-tab-save-bar.tsx` → 改名为 `component-save-bar.tsx`（新文件名）。旧文件删除。

**变更**：
- 组件名 `TabSaveBar` → `SaveBar`
- 新增可选 prop `variant?: 'tab' | 'detail'`（缺省 `'tab'`，向后兼容）
  - `'tab'`：action-key 后缀 `.tab.save/cancel`（既有行为）
  - `'detail'`：action-key 后缀 `.detail.save/cancel`
- 视觉/逻辑零变化（dirty/saving/saved/cancel 全部不变）
- 原 87 行 → 约 95 行（加 variant 分支 + action-key 映射）

**向后兼容**：原 `import { TabSaveBar }` 的消费方改为 `import { SaveBar }`。保留 `export { SaveBar as TabSaveBar }` alias 一个版本，下版本删。

### D2: SeatsPanel 面板级 SaveBar — dirty 上推 + tab 切换保护

**问题**：ManageTab/AutoworkTab 当前各自在内容流底部渲染保存按钮。要改成 SeatsPanel 底部统一 sticky SaveBar，需要：
1. tab 内部 dirty 上推到 SeatsPanel
2. SeatsPanel 按当前 tab 的 dirty/saving/saveFn/cancelFn 驱动 SaveBar
3. 切 tab 时 dirty 保护（弹确认 modal）

**方案**：tab 组件（ManageTab/AutoworkTab）暴露 dirty/saving/saveFn/cancelFn 给 SeatsPanel。

**接口设计**：
```ts
// 新增公共 type（放 studio-types.ts 或 inline）
interface SaveBarController {
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
  cancel: () => void;
}
```

ManageTab/AutoworkTab 各加一个 `onSaveBarChange?: (ctrl: SaveBarController | null) => void` prop。组件 mount 时上报 controller，unmount 时上报 null。SeatsPanel 持当前 tab 的 controller，驱动 SaveBar。

**为什么不用 ref**：dirty 是声明式值（随 render 变化），需要触发 SeatsPanel re-render → SaveBar 更新。ref 不触发 re-render。onSaveBarChange callback 在 useState effect 中调，SeatsPanel setState → re-render → SaveBar dirty 更新。

### D3: SeatsPanel tab 切换 dirty 保护

SeatsPanel 当前切 tab 无 dirty 保护（审计报告问题 6）。新增：
- 切 tab 前检查 `activeController?.dirty`
- dirty → 弹 ConfirmModal（复用 app-dev-config-page 已有的 `component-confirm-modal`）
- 确认丢弃 → 调 `activeController.cancel()` + 切 tab
- 取消 → 留在当前 tab

### D4: AppConfig 容器 max-width — 只右侧内容区

`page-app-settings-merged.tsx` 右侧内容区 `<section className="flex-1">` → 加 `<div className="mx-auto max-w-[880px] w-full">` 包裹。
左侧 tab 树 `<aside className="w-[200px]">` 不动。

### D5: GroupSaveBar 废弃 + saveMode='item' 改受控

**GroupSaveBar 废弃**：
- `section-config-layout.tsx` 去掉 `ComponentGroupSaveBar` 渲染（group 级 saveMode='group' 的 group 底部不再有独立 save bar）
- group 的 dirty 纳入 tab 级（useAppSettingsConfig 已有 KV group dirty 跟踪 → TabSaveBar 已消费）——实际上 GroupSaveBar 在 v0.0.89 后已不在主流程渲染（page-app-settings-merged 用 TabSaveBar 替代），section-config-layout 里的 GroupSaveBar 是旧路径。废弃 = 确认无消费方后删组件 + 删 import

**saveMode='item'（web_search/see_image）改受控**：
- v0.0.316 已将 web_search/see_image/bash/web_fetch 改为 forwardRef + onDirtyChange 上报 tab 级 aggregator
- v0.0.317 确认：这 4 个 section 的 save/reset toolbar 已去掉（v0.0.316 完成），不再有 item 级独立保存
- GroupSaveBar 物理废弃 = 删文件 + grep 确认零引用

### D6: provider-detail SaveBar 替换

provider-detail 当前自定义 inline save-bar（:146-168）。替换为 `<SaveBar variant="detail" />`：
- dirty/saving 由 provider-detail 传入（已有 isDirty + handleSave + handleReset）
- 新增 saving state（当前无——saveProviderWithModels 是同步调 reload）
- reset 按钮 → SaveBar 的 cancel 按钮（语义一致：draft 回 snapshot）
- 去掉自定义 inline JSX

### D7: channel form SaveBar 替换

channel form 当前是弹层内表单 + 自定义提交/取消按钮。替换为 `<SaveBar variant="detail" />`：
- **提交逻辑不动**（onSubmit/onCancel props 不变）
- dirty = 表单字段任一变化（新增 dirty 判定：implId/name/appId/appSecret 与 editing baseline 比较）
- submitting → saving prop
- 去掉底部自定义提交/取消按钮，换 SaveBar
- SaveBar 的 save → 组装 ChannelFormInput + 调 onSubmit
- SaveBar 的 cancel → 调 onCancel

---

## 变更清单

### P0-A: 全局 SaveBar 组件升级

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-common | app/web/src/components/common/component-save-bar.tsx | SaveBar | 新增 | 从 component-tab-save-bar.tsx 迁移 + 升级：组件名 TabSaveBar→SaveBar；新增 `variant?: 'tab'\|'detail'` prop（缺省 'tab'）；action-key 按 variant 切后缀；视觉/逻辑零变化 | MUST: variant 缺省='tab' 向后兼容；export alias TabSaveBar；MUST NOT: 不改 dirty/saving/saved/cancel 逻辑 | PRD §3 / D1 | +95/-0 |
| ui-common | app/web/src/components/app-dev-config-page/component-tab-save-bar.tsx | TabSaveBar (file) | 删除 | 文件删除（功能迁移到 common/component-save-bar.tsx）；保留 re-export alias 一个版本 | MUST: grep 确认所有 import 路径更新 | D1 | 0/-87 |

### P0-B: 管理 tab SaveBar 迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-manage-tab.tsx | ManageTabProps | 修改 | 新增 `onSaveBarChange?: (ctrl: SaveBarController \| null) => void` | MUST: controller 含 dirty/saving/save/cancel | D2 / PRD §4 #10 | +1/-0 |
| ui-studio | component-manage-tab.tsx | ManageTab 保存按钮 JSX | 修改 | 去掉 `<div className="mb-5 flex justify-end">` 内的 BTN_PRIMARY 保存按钮；新增 useEffect 上报 onSaveBarChange({ dirty, saving, save, cancel }) | MUST: 去掉 BTN_PRIMARY 保存按钮 + Icon import（如不再用）；save/cancel 函数不变；MUST NOT: 不改 dirty 判定/save 逻辑 | PRD §3.5 / D2 | +8/-5 |
| ui-studio | component-manage-tab.tsx | ManageTab onSaveBarChange effect | 新增 | `useEffect(() => { onSaveBarChange?.({ dirty, saving, save, cancel }); return () => onSaveBarChange?.(null) }, [dirty, saving, onSaveBarChange])` | MUST: cleanup 上报 null（unmount 时 SeatsPanel 清 controller）；deps 含 dirty/saving（值变 → 上报新 controller） | D2 | +5/-0 |

### P0-C: 自动工作 tab SaveBar 迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-autowork-tab.tsx | AutoworkTabProps | 修改 | 新增 `onSaveBarChange?: (ctrl: SaveBarController \| null) => void` | 同 ManageTab | D2 / PRD §4 #11 | +1/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTab 保存按钮 JSX | 修改 | 去掉底部自定义 inline 保存/取消按钮 JSX（:116-142）+ saveError banner；新增 useEffect 上报 onSaveBarChange | MUST: 去掉自定义按钮 + saveError banner（error 由 SaveBar 区域统一显示或保留在 tab 内）；MUST NOT: 不改 dirty/save/cancel 逻辑 | PRD §3.5 / D2 | +8/-28 |

### P0-D: SeatsPanel 面板级 SaveBar + tab 切换保护

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-seats-panel.tsx | SeatsPanel state | 修改 | 新增 `const [saveBarCtrl, setSaveBarCtrl] = useState<SaveBarController \| null>(null)` + `const [pendingTab, setPendingTab] = useState<SeatsPanelTab \| null>(null)` | MUST: saveBarCtrl 持当前 tab 的 controller | D2 / D3 | +2/-0 |
| ui-studio | component-seats-panel.tsx | tab 切换 handler | 修改 | setActiveTab 改为先检查 saveBarCtrl?.dirty → dirty 则 setPendingTab(tab)；否则直接切 | MUST: dirty 时不直接切（弹确认） | D3 / PRD §7 | +8/-1 |
| ui-studio | component-seats-panel.tsx | ManageTab/AutoworkTab JSX | 修改 | 传 `onSaveBarChange={setSaveBarCtrl}` 到两个 tab 组件 | MUST: setSaveBarCtrl 直接透传 | D2 | +2/-0 |
| ui-studio | component-seats-panel.tsx | SaveBar 渲染 | 新增 | panel/autowork tab 时底部渲染 `<SaveBar dirty={saveBarCtrl?.dirty ?? false} saving={saveBarCtrl?.saving ?? false} onSave={() => void saveBarCtrl?.save()} onCancel={() => saveBarCtrl?.cancel()} />`；seats tab 不渲染 | MUST: SaveBar 在 main 内、内容区外 sticky bottom-0；seats tab 无 SaveBar | PRD §6.4 / D2 | +8/-0 |
| ui-studio | component-seats-panel.tsx | ConfirmModal | 新增 | pendingTab !== null 时渲染 ConfirmModal（复用 common/component-confirm-modal）；确认 → saveBarCtrl?.cancel() + setActiveTab(pendingTab) + setPendingTab(null)；取消 → setPendingTab(null) | MUST: 丢弃 = cancel draft + 切 tab | D3 / PRD §7.1 | +12/-0 |

### P1-A: Member 编辑面板 SaveBar 迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | section-member-panel.tsx | MemberPanel 悬浮保存 | 修改 | 去掉右下 fixed 悬浮保存按钮（:189-199）；底部新增 `<SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onCancel={reset} />` | MUST: SaveBar sticky bottom-0；onCancel = reset draft 到 base（新增 reset 函数）；去掉 Icon import（如不再用） | PRD §4 #18 / §3.5 | +5/-12 |
| ui-studio | section-member-panel.tsx | MemberPanel reset | 新增 | 新增 reset 函数：name/intro/workStyle/skillMode/overrides 回 base 值 | MUST: reset = 全部 draft 回 baseline | PRD §3.3 | +8/-0 |

### P1-B: 供应商详情 SaveBar 替换

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-providers | component-provider-detail.tsx | ProviderDetail save-bar JSX | 修改 | 去掉自定义 inline save-bar（:147-168）；替换为 `<SaveBar variant="detail" dirty={dirty} saving={saving} onSave={handleSave} onCancel={handleReset} />` | MUST: 新增 saving useState（当前无——saveProviderWithModels 需包装 async）；handleSave 改为 async + setSaving；MUST NOT: 不改 draft/snapshot 逻辑 | PRD §4 #3 / D6 | +8/-22 |
| ui-providers | component-provider-detail.tsx | saving state | 新增 | `const [saving, setSaving] = useState(false)` + handleSave 包装 `setSaving(true); try { await onSaved(draft) } finally { setSaving(false) }` | MUST: onSaved 调用前后管 saving | D6 | +6/-0 |

### P1-C: 渠道表单 SaveBar 替换

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-channel | section-channel-form.tsx | SectionChannelForm dirty | 新增 | 新增 dirty 判定：implId/name/appId/appSecret 各 !== editing baseline（editing=null 时全 dirty） | MUST: dirty 判定与 PRD §4.3 对齐 | PRD §4 #15 / D7 | +5/-0 |
| ui-channel | section-channel-form.tsx | 底部按钮 JSX | 修改 | 去掉自定义提交/取消按钮；替换为 `<SaveBar variant="detail" dirty={dirty} saving={submitting} onSave={handleSubmit} onCancel={onCancel} />` | MUST: 提交逻辑不动（handleSubmit 组装 input + 调 onSubmit）；submitting → saving prop | D7 / PRD §4 #15 | +3/-15 |
| ui-channel | section-channel-form.tsx | handleSubmit | 修改 | 从 inline form submit 改为 SaveBar onSave 回调（组装 ChannelFormInput + 调 onSubmit + catch err） | MUST: 提交逻辑不变（组装 + onSubmit + err setErr）；MUST NOT: 不改 validation | D7 | +5/-3 |

### P2-A: 容器 max-width 对齐

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-seats-panel.tsx | panel/autowork 容器 | 修改 | `max-w-[920px]` → `max-w-[880px]`（:174, :183 两处）；`pt-5` → `pt-6` | MUST: 两处都改 | PRD §6.4 | +2/-2 |
| ui-config | page-app-settings-merged.tsx | 右侧内容区 | 修改 | `<section className="flex-1 flex flex-col overflow-hidden">` 内层加 `<div className="mx-auto max-w-[880px] w-full">` 包裹 SectionTabPanel + TabSaveBar | MUST: 只包右侧内容区（左侧 tab 树不动）；TabSaveBar 也在 max-width 内 | D4 / PRD §6 | +2/-0 |

### P2-B: GroupSaveBar 废弃

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | section-config-layout.tsx | ComponentGroupSaveBar 渲染 | 删除 | 去掉 group 底部 ComponentGroupSaveBar 渲染（:134-143）；去掉 import | MUST: grep 确认 section-config-layout 是唯一消费方；saveMode='group' 的 group 底部不再有 save bar | D5 / PRD §3.5 | 0/-12 |
| ui-config | component-group-save-bar.tsx | ComponentGroupSaveBar (file) | 删除 | 文件删除（零引用后） | MUST: grep 确认零 import 后才删 | D5 | 0/-89 |

### P2-C: AppConfig TabSaveBar import 路径迁移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | page-app-settings-merged.tsx | TabSaveBar import | 修改 | `from './component-tab-save-bar'` → `from '../common/component-save-bar'`；组件名 TabSaveBar→SaveBar（或用 alias） | MUST: 所有引用同步改 | D1 | +1/-1 |

---

## 影响面评估

### 跨模块影响

| 模块 | 涉及文件 | 改动性质 |
|------|---------|---------|
| ui-common | 1 新建（component-save-bar）+ 1 删（component-tab-save-bar） | D1 组件升级 |
| ui-studio | 5 文件（manage-tab / autowork-tab / seats-panel / member-panel + studio-styles 可能微调） | P0 核心 + P1 |
| ui-config | 3 文件（page-app-settings-merged / section-config-layout / component-group-save-bar 删） | P2 容器 + 废弃 |
| ui-providers | 1 文件（component-provider-detail） | P1 SaveBar 替换 |
| ui-channel | 1 文件（section-channel-form） | P1 SaveBar 替换 |

### 破坏性变更

- **SaveBar 改名**：`TabSaveBar` → `SaveBar`（保留 alias 一版本）
- **ManageTab/AutoworkTab 新增 onSaveBarChange prop**：SeatsPanel 必须同步传
- **GroupSaveBar 删除**：section-config-layout 去掉渲染
- **ManageTab/AutoworkTab/MemberPanel 去掉自身保存按钮**：保存职责上移到 SeatsPanel/面板级

### 零回归保证

- App Config 会话/工具/可观测性/整理 tab：TabSaveBar → SaveBar 改名，功能不变
- 范式 A 页面（连接器/技能/语言/记忆/插件）：**不碰**
- deploy/bench/hire 操作类：**不碰**
- v0.0.316 受控化/aggregator：**不碰**（只换 UI 层组件）

### 依赖顺序

```
P0-A (SaveBar 组件升级) ← 所有 P0-B/C/D + P1-B/C 依赖
P0-B (ManageTab) ┐
P0-C (AutoworkTab) ├── P0-D (SeatsPanel) 依赖 B+C 完成
P0-D (SeatsPanel) ┘
P1-A (MemberPanel) ── 独立
P1-B (ProviderDetail) ── 依赖 P0-A
P1-C (ChannelForm) ── 依赖 P0-A
P2-A (max-width) ── 独立
P2-B (GroupSaveBar 废弃) ── 独立（grep 确认后删）
P2-C (AppConfig import 迁移) ── 依赖 P0-A
```

**并行策略**：
- 路线 1：P0-A → P0-B + P0-C → P0-D（studio-page 链）
- 路线 2：P0-A → P1-B + P1-C（providers + channel）
- 路线 3：P1-A + P2-A + P2-B + P2-C（独立小改）
- P0-A 是全局前置（先出 SaveBar 组件），之后 3 条路线可并行

### 风险点

1. **SaveBarController effect 时序**：ManageTab/AutoworkTab mount → useEffect 上报 controller → SeatsPanel setState → re-render。需确保 controller 的 save/cancel 函数是最新的（deps 含 dirty/saving → 每次 re-render 上报新 controller）
2. **SeatsPanel tab 切换保护**：pendingTab state + ConfirmModal 需正确处理 seats tab（无 controller → 无保护 → 直接切）
3. **provider-detail saving 新增**：原 onSaved 是同步调用（saveProviderWithModels 返回 Promise），需包装 async + setSaving
4. **channel form dirty 判定**：editing=null（新建）时 baseline 为空 → 改任何字段都 dirty；editing 有值时逐字段比较

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
