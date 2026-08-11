# v0.0.316 变更计划书 — 配置面板统一保存按钮

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## Leader 裁决摘要

| 待定项 | 裁决 |
|--------|------|
| 切 tab unsaved warning | **不加**（静默丢弃） |
| AutoworkTab 重构 | **方案 A**（AutoworkTab 持全部 draft，子组件纯受控） |
| 工具 tab dirty 注册方式 | **useImperativeHandle ref 注册**（架构师定，见 §设计决策 D1） |
| 可观测性 observability | **合入 tab 级**（不保留独立 save） |
| ManageTab 是否换 TabSaveBar | **保持现有 BTN_PRIMARY 风格** |

## 设计决策（D 编号，review 时参照）

### D1: ~~useImperativeHandle + ref 注册~~ → **已废弃，见 D1-revised**

> **v0.0.316-fix**: 原 D1 设计有架构级缺陷——ref 不触发 re-render，section 内部 dirty 变化无法通知 page。详见 `fix-aggregator-dirty-report.md`。

### D1-revised: 声明式 state dirty 上报 + ref 仅管 save/reset

**选择**：dirty 走 `useState` 声明式上报（section → onDirtyChange callback → page setState → re-render）；save/reset 走 ref（命令式，不需触发 re-render）。

**接口契约**：
```ts
interface SectionSaveHandle {
  // 去掉 isDirty（改由 onDirtyChange callback 声明式上报）
  save: () => Promise<void>;
  reset: () => void;
}
```

详见 `fix-aggregator-dirty-report.md`（替代原 D1 + D4 的完整设计）。

### D2: AutoworkTab 方案 A draft 管理 — 3 useState + 1 dirty 派生

AutoworkTab 持 3 个独立 useState（不合并为单一对象——避免每次改一个字段 spread 整个对象）：
- `enableHeartBeatDraft: boolean`
- `heartbeatConfigDraft: SquadHeartbeatConfig | null`
- `budgetDraft: { limit, window, scope } | null`

dirty = 三字段各自 !== detail 对应字段（复合对象用 JSON.stringify 比较）。

### D3: 工具/可观测性 tab section 改造策略 — 保留内部 draft，去掉 save UI，暴露 ref

section 内部 GET/draft/save 逻辑**不变**（保留 reload/baseline/draft/handleSave），仅：
1. 去掉底部 save/reset toolbar JSX
2. `forwardRef` + `useImperativeHandle` 暴露 `{ isDirty: () => dirty, save: handleSave, reset: handleReset }`
3. section 保留自身 loading/error 展示（非 save 相关的错误展示不变）

### D4: ~~useTabDirtyAggregator hook（ref 遍历模式）~~ → **已废弃，见 D4-revised**

> **v0.0.316-fix**: 原 D4 的 `useRef(new Map())` 被实现成 `new Map()`（CRITICAL-1），且 ref 遍历 isDirty 不触发 re-render（MAJOR-1）。重新设计见 D4-revised。

### D4-revised: useTabDirtyAggregator hook（声明式 state dirty + ref save/reset）

```ts
function useTabDirtyAggregator() {
  const handles = useRef<Map<string, SectionSaveHandle>>(new Map()); // 仅管 save/reset
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({}); // dirty 走 state

  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyMap((prev) => prev[key] === dirty ? prev : { ...prev, [key]: dirty });
  }, []);

  const isDirty = useCallback(() => Object.values(dirtyMap).some(Boolean), [dirtyMap]);
  const saveAll = useCallback(async () => {
    // dirtyKeys 从 dirtyMap 取，handles.current.get(key)?.save()
  }, [dirtyMap]);
  // register / resetAll 同 D1-revised

  return { register, reportDirty, isDirty, saveAll, resetAll, dirtyMap };
}
```

section 侧：新增 `onDirtyChange` prop + `useEffect(() => onDirtyChange?.(dirty), [dirty])`；`useImperativeHandle` 只暴露 `{ save, reset }`（去掉 isDirty）。

详见 `fix-aggregator-dirty-report.md`（含完整代码 + 逐文件改动清单 + UT 修复指引）。

### D5: 可观测性 tab observability 改造 — 特殊处理

observability section 有 list/detail 二级视图（toggle/delete 是**即时操作类**，detail save 是配置保存类）。改造策略：
- detail save（新增/编辑配置）从即时 persist 改为攒 draft → ref.save 时 persist
- list toggle（启停开关）保留即时（操作类，同 deploy/bench 性质）
- list delete 保留即时（操作类，有 modal 确认）
- ref.isDirty = detail 是否有未保存编辑

---

## 变更清单

### P0: 管理 tab（ManageTab）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-group-chat-toggle.tsx | GroupChatToggleProps | 修改 | 去掉 squadId/onPatch/error/pending；新增 `enableGroupChat: boolean` + `onChange: (v: boolean) => void` | MUST: 去掉 onPatch（不再自管 PATCH）；去掉 error banner + pending 状态（tab 级统一处理）；MUST NOT: 不改 toggle 视觉样式 | PRD §3.1.1 | +3/-15 |
| ui-studio | component-group-chat-toggle.tsx | GroupChatToggle | 修改 | toggle onClick 改为 `onChange(!enableGroupChat)`（上报父级）；去掉 `void toggle()` async 逻辑 | MUST: 无 async/PATCH 调用（纯受控上报）；MUST NOT: 不加 debounce | PRD §3.1.1 | +2/-12 |
| ui-studio | component-manage-tab.tsx | ManageTab state | 修改 | 新增 `const [enableGroupChat, setEnableGroupChat] = useState(detail.enableGroupChat)` | MUST: init 值 = detail.enableGroupChat（受控模式） | PRD §3.1.2 | +1/-0 |
| ui-studio | component-manage-tab.tsx | ManageTab dirty | 修改 | dirty 判定追加 `\|\| enableGroupChat !== detail.enableGroupChat` | MUST: 与现有 5 字段 dirty 用 \|\| 连接 | PRD §3.1.2 | +1/-0 |
| ui-studio | component-manage-tab.tsx | ManageTab save() | 修改 | onSaveMeta 合并字段追加 `enableGroupChat` | MUST: 同一次 PATCH 合并提交 | PRD §3.1.3 | +1/-0 |
| ui-studio | component-manage-tab.tsx | GroupChatToggle JSX | 修改 | props 改为 `enableGroupChat={enableGroupChat} onChange={setEnableGroupChat}`；去掉 squadId/onPatch | MUST: 传入 draft 值（非 detail 原值） | PRD §3.1 | +1/-3 |

### P1: 自动工作 tab（AutoworkTab）— 方案 A

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | component-squad-autonomy-toggle.tsx | SquadAutonomyToggleProps | 修改 | 去掉 squadId/onPatch/error/pending；新增 `enableHeartBeat: boolean` + `onChange: (v: boolean) => void` | MUST: 同 GroupChatToggle 改造模式 | PRD §3.2.2 | +3/-15 |
| ui-studio | component-squad-autonomy-toggle.tsx | SquadAutonomyToggle | 修改 | toggle onClick 改为 `onChange(!enableHeartBeat)`；去掉 async toggle() | MUST: 纯受控上报 | PRD §3.2.2 | +2/-12 |
| ui-studio | section-heartbeat-config.tsx | HeartbeatConfigProps | 修改 | 去掉 squadId/onSave/pending/error；新增 `heartbeatConfig: SquadHeartbeatConfig \| null` + `onChange: (v) => void`；保留 enableHeartBeat + members + timezone（UI 展示用） | MUST: 去掉 handleSave + handleReset + save/reset 按钮 JSX；MUST NOT: 不改 interval/windows/scope 子控件交互 | PRD §3.2.2 | +3/-30 |
| ui-studio | section-heartbeat-config.tsx | HeartbeatConfigSection | 修改 | 内部 useState 改为从 props.heartbeatConfig 派生（受控）；onChange 汇总上报 `{ interval, activeWindows, scope }`；去掉 useEffect 外部同步（父级 refresh 后 prop 变化直接驱动） | MUST: 子控件改 draft 后汇总 onChange 上报；去掉底部 save/reset 按钮区域（含 dirty 判定 + handleSave + handleReset） | PRD §3.2.2 / D2 | +8/-40 |
| ui-studio | component-budget-meter.tsx | BudgetMeterProps | 修改 | 去掉 squadId/onSaveBudget/savePending；新增 `budget: { limit, window, scope } \| null` + `onChange: (v) => void`；保留 refreshKey | MUST: budgetOn 从 useState 改为派生 `budget != null`；去掉底部 save 按钮 JSX | PRD §3.2.2 / §3.2.4 | +3/-15 |
| ui-studio | component-budget-meter.tsx | BudgetMeter | 修改 | budgetOn toggle 改为 `onChange(budgetOn ? null : { limit: parseInt(limitInput), window:'daily', scope:'team' })`；limitInput onChange 改为派生更新 budget draft；去掉 handleSaveBudget | MUST: toggle off → onChange(null)；toggle on → onChange(默认值)；limit 变 → onChange(更新 limit) | PRD §3.2.4 / D2 | +10/-20 |
| ui-studio | component-budget-meter.tsx | BudgetMeter usage 展示 | 修改 | 保留 useLifecycle usage 轮询不变（只读展示，与 save 无关） | MUST NOT: 不动 useLifecycle/onInit/onTick 逻辑 | 既有实现 | +0/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTabProps | 修改 | 不变（detail + onSaveMeta 已有） | — | 既有 | +0/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTab draft state | 新增 | 新增 3 useState：`enableHeartBeatDraft` / `heartbeatConfigDraft` / `budgetDraft`（init = detail 对应字段） | MUST: init 值 = detail 原值；D2 设计 | PRD §3.2.1 / D2 | +5/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTab dirty | 新增 | `const dirty = enableHeartBeatDraft !== detail.enableHeartBeat \|\| ...`（3 字段比较，复合对象 JSON.stringify） | MUST: dirty 判定与 PRD §3.2.1 一致 | PRD §3.2.1 | +4/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTab save | 新增 | `const save = async () => { setSaving(true); await onSaveMeta({ enableHeartBeat, heartbeatConfig, budget }); setSaving(false) }` | MUST: 一次 PATCH 合并 3 字段；saving 防 repeat | PRD §3.2.3 | +8/-0 |
| ui-studio | component-autowork-tab.tsx | AutoworkTab cancel | 新增 | draft 回 detail 原值（3 useState reset） | MUST: cancel = 3 setX(detail.xxx) | PRD §3.2.3 | +4/-0 |
| ui-studio | component-autowork-tab.tsx | 子组件 JSX | 修改 | 3 子组件 props 改为受控（传 draft 值 + onChange）；底部新增保存/取消按钮（BTN_PRIMARY 风格，dirty 高亮，saving 禁用） | MUST: 子组件不传 squadId/onPatch/onSave/onSaveBudget；底部按钮在 AutoWorkHistory 之后 | PRD §3.2 / §7.1 | +15/-8 |
| ui-studio | component-autowork-tab.tsx | detail 外部变化同步 | 新增 | useEffect `[detail]` → 当 detail 变化（保存成功后父级 refresh 回灌）重置 3 draft | MUST: 仅 detail 引用变化时重置（非每次 render） | PRD §3.2.1 | +5/-0 |

### P2: 工具 tab（App Config）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | section-web-search-config.tsx | SectionWebSearchConfig | 修改 | `forwardRef` 包装；`useImperativeHandle` 暴露 `{ isDirty: () => dirty, save: handleSave, reset: handleReset }`；去掉底部 save/reset toolbar JSX | MUST: 内部 GET/draft/save 逻辑不变；MUST NOT: 不改 type 下拉 / apiKey SecretInput 交互 | D3 / D4 | +8/-20 |
| ui-config | section-web-fetch-config.tsx | SectionWebFetchConfig | 修改 | 同上（forwardRef + useImperativeHandle + 去 toolbar） | MUST: 同上模式 | D3 / D4 | +8/-20 |
| ui-config | section-see-image-config.tsx | SectionSeeImageConfig | 修改 | 同上 | MUST: 同上模式 | D3 / D4 | +8/-20 |
| ui-config | section-bash-config.tsx | SectionBashConfig | 修改 | 同上 | MUST: 同上模式 | D3 / D4 | +8/-20 |
| ui-config | use-tab-dirty-aggregator.ts | useTabDirtyAggregator | 新增 | 通用 hook：ref Map 收集 + isDirty/saveAll/resetAll 聚合（D4 设计） | MUST: saveAll 用 Promise.allSettled（部分失败不中断）；resetAll 同步遍历 | D4 | +25/-0 |
| ui-config | section-tab-panel.tsx | SectionTabPanel (tools case) | 修改 | tools case 内 4 section 包裹 ref 回调（setRef('web_search', ref) 等）；TabPanel 不直接渲染 TabSaveBar（由 page 渲染） | MUST: ref 回调在 unmount 时传 null（清理 Map） | D1 / D4 | +15/-8 |
| ui-config | section-tab-panel.tsx | SectionTabPanel (observability case) | 修改 | observability section 包裹 ref；logs KV group 保持现有（useAppSettingsConfig 管理） | MUST: observability ref + logs KV 并存 | D5 | +8/-4 |
| ui-config | page-app-settings-merged.tsx | tools/observability tab dirty | 修改 | tools/observability tab 的 dirty/save/cancel 改为消费 useTabDirtyAggregator（覆盖现有 showSaveBar 判断逻辑） | MUST: tools tab dirty = aggregator.isDirty() OR 无 KV group dirty；observability tab dirty = aggregator.isDirty() OR logs dirty | PRD §3.3 / §3.4 | +12/-5 |
| ui-config | page-app-settings-merged.tsx | tools/observability tab save | 修改 | saveTab(tools) = aggregator.saveAll() + KV group save（如有）；部分失败设 error | MUST: Promise.allSettled 后检查 rejected → 设 error banner | PRD §3.3.4 / §4.3 | +10/-2 |

### P3: 可观测性 tab — observability section 受控化

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | observability-config/section-observability.tsx | SectionObservability | 修改 | `forwardRef` + useImperativeHandle 暴露 `{ isDirty, save, reset }`；detail save 从即时 persist 改为攒 draft（ref.save 时 persist）；list toggle/delete 保留即时 | MUST: toggle/delete 保留即时（操作类）；detail 编辑改为攒 draft；ref.isDirty = detail 有未保存编辑；MUST NOT: 不改 list/detail 视觉 | D5 / PRD §3.4 | +15/-8 |

### 公共/类型

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | section-web-search-config.tsx | SectionSaveHandle (type) | 新增 | `export interface SectionSaveHandle { isDirty: () => boolean; save: () => Promise<void>; reset: () => void }` | MUST: 从 web-search 导出（首个定义点），其他文件 import | D1 | +4/-0 |

---

## 影响面评估

### 跨模块影响

| 模块 | 涉及文件 | 改动性质 |
|------|---------|---------|
| studio-page | 6 文件（manage-tab / group-chat-toggle / autowork-tab / squad-autonomy-toggle / heartbeat-config / budget-meter） | P0 微改 + P1 中等重构 |
| app-dev-config-page | 9 文件（4 tool sections + observability + tab-panel + page-merged + 新 hook + 新 type） | P2 中等 + P3 中等 |

### 破坏性变更

- **子组件 props 签名变更**（GroupChatToggle / SquadAutonomyToggle / HeartbeatConfigSection / BudgetMeter）：从自管 save 改为受控，消费方需同步改 props 传递
- **4 个 tool section 加 forwardRef**：外部包裹方式不变但需配 ref 类型
- **observability section 加 forwardRef**：同上

### 零回归保证

- 会话/模型/整理/插件 tab：**不碰**（useAppSettingsConfig + KV group dirty 不变）
- Member 编辑面板：**不碰**
- 通用 tab 语言切换：**不碰**（保留即时生效）
- 记忆 tab CRUD：**不碰**
- seats tab deploy/bench/hire：**不碰**

### 依赖顺序

1. P0 可独立先做（仅 studio-page 管理 tab）
2. P1 可独立做（仅 studio-page autowork tab）—— 与 P0 可并行
3. P2 依赖 `use-tab-dirty-aggregator.ts` + `SectionSaveHandle` type 先定义
4. P3 依赖 P2 的 aggregator（复用同 hook）
5. P2 + P3 可与 P0 + P1 **完全并行**（不同模块/文件零交集）

### 风险点

1. **BudgetMeter 受控化复杂度**：budget toggle off→on 需预填默认值（DEFAULT_LIMIT），on→off 需传 null；limitInput 需从 budget draft 派生（非独立 useState）
2. **HeartbeatConfigSection 受控化**：内部有 interval/activeWindows/scope 三个子控件，改 onChange 需汇总三子控件值为一个 heartbeatConfig 对象上报
3. **observability detail 攒 draft**：原 detail save 是即时的（persist），改为攒 draft 需引入 detail draft state + isDirty 判定
4. **工具 tab 部分失败**：Promise.allSettled 后需区分 fully rejected / partially rejected / all fulfilled

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
