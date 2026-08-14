# section-see-image-config（应用设置 → 工具 → 看图理解 自渲染 section）

> 层级: section
> 本文是「看图理解」section 的**概念权威源**：标题区 + type 选择控件 + 动态 credentials 字段 + saveMode + testid 命名。
> 蓝本: `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`（see_image 与 web_search 完全同构，仅 group/pointId/testid 前缀不同）。

## 1. 概念定位
看图理解（see_image）是 **app config 页内的一个自渲染 group**（与 web_search/web_fetch 同范式）：
- type 选择控件（下拉 `ComponentChannelTypeDropdown`）+ 选中 impl 时动态展示对应 credentials 字段（当前仅 `apiKey`）；由本 section 整组 GET → 草稿态编辑 → 整组 PUT 提交。

## 2. 数据模型（UI 侧契约）
- record 缺失 / `type` 缺失 → UI 草稿态 `type = ""`（空选中）+ `credentials = {}`；保存禁用直到选 type。
- 单实例（`key="default"`），全局一份。

## 3. 保存模型（v0.0.316 统一保存受控化）

section **不自带保存按钮**，改为受控组件接入 tab 级统一保存（`page-app-settings-merged.tsx` 工具 tab + `use-tab-dirty-aggregator.ts`，与 web_search 同构）：
- **`forwardRef` + `useImperativeHandle`** 暴露 `SectionSaveHandle { save, reset }`——save = 整组 PUT `/config/app`（`{group:'see_image', items:[{key:'default', data:draft}]}`），成功后 `baseline = draft` 清 dirty；reset = draft 回 baseline。
- **`onDirtyChange?: (dirty) => void` prop**：`dirty = JSON.stringify(draft) !== JSON.stringify(baseline)`，变化时声明式上报（驱动 tab 级 save bar 亮/灭）。
- **save 可行性（canSave）**：`dirty && draft.type !== '' && impls 含该 type`——type 未配置或无候选 impl 时 save 无效（handleSave 内短路）。
- **内部状态**：baseline / draft / impls / loading / error / saving 照旧；GET（config + inventory）挂载时并发拉取。

## 视觉基线
照 `section-web-search-config` 同款（**非** observability outlier）：
- section 容器：（外层不另加 padding，左边缘统一对齐父 `config-area` 的 ）。
- **切 type 时凭证区高度稳定**：credentials 区域始终为单个 apiKey 字段（两 impl 字段集相同），切换 type 不引起整体高度跳动。
