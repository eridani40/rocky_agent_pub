# component-save-bar（通用保存条）

> 层级: component
> 文件: app/web/src/components/common/component-save-bar.tsx
> 关联: `component-seats-panel.md`（面板级 SaveBar 消费）/ `section-config-layout.md`（config 页 tab 级消费）

## 职责
页面/面板底部 sticky 保存条：dirty/saving/saved/cancel 状态展示 + 保存/取消按钮。纯展示组件——不直接调 API，onSave/onCancel 上抛父级。

v0.0.317 从 `component-tab-save-bar.tsx` 迁移并升级：改名 `SaveBar` + 新增 `variant` prop。`TabSaveBar` 为向后兼容 alias。

## Props
- dirty: boolean — 当前是否有未保存改动
- saving: boolean — 是否正在保存
- saved?: boolean — 父级维护的短暂「已保存」反馈标志（保存成功置 true，~1.5s 后清）
- onSave: () => void — 点保存 → 父级提交
- onCancel: () => void — 点取消 → 父级重置 draft 到 snapshot
- variant?: 'tab' | 'detail' — action-key 后缀模式：
  - `'tab'`（缺省）：action-key = `settings.tab.save` / `settings.tab.cancel`
  - `'detail'`：action-key = `settings.detail.save` / `settings.detail.cancel`
- saveTestId?: string — 保存按钮 testid（T4 additive prop，不传=无 testid）
- cancelTestId?: string — 取消按钮 testid（T4 additive prop，不传=无 testid）
- trailing?: ReactNode — **[v0.0.349]** 尾部插槽：渲染在按钮组之后（右端），供消费方挂附加动作（如 provider detail 的删除 danger 按钮）；不传=零渲染，既有消费方零影响。删除等破坏性动作走 danger 按钮样式由插槽内容自带

## 视觉基线
- dirty=true：status「● 有未保存的改动」+ 保存按钮高亮（accent bg）+ 取消按钮可见
- saving=true：保存按钮禁用 + 文案「保存中…」
- saved=true（flash）：status「✓ 已保存」
- 干净态：status「✓ 已保存」+ 保存按钮灰态 + 取消按钮 `visibility:hidden`
- **布局稳定性（MANDATORY）**：取消按钮用 `visibility:hidden` 预留空间（非 `display:none`），避免 dirty 切换时按钮位移

## 消费方
- `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx`（dev config 页 tab 级，variant=tab）
- `app/web/src/components/studio-page/component-seats-panel.tsx`（studio 面板级，variant=tab）
- `app/web/src/components/app-dev-config-page/component-plan-detail.tsx`（方案详情页，variant=detail + saveTestId/cancelTestId）
- `app/web/src/components/providers/component-provider-detail.tsx`（provider 详情页，variant=detail + **[v0.0.349] trailing=删除 danger 按钮**：已存 provider 且 onDeleted 存在才渲染）
