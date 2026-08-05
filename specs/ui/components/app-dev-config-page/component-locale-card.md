# component-locale-card

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-locale-card.tsx

## 职责
locale group 的语言选择器卡片：label + 说明 + 两选项卡。选项 onChange 立即调 `changeLanguage(lng)`——实时切（react-i18next 触发组件重渲染，无刷新）+ `<html lang>` 同步（无障碍）+ PUT 持久化（`/config/app` 整组提交 `locale` group）。
边界：
- **选项 label 自指**——「中文」恒显「中文」、「English」恒显「English」，不随 locale 切换变化（用户在任何 locale 下都能识别自己想切的语言）。label 不进 i18n 切换（不走 `t`）。
- **切即生效，不进 group save-bar**——对齐 §2.3 appearance.theme 模式；dirty 状态不进 group save 编排。
- **不持编辑态本地副本**——选中态真值来自 `i18n.language`（react-i18next 内部状态），changeLanguage 后 react-i18next 触发本组件重渲染，选中态视觉同步。

## 状态 / 交互
- 选中态真值 = `useTranslation.i18n.language`（当前 locale，`'zh-CN'` / `'en'`，缺省 `'zh-CN'`）。
- 点击选项 → `handleSelect(lng)`：
  - 若 `lng === currentLng` → no-op（避免无意义的 PUT）。
- react-i18next 在 `changeLanguage` 后触发本组件重渲染，选中态视觉（accent 边框 + 对勾 svg）同步切换。
- 持久化失败不显错。

## 复用关系
- 取当前 locale：`useTranslation.i18n.language`（react-i18next hook）
- 不复用 primitive：本组件自渲染 choice-cards（卡片容器 + 选项 button + 选中态 svg），不复用 `primitive-k
- 被组合：`page-app-settings-merged.tsx`（renderGroupArea 注入，仅 locale group 渲染本组件）

## 视觉基线
- 卡片样式：border + rounded-lg + py-[16px] + px-[20px] + mb-[8px] + bg-surface-2 + hover:border-border-strong。
- 选项卡：flex-1 + rounded-lg + border + px-3 + py-2.5；选中态 border-accent + bg-accent-surface + text-accent；未选中 border-border + bg-surface-2 + text-fg-2 + hover:border-border-strong。
- 选中态对勾：14×14 svg，stroke=currentColor，text-accent（accent 颜色随 theme 切换）。
- label：固定字符串 "language"。
