# component-tab-save-bar（page-tab 级保存条）

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-tab-save-bar.tsx
> 关联: `page-app-settings-merged.md`（page-tab 级保存交互）/ `component-group-save-bar.md`（per-group 例外，provider/observability 保留）

## 职责
应用设置页底部 sticky 保存条（page-tab 级保存/取消）。当前 tab 内任一 KV group 有改动 → dirty 高亮保存 + 显示取消；保存 = 当前 tab 全部 dirty group 原子提交；取消 = 重置 draft 到 snapshot。**替代** per-group save-bar 在多 group tab 的角色（provider/observability 例外保留原 save-bar，不进本组件）。

## Props
- dirty: boolean
- saving: boolean
- saved?: boolean
- onSave: () => void
- onCancel: () => void

## 视觉基线
- dirty=true：status「● 有未保存的改动」+ 保存按钮高亮（accent bg）+ 取消按钮可见
- saving=true：保存按钮禁用 + 文案「保存中…」
- saved=true（flash）：status「✓ 已保存」1.5s
- 干净态：status「✓ 已保存」+ 保存按钮灰态 + 取消按钮 `visibility:hidden` ## 视觉基线（demo.html）
