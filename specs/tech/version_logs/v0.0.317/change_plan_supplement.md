# v0.0.317 补充变更计划书 — 范式漏洞补丁（配置面板内控件一律走 SaveBar）

> **method 级 review 合同**。补充主 change_plan，覆盖语言切换 + 可观测性 toggle 的范式漏洞修复。
> 主 change_plan D 编号续接（D8-D10）。

## 背景

老板体验后发现两个范式漏洞：
1. **语言切换**：在 App Config 配置面板里但即时生效（不走 SaveBar）
2. **可观测性 detail toggle**：在配置面板里但即时生效（不走 SaveBar）

**新判定规则（老板拍板）**：凡是在有 SaveBar 的配置面板里的控件，一律走 SaveBar（进 dirty，点保存才生效），没有例外。独立页面（连接器、技能管理、Academy）的 toggle → 即时生效（不在配置面板里）。

---

## 设计决策

### D8: 语言切换 — 点保存才切（与其他配置完全统一）

**老板拍板**：「点保存才切，尽量统一」。语言不再是特例——选语言只进 draft，UI 不切，点 SaveBar 保存后才调 changeLanguage（切 UI + PUT 持久化一起做）。

**实现**：
- ComponentLocaleCard 改为**受控组件**：接收 `value: LocaleId`（draft 值）+ `onChange: (lng) => void`（仅上报父级，**不调 changeLanguage，UI 不切**）
- 父级（page-app-settings-merged）持 `languageDraft: LocaleId | null` state → 进 general tab dirty → SaveBar 点保存时调 `changeLanguage(languageDraft)`（切 UI + PUT 持久化一起做）
- **cancel = draft 回原值**：`setLanguageDraft(null)`，UI 本来就没切，无需回退

**changeLanguage 函数不改**：保持原三步原子（i18n.changeLanguage + html lang + PUT），只是调用时机从 onChange 移到 save。

**D8 实现细节**：

1. ComponentLocaleCard 从「自渲染切即生效」改为「受控 + 上报 onChange」
2. page-app-settings-merged 新增 `languageDraft: LocaleId | null` state（null = 未改动）
3. general tab dirty = `languageDraft !== null`
4. general tab showSaveBar 从 `false` 改为 dirty 时 `true`
5. save → `await changeLanguage(languageDraft)` + `setLanguageDraft(null)`
6. cancel → `setLanguageDraft(null)`（UI 本来没切，无需回退 i18n）

### D9: 可观测性 detail toggle — enabled 进 dirty

**当前**（section-observability-detail.tsx :62-66）：
```ts
const handleHeaderToggle = (next: boolean) => {
  if (isNew) return;
  updateField('enabled', next);  // 本地 draft 更新
  onToggle(initialData.id, next); // ← 即时 API 调用
};
```

`isObservabilityDirty` (types.ts :65-72) 显式排除 enabled：
```ts
if (k === 'enabled') continue; // enabled 不计 dirty
```

**目标**：enabled 进 dirty，toggle 不再即时调 API。

**改动**：
1. `handleHeaderToggle` 改为仅 `updateField('enabled', next)`（去掉 `onToggle` 即时调用）
2. `isObservabilityDirty` 去掉 `if (k === 'enabled') continue`（enabled 计入 dirty）
3. detail 组件去掉 `onToggle` prop（不再需要即时 toggle 回调）
4. section-observability.tsx 去掉 detail 的 onToggle 透传（list 级 toggle 保留）

**注意**：onToggle prop 仍被 list 级 toggle 消费（section-observability-list 的 handleToggle），所以 section-observability.tsx 的 handleToggle 函数保留——只是不再传给 detail。

### D10: 可观测性 list toggle — ~~保持即时~~ → 已纠正为进 dirty

> ⚠️ **D10 原始裁决是错误的，已于体验阶段纠正。** 下文保留原始错误记录以供追责。

**原始裁决（错误）**：list 级 toggle 属于「列表项操作」（范式 C list 级 = 即时），不是配置编辑。保持即时不变。

**错误原因**：违反老板拍板的唯一判定规则——"配置面板内一律走 SaveBar，没有例外"。可观测性 list 页在有 SaveBar 的配置面板里，toggle 就该进 dirty。Leader 在补充设计阶段错误地把 list toggle 归类为"范式 C list 级操作"，与唯一判定规则矛盾。

**纠正（commit `24c62fd76`）**：handleToggle 改为更新 `listDraft` state（不再即时 PUT），走 SaveBar 统一保存。toggle 回原值时 listDraft 自动清除 → dirty 消失。

**追责**：计划定义错误（leader 审批通过 D10），非执行错误。coder 严格按 change_plan 执行，无责任。

### D11: 可观测性 logs group toggle — 进 dirty（补充遗漏）

**原始遗漏**：change_plan_supplement 只覆盖了 observability detail toggle（D9）和 list toggle（D10 纠正），但漏了 observability tab 下 logs group 的 6 个日志 KV toggle。

**根因**：logs group 在 observability tab 下，但 toggle 走的是 `onKeyChange('logs', k.key, next)`（KV 即时写入路径），不进 aggregator dirtyMap。observability tab 是 aggregator tab（dirty 走 `obsAgg.isDirty()`），logs 的 KV 改动根本没进 aggregator。

**纠正（commit `026a3a4f0`）**：新建 `SectionLogsConfig` forwardRef 组件（参考 SectionBashConfig 范式），logs toggle 攒 draft → save PUT 全量 → reset 回 baseline → forwardRef + onDirtyChange 走 aggregator。tab-panel 里 logs group 用 SectionLogsConfig 替代内联 KV KeyCard 渲染。

**教训**：出 change_plan 时必须逐控件过一遍范式归属，不能凭感觉挑几个改。

---

## 变更清单

### 补丁 1: 语言切换走 SaveBar（点保存才切 UI + 持久化）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | component-locale-card.tsx | ComponentLocaleCardProps | 新增 | 接口定义：`value: LocaleId` + `onChange: (lng: LocaleId) => void` | MUST: 从无 props 改为受控 | D8 | +5/-0 |
| ui-config | component-locale-card.tsx | ComponentLocaleCard | 修改 | 选中态从 `i18n.language` 改为 `value` prop；handleSelect 改为仅 `onChange(lng)`（不调 changeLanguage，UI 不切）；去掉 changeLanguage import + i18n useTranslation 取消（不再消费 i18n.language） | MUST: onChange 内**不调 changeLanguage**（UI 不切）；MUST NOT: 不在 onChange 内调任何 i18n/PUT | D8 | +3/-10 |
| ui-config | page-app-settings-merged.tsx | languageDraft state | 新增 | `const [languageDraft, setLanguageDraft] = useState<LocaleId \| null>(null)`（null = 未改动） | MUST: null = 未改动 | D8 | +2/-0 |
| ui-config | page-app-settings-merged.tsx | general tab dirty | 修改 | general tab dirty 判定：`languageDraft !== null`；showSaveBar 含 general tab（当 dirty 时） | MUST: general tab 之前 showSaveBar=false，现在 dirty 时=true | D8 | +3/-1 |
| ui-config | page-app-settings-merged.tsx | general tab save | 新增 | saveTab('general') → `if (languageDraft) { await changeLanguage(languageDraft); setLanguageDraft(null) }` | MUST: 调 changeLanguage（完整三步：切 UI + PUT）；changeLanguage 不改不拆 | D8 | +4/-0 |
| ui-config | page-app-settings-merged.tsx | general tab cancel | 新增 | cancelTab('general') → `setLanguageDraft(null)`（UI 本来没切，无需回退 i18n） | MUST: cancel 仅清 draft（不调 i18n） | D8 | +2/-0 |
| ui-config | page-app-settings-merged.tsx | SectionTabPanel general case | 修改 | ComponentLocaleCard 传 `value={languageDraft ?? i18n.language}` + `onChange={(lng) => setLanguageDraft(lng)}` | MUST: value 缺省=当前 i18n 语言（未改动时显示当前选中） | D8 | +2/-1 |
| ui-config | section-tab-panel.tsx | SectionTabPanelProps | 修改 | 新增 `languageDraft?: LocaleId \| null` + `onLanguageChange?: (lng: LocaleId) => void` | MUST: 透传到 general case | D8 | +2/-0 |

### 补丁 2: 可观测性 detail toggle 进 dirty

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-config | observability-config/types.ts | isObservabilityDirty | 修改 | 去掉 `if (k === 'enabled') continue`——enabled 计入 dirty 判定 | MUST: enabled 变化 → dirty=true | D9 | +0/-2 |
| ui-config | observability-config/section-observability-detail.tsx | handleHeaderToggle | 修改 | 改为仅 `updateField('enabled', next)`（去掉 `onToggle(initialData.id, next)` 即时调用） | MUST: 不再调 onToggle；MUST NOT: 不改 updateField 逻辑 | D9 | +1/-2 |
| ui-config | observability-config/section-observability-detail.tsx | SectionObservabilityDetailProps | 修改 | 去掉 `onToggle: (id: string, enabled: boolean) => void` prop | MUST: detail 不再需要即时 toggle 回调 | D9 | +0/-1 |
| ui-config | observability-config/section-observability.tsx | detail onToggle 透传 | 修改 | 去掉传给 SectionObservabilityDetail 的 onToggle prop（list 级 handleToggle 保留——list toggle 仍即时） | MUST: list toggle 保留即时（D10）；仅 detail onToggle 去掉 | D9 / D10 | +0/-1 |

---

## 影响面评估

### 跨模块影响

| 模块 | 涉及文件 | 改动性质 |
|------|---------|---------|
| ui-config | 6 文件（locale-card + page-merged + tab-panel + observability detail/types/section） | D8 受控化 + D9 toggle 进 dirty |

### 零回归保证

- changeLanguage 原函数**不改不拆**（保持三步原子），仅调用时机从 onChange 移到 save
- 可观测性 list toggle 保留即时（D10 不改）
- 其他 tab 行为不变

### 风险点

1. **语言切换 UI 延迟**：用户选 English 后界面不立刻变英文，需点保存才切。这是老板明确要求的行为（与其他配置统一），非 bug。
2. **general tab 之前无 SaveBar**：改为有条件显示后，general tab 的 ConfirmModal（切 tab dirty 保护）也会生效——用户改语言后切 tab 会弹确认。这是正确行为（dirty 保护），不是 bug。
3. **isObservabilityDirty 改动**：原来 enabled 不计 dirty，现在计入。这意味着用户在 detail 只切 toggle（不改其他字段）也会 dirty → SaveBar 亮。正确行为。

## 反馈回路

- 实现/codereview 严重违反本表 → 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect
