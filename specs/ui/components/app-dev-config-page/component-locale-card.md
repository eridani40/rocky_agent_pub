# component-locale-card

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-locale-card.tsx

## 职责
外观 group 内的语言选择器卡片：label + 说明 + 两选项卡。**v0.0.317（D8）改为纯受控组件**——选语言只进 draft（UI 不切），点保存才由父级调 `changeLanguage`（切 UI + PUT 持久化一起做），与配置面板其他控件统一走 SaveBar。

边界：
- **受控模式**：接收 `value`（当前选中 locale）+ `onChange`（仅上报，不调 `changeLanguage`）。选中态真值来自父级 draft，不由 `i18n.language` 直接驱动。
- **选项 label 自指**——「中文」恒显「中文」、「English」恒显「English」，不随 locale 切换变化（用户在任何 locale 下都能识别自己想切的语言）。label 不进 i18n 切换（不走 `t`）。
- **语言切换走 SaveBar**——选语言只进 draft，UI 不切；点保存才由父级调 `changeLanguage`（切 UI + PUT 持久化）。不再「切即生效」。

## Props
- value: LocaleId — 当前选中 locale（由父级 draft 控制）
- onChange: (lng: LocaleId) => void — 选择回调：仅上报父级，不做任何副作用

## 状态 / 交互
- 选中态真值 = `value` prop（父级 draft 控制）。
- 点击选项 → `handleSelect(lng)`：若 `lng === value` → no-op；否则 `onChange(lng)` 仅上报父级。
- 父级保存时调 `changeLanguage(lng)`（react-i18next 触发组件重渲染，UI 切 + PUT 持久化）。

## 复用关系
- 用 primitive-key-choice-cards 范式（与 appearance.theme 同款选择卡片，禁原生 `<select>`）。
- 被组合：`section-tab-panel.tsx`（general tab case）

## 视觉基线
- 卡片样式：border + rounded-lg + py-[16px] + px-[20px] + mb-[8px] + bg-surface-2 + hover:border-border-strong。
- 选项卡：flex-1 + rounded-lg + border + px-3 + py-2.5；选中态 border-accent + bg-accent-surface + text-accent；未选中 border-border + bg-surface-2 + text-fg-2 + hover:border-border-strong。
- 选中态对勾：14×14 svg，stroke=currentColor，text-accent。
- label：i18n key `locale.label`（app-dev-config ns）。

## 消费方
- `app/web/src/components/app-dev-config-page/section-tab-panel.tsx`
